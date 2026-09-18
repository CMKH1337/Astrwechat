import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
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
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const result = this.serial.then(action)
    this.serial = result.catch(() => {})
    return result
  }
  private publish(change: Record<string, unknown>) {
    this._status = { ...this._status, ...change }
    this.options.onStatus(this.status)
  }
  private redact(value: string) {
    return this.secrets.reduce((text, secret) => text.split(secret).join('[REDACTED]'), value)
      .replace(/([?&](?:access_token|token)=)[^&\s]+/gi, '$1[REDACTED]')
  }
  private log(value: string) {
    const line = this.redact(value)
    this._logs.push(line)
    if (this._logs.length > 500) this._logs.shift()
    this.options.onLog(line)
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
    const embedded = join(this.getBridgeDir(), 'python', 'python.exe')
    if (existsSync(embedded)) return embedded
    const configured = process.env.WEFLOW_BRIDGE_PYTHON || process.env.PYTHON
    if (configured?.trim()) return configured.trim()
    const python310 = join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'python.exe')
    return existsSync(python310) ? python310 : 'python'
  }
  send(command: Record<string, unknown>) {
    if (!this.proc?.stdin || this.proc.stdin.destroyed) return false
    try { this.proc.stdin.write(JSON.stringify(command) + '\n'); return true } catch { return false }
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
      this.secrets = [config.access_token, config.astrbot_ob_token, config.kourichat_ob_token].map(value => String(value || '')).filter(Boolean)
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
      this.secrets = [config.access_token, config.astrbot_ob_token, config.kourichat_ob_token].map(value => String(value || '')).filter(Boolean)
      if (this.options.getManagedConfig) await this.waitForStartup(this.writeConfig(config, controller.signal), controller.signal)
      controller.signal.throwIfAborted()
      const connection = activeBridgeConnection(config)
      context.reportProgress('启动 Python Bridge 进程')
      const proc = (this.options.spawnProcess || spawn)(this.getPython(), [join(dir, 'main.py')], {
        cwd: this.getConfigDir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, WEFLOW_BRIDGE_CONFIG: this.configStore.getPath(), PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      })
      this.proc = proc
      this.publish({ running: false, paused: false, ob_connected: false, ob_state: 'connecting', ob_error: '', bot_backend: connection.backend, ob_url: connection.url })
      let buffer = ''
      proc.stdout?.setEncoding('utf8')
      proc.stdout?.on('data', (chunk: string) => {
        if (this.proc !== proc) return
        buffer += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        // Bound malformed output without losing legitimate split JSON / UTF-8 frames.
        if (buffer.length > 1024 * 1024) buffer = ''
        for (const line of lines) {
          try {
            const message = JSON.parse(line)
            if (message.type === 'status' && message.data && typeof message.data === 'object') this.publish(message.data)
            else if (message.type === 'log') this.log(`[${String(message.data?.level || 'INFO').toUpperCase()}] ${message.data?.msg || ''}`)
          } catch { /* Non-JSON startup output is not a status update. */ }
        }
      })
      proc.stderr?.setEncoding('utf8')
      proc.stderr?.on('data', (chunk: string) => { if (this.proc === proc) this.log(`[STDERR] ${chunk.trim()}`) })
      proc.stdin?.on('error', error => { if (this.proc === proc) this.log(`[ERROR] Bridge 命令发送失败：${error.message}`) })
      proc.on('error', error => { if (this.proc === proc) this.log(`[ERROR] Bridge 进程错误：${error.message}`) })
      proc.on('exit', (code) => {
        if (this.proc !== proc) return
        const expected = this._status.ob_state === 'stopping'
        this.proc = null
        this.publish({ running: false, paused: false, ob_connected: false, ob_state: expected || code === 0 ? 'disconnected' : 'error', ob_error: expected || code === 0 ? '' : 'Bridge 进程异常退出，请查看日志' })
      })
      await this.waitForStartup(new Promise<void>((resolve, reject) => {
        proc.once('spawn', resolve)
        proc.once('error', reject)
      }), controller.signal)
      controller.signal.throwIfAborted()
      if (this.proc !== proc || !this.send({ cmd: 'start' })) throw new Error('Bridge 未能接收启动命令')
      this.publish({ starting: false, startup_stage: '' })
      this.log('[INFO] Bridge 启动命令已发送，等待机器人连接')
      return { success: true }
    } catch (error) {
      controller.abort(error)
      const message = this.redact(error instanceof Error ? error.message : String(error))
      this.log(`[ERROR] ${message}`)
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
        try { proc.kill() } catch { /* Keep the handle and refuse to start a second process. */ }
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
        delete next.active_reply_method
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
