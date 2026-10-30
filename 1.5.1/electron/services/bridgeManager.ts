import packageInfo from '../../package.json'
import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BridgeConfigStore } from './bridgeConfigStore'
import { activeBridgeConnection, normalizeBridgeConnection, requiresBridgeRestart, validateBridgeConnection } from '../../shared/bridge-connection'

export interface BridgeStartContext {
  signal: AbortSignal
  reportProgress: (message: string) => void
  reportWarning: (message: string) => void
}

type Result = { success: boolean; error?: string; warning?: string; restarted?: boolean; config?: Record<string, unknown> }
interface Options {
  getBridgeDir: () => string
  getConfigDir?: () => string
  onStatus: (status: Record<string, unknown>) => void
  onLog: (line: string) => void
  spawnProcess?: typeof spawn
  stopTimeoutMs?: number
  killTimeoutMs?: number
  getManagedConfig?: () => Record<string, unknown>
  prepareStart?: (context: BridgeStartContext) => Promise<void>
  onVoiceAudioRequest?: (payload: Record<string, unknown>) => void
  onVoiceAudioStart?: (payload: Record<string, unknown>) => void
  onVoiceAudioCancel?: (payload: Record<string, unknown>) => void
  startTimeoutMs?: number
}

// All start/stop/save operations share one queue. A replacement cannot start until the old process actually exits.
export class BridgeManager {
  private proc: ChildProcess | null = null
  private serial: Promise<unknown> = Promise.resolve()
  private _status: Record<string, unknown> = { running: false, paused: false, ob_connected: false, ob_state: 'disconnected' }
  private _logs: string[] = []
  private secrets: string[] = []
  private startupGeneration = 0
  private stopRequested = new WeakSet<ChildProcess>()
  private lastCommand = ''
  private lastCommandAt = 0
  private logWriteWarning = false
  private readonly configStore: BridgeConfigStore
  private _configWarning: string | undefined
  constructor(private options: Options) {
    this.configStore = new BridgeConfigStore({
      getDirectory: () => this.getConfigDir(),
      getLegacyPath: () => join(this.getBridgeDir(), 'config.json'),
      onWarning: message => { this._configWarning = message; this.log(`[WARN] ${message}`) }
    })
  }
  get configWarning() { return this._configWarning }
  getConfigDir() { return this.options.getConfigDir?.() || this.getBridgeDir() }
  resetConfig(): Promise<void> {
    return this.exclusive(async () => { this.configStore.reset(); this._configWarning = undefined })
  }
  get status() { return { ...this._status, processRunning: this.isRunning() } }
  get logs() { return this._logs }
  isRunning() { return this.proc !== null }
  getBridgeDir() { return this.options.getBridgeDir() }
  private getSystemPython() {
    const embedded = join(this.getBridgeDir(), 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
    if (existsSync(embedded)) return embedded
    const configured = process.env.WEFLOW_BRIDGE_PYTHON || process.env.PYTHON
    if (configured?.trim()) return configured.trim()
    const python310 = join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'python.exe')
    return process.platform === 'win32' && existsSync(python310) ? python310 : (process.platform === 'win32' ? 'python' : 'python3')
  }
  private getManagedPython() {
    const root = join(this.getConfigDir(), 'python-env')
    return process.platform === 'win32' ? join(root, 'Scripts', 'python.exe') : join(root, 'bin', 'python3')
  }
  private getRequirementsHash() {
    const requirements = join(this.getBridgeDir(), 'requirements.txt')
    if (!existsSync(requirements)) throw new Error('Bridge 依赖清单不存在：' + requirements)
    return createHash('sha256').update(readFileSync(requirements)).digest('hex')
  }
  private runDependencyCommand(program: string, args: string[], stage: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      let output = ''
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        error ? reject(error) : resolve()
      }
      const child = (this.options.spawnProcess || spawn)(program, args, {
        cwd: this.getBridgeDir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PYTHONUNBUFFERED: '1' }
      })
      const report = (chunk: Buffer) => {
        output += chunk.toString('utf8')
        const lines = output.split(String.fromCharCode(10))
        output = lines.pop() || ''
        for (const line of lines) if (line.trim()) this.log('[依赖补齐] ' + line.trim().slice(0, 1000))
      }
      child.stdout?.on('data', report)
      child.stderr?.on('data', report)
      child.once('error', (error: Error) => finish(new Error(stage + '失败：' + error.message)))
      child.once('close', (code: number | null) => {
        if (output.trim()) this.log('[依赖补齐] ' + output.trim().slice(0, 1000))
        finish(code === 0 ? undefined : new Error(stage + '失败（退出码 ' + (code ?? '未知') + '），请检查 Bridge 日志和网络连接'))
      })
      const timer = setTimeout(() => {
        try { child.kill() } catch {}
        finish(new Error(stage + '超时，请检查网络后重试'))
      }, 10 * 60 * 1000)
      child.once('spawn', () => this.log('[依赖补齐] ' + stage))
    })
  }
  repairDependencies(): Promise<{ success: boolean; error?: string; python?: string }> {
    return this.exclusive(async () => {
      if (this.isRunning()) return { success: false, error: '请先停止 Bridge，再补齐 Python 模块' }
      const bridgeDir = this.getBridgeDir()
      const managedRoot = join(this.getConfigDir(), 'python-env')
      const managedPython = this.getManagedPython()
      let requirementsHash: string
      try {
        requirementsHash = this.getRequirementsHash()
        mkdirSync(this.getConfigDir(), { recursive: true })
      } catch (error) {
        return { success: false, error: String(error) }
      }
      try {
        if (!existsSync(managedPython)) {
          this.log('[依赖补齐] 正在创建 AstrWeChat 专用 Python 环境')
          await this.runDependencyCommand(this.getSystemPython(), ['-m', 'venv', managedRoot], '创建隔离环境')
        }
        if (!existsSync(managedPython)) throw new Error('Python 虚拟环境创建后未找到解释器')
        const importCheck = 'import importlib.util,sys; names=("requests","pyautogui","pyperclip","pygetwindow","uiautomation","PIL","websockets"); missing=[name for name in names if importlib.util.find_spec(name) is None]; print("缺失模块："+", ".join(missing)) if missing else print("Bridge 模块检查通过"); sys.exit(bool(missing))'
        const marker = join(managedRoot, '.requirements-sha256')
        const alreadyCurrent = existsSync(marker) && readFileSync(marker, 'utf8').trim() === requirementsHash
        if (alreadyCurrent) {
          try {
            await this.runDependencyCommand(managedPython, ['-c', importCheck], '验证 Bridge 模块')
            return { success: true, python: managedPython }
          } catch {
            this.log('[依赖补齐] 环境中仍有缺失模块，将重新安装依赖')
          }
        }
        this.log('[依赖补齐] 正在安装 Bridge 模块；首次安装需要联网')
        await this.runDependencyCommand(managedPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', join(bridgeDir, 'requirements.txt')], '安装 Bridge 模块')
        await this.runDependencyCommand(managedPython, ['-c', importCheck], '验证 Bridge 模块')
        writeFileSync(join(managedRoot, '.requirements-sha256'), requirementsHash, 'utf8')
        this.log('[依赖补齐] 完成。之后 Bridge 将固定使用 AstrWeChat 专用 Python 环境')
        return { success: true, python: managedPython }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.log('[依赖补齐] ' + message)
        return { success: false, error: message }
      }
    })
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.serial.then(action)
    this.serial = result.catch(() => {})
    return result
  }
  private publish(change: Record<string, unknown>) {
    this._status = { ...this._status, ...change }
    this.options.onStatus(this.status)
  }
  private rememberSecrets(config: Record<string, unknown>) {
    const variants = Object.entries(config)
      .filter(([key, value]) => /token|api_key|password|secret/i.test(key) && typeof value === 'string' && value.length > 0)
      .flatMap(([, value]) => {
        const text = String(value)
        return [text, JSON.stringify(text).slice(1, -1), encodeURIComponent(text), encodeURIComponent(text).replace(/%20/g, '+')]
      })
    // Queued output from an old process can still contain its previous credentials.
    this.secrets = [...new Set([...this.secrets, ...variants])].sort((a, b) => b.length - a.length)
  }
  private redact(value: string) {
    return this.secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value)
      .replace(/([?&](?:access_token|token|api_key)=)[^&\s]+/gi, '$1[REDACTED]')
      .replace(/(https?:\/\/|wss?:\/\/)[^/@\s]+@/gi, '$1[REDACTED]@')
  }
  private log(value: string) {
    const line = this.redact(value)
    this._logs.push(line)
    if (this._logs.length > 500) this._logs.shift()
    this.options.onLog(line)
    try {
      const directory = this.getConfigDir()
      const path = join(directory, 'bridge-process.log')
      mkdirSync(directory, { recursive: true })
      if (existsSync(path) && statSync(path).size >= 5 * 1024 * 1024) renameSync(path, `${path}.1`)
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`, 'utf8')
      this.logWriteWarning = false
    } catch (error) {
      if (!this.logWriteWarning) {
        this.logWriteWarning = true
        const warning = this.redact(`[WARN] Bridge 诊断日志写入失败，当前日志仍可在页面查看：${String(error)}`)
        this._logs.push(warning)
        if (this._logs.length > 500) this._logs.shift()
        this.options.onLog(warning)
      }
    }
  }
  ensureConfigFile(): string {
    this.configStore.read()
    return this.configStore.getPath()
  }
  private async readStoredConfig(): Promise<Record<string, unknown>> {
    const raw = this.configStore.read()
    return { ...raw, ...normalizeBridgeConnection(raw) }
  }
  async getConfig(): Promise<Record<string, unknown>> {
    return { ...await this.readStoredConfig(), ...this.options.getManagedConfig?.() }
  }
  private async writeConfig(config: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
    this.configStore.write(config, signal)
  }
  private getPython() {
    const managedPython = this.getManagedPython()
    const marker = join(this.getConfigDir(), 'python-env', '.requirements-sha256')
    try {
      if (existsSync(managedPython) && readFileSync(marker, 'utf8').trim() === this.getRequirementsHash()) return managedPython
    } catch {}
    return this.getSystemPython()
  }
  send(command: Record<string, unknown>) {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) return false
    const action = String(command.cmd || 'unknown')
    try {
      this.lastCommand = action
      this.lastCommandAt = Date.now()
      this.proc.stdin.write(JSON.stringify(command) + '\n')
      return true
    } catch (error) {
      this.log(`[ERROR] Bridge 命令发送失败：cmd=${action}；${String(error)}`)
      return false
    }
  }
  private waitForStartup<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason)
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', onAbort, { once: true })
      // Always observe late rejections, including after a timeout.
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
    })
  }
  start(): Promise<Result> { return this.exclusive(() => this.startUnlocked()) }
  private async startUnlocked(): Promise<Result> {
    if (this.proc) return { success: false, error: 'Bridge 进程已在运行' }
    const controller = new AbortController()
    const generation = ++this.startupGeneration
    let stage = '读取 Bridge 配置'
    const context: BridgeStartContext = {
      signal: controller.signal,
      reportProgress: message => {
        if (controller.signal.aborted || generation !== this.startupGeneration) return
        stage = message
        this.publish({ starting: true, startup_stage: message })
        this.log(`[INFO] ${message}`)
      },
      reportWarning: message => {
        if (!controller.signal.aborted && generation === this.startupGeneration) this.log(`[WARN] ${message}`)
      }
    }
    this.publish({ starting: true, running: false, ob_connected: false, ob_state: 'connecting', ob_error: '' })
    context.reportProgress(stage)
    const timer = setTimeout(() => {
      controller.abort(new Error(`启动超时：${stage}。请重试；若微信数据库无响应，请重启软件后重新连接微信`))
    }, this.options.startTimeoutMs ?? 15000)
    try {
      let config = await this.waitForStartup(this.getConfig(), controller.signal)
      this.rememberSecrets(config)
      const invalid = validateBridgeConnection(config)
      if (invalid) throw new Error(invalid)
      const dir = this.getBridgeDir()
      if (!existsSync(join(dir, 'main.py'))) throw new Error('Bridge 程序文件不存在')
      if (this.options.prepareStart) {
        context.reportProgress('准备微信消息接收')
        await this.waitForStartup(this.options.prepareStart(context), controller.signal)
      }
      context.reportProgress('同步微信连接配置')
      config = await this.waitForStartup(this.getConfig(), controller.signal)
      this.rememberSecrets(config)
      if (this.options.getManagedConfig) await this.waitForStartup(this.writeConfig(config, controller.signal), controller.signal)
      controller.signal.throwIfAborted()
      const connection = activeBridgeConnection(config)
      context.reportProgress('启动 Python Bridge 进程')
      const python = this.getPython()
      const entry = join(dir, 'main.py')
      const runtimeDir = this.getConfigDir()
      const startedAt = Date.now()
      this.lastCommand = ''
      this.lastCommandAt = 0
      this.log(`[INFO] [Bridge 诊断] 启动时间=${new Date(startedAt).toISOString()}；应用=${packageInfo.version}；系统=${process.platform}/${process.arch}；Electron=${process.versions.electron || '未使用'}；Node=${process.versions.node}`)
      this.log(`[INFO] [Bridge 诊断] Python=${python}；入口=${entry}；工作目录=${runtimeDir}；配置=${this.configStore.getPath()}`)
      this.log(`[INFO] [Bridge 诊断] 日志文件=${join(runtimeDir, 'bridge-process.log')}；Python 日志=${join(runtimeDir, 'bridge.log')}；后端=${connection.backend}；地址=${connection.url}；发送模式=${config.uia_direct_window ? '独立窗口' : '主窗口'}；UIA详细日志=${Boolean(config.uia_detailed_logging)}`)
      const proc = (this.options.spawnProcess || spawn)(python, [entry], {
        cwd: runtimeDir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ASTRWECHAT_VERSION: packageInfo.version, WEFLOW_BRIDGE_CONFIG: this.configStore.getPath(), PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONFAULTHANDLER: '1' }
      })
      this.proc = proc
      this.publish({ running: false, paused: false, ob_connected: false, ob_state: 'connecting', ob_error: '', bot_backend: connection.backend, ob_url: connection.url })
      let buffer = '', stderrBuffer = '', lastError = ''
      let stdoutBytes = 0, stderrBytes = 0, stdoutAt = 0, stderrAt = 0
      let exited = false, expectedExit = false, reportedExit = false, closed = false
      const stdoutLine = (line: string) => {
        if (!line.trim()) return
        try {
          const message = JSON.parse(line)
          if (message.type === 'status' && message.data && typeof message.data === 'object') {
            if (this.proc === proc) this.publish(message.data)
          } else if (message.type === 'log') {
            const level = String(message.data?.level || 'INFO').toUpperCase()
            const text = String(message.data?.msg || '')
            if (level === 'ERROR' || level === 'CRITICAL') lastError = this.redact(text).slice(-2000)
            this.log(`[${level}] ${text}`)
          } else if (message.type === 'voice_audio_request' && message.data && typeof message.data === 'object') {
            try { this.options.onVoiceAudioRequest?.(message.data as Record<string, unknown>) }
            catch (error) { this.log(`[ERROR] 语音播放请求处理失败：${String(error)}`) }
          } else if (message.type === 'voice_audio_start' && message.data && typeof message.data === 'object') {
            try { this.options.onVoiceAudioStart?.(message.data as Record<string, unknown>) }
            catch (error) { this.log(`[ERROR] 启动语音播放失败：${String(error)}`) }
          } else if (message.type === 'voice_audio_cancel' && message.data && typeof message.data === 'object') {
            try { this.options.onVoiceAudioCancel?.(message.data as Record<string, unknown>) }
            catch (error) { this.log(`[ERROR] 停止语音播放失败：${String(error)}`) }
          } else if (message.type === 'error') {
            lastError = this.redact(typeof message.data === 'string' ? message.data : JSON.stringify(message.data) || line).slice(-2000)
            this.log(`[ERROR] ${lastError}`)
          } else this.log(`[STDOUT] ${line}`)
        } catch { this.log(`[STDOUT] ${line}`) }
      }
      const stderrLine = (line: string) => {
        if (!line.trim()) return
        lastError = this.redact(line.trim()).slice(-2000)
        this.log(`[STDERR] ${line}`)
      }
      proc.stdout?.setEncoding('utf8')
      proc.stdout?.on('data', (chunk: string) => {
        if (closed || (this.proc !== proc && !exited)) return
        stdoutBytes += Buffer.byteLength(chunk, 'utf8'); stdoutAt = Date.now()
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) stdoutLine(line.replace(/\r$/, ''))
        if (buffer.length > 1024 * 1024) {
          this.log('[WARN] Bridge stdout 单行超过 1 MiB，按原始输出分段保存')
          this.log(`[STDOUT] ${buffer}`)
          buffer = ''
        }
      })
      proc.stderr?.setEncoding('utf8')
      proc.stderr?.on('data', (chunk: string) => {
        if (closed || (this.proc !== proc && !exited)) return
        stderrBytes += Buffer.byteLength(chunk, 'utf8'); stderrAt = Date.now()
        stderrBuffer += chunk
        const lines = stderrBuffer.split('\n')
        stderrBuffer = lines.pop() || ''
        for (const line of lines) stderrLine(line.replace(/\r$/, ''))
        if (stderrBuffer.length > 1024 * 1024) { stderrLine(stderrBuffer); stderrBuffer = '' }
      })
      const processError = (source: string, error: Error) => {
        if (this.proc !== proc) return
        const detail = error as NodeJS.ErrnoException & { path?: string; spawnargs?: string[] }
        lastError = this.redact(error.message)
        this.log(`[ERROR] Bridge ${source}：${error.stack || error.message}；code=${detail.code || '无'}；errno=${detail.errno ?? '无'}；syscall=${detail.syscall || '无'}；path=${detail.path || python}`)
      }
      proc.stdin?.on('error', error => processError('命令管道错误', error))
      proc.stdout?.on('error', error => processError('stdout 管道错误', error))
      proc.stderr?.on('error', error => processError('stderr 管道错误', error))
      proc.on('error', error => processError('进程错误', error))
      const exitDescription = (code: number | null, signal: NodeJS.Signals | null) => {
        const hex = code === null ? '' : ` (0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')})`
        return `退出码=${code ?? '无'}${hex}；信号=${signal || '无'}`
      }
      const exitMessage = (code: number | null, signal: NodeJS.Signals | null) => {
        const detail = lastError.trim().split(/\r?\n/).filter(Boolean).pop()
        return `Bridge 进程异常退出（${exitDescription(code, signal)}）${detail ? `；最后报错：${detail.slice(0, 400)}` : '；请查看日志中的 Bridge 诊断'}`
      }
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (reportedExit || this.proc !== proc) return
        reportedExit = true
        exited = true
        expectedExit = this.stopRequested.has(proc)
        const snapshot = JSON.stringify({ running: this._status.running, paused: this._status.paused, ob_connected: this._status.ob_connected, ob_state: this._status.ob_state, ob_error: this._status.ob_error, startup_stage: this._status.startup_stage })
        const age = (at: number) => at ? `${Date.now() - at}ms前` : '无'
        this.log(`[${expectedExit ? 'INFO' : 'ERROR'}] [Bridge 诊断] 进程${expectedExit ? '停止' : '意外退出'}：PID=${proc.pid ?? '未分配'}；${exitDescription(code, signal)}；运行=${Date.now() - startedAt}ms；主动停止=${expectedExit}`)
        this.log(`[INFO] [Bridge 诊断] 退出前状态=${snapshot}；最后命令=${this.lastCommand || '无'} (${age(this.lastCommandAt)})；stdout=${stdoutBytes}字节 (${age(stdoutAt)})；stderr=${stderrBytes}字节 (${age(stderrAt)})；待收尾输出=${buffer.length}/${stderrBuffer.length}字符`)
        this.proc = null
        this.publish({ starting: false, startup_stage: '', running: false, paused: false, ob_connected: false, ob_state: expectedExit ? 'disconnected' : 'error', ob_error: expectedExit ? '' : exitMessage(code, signal) })
      }
      proc.on('exit', onExit)
      // 'exit' can precede the last bytes on the pipes. Drain through 'close',
      // but never let a retired child's status overwrite a replacement process.
      proc.once('close', (code, signal) => {
        onExit(code, signal)
        if (buffer) stdoutLine(buffer.replace(/\r$/, ''))
        if (stderrBuffer) stderrLine(stderrBuffer.replace(/\r$/, ''))
        buffer = ''; stderrBuffer = ''; closed = true
        this.log(`[INFO] [Bridge 诊断] 输出管道已关闭：PID=${proc.pid ?? '未分配'}；stdout=${stdoutBytes}字节；stderr=${stderrBytes}字节`)
        if (reportedExit && !expectedExit && generation === this.startupGeneration && !this.proc) this.publish({ ob_error: exitMessage(code, signal) })
      })
      await this.waitForStartup(new Promise<void>((resolve, reject) => {
        proc.once('spawn', resolve)
        proc.once('error', reject)
      }), controller.signal)
      controller.signal.throwIfAborted()
      this.log(`[INFO] [Bridge 诊断] Python 进程已创建：PID=${proc.pid ?? '未分配'}；启动耗时=${Date.now() - startedAt}ms`)
      if (this.proc !== proc || !this.send({ cmd: 'start' })) throw new Error('Bridge 未能接收启动命令')
      this.publish({ starting: false, startup_stage: '' })
      this.log('[INFO] Bridge 启动命令已发送，等待机器人连接')
      return { success: true }
    } catch (error) {
      controller.abort(error)
      const message = this.redact(error instanceof Error ? error.message : String(error))
      this.log(`[ERROR] Bridge 启动失败：${error instanceof Error ? error.stack || error.message : message}`)
      // A timed-out attempt must not leave a child waiting for a late start command.
      if (this.proc && !this.proc.pid) this.proc = null
      else if (this.proc) await this.stopUnlocked()
      this.publish({ starting: false, startup_stage: '', ob_state: 'error', ob_error: message, ob_connected: false })
      return { success: false, error: message }
    } finally {
      clearTimeout(timer)
    }
  }
  stop(): Promise<boolean> { return this.exclusive(() => this.stopUnlocked()) }
  private async stopUnlocked(): Promise<boolean> {
    this.startupGeneration += 1
    const proc = this.proc
    if (!proc) return false
    this.stopRequested.add(proc)
    this.publish({ ob_state: 'stopping', ob_connected: false, ob_error: '' })
    return new Promise<boolean>(resolve => {
      let settled = false
      let killTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (success: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (killTimer) clearTimeout(killTimer)
        proc.removeListener('exit', onExit)
        if (!success) this.publish({ ob_state: 'error', ob_error: '旧 Bridge 进程尚未退出，已取消切换，请重试停止' })
        resolve(success)
      }
      const onExit = () => finish(true)
      proc.once('exit', onExit)
      const timer = setTimeout(() => {
        if (proc.exitCode !== null || proc.signalCode !== null) { finish(true); return }
        this.log(`[WARN] [Bridge 诊断] 停止等待超时，尝试强制终止：PID=${proc.pid ?? '未分配'}`)
        try { proc.kill() } catch (error) { this.log(`[ERROR] Bridge 强制终止失败：${String(error)}`) }
        killTimer = setTimeout(() => finish(false), this.options.killTimeoutMs ?? 5000)
      }, this.options.stopTimeoutMs ?? 4000)
      this.send({ cmd: 'exit' })
    })
  }
  saveConfig(input: Record<string, unknown>): Promise<Result> {
    return this.exclusive(async () => {
      try {
        // Compare the config actually given to Python, not a fresh managed overlay:
        // a changed local token/account must restart the existing child as well.
        const previous = await this.readStoredConfig()
        const raw = { ...previous, ...input, ...this.options.getManagedConfig?.() }
        const invalid = validateBridgeConnection(raw)
        if (invalid) return { success: false, error: invalid }
        const next: Record<string, unknown> = { ...raw, ...normalizeBridgeConnection(raw) }
        this.rememberSecrets(next)
        delete next.active_reply_method
        delete next.local_attachment_label
        if (next.group_reply_filter_mode) delete next.active_reply_whitelist
        const restart = this.isRunning() && requiresBridgeRestart(previous, next)
        if (restart && !await this.stopUnlocked()) return { success: false, error: '旧连接未安全退出，配置未更改，也没有启动新连接' }
        await this.writeConfig(next)
        this._configWarning = undefined
        if (restart) {
          this.log(`[INFO] 已停止旧连接，切换至 ${activeBridgeConnection(next).label}；旧进程未发送的回复不会转交新连接`)
          const started = await this.startUnlocked()
          return { success: true, config: next, restarted: started.success, ...(!started.success ? { warning: `配置已保存，但启动失败：${started.error}` } : {}) }
        }
        if (this.isRunning()) this.send({ cmd: 'update_config', config: next })
        else this.publish({ bot_backend: activeBridgeConnection(next).backend, ob_url: activeBridgeConnection(next).url })
        return { success: true, config: next, restarted: false }
      } catch (error) { return { success: false, error: this.redact(String(error)) } }
    })
  }
}
