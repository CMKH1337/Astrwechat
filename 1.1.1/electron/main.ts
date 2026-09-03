import './runtime-env'
import './appIdentity'
import './preload-env'
import { app, BrowserWindow, ipcMain, nativeTheme, session, Tray, Menu, nativeImage } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { join, dirname } from 'path'
import { autoUpdater } from 'electron-updater'
import { readFile, writeFile, appendFile, mkdir, rm, readdir } from 'fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import packageMetadata from '../package.json'
import bridgeDefaultConfig from '../shared/bridge-default-config.json'
import { ConfigService } from './services/config'
import { resolveAppIconPath } from './appIcon'
import { dbPathService } from './services/dbPathService'
import { wcdbService } from './services/wcdbService'
import { chatService } from './services/chatService'
import { imageDecryptService } from './services/imageDecryptService'
import { imagePreloadService } from './services/imagePreloadService'
import { KeyService } from './services/keyService'
import { KeyServiceLinux } from './services/keyServiceLinux'
import { KeyServiceMac } from './services/keyServiceMac'
import { videoService } from './services/videoService'
import { windowsHelloService } from './services/windowsHelloService'

import { destroyNotificationWindow, registerNotificationHandlers, showNotification, setNotificationNavigateHandler } from './windows/notificationWindow'
import { httpService } from './services/httpService'
import { messagePushService } from './services/messagePushService'

// WCDB compatibility: native initialization expects the legacy internal name.
// Product-facing branding remains AstrWeChat through productName, custom titlebar
// and tray labels; this only preserves the runtime compatibility profile.
app.setName('WeFlow')
try {
  app.setPath('userData', join(app.getPath('appData'), 'weflow'))
} catch (error) {
  console.warn('[AstrWeChat] Failed to preserve legacy WeFlow userData path:', error)
}
if (process.platform === 'win32') {
  app.setAppUserModelId('com.AstrWeChat.app')
}


// 配置自动更新
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true
autoUpdater.disableDifferentialDownload = true  // 禁用差分更新，强制全量下载
// 更新通道策略：
// - 稳定版（如 4.3.0）默认走 latest
// - 预览版（如 0.26.2）默认走 preview（0.年.当年发布序号）
// - 开发版（如 26.4.5）默认走 dev（年.月.日）
// - 用户可在设置页切换稳定/预览/开发，切换后即时生效
// 同时区分 Windows x64 / arm64，避免更新清单互相覆盖。
// app.getVersion() reports the Electron runtime version when a development launch
// points directly at dist-electron/main.js. Use project metadata as the
// authoritative product version so development and packaged builds agree.
const appVersion = String(packageMetadata.version || app.getVersion()).trim()
const inferUpdateTrackFromVersion = (version: string): 'stable' | 'preview' | 'dev' => {
  const normalized = String(version || '').trim().replace(/^v/i, '')
  if (/^0\.\d{2}\.\d+$/i.test(normalized)) return 'preview'
  if (/^\d{2}\.\d{1,2}\.\d{1,2}$/i.test(normalized)) return 'dev'
  // 兼容旧版命名（如 4.3.0-preview.26.1 / 4.3.0-dev.26.3.4）
  if (/-preview\.\d+\.\d+$/i.test(normalized)) return 'preview'
  if (/-dev\.\d+\.\d+\.\d+$/i.test(normalized)) return 'dev'
  // 兼容 alpha/beta/rc 预发布
  if (/(alpha|beta|rc)/i.test(normalized)) return 'dev'
  return 'stable'
}

const defaultUpdateTrack: 'stable' | 'preview' | 'dev' = (() => {
  const inferred = inferUpdateTrackFromVersion(appVersion)
  if (inferred === 'preview' || inferred === 'dev') return inferred
  return 'stable'
})()
let configService: ConfigService | null = null

// ============ Bridge 进程管理 ============

class BridgeManager {
  private proc: ChildProcess | null = null
  private _status: Record<string, unknown> = { running: false, ob_connected: false }
  private _logs: string[] = []

  get status() { return this._status }
  get logs() { return this._logs }
  ensureConfigFile(): string {
    const dir = this.getBridgeDir()
    const configPath = join(dir, 'config.json')
    if (!existsSync(configPath)) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(configPath, JSON.stringify(bridgeDefaultConfig, null, 4), 'utf8')
    }
    return configPath
  }

  getBridgeDir() {
    const candidates = [
      // electron:run passes dist-electron/main.js, so app.getAppPath() can be
      // dist-electron rather than the project root.
      join(app.getAppPath(), 'bridge'),
      join(dirname(app.getAppPath()), 'bridge'),
      join(process.cwd(), 'bridge'),
      join(process.resourcesPath, 'bridge'),
      join(process.resourcesPath, 'app.asar.unpacked', 'bridge')
    ]
    return candidates.find((candidate) => existsSync(candidate)) || candidates[0]
  }

  private getPython() {
    const embedded = join(this.getBridgeDir(), 'python', 'python.exe')
    if (existsSync(embedded)) return embedded

    const configured = process.env.WEFLOW_BRIDGE_PYTHON || process.env.PYTHON
    if (configured?.trim()) return configured.trim()

    const python310 = join(process.env.LOCALAPPDATA || '', 'Programs', 'Python', 'Python310', 'python.exe')
    return existsSync(python310) ? python310 : 'python'
  }

  start() {
    if (this.proc) return { success: false, error: '进程已在运行' }
    const dir = this.getBridgeDir()
    this.ensureConfigFile()
    const entry = join(dir, 'main.py')
    if (!existsSync(entry)) {
      return { success: false, error: `Bridge 程序文件不存在: ${entry}` }
    }
    const py = this.getPython()
    try {
      this.proc = spawn(py, ['main.py'], {
        cwd: dir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1'
        }
      })
      this.proc.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          try {
            const msg = JSON.parse(line)
            if (msg.type === 'status') {
              this._status = msg.data
              const liveStatus = { ...this._status, processRunning: this.isRunning() }
              BrowserWindow.getAllWindows().forEach(w => {
                if (!w.isDestroyed()) w.webContents.send('bridge:status', liveStatus)
              })
            } else if (msg.type === 'log') {
              const entry = `[${msg.data.level?.toUpperCase() || 'INFO'}] ${msg.data.msg}`
              this._logs.push(entry)
              if (this._logs.length > 500) this._logs.shift()
              BrowserWindow.getAllWindows().forEach(w => {
                if (!w.isDestroyed()) w.webContents.send('bridge:log', entry)
              })
            }
          } catch { /* 非 JSON 行忽略 */ }
        }
      })
      this.proc.stderr?.on('data', (chunk: Buffer) => {
        const msg = `[STDERR] ${chunk.toString().trim()}`
        this._logs.push(msg)
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send('bridge:log', msg)
        })
      })
      this.proc.on('exit', () => {
        this.proc = null
        this._status = { running: false, ob_connected: false }
        BrowserWindow.getAllWindows().forEach(w => {
          if (!w.isDestroyed()) w.webContents.send('bridge:status', this._status)
        })
      })
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  send(cmd: Record<string, unknown>) {
    if (!this.proc?.stdin) return false
    try {
      this.proc.stdin.write(JSON.stringify(cmd) + '\n')
      return true
    } catch { return false }
  }

  stop() {
    const proc = this.proc
    if (!proc) return Promise.resolve(false)

    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (stopped: boolean) => {
        if (settled) return
        settled = true
        if (this.proc === proc) {
          this.proc = null
          this._status = { running: false, ob_connected: false }
        }
        resolve(stopped)
      }

      proc.once('exit', () => finish(true))
      this.send({ cmd: 'exit' })

      setTimeout(() => {
        if (proc.exitCode === null && !proc.killed) {
          proc.kill()
        }
        finish(true)
      }, 3000)
    })
  }

  isRunning() { return this.proc !== null }
}

const bridgeManager = new BridgeManager()

const writeDatabaseConnectionLog = async (message: string): Promise<void> => {
  try {
    const logPath = join(app.getPath('userData'), 'logs', 'wcdb.log')
    await mkdir(dirname(logPath), { recursive: true })
    await appendFile(logPath, `${new Date().toISOString()} [connection] ${message}\n`, 'utf8')
  } catch (error) {
    console.warn('写入数据库连接日志失败:', error)
  }
}

type ResourceDiagnosticsEntry = {
  ts: number
  payload: Record<string, unknown>
}

const resourceDiagnosticsEntries: ResourceDiagnosticsEntry[] = []
const maxResourceDiagnosticsEntries = 240
let resourceDiagnosticsPreloadTotalsBaseline: Record<string, number> | null = null

const sanitizeResourceDiagnosticsPayload = (payload: unknown): Record<string, unknown> => {
  if (!payload || typeof payload !== 'object') return {}
  try {
    const serialized = JSON.stringify(payload)
    if (serialized.length > 24_000) {
      return {
        truncated: true,
        size: serialized.length
      }
    }
    return JSON.parse(serialized)
  } catch {
    return { unserializable: true }
  }
}

const getRecordValue = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== 'object') return undefined
  return (value as Record<string, unknown>)[key]
}

const getNumericRecordValue = (value: unknown, path: string[]): number => {
  let current: unknown = value
  for (const key of path) {
    current = getRecordValue(current, key)
  }
  const numeric = Number(current)
  return Number.isFinite(numeric) ? numeric : 0
}

const summarizeResourceDiagnostics = (
  entries: ResourceDiagnosticsEntry[],
  preloadTotalsBaseline: Record<string, number> | null = resourceDiagnosticsPreloadTotalsBaseline
): Record<string, unknown> => {
  const counterDeltas: Record<string, number> = {}
  const preloadTotalDeltas: Record<string, number> = {}
  let longFrames = 0
  let maxRecentFrameMs = 0
  let maxQueued = 0
  let maxQueuedCache = 0
  let maxQueuedDecrypt = 0
  let maxQueuedHigh = 0
  let maxQueuedNormal = 0
  let maxQueuedLow = 0
  let maxActiveCache = 0
  let maxActiveDecrypt = 0
  let maxPending = 0
  let maxHighWaterQueued = 0
  let maxHighWaterQueuedDecrypt = 0
  let maxHighWaterQueuedLow = 0
  let maxHighWaterActiveDecrypt = 0
  let mediaStreamMaxLoadMs = 0

  for (const entry of entries) {
    const payload = entry.payload
    longFrames += getNumericRecordValue(payload, ['frameDelta', 'longFrames'])
    maxRecentFrameMs = Math.max(maxRecentFrameMs, getNumericRecordValue(payload, ['frameDelta', 'recentMaxFrameMs']))
    maxQueued = Math.max(maxQueued, getNumericRecordValue(payload, ['preloadStats', 'queued']))
    maxQueuedCache = Math.max(maxQueuedCache, getNumericRecordValue(payload, ['preloadStats', 'queuedCache']))
    maxQueuedDecrypt = Math.max(maxQueuedDecrypt, getNumericRecordValue(payload, ['preloadStats', 'queuedDecrypt']))
    maxQueuedHigh = Math.max(maxQueuedHigh, getNumericRecordValue(payload, ['preloadStats', 'queuedHigh']))
    maxQueuedNormal = Math.max(maxQueuedNormal, getNumericRecordValue(payload, ['preloadStats', 'queuedNormal']))
    maxQueuedLow = Math.max(maxQueuedLow, getNumericRecordValue(payload, ['preloadStats', 'queuedLow']))
    maxActiveCache = Math.max(maxActiveCache, getNumericRecordValue(payload, ['preloadStats', 'activeCache']))
    maxActiveDecrypt = Math.max(maxActiveDecrypt, getNumericRecordValue(payload, ['preloadStats', 'activeDecrypt']))
    maxPending = Math.max(maxPending, getNumericRecordValue(payload, ['preloadStats', 'pending']))
    maxHighWaterQueued = Math.max(maxHighWaterQueued, getNumericRecordValue(payload, ['preloadStats', 'highWater', 'queued']))
    maxHighWaterQueuedDecrypt = Math.max(maxHighWaterQueuedDecrypt, getNumericRecordValue(payload, ['preloadStats', 'highWater', 'queuedDecrypt']))
    maxHighWaterQueuedLow = Math.max(maxHighWaterQueuedLow, getNumericRecordValue(payload, ['preloadStats', 'highWater', 'queuedLow']))
    maxHighWaterActiveDecrypt = Math.max(maxHighWaterActiveDecrypt, getNumericRecordValue(payload, ['preloadStats', 'highWater', 'activeDecrypt']))
    mediaStreamMaxLoadMs = Math.max(
      mediaStreamMaxLoadMs,
      getNumericRecordValue(payload, ['counters', 'mediaStreamMaxLoadMs']),
      getNumericRecordValue(payload, ['delta', 'mediaStreamMaxLoadMs'])
    )

    const delta = getRecordValue(payload, 'delta')
    if (delta && typeof delta === 'object') {
      for (const [key, value] of Object.entries(delta as Record<string, unknown>)) {
        const numeric = Number(value)
        if (!Number.isFinite(numeric)) continue
        counterDeltas[key] = (counterDeltas[key] || 0) + numeric
      }
    }
  }

  const lastTotals = getRecordValue(getRecordValue(entries[entries.length - 1]?.payload, 'preloadStats'), 'totals')
  const firstTotals = preloadTotalsBaseline || getRecordValue(getRecordValue(entries[0]?.payload, 'preloadStats'), 'totals')
  if (firstTotals && typeof firstTotals === 'object' && lastTotals && typeof lastTotals === 'object') {
    const keys = new Set([
      ...Object.keys(firstTotals as Record<string, unknown>),
      ...Object.keys(lastTotals as Record<string, unknown>)
    ])
    for (const key of keys) {
      const first = Number((firstTotals as Record<string, unknown>)[key])
      const last = Number((lastTotals as Record<string, unknown>)[key])
      if (!Number.isFinite(first) || !Number.isFinite(last)) continue
      preloadTotalDeltas[key] = last - first
    }
  }

  const mediaStreamLoadSamples = counterDeltas.mediaStreamLoadSamples || 0
  const mediaStreamLoadMsTotal = counterDeltas.mediaStreamLoadMsTotal || 0
  const mediaStreamPageCacheHits = counterDeltas.mediaStreamPageCacheHits || 0
  const mediaStreamInflightMerges = counterDeltas.mediaStreamInflightMerges || 0
  const mediaStreamAvoidedNativeLoads = mediaStreamPageCacheHits + mediaStreamInflightMerges
  const mediaStreamNativeLoads = counterDeltas.mediaStreamNativeLoads || 0
  const mediaStreamRowsLoaded = counterDeltas.mediaStreamRowsLoaded || 0
  const mediaStreamDuplicateRows = counterDeltas.mediaStreamDuplicateRows || 0
  const mediaStreamNoProgressStops = counterDeltas.mediaStreamNoProgressStops || 0
  const preloadAccepted = preloadTotalDeltas.accepted || 0
  const preloadMergedQueued = preloadTotalDeltas.mergedQueued || 0
  const preloadSkippedActive = preloadTotalDeltas.skippedActive || 0
  const preloadSkippedPending = preloadTotalDeltas.skippedPending || 0
  const preloadDeduped = preloadMergedQueued + preloadSkippedActive + preloadSkippedPending
  const preloadHandled = preloadAccepted + preloadDeduped
  const preloadCanceledActive = preloadTotalDeltas.canceledActive || 0
  const preloadDroppedQueued = preloadTotalDeltas.droppedQueued || 0
  const preloadDeferredLowPriority = preloadTotalDeltas.deferredLowPriority || 0
  const preloadLowPriorityIdleDeferrals = preloadTotalDeltas.lowPriorityIdleDeferrals || 0
  const preloadActiveCacheSnapshots = preloadTotalDeltas.activeCacheSnapshots || 0
  const preloadActiveCacheSnapshotSkipped = preloadTotalDeltas.activeCacheSnapshotSkipped || 0
  const preloadActiveCacheSnapshotCanceled = preloadTotalDeltas.activeCacheSnapshotCanceled || 0
  const preloadLowPriorityRejected = preloadTotalDeltas.lowPriorityRejected || 0
  const imagePreloadRejectedCapacity = counterDeltas.imagePreloadRejectedCapacity || 0
  const imagePredecryptRequests = counterDeltas.imagePredecryptRequests || 0
  const imagePredecryptBackpressureSkips = counterDeltas.imagePredecryptBackpressureSkips || 0
  const imagePredecryptRejectedCapacity = counterDeltas.imagePredecryptRejectedCapacity || 0
  const imagePredecryptDeferred = counterDeltas.imagePredecryptDeferred || 0
  const imagePredecryptPreviewUpgrades = counterDeltas.imagePredecryptPreviewUpgrades || 0
  const predecryptHiddenSkips = counterDeltas.predecryptHiddenSkips || 0
  const rangeHiddenSkips = counterDeltas.rangeHiddenSkips || 0
  const rangeDuplicateSkips = counterDeltas.rangeDuplicateSkips || 0
  const rangeVisibilityReschedules = counterDeltas.rangeVisibilityReschedules || 0
  const transientStatePruneRuns = counterDeltas.transientStatePruneRuns || 0

  return {
    samples: entries.length,
    longFrames,
    maxRecentFrameMs,
    maxQueued,
    maxQueuedCache,
    maxQueuedDecrypt,
    maxQueuedHigh,
    maxQueuedNormal,
    maxQueuedLow,
    maxPending,
    maxActiveCache,
    maxActiveDecrypt,
    maxHighWaterQueued,
    maxHighWaterQueuedDecrypt,
    maxHighWaterQueuedLow,
    maxHighWaterActiveDecrypt,
    mediaStreamLoadSamples,
    mediaStreamAvgLoadMs: mediaStreamLoadSamples > 0 ? mediaStreamLoadMsTotal / mediaStreamLoadSamples : 0,
    mediaStreamMaxLoadMs,
    mediaStreamNativeLoads,
    mediaStreamPageCacheHits,
    mediaStreamInflightMerges,
    mediaStreamAvoidedNativeLoads,
    mediaStreamAvoidedNativeRate: mediaStreamLoadSamples > 0 ? mediaStreamAvoidedNativeLoads / mediaStreamLoadSamples : 0,
    mediaStreamPageCacheHitRate: mediaStreamLoadSamples > 0 ? mediaStreamPageCacheHits / mediaStreamLoadSamples : 0,
    mediaStreamRowsLoaded,
    mediaStreamDuplicateRows,
    mediaStreamDuplicateRate: mediaStreamRowsLoaded > 0 ? mediaStreamDuplicateRows / mediaStreamRowsLoaded : 0,
    mediaStreamNoProgressStops,
    preloadAccepted,
    preloadDeduped,
    preloadHandled,
    preloadDedupRate: preloadHandled > 0 ? preloadDeduped / preloadHandled : 0,
    preloadCanceledActive,
    preloadDroppedQueued,
    preloadDeferredLowPriority,
    preloadLowPriorityIdleDeferrals,
    preloadActiveCacheSnapshots,
    preloadActiveCacheSnapshotSkipped,
    preloadActiveCacheSnapshotCanceled,
    preloadLowPriorityRejected,
    imagePreloadRejectedCapacity,
    imagePredecryptRequests,
    imagePredecryptBackpressureSkips,
    imagePredecryptRejectedCapacity,
    imagePredecryptDeferred,
    imagePredecryptPreviewUpgrades,
    imagePredecryptRejectRate: imagePredecryptRequests > 0 ? imagePredecryptRejectedCapacity / imagePredecryptRequests : 0,
    imagePredecryptBackpressureRate: imagePredecryptRequests > 0 ? imagePredecryptBackpressureSkips / imagePredecryptRequests : 0,
    predecryptHiddenSkips,
    rangeHiddenSkips,
    rangeDuplicateSkips,
    rangeVisibilityReschedules,
    transientStatePruneRuns,
    preloadTotalsBaselineCaptured: Boolean(preloadTotalsBaseline),
    counterDeltas,
    preloadTotalDeltas
  }
}

const ALLOWED_EXTERNAL_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:'])

const normalizeAllowedExternalUrl = (rawUrl: unknown): string | null => {
  const value = String(rawUrl || '').trim()
  if (!value) return null
  try {
    const parsed = new URL(value)
    if (!ALLOWED_EXTERNAL_URL_PROTOCOLS.has(parsed.protocol.toLowerCase())) {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

const normalizeUpdateTrack = (raw: unknown): 'stable' | 'preview' | 'dev' | null => {
  if (raw === 'stable' || raw === 'preview' || raw === 'dev') return raw
  return null
}

const getEffectiveUpdateTrack = (): 'stable' | 'preview' | 'dev' => {
  const configuredTrack = normalizeUpdateTrack(configService?.get('updateChannel'))
  return configuredTrack || defaultUpdateTrack
}

const isRemoteVersionNewer = (latestVersion: string, currentVersion: string): boolean => {
  const latest = String(latestVersion || '').trim()
  const current = String(currentVersion || '').trim()
  if (!latest || !current) return false

  const parseVersion = (version: string) => {
    const normalized = version.replace(/^v/i, '')
    const [main, pre = ''] = normalized.split('-', 2)
    const core = main.split('.').map((segment) => Number.parseInt(segment, 10) || 0)
    const prerelease = pre ? pre.split('.').map((segment) => /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : segment) : []
    return { core, prerelease }
  }

  const compareParsedVersion = (a: ReturnType<typeof parseVersion>, b: ReturnType<typeof parseVersion>): number => {
    const maxLen = Math.max(a.core.length, b.core.length)
    for (let i = 0; i < maxLen; i += 1) {
      const left = a.core[i] || 0
      const right = b.core[i] || 0
      if (left > right) return 1
      if (left < right) return -1
    }

    const aPre = a.prerelease
    const bPre = b.prerelease
    if (aPre.length === 0 && bPre.length === 0) return 0
    if (aPre.length === 0) return 1
    if (bPre.length === 0) return -1

    const preMaxLen = Math.max(aPre.length, bPre.length)
    for (let i = 0; i < preMaxLen; i += 1) {
      const left = aPre[i]
      const right = bPre[i]
      if (left === undefined) return -1
      if (right === undefined) return 1
      if (left === right) continue

      const leftNum = typeof left === 'number'
      const rightNum = typeof right === 'number'
      if (leftNum && rightNum) return left > right ? 1 : -1
      if (leftNum) return -1
      if (rightNum) return 1
      return String(left) > String(right) ? 1 : -1
    }

    return 0
  }

  try {
    return autoUpdater.currentVersion.compare(latest) < 0
  } catch {
    return compareParsedVersion(parseVersion(latest), parseVersion(current)) > 0
  }
}

const shouldOfferUpdateForTrack = (latestVersion: string, currentVersion: string): boolean => {
  if (isRemoteVersionNewer(latestVersion, currentVersion)) return true
  const effectiveTrack = getEffectiveUpdateTrack()
  const currentTrack = inferUpdateTrackFromVersion(currentVersion)
  // 切换通道后，目标通道最新版本与当前版本不同即提示更新（即使是降级）
  if (effectiveTrack !== currentTrack && latestVersion !== currentVersion) return true
  return false
}

let lastAppliedUpdaterChannel: string | null = null
let lastAppliedUpdaterFeedUrl: string | null = null
const resetUpdaterProviderCache = () => {
  const updater = autoUpdater as any
  // electron-updater 会缓存 provider；切换 channel 后需清理缓存，避免仍请求旧通道
  for (const key of ['clientPromise', '_clientPromise', 'updateInfoAndProvider']) {
    if (Object.prototype.hasOwnProperty.call(updater, key)) {
      updater[key] = null
    }
  }
}

const getUpdaterFeedUrlByTrack = (track: 'stable' | 'preview' | 'dev'): string => {
  const repoBase = 'https://github.com/hicccc77/WeFlow/releases'
  if (track === 'stable') return `${repoBase}/latest/download`
  if (track === 'preview') return `${repoBase}/download/nightly-preview`
  return `${repoBase}/download/nightly-dev`
}

const applyAutoUpdateChannel = (reason: 'startup' | 'settings' = 'startup') => {
  const track = getEffectiveUpdateTrack()
  const currentTrack = inferUpdateTrackFromVersion(appVersion)
  const baseUpdateChannel = track === 'stable' ? 'latest' : track
  const nextFeedUrl = getUpdaterFeedUrlByTrack(track)
  const nextUpdaterChannel =
    process.platform === 'win32' && process.arch === 'arm64'
      ? `${baseUpdateChannel}-arm64`
      : baseUpdateChannel
  if (
    (lastAppliedUpdaterChannel && lastAppliedUpdaterChannel !== nextUpdaterChannel) ||
    (lastAppliedUpdaterFeedUrl && lastAppliedUpdaterFeedUrl !== nextFeedUrl)
  ) {
    resetUpdaterProviderCache()
  }
  autoUpdater.allowPrerelease = track !== 'stable'
  // 只要用户当前选择的目标通道与当前安装版本所属通道不同，就允许跨通道更新（含降级）
  autoUpdater.allowDowngrade = track !== currentTrack
  // 统一走 generic feed，确保 preview/dev 命中各自固定发布页，不受 GitHub provider 的 prerelease 选择影响。
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: nextFeedUrl,
    channel: nextUpdaterChannel
  })
  autoUpdater.channel = nextUpdaterChannel
  lastAppliedUpdaterChannel = nextUpdaterChannel
  lastAppliedUpdaterFeedUrl = nextFeedUrl
}

applyAutoUpdateChannel('startup')
const AUTO_UPDATE_ENABLED =
  process.env.AUTO_UPDATE_ENABLED === 'true' ||
  process.env.AUTO_UPDATE_ENABLED === '1' ||
  (process.env.AUTO_UPDATE_ENABLED == null && !process.env.VITE_DEV_SERVER_URL)

const getLaunchAtStartupUnsupportedReason = (): string | null => {
  if (process.platform !== 'win32' && process.platform !== 'darwin') {
    return '当前平台暂不支持开机自启动'
  }
  if (!app.isPackaged) {
    return '仅安装后的 Windows / macOS 版本支持开机自启动'
  }
  return null
}

const isLaunchAtStartupSupported = (): boolean => getLaunchAtStartupUnsupportedReason() == null

const getStoredLaunchAtStartupPreference = (): boolean | undefined => {
  const value = configService?.get('launchAtStartup')
  return typeof value === 'boolean' ? value : undefined
}

const getSystemLaunchAtStartup = (): boolean => {
  if (!isLaunchAtStartupSupported()) return false
  try {
    return app.getLoginItemSettings().openAtLogin === true
  } catch (error) {
    console.error('[WeFlow] 读取开机自启动状态失败:', error)
    return false
  }
}

const buildLaunchAtStartupSettings = (enabled: boolean): Parameters<typeof app.setLoginItemSettings>[0] =>
  process.platform === 'win32'
    ? { openAtLogin: enabled, path: process.execPath }
    : { openAtLogin: enabled }

const setSystemLaunchAtStartup = (enabled: boolean): { success: boolean; enabled: boolean; error?: string } => {
  try {
    app.setLoginItemSettings(buildLaunchAtStartupSettings(enabled))
    const effectiveEnabled = app.getLoginItemSettings().openAtLogin === true
    if (effectiveEnabled !== enabled) {
      return {
        success: false,
        enabled: effectiveEnabled,
        error: '系统未接受该开机自启动设置'
      }
    }
    return { success: true, enabled: effectiveEnabled }
  } catch (error) {
    return {
      success: false,
      enabled: getSystemLaunchAtStartup(),
      error: `设置开机自启动失败: ${String((error as Error)?.message || error)}`
    }
  }
}

const getLaunchAtStartupStatus = (): { enabled: boolean; supported: boolean; reason?: string } => {
  const unsupportedReason = getLaunchAtStartupUnsupportedReason()
  if (unsupportedReason) {
    return {
      enabled: getStoredLaunchAtStartupPreference() === true,
      supported: false,
      reason: unsupportedReason
    }
  }
  return {
    enabled: getSystemLaunchAtStartup(),
    supported: true
  }
}

const applyLaunchAtStartupPreference = (
  enabled: boolean
): { success: boolean; enabled: boolean; supported: boolean; reason?: string; error?: string } => {
  const unsupportedReason = getLaunchAtStartupUnsupportedReason()
  if (unsupportedReason) {
    return {
      success: false,
      enabled: getStoredLaunchAtStartupPreference() === true,
      supported: false,
      reason: unsupportedReason
    }
  }

  const result = setSystemLaunchAtStartup(enabled)
  configService?.set('launchAtStartup', result.enabled)
  return {
    ...result,
    supported: true
  }
}

const syncLaunchAtStartupPreference = () => {
  if (!configService) return

  const unsupportedReason = getLaunchAtStartupUnsupportedReason()
  if (unsupportedReason) return

  const storedPreference = getStoredLaunchAtStartupPreference()
  const systemEnabled = getSystemLaunchAtStartup()

  if (typeof storedPreference !== 'boolean') {
    configService.set('launchAtStartup', systemEnabled)
    return
  }

  if (storedPreference === systemEnabled) return

  const result = setSystemLaunchAtStartup(storedPreference)
  configService.set('launchAtStartup', result.enabled)
  if (!result.success && result.error) {
    console.error('[WeFlow] 同步开机自启动设置失败:', result.error)
  }
}

// 使用白名单过滤 PATH，避免被第三方目录中的旧版 VC++ 运行库劫持。
// 仅保留系统目录（Windows/System32/SysWOW64）和应用自身目录（可执行目录、resources）。
function preservePathEnvWithLocalDllPriority() {
  // Do not remove existing PATH entries here. The WCDB protection layer may
  // depend on machine-specific Windows/security-provider directories even
  // though its direct DLL dependencies have already loaded successfully.
  if (process.env.VITE_DEV_SERVER_URL) return

  const rawPath = process.env.PATH || process.env.Path || ''
  const sep = process.platform === 'win32' ? ';' : ':'
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || ''
  const preferred = [
    dirname(process.execPath),
    process.resourcesPath,
    join(process.resourcesPath || '', 'resources'),
    systemRoot,
    systemRoot ? join(systemRoot, 'System32') : '',
    systemRoot ? join(systemRoot, 'SysWOW64') : ''
  ].filter(Boolean)

  const seen = new Set<string>()
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase()
  const merged = [...preferred, ...rawPath.split(sep).filter(Boolean)].filter((entry) => {
    const key = normalize(entry)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
  const nextPath = merged.join(sep)
  process.env.PATH = nextPath
  process.env.Path = nextPath
}

// Keep the original machine PATH intact and only raise local/system DLL paths
// to the front before the WCDB worker is created.
preservePathEnvWithLocalDllPriority()

// 启动时立即清理 PATH，后续创建的 worker 也能继承安全的环境

// 单例服务

// 协议窗口实例
let agreementWindow: BrowserWindow | null = null
let onboardingWindow: BrowserWindow | null = null
// Splash 启动窗口
let splashWindow: BrowserWindow | null = null
const sessionChatWindows = new Map<string, BrowserWindow>()
const sessionChatWindowSources = new Map<string, 'chat' | 'export'>()

let keyService: any
if (process.platform === 'darwin') {
  keyService = new KeyServiceMac()
} else if (process.platform === 'linux') {
  keyService = new KeyServiceLinux()
} else {
  keyService = new KeyService()
}

let mainWindowReady = false
let shouldShowMain = true
let isAppQuitting = false
let shutdownPromise: Promise<void> | null = null
let tray: Tray | null = null
let isClosePromptVisible = false

interface ChatHistoryPayloadEntry {
  sessionId: string
  title?: string
  recordList: any[]
  createdAt: number
  lastAccessedAt: number
}

const chatHistoryPayloadStore = new Map<string, ChatHistoryPayloadEntry>()
const chatHistoryPayloadTtlMs = 10 * 60 * 1000
const chatHistoryPayloadMaxEntries = 20

const pruneChatHistoryPayloadStore = (): void => {
  const now = Date.now()

  for (const [payloadId, payload] of chatHistoryPayloadStore.entries()) {
    if (now - payload.createdAt > chatHistoryPayloadTtlMs) {
      chatHistoryPayloadStore.delete(payloadId)
    }
  }

  while (chatHistoryPayloadStore.size > chatHistoryPayloadMaxEntries) {
    const oldestPayloadId = chatHistoryPayloadStore.keys().next().value as string | undefined
    if (!oldestPayloadId) break
    chatHistoryPayloadStore.delete(oldestPayloadId)
  }
}

type WindowCloseBehavior = 'ask' | 'tray' | 'quit'
type CloseRestoreMethod = 'tray' | 'dock'

// 更新下载状态管理（Issue #294 修复）
let isDownloadInProgress = false
let downloadProgressHandler: ((progress: any) => void) | null = null
let downloadedHandler: (() => void) | null = null

const normalizeReleaseNotes = (rawReleaseNotes: unknown): string => {
  const merged = (() => {
    if (typeof rawReleaseNotes === 'string') {
      return rawReleaseNotes
    }
    if (Array.isArray(rawReleaseNotes)) {
      return rawReleaseNotes
        .map((item) => {
          if (!item || typeof item !== 'object') return ''
          const note = (item as { note?: unknown }).note
          return typeof note === 'string' ? note : ''
        })
        .filter(Boolean)
        .join('\n\n')
    }
    return ''
  })()

  if (!merged.trim()) return ''

  const normalizeHeadingText = (raw: string): string => {
    return raw
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, '\'')
      .replace(/&#x27;/gi, '\'')
      .toLowerCase()
      .replace(/[：:]/g, '')
      .replace(/\s+/g, '')
      .trim()
  }

  const shouldStripReleaseSection = (headingRaw: string): boolean => {
    const heading = normalizeHeadingText(headingRaw)
    if (!heading) return false
    if (heading.startsWith('下载') || heading.startsWith('download')) return true

    if ((heading.includes('macos') || heading.startsWith('mac')) && heading.includes('安装提示')) return true
    return false
  }

  // 兼容 electron-updater 直接返回 HTML 的场景（含 dir/anchor 等标签嵌套）
  const removeDownloadSectionFromHtml = (input: string): string => {
    const headingPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi
    const headings: Array<{ start: number; end: number; headingText: string }> = []
    let match: RegExpExecArray | null

    while ((match = headingPattern.exec(input)) !== null) {
      const full = match[0]
      headings.push({
        start: match.index,
        end: match.index + full.length,
        headingText: match[2] || ''
      })
    }

    if (headings.length === 0) return input

    const rangesToRemove: Array<{ start: number; end: number }> = []
    for (let i = 0; i < headings.length; i += 1) {
      const current = headings[i]
      if (!shouldStripReleaseSection(current.headingText)) continue

      const nextStart = i + 1 < headings.length ? headings[i + 1].start : input.length
      rangesToRemove.push({ start: current.start, end: nextStart })
    }

    if (rangesToRemove.length === 0) return input

    let output = ''
    let cursor = 0
    for (const range of rangesToRemove) {
      output += input.slice(cursor, range.start)
      cursor = range.end
    }
    output += input.slice(cursor)
    return output
  }

  // 兼容 Markdown 场景（Action 最终 release note 模板）
  const removeDownloadSectionFromMarkdown = (input: string): string => {
    const lines = input.split(/\r?\n/)
    const output: string[] = []
    let skipSection = false

    for (const line of lines) {
      const headingMatch = line.match(/^\s*#{1,6}\s*(.+?)\s*$/)
      if (headingMatch) {
        if (shouldStripReleaseSection(headingMatch[1])) {
          skipSection = true
          continue
        }
        if (skipSection) {
          skipSection = false
        }
      }
      if (!skipSection) {
        output.push(line)
      }
    }

    return output.join('\n')
  }

  const cleaned = removeDownloadSectionFromMarkdown(removeDownloadSectionFromHtml(merged))
    // 兜底：即使没有匹配到标题，也不在弹窗展示 macOS 隔离标记清理命令
    .replace(/^[ \t>*-]*`?\s*xattr\s+-[a-z]*d[a-z]*\s+com\.apple\.quarantine[^\n]*`?\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return cleaned
}

const getDialogReleaseNotes = (rawReleaseNotes: unknown): string => {
  const track = getEffectiveUpdateTrack()
  if (track !== 'stable') {
    return '修复了一些已知问题'
  }
  return normalizeReleaseNotes(rawReleaseNotes)
}

interface OpenSessionChatWindowOptions {
  source?: 'chat' | 'export'
  initialDisplayName?: string
  initialAvatarUrl?: string
  initialContactType?: 'friend' | 'group' | 'official' | 'former_friend' | 'blocked' | 'other'
}

const normalizeSessionChatWindowSource = (source: unknown): 'chat' | 'export' => {
  return String(source || '').trim().toLowerCase() === 'export' ? 'export' : 'chat'
}

const normalizeSessionChatWindowOptionString = (value: unknown): string => {
  return String(value || '').trim()
}

const loadSessionChatWindowContent = (
  win: BrowserWindow,
  sessionId: string,
  source: 'chat' | 'export',
  options?: OpenSessionChatWindowOptions
) => {
  const queryParams = new URLSearchParams({
    sessionId,
    source
  })
  const initialDisplayName = normalizeSessionChatWindowOptionString(options?.initialDisplayName)
  const initialAvatarUrl = normalizeSessionChatWindowOptionString(options?.initialAvatarUrl)
  const initialContactType = normalizeSessionChatWindowOptionString(options?.initialContactType)
  if (initialDisplayName) queryParams.set('initialDisplayName', initialDisplayName)
  if (initialAvatarUrl) queryParams.set('initialAvatarUrl', initialAvatarUrl)
  if (initialContactType) queryParams.set('initialContactType', initialContactType)
  const query = queryParams.toString()
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/chat-window?${query}`)
    return
  }
  win.loadFile(join(__dirname, '../dist/index.html'), {
    hash: `/chat-window?${query}`
  })
}

const setupCustomTitleBarWindow = (win: BrowserWindow): void => {
  if (process.platform === 'darwin') {
    win.setWindowButtonVisibility(false)
  }

  const emitMaximizeState = () => {
    if (win.isDestroyed()) return
    win.webContents.send('window:maximizeStateChanged', win.isMaximized() || win.isFullScreen())
  }

  win.on('maximize', emitMaximizeState)
  win.on('unmaximize', emitMaximizeState)
  win.on('enter-full-screen', emitMaximizeState)
  win.on('leave-full-screen', emitMaximizeState)
  win.webContents.on('did-finish-load', emitMaximizeState)
}

let notificationNavigateHandlerRegistered = false
const focusMainWindowAndNavigate = (sessionId: string): void => {
  const targetWindow = mainWindow
  if (!targetWindow || targetWindow.isDestroyed()) return
  if (targetWindow.isMinimized()) targetWindow.restore()
  targetWindow.show()
  targetWindow.focus()
  targetWindow.webContents.send('navigate-to-session', sessionId)
}

const focusMainWindowAndNavigateRoute = (route: string): void => {
  const targetWindow = mainWindow
  if (!targetWindow || targetWindow.isDestroyed()) return
  if (targetWindow.isMinimized()) targetWindow.restore()
  targetWindow.show()
  targetWindow.focus()
  targetWindow.webContents.send('navigate-to-route', route)
}

const handleNotificationClickNavigation = (payload: unknown): void => {
  if (payload && typeof payload === 'object') {
    const data = payload as { sessionId?: string; targetRoute?: string }
    const targetRoute = String(data.targetRoute || '').trim()
    if (targetRoute.startsWith('/')) {
      focusMainWindowAndNavigateRoute(targetRoute)
      return
    }
    focusMainWindowAndNavigate(String(data.sessionId || ''))
    return
  }
  focusMainWindowAndNavigate(String(payload || ''))
}

const ensureNotificationNavigateHandlerRegistered = (): void => {
  if (notificationNavigateHandlerRegistered) return
  notificationNavigateHandlerRegistered = true
  ipcMain.on('notification-clicked', (_event, payload) => {
    handleNotificationClickNavigation(payload)
  })
  setNotificationNavigateHandler((payload: unknown) => {
    handleNotificationClickNavigation(payload)
  })
}

let wechatRequestHeaderInterceptorRegistered = false
const ensureWeChatRequestHeaderInterceptor = (): void => {
  if (wechatRequestHeaderInterceptorRegistered) return
  wechatRequestHeaderInterceptorRegistered = true

  session.defaultSession.webRequest.onBeforeSendHeaders(
    {
      urls: [
        '*://*.qpic.cn/*',
        '*://*.qlogo.cn/*',
        '*://*.wechat.com/*',
        '*://*.weixin.qq.com/*',
        '*://*.wx.qq.com/*'
      ]
    },
    (details, callback) => {
      details.requestHeaders['User-Agent'] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/107.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) WindowsWechat(0x63090719) XWEB/8351"
      details.requestHeaders['Accept'] = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      details.requestHeaders['Accept-Encoding'] = "gzip, deflate, br"
      details.requestHeaders['Accept-Language'] = "zh-CN,zh;q=0.9"
      details.requestHeaders['Connection'] = "keep-alive"
      details.requestHeaders['Range'] = "bytes=0-"

      let host = ''
      try {
        host = new URL(details.url).hostname.toLowerCase()
      } catch {}
      const isWxQQ = host === 'wx.qq.com' || host.endsWith('.wx.qq.com')
      details.requestHeaders['Referer'] = isWxQQ ? 'https://wx.qq.com/' : 'https://servicewechat.com/'

      callback({ cancel: false, requestHeaders: details.requestHeaders })
    }
  )
}

const getWindowCloseBehavior = (): WindowCloseBehavior => {
  const behavior = configService?.get('windowCloseBehavior')
  return behavior === 'quit' ? 'quit' : 'tray'
}

const requestApplicationQuit = async (): Promise<void> => {
  if (isAppQuitting) return
  isAppQuitting = true
  await shutdownAppServices()

  // electron:dev 由 Vite 启动 Electron 子进程。终止其父进程，才能让 start.bat
  // 中的 npm run electron:dev 返回并关闭批处理窗口。
  if (process.env.VITE_DEV_SERVER_URL && process.ppid > 1) {
    try {
      process.kill(process.ppid, 'SIGTERM')
    } catch (error) {
      console.warn('[App] Failed to stop Vite parent process:', error)
    }
  }

  app.exit(0)
}

const isSilentStartupEnabled = (): boolean => {
  return configService?.get('silentStartup') === true
}

const getCloseRestoreMethod = (): CloseRestoreMethod | null => {
  if (tray) return 'tray'
  if (process.platform === 'darwin') return 'dock'
  return null
}

const canKeepMainWindowInBackground = (): boolean => {
  return getCloseRestoreMethod() !== null
}



const requestMainWindowCloseConfirmation = (win: BrowserWindow): void => {
  if (isClosePromptVisible) return
  isClosePromptVisible = true
  const restoreMethod = getCloseRestoreMethod()
  win.webContents.send('window:confirmCloseRequested', {
    canMinimizeToTray: restoreMethod !== null,
    restoreMethod: restoreMethod ?? undefined
  })
}

function createWindow(options: { autoShow?: boolean } = {}) {
  // 获取图标路径 - 打包后在 resources 目录
  const { autoShow = true } = options
  const iconPath = resolveAppIconPath()

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false // Allow loading local files (video playback)
    },
    frame: false,
    show: false
  })
  setupCustomTitleBarWindow(win)

  // 窗口准备好后显示
  // Splash 模式下不在这里 show，由启动流程统一控制
  win.once('ready-to-show', () => {
    mainWindowReady = true
    if (autoShow && !splashWindow) {
      win.show()
    }
  })

  // 开发环境加载 vite 服务器
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL)

    // 开发环境下按 F12 或 Ctrl+Shift+I 打开开发者工具
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'))
  }

  // 忽略微信 CDN 域名的证书错误（部分节点证书配置不正确）
  win.webContents.on('certificate-error', (event, url, _error, _cert, callback) => {
    const trusted = ['.qq.com', '.qpic.cn', '.weixin.qq.com', '.wechat.com']
    try {
      const host = new URL(url).hostname
      if (trusted.some(d => host.endsWith(d))) {
        event.preventDefault()
        callback(true)
        return
      }
    } catch {}
    callback(false)
  })

  win.on('close', (e) => {
    if (isAppQuitting || win !== mainWindow) return
    e.preventDefault()
    const closeBehavior = getWindowCloseBehavior()

    if (closeBehavior === 'quit') {
      void requestApplicationQuit()
      return
    }

    if (closeBehavior === 'tray' && canKeepMainWindowInBackground()) {
      win.hide()
      return
    }

    requestMainWindowCloseConfirmation(win)
  })

  win.on('closed', () => {
    if (mainWindow !== win) return

    mainWindow = null
    mainWindowReady = false
    isClosePromptVisible = false

    if (process.platform !== 'darwin' && !isAppQuitting) {
      destroyNotificationWindow()
      if (BrowserWindow.getAllWindows().length === 0) {
        app.quit()
      }
    }
  })

  return win
}

/**
 * 创建用户协议窗口
 */
function createAgreementWindow() {
  // 如果已存在，聚焦
  if (agreementWindow && !agreementWindow.isDestroyed()) {
    agreementWindow.focus()
    return agreementWindow
  }

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = resolveAppIconPath()

  const isDark = nativeTheme.shouldUseDarkColors

  agreementWindow = new BrowserWindow({
    width: 700,
    height: 600,
    minWidth: 500,
    minHeight: 400,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: isDark ? '#FFFFFF' : '#333333',
      height: 32
    },
    show: false,
    backgroundColor: isDark ? '#1A1A1A' : '#FFFFFF'
  })

  agreementWindow.once('ready-to-show', () => {
    agreementWindow?.show()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    agreementWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/agreement-window`)
  } else {
    agreementWindow.loadFile(join(__dirname, '../dist/index.html'), { hash: '/agreement-window' })
  }

  agreementWindow.on('closed', () => {
    agreementWindow = null
  })

  return agreementWindow
}

/**
 * 创建 Splash 启动窗口
 * 使用纯 HTML 页面，不依赖 React，确保极速显示
 */
function createSplashWindow(): BrowserWindow {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const splashThemeId = configService?.get('themeId') || 'cloud-dancer'
  const splashThemeMode = configService?.get('theme') || 'system'
  const iconPath = resolveAppIconPath()

  splashWindow = new BrowserWindow({
    width: 800,
    height: 500,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    center: true,
    skipTaskbar: false,
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
      // 不需要 preload —— 通过 executeJavaScript 单向推送进度
    },
    show: false
  })

  if (isDev) {
    const splashUrl = new URL('splash.html', process.env.VITE_DEV_SERVER_URL)
    splashUrl.searchParams.set('themeId', splashThemeId)
    splashUrl.searchParams.set('themeMode', splashThemeMode)
    splashUrl.searchParams.set('version', appVersion)
    splashWindow.loadURL(splashUrl.toString())
  } else {
    splashWindow.loadFile(join(__dirname, '../dist/splash.html'), {
      query: {
        themeId: splashThemeId,
        themeMode: splashThemeMode,
        version: appVersion
      }
    })
  }

  splashWindow.once('ready-to-show', () => {
    splashWindow?.show()
  })

  splashWindow.on('closed', () => {
    splashWindow = null
  })

  return splashWindow
}

/**
 * 向 Splash 窗口发送进度更新
 */
function updateSplashProgress(percent: number, text: string, indeterminate = false) {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.webContents
      .executeJavaScript(`updateProgress(${percent}, ${JSON.stringify(text)}, ${indeterminate})`)
      .catch(() => {})
  }
}

/**
 * 关闭 Splash 窗口
 */
function closeSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close()
    splashWindow = null
  }
}

/**
 * 创建首次引导窗口
 */
function createOnboardingWindow(mode: 'default' | 'add-account' = 'default') {
  const onboardingHash = mode === 'add-account'
    ? '/onboarding-window?mode=add-account'
    : '/onboarding-window'

  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    if (process.env.VITE_DEV_SERVER_URL) {
      onboardingWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${onboardingHash}`)
    } else {
      onboardingWindow.loadFile(join(__dirname, '../dist/index.html'), { hash: onboardingHash })
    }
    onboardingWindow.focus()
    return onboardingWindow
  }

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = resolveAppIconPath()

  onboardingWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 900,
    minHeight: 620,
    resizable: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  })

  onboardingWindow.once('ready-to-show', () => {
    onboardingWindow?.show()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    onboardingWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${onboardingHash}`)
  } else {
    onboardingWindow.loadFile(join(__dirname, '../dist/index.html'), { hash: onboardingHash })
  }

  onboardingWindow.on('closed', () => {
    onboardingWindow = null
  })

  return onboardingWindow
}

/**
 * 创建独立的视频播放窗口
 * 窗口大小会根据视频比例自动调整
 */
function createVideoPlayerWindow(videoPath: string, videoWidth?: number, videoHeight?: number) {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = resolveAppIconPath()

  // 获取屏幕尺寸
  const { screen } = require('electron')
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

  // 计算窗口尺寸，只有标题栏 40px，控制栏悬浮
  let winWidth = 854
  let winHeight = 520
  const titleBarHeight = 40

  if (videoWidth && videoHeight && videoWidth > 0 && videoHeight > 0) {
    const aspectRatio = videoWidth / videoHeight

    const maxWidth = Math.floor(screenWidth * 0.85)
    const maxHeight = Math.floor(screenHeight * 0.85)

    if (aspectRatio >= 1) {
      // 横向视频
      winWidth = Math.min(videoWidth, maxWidth)
      winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight

      if (winHeight > maxHeight) {
        winHeight = maxHeight
        winWidth = Math.floor((winHeight - titleBarHeight) * aspectRatio)
      }
    } else {
      // 竖向视频
      const videoDisplayHeight = Math.min(videoHeight, maxHeight - titleBarHeight)
      winHeight = videoDisplayHeight + titleBarHeight
      winWidth = Math.floor(videoDisplayHeight * aspectRatio)

      if (winWidth < 300) {
        winWidth = 300
        winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight
      }
    }

    winWidth = Math.max(winWidth, 360)
    winHeight = Math.max(winHeight, 280)
  }

  const win = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: 360,
    minHeight: 280,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1a1a1a',
      symbolColor: '#ffffff',
      height: 40
    },
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true
  })

  win.once('ready-to-show', () => {
    win.show()
  })

  const videoParam = `videoPath=${encodeURIComponent(videoPath)}`
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/video-player-window?${videoParam}`)

    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'), {
      hash: `/video-player-window?${videoParam}`
    })
  }
}

/**
 * 创建独立的图片查看窗口
 */
function createImageViewerWindow(imagePath: string, liveVideoPath?: string) {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = resolveAppIconPath()

  const win = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 400,
    minHeight: 300,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false // 允许加载本地文件
    },
    frame: false,
    show: false,
    backgroundColor: '#000000',
    autoHideMenuBar: true
  })

  setupCustomTitleBarWindow(win)

  win.once('ready-to-show', () => {
    win.show()
  })

  let imageParam = `imagePath=${encodeURIComponent(imagePath)}`
  if (liveVideoPath) imageParam += `&liveVideoPath=${encodeURIComponent(liveVideoPath)}`

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/image-viewer-window?${imageParam}`)

    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'), {
      hash: `/image-viewer-window?${imageParam}`
    })
  }

  return win
}

/**
 * 创建独立的聊天记录窗口
 */
function createChatHistoryWindow(sessionId: string, messageId: number) {
  return createChatHistoryRouteWindow(`/chat-history/${sessionId}/${messageId}`)
}

function createChatHistoryPayloadWindow(payloadId: string) {
  const win = createChatHistoryRouteWindow(`/chat-history-inline/${payloadId}`)
  win.on('closed', () => {
    chatHistoryPayloadStore.delete(payloadId)
  })
  return win
}

function createChatHistoryRouteWindow(route: string) {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = resolveAppIconPath()

  const win = new BrowserWindow({
    width: 600,
    height: 800,
    minWidth: 400,
    minHeight: 500,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    frame: false,
    show: false,
    backgroundColor: '#FFFFFF',
    autoHideMenuBar: true
  })
  setupCustomTitleBarWindow(win)

  let hasShown = false
  let isReadyToShow = false
  let hasLoadedRoute = false
  const showChatHistoryWindow = () => {
    if (hasShown || !isReadyToShow || !hasLoadedRoute || win.isDestroyed()) return
    hasShown = true
    win.show()
  }

  win.webContents.once('did-finish-load', () => {
    hasLoadedRoute = true
    setTimeout(showChatHistoryWindow, 30)
  })
  win.webContents.once('did-fail-load', () => {
    hasLoadedRoute = true
    showChatHistoryWindow()
  })
  win.once('ready-to-show', () => {
    isReadyToShow = true
    showChatHistoryWindow()
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${route}`)

    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  } else {
    win.loadFile(join(__dirname, '../dist/index.html'), {
      hash: route
    })
  }

  return win
}

/**
 * 创建独立的会话聊天窗口（单会话，复用聊天页右侧消息区域）
 */
function createSessionChatWindow(sessionId: string, options?: OpenSessionChatWindowOptions) {
  const normalizedSessionId = String(sessionId || '').trim()
  if (!normalizedSessionId) return null
  const normalizedSource = normalizeSessionChatWindowSource(options?.source)

  const existing = sessionChatWindows.get(normalizedSessionId)
  if (existing && !existing.isDestroyed()) {
    const trackedSource = sessionChatWindowSources.get(normalizedSessionId) || 'chat'
    if (trackedSource !== normalizedSource) {
      loadSessionChatWindowContent(existing, normalizedSessionId, normalizedSource, options)
      sessionChatWindowSources.set(normalizedSessionId, normalizedSource)
    }
    if (existing.isMinimized()) {
      existing.restore()
    }
    existing.focus()
    return existing
  }

  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const iconPath = resolveAppIconPath()

  const isDark = nativeTheme.shouldUseDarkColors

  const win = new BrowserWindow({
    width: 600,
    height: 820,
    minWidth: 420,
    minHeight: 560,
    icon: iconPath,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: isDark ? '#ffffff' : '#1a1a1a',
      height: 40
    },
    show: false,
    backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0',
    autoHideMenuBar: true
  })

  loadSessionChatWindowContent(win, normalizedSessionId, normalizedSource, options)

  if (process.env.VITE_DEV_SERVER_URL) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools()
        } else {
          win.webContents.openDevTools()
        }
        event.preventDefault()
      }
    })
  }

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  win.on('closed', () => {
    const tracked = sessionChatWindows.get(normalizedSessionId)
    if (tracked === win) {
      sessionChatWindows.delete(normalizedSessionId)
      sessionChatWindowSources.delete(normalizedSessionId)
    }
  })

  sessionChatWindows.set(normalizedSessionId, win)
  sessionChatWindowSources.set(normalizedSessionId, normalizedSource)
  return win
}

function showMainWindow() {
  shouldShowMain = true
  if (mainWindowReady) {
    mainWindow?.show()
  }
}

const normalizeAccountId = (value: string): string => {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''
  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[^_]+)/i)
    return match?.[1] || trimmed
  }
  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return suffixMatch ? suffixMatch[1] : trimmed
}

const buildAccountNameMatcher = (wxidCandidates: string[]) => {
  const loweredCandidates = wxidCandidates
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean)
  return (name: string): boolean => {
    const loweredName = String(name || '').trim().toLowerCase()
    if (!loweredName) return false
    return loweredCandidates.some((candidate) => (
      loweredName === candidate ||
      loweredName.startsWith(`${candidate}_`) ||
      loweredName.includes(candidate)
    ))
  }
}

const removePathIfExists = async (
  targetPath: string,
  removedPaths: string[],
  warnings: string[]
): Promise<void> => {
  if (!targetPath || !existsSync(targetPath)) return
  try {
    await rm(targetPath, { recursive: true, force: true })
    removedPaths.push(targetPath)
  } catch (error) {
    warnings.push(`${targetPath}: ${String(error)}`)
  }
}

const removeMatchedEntriesInDir = async (
  rootDir: string,
  shouldRemove: (name: string) => boolean,
  removedPaths: string[],
  warnings: string[]
): Promise<void> => {
  if (!rootDir || !existsSync(rootDir)) return
  try {
    const entries = await readdir(rootDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!shouldRemove(entry.name)) continue
      const targetPath = join(rootDir, entry.name)
      await removePathIfExists(targetPath, removedPaths, warnings)
    }
  } catch (error) {
    warnings.push(`${rootDir}: ${String(error)}`)
  }
}

const normalizeFsPathForCompare = (value: string): string => {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

// 注册 IPC 处理器

function registerIpcHandlers() {
  registerNotificationHandlers()
  ensureNotificationNavigateHandlerRegistered()
  // 配置相关
  ipcMain.handle('config:get', async (_, key: string) => {
    return configService?.get(key as any)
  })

  ipcMain.handle('config:set', async (_, key: string, value: any) => {
    let result: unknown
    if (key === 'launchAtStartup') {
      result = applyLaunchAtStartupPreference(value === true)
    } else {
      result = configService?.set(key as any, value)
    }
    if (key === 'updateChannel') {
      applyAutoUpdateChannel('settings')
    }
    if (key === 'messagePushEnabled' && value === true && !httpService.isRunning()) {
      const port = Number(configService?.get('httpApiPort')) || 5031
      const host = String(configService?.get('httpApiHost') || '127.0.0.1').trim() || '127.0.0.1'
      const startResult = await httpService.start(port, host)
      if (!startResult.success) {
        console.error('[HttpService] Message push auto-start failed:', startResult.error)
      }
    }
    void messagePushService.handleConfigChanged(key)
    return result
  })

  // AI 见解
  ipcMain.handle('config:clear', async () => {
    const errors: string[] = []

    try {
      await bridgeManager.stop()
    } catch (error) {
      errors.push(`停止 Bridge 失败：${String(error)}`)
    }

    try {
      await httpService.stop()
    } catch (error) {
      errors.push(`停止 HTTP 服务失败：${String(error)}`)
    }

    try {
      chatService.close()
    } catch (error) {
      errors.push(`断开数据库失败：${String(error)}`)
    }

    if (isLaunchAtStartupSupported() && getSystemLaunchAtStartup()) {
      const result = setSystemLaunchAtStartup(false)
      if (!result.success && result.error) {
        errors.push(`关闭开机自启失败：${result.error}`)
      }
    }

    try {
      configService?.clear()
    } catch (error) {
      errors.push(`清空配置失败：${String(error)}`)
    }

    // Bridge keeps its settings in a separate JSON file, outside Electron Store.
    try {
      const bridgeDir = bridgeManager.getBridgeDir()
      const bridgeConfigPath = join(bridgeDir, 'config.json')
      await mkdir(bridgeDir, { recursive: true })
      await writeFile(
        bridgeConfigPath,
        JSON.stringify(bridgeDefaultConfig, null, 4),
        'utf8'
      )
    } catch (error) {
      errors.push(`Bridge configuration reset failed: ${String(error)}`)
    }

    messagePushService.handleConfigCleared()

    try {
      const logPath = join(app.getPath('userData'), 'logs', 'wcdb.log')
      await mkdir(dirname(logPath), { recursive: true })
      await writeFile(logPath, '', 'utf8')
    } catch (error) {
      errors.push(`清空日志失败：${String(error)}`)
    }

    return { success: errors.length === 0, errors }
  })

  // 文件对话框
  ipcMain.handle('dialog:openFile', async (_, options) => {
    const { dialog } = await import('electron')
    return dialog.showOpenDialog(options)
  })

  ipcMain.handle('dialog:openDirectory', async (_, options) => {
    const { dialog } = await import('electron')
    return dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      ...options
    })
  })

  ipcMain.handle('dialog:saveFile', async (_, options) => {
    const { dialog } = await import('electron')
    return dialog.showSaveDialog(options)
  })

  ipcMain.handle('shell:openPath', async (_, path: string) => {
    const { shell } = await import('electron')
    return shell.openPath(path)
  })

  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    const { shell } = await import('electron')
    const safeUrl = normalizeAllowedExternalUrl(url)
    if (!safeUrl) {
      return { success: false, error: '不允许打开该外部链接协议' }
    }
    await shell.openExternal(safeUrl)
    return { success: true }
  })

  ipcMain.handle('app:getDownloadsPath', async () => {
    return app.getPath('downloads')
  })

  ipcMain.handle('app:getVersion', async () => {
    return appVersion
  })

  ipcMain.handle('app:getRuntimeSeconds', async () => {
    return Math.max(0, Math.floor(process.uptime()))
  })

  ipcMain.handle('app:getLaunchAtStartupStatus', async () => {
    return getLaunchAtStartupStatus()
  })

  ipcMain.handle('app:setLaunchAtStartup', async (_, enabled: boolean) => {
    return applyLaunchAtStartupPreference(enabled === true)
  })

  ipcMain.handle('log:getPath', async () => {
    return join(app.getPath('userData'), 'logs', 'wcdb.log')
  })

  ipcMain.handle('log:read', async () => {
    try {
      const logPath = join(app.getPath('userData'), 'logs', 'wcdb.log')
      const content = await readFile(logPath, 'utf8')
      return { success: true, content }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('log:clear', async () => {
    try {
      const logPath = join(app.getPath('userData'), 'logs', 'wcdb.log')
      await mkdir(dirname(logPath), { recursive: true })
      await writeFile(logPath, '', 'utf8')
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('diagnostics:recordResourceStats', async (_, payload?: unknown) => {
    resourceDiagnosticsEntries.push({
      ts: Date.now(),
      payload: sanitizeResourceDiagnosticsPayload(payload)
    })
    while (resourceDiagnosticsEntries.length > maxResourceDiagnosticsEntries) {
      resourceDiagnosticsEntries.shift()
    }
    return { success: true, count: resourceDiagnosticsEntries.length }
  })

  ipcMain.handle('diagnostics:getResourceStats', async (_, options?: { limit?: number }) => {
    const limit = Math.max(1, Math.min(500, Number(options?.limit || maxResourceDiagnosticsEntries)))
    const entries = resourceDiagnosticsEntries.slice(-limit)
    return {
      entries,
      summary: {
        count: resourceDiagnosticsEntries.length,
        firstTs: resourceDiagnosticsEntries[0]?.ts || 0,
        lastTs: resourceDiagnosticsEntries[resourceDiagnosticsEntries.length - 1]?.ts || 0,
        ...summarizeResourceDiagnostics(entries, resourceDiagnosticsPreloadTotalsBaseline)
      }
    }
  })

  ipcMain.handle('diagnostics:clearResourceStats', async () => {
    resourceDiagnosticsEntries.length = 0
    try {
      const stats = imagePreloadService.getStats()
      const totals = stats?.totals || {}
      resourceDiagnosticsPreloadTotalsBaseline = Object.fromEntries(
        Object.entries(totals)
          .map(([key, value]) => [key, Number(value)])
          .filter(([, value]) => Number.isFinite(value))
      )
    } catch {
      resourceDiagnosticsPreloadTotalsBaseline = null
    }
    return { success: true }
  })

  ipcMain.handle('app:checkForUpdates', async () => {
    if (!AUTO_UPDATE_ENABLED) {
      return { hasUpdate: false }
    }
    // 每次主动检查前重新应用一次通道配置，确保使用最新选择的更新通道。
    applyAutoUpdateChannel('settings')
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result && result.updateInfo) {
        const currentVersion = appVersion
        const latestVersion = result.updateInfo.version
        if (shouldOfferUpdateForTrack(latestVersion, currentVersion)) {
          return {
            hasUpdate: true,
            version: latestVersion,
            releaseNotes: getDialogReleaseNotes(result.updateInfo.releaseNotes),
            minimumVersion: (result.updateInfo as any).minimumVersion
          }
        }
      }
      return { hasUpdate: false }
    } catch (error) {
      console.error('检查更新失败:', error)
      return { hasUpdate: false }
    }
  })

  ipcMain.handle('app:downloadAndInstall', async (event) => {
    if (!AUTO_UPDATE_ENABLED) {
      throw new Error('自动更新已暂时禁用')
    }

    // 防止重复下载（Issue #294 修复）
    if (isDownloadInProgress) {
      throw new Error('更新正在下载中，请稍候')
    }

    isDownloadInProgress = true
    const win = BrowserWindow.fromWebContents(event.sender)

    // 清理旧的监听器（Issue #294 修复：防止监听器泄漏）
    if (downloadProgressHandler) {
      autoUpdater.removeListener('download-progress', downloadProgressHandler)
      downloadProgressHandler = null
    }
    if (downloadedHandler) {
      autoUpdater.removeListener('update-downloaded', downloadedHandler)
      downloadedHandler = null
    }

    // 创建新的监听器并保存引用
    downloadProgressHandler = (progress) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('app:downloadProgress', progress)
      }
    }

    downloadedHandler = () => {
      console.log('[Update] 更新下载完成，准备安装')
      if (downloadProgressHandler) {
        autoUpdater.removeListener('download-progress', downloadProgressHandler)
        downloadProgressHandler = null
      }
      downloadedHandler = null
      isDownloadInProgress = false
      autoUpdater.quitAndInstall(false, true)
    }

    autoUpdater.on('download-progress', downloadProgressHandler)
    autoUpdater.once('update-downloaded', downloadedHandler)

    try {
      console.log('[Update] 开始下载更新...')
      await autoUpdater.downloadUpdate()
    } catch (error: any) {
      console.error('[Update] 下载更新失败:', error)
      // 失败时清理状态和监听器
      isDownloadInProgress = false
      if (downloadProgressHandler) {
        autoUpdater.removeListener('download-progress', downloadProgressHandler)
        downloadProgressHandler = null
      }
      if (downloadedHandler) {
        autoUpdater.removeListener('update-downloaded', downloadedHandler)
        downloadedHandler = null
      }
      
      const errorCode = typeof error?.code === 'string' ? error.code : ''
      const rawErrorMessage =
        typeof error?.message === 'string'
          ? error.message
          : (typeof error === 'string' ? error : JSON.stringify(error))

      if (errorCode === 'ERR_UPDATER_ZIP_FILE_NOT_FOUND' || /ZIP file not provided/i.test(rawErrorMessage)) {
        throw new Error('当前发布版本缺少 macOS 自动更新所需的 ZIP 包，请联系开发者重新发布该版本')
      }

      throw new Error(rawErrorMessage || '下载更新失败，请稍后重试')
    }
  })

  ipcMain.handle('app:ignoreUpdate', async (_, version: string) => {
    configService?.set('ignoredUpdateVersion', version)
    return { success: true }
  })

  // 窗口控制
  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })

  ipcMain.handle('window:isMaximized', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return Boolean(win?.isMaximized() || win?.isFullScreen())
  })

  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle('window:respondCloseConfirm', async (_event, action: 'tray' | 'quit' | 'cancel') => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      isClosePromptVisible = false
      return false
    }

    try {
      if (action === 'tray') {
        if (canKeepMainWindowInBackground()) {
          mainWindow.hide()
          return true
        }
        return false
      }

      if (action === 'quit') {
        void requestApplicationQuit()
        return true
      }

      return true
    } finally {
      isClosePromptVisible = false
    }
  })

  // 更新窗口控件主题色
  ipcMain.on('window:setTitleBarOverlay', (event, options: { symbolColor: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      try {
        win.setTitleBarOverlay({
          color: '#00000000',
          symbolColor: options.symbolColor,
          height: 40
        })
      } catch (error) {
        console.warn('TitleBarOverlay not enabled for this window:', error)
      }
    }
  })

  // 打开视频播放窗口
  ipcMain.handle('window:openVideoPlayerWindow', (_, videoPath: string, videoWidth?: number, videoHeight?: number) => {
    createVideoPlayerWindow(videoPath, videoWidth, videoHeight)
  })

  // 打开聊天记录窗口
  ipcMain.handle('window:openChatHistoryWindow', (_, sessionId: string, messageId: number) => {
    createChatHistoryWindow(sessionId, messageId)
    return true
  })

  ipcMain.handle('window:openChatHistoryPayloadWindow', (_, payload: { sessionId: string; title?: string; recordList: any[] }) => {
    const payloadId = randomUUID()
    pruneChatHistoryPayloadStore()
    const now = Date.now()
    chatHistoryPayloadStore.set(payloadId, {
      sessionId: String(payload?.sessionId || '').trim(),
      title: String(payload?.title || '').trim() || '聊天记录',
      recordList: Array.isArray(payload?.recordList) ? payload.recordList : [],
      createdAt: now,
      lastAccessedAt: now
    })
    pruneChatHistoryPayloadStore()
    createChatHistoryPayloadWindow(payloadId)
    return true
  })

  ipcMain.handle('window:getChatHistoryPayload', (_, payloadId: string) => {
    pruneChatHistoryPayloadStore()
    const normalizedPayloadId = String(payloadId || '').trim()
    const payload = chatHistoryPayloadStore.get(normalizedPayloadId)
    if (!payload) return { success: false, error: '聊天记录载荷不存在或已失效' }
    const nextPayload: ChatHistoryPayloadEntry = {
      ...payload,
      lastAccessedAt: Date.now()
    }
    chatHistoryPayloadStore.set(normalizedPayloadId, nextPayload)
    return {
      success: true,
      payload: {
        sessionId: nextPayload.sessionId,
        title: nextPayload.title,
        recordList: nextPayload.recordList
      }
    }
  })

  // 打开会话聊天窗口（同会话仅保留一个窗口并聚焦）
  ipcMain.handle('window:openSessionChatWindow', (_, sessionId: string, options?: OpenSessionChatWindowOptions) => {
    const win = createSessionChatWindow(sessionId, options)
    return Boolean(win)
  })

  // 根据视频尺寸调整窗口大小
  ipcMain.handle('window:resizeToFitVideo', (event, videoWidth: number, videoHeight: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !videoWidth || !videoHeight) return

    const { screen } = require('electron')
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

    // 只有标题栏 40px，控制栏悬浮在视频上
    const titleBarHeight = 40
    const aspectRatio = videoWidth / videoHeight

    const maxWidth = Math.floor(screenWidth * 0.85)
    const maxHeight = Math.floor(screenHeight * 0.85)

    let winWidth: number
    let winHeight: number

    if (aspectRatio >= 1) {
      // 横向视频 - 以宽度为基准
      winWidth = Math.min(videoWidth, maxWidth)
      winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight

      if (winHeight > maxHeight) {
        winHeight = maxHeight
        winWidth = Math.floor((winHeight - titleBarHeight) * aspectRatio)
      }
    } else {
      // 竖向视频 - 以高度为基准
      const videoDisplayHeight = Math.min(videoHeight, maxHeight - titleBarHeight)
      winHeight = videoDisplayHeight + titleBarHeight
      winWidth = Math.floor(videoDisplayHeight * aspectRatio)

      // 确保宽度不会太窄
      if (winWidth < 300) {
        winWidth = 300
        winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight
      }
    }

    winWidth = Math.max(winWidth, 360)
    winHeight = Math.max(winHeight, 280)

    // 调整窗口大小并居中
    win.setSize(winWidth, winHeight)
    win.center()
  })

  // 视频相关
  ipcMain.handle('video:getVideoInfo', async (_, videoMd5: string, options?: { includePoster?: boolean; posterFormat?: 'dataUrl' | 'fileUrl' }) => {
    try {
      const result = await videoService.getVideoInfo(videoMd5, options)
      return { success: true, ...result }
    } catch (e) {
      return { success: false, error: String(e), exists: false }
    }
  })

  ipcMain.handle('video:getVideoInfoBatch', async (_, videoMd5List?: string[], options?: { includePoster?: boolean; posterFormat?: 'dataUrl' | 'fileUrl' }) => {
    try {
      const rows = await videoService.getVideoInfoBatch(Array.isArray(videoMd5List) ? videoMd5List : [], options)
      return {
        success: true,
        rows: rows.map((row) => ({
          index: row.index,
          md5: row.md5,
          success: true,
          ...row.info
        }))
      }
    } catch (e) {
      return { success: false, rows: [], error: String(e) }
    }
  })

  ipcMain.handle('video:parseVideoMd5', async (_, content: string) => {
    try {
      const md5 = videoService.parseVideoMd5(content)
      return { success: true, md5 }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 数据库路径相关
  ipcMain.handle('dbpath:autoDetect', async () => {
    return dbPathService.autoDetect()
  })

  ipcMain.handle('dbpath:scanWxids', async (_, rootPath: string) => {
    return dbPathService.scanWxids(rootPath)
  })

  ipcMain.handle('dbpath:scanWxidCandidates', async (_, rootPath: string) => {
    return dbPathService.scanWxidCandidates(rootPath)
  })

  ipcMain.handle('dbpath:getDefault', async () => {
    return dbPathService.getDefaultPath()
  })

  // WCDB 数据库相关
  ipcMain.handle('wcdb:testConnection', async (_, dbPath: string, hexKey: string, wxid: string) => {
    const cfg = configService || new ConfigService()
    const accountDir = cfg.getAccountDir(dbPath, wxid)
    if (!accountDir) {
      return { success: false, error: '未找到账号目录' }
    }
    return wcdbService.testConnection(accountDir, hexKey)
  })

  ipcMain.handle('wcdb:open', async (_, dbPath: string, hexKey: string, wxid: string) => {
    const cfg = configService || new ConfigService()
    const accountDir = cfg.getAccountDir(dbPath, wxid)
    if (!accountDir) {
      const error = '未找到与微信 ID 匹配的账号目录，请确认数据目录和微信 ID 是否正确'
      await writeDatabaseConnectionLog(`open failed: ${error}; dbPath=${dbPath}; wxid=${wxid}`)
      return { success: false, error }
    }

    try {
      const success = await wcdbService.open(accountDir, hexKey)
      if (success) {
        await writeDatabaseConnectionLog(`open succeeded: accountDir=${accountDir}`)
        void messagePushService.handleDatabaseConnected(dbPath, hexKey, wxid)
        return { success: true }
      }

      const error = await wcdbService.getLastInitError() || '无法打开微信数据库，请检查密钥、数据库文件和 WCDB 日志'
      await writeDatabaseConnectionLog(`open failed: ${error}; accountDir=${accountDir}`)
      return { success: false, error }
    } catch (exception) {
      const error = exception instanceof Error ? exception.message : String(exception)
      await writeDatabaseConnectionLog(`open exception: ${error}; accountDir=${accountDir}`)
      return { success: false, error: `连接数据库时发生异常：${error}` }
    }
  })

  ipcMain.handle('wcdb:isConnected', async () => {
    return wcdbService.isConnected()
  })

  ipcMain.handle('wcdb:close', async () => {
    await wcdbService.close()
    return true
  })

  // 聊天相关
  ipcMain.handle('chat:connect', async () => {
    return chatService.connect()
  })

  ipcMain.handle('chat:getSessions', async () => {
    return chatService.getSessions()
  })

  ipcMain.handle('chat:markAllSessionsRead', async () => {
    return chatService.markAllSessionsRead()
  })

  ipcMain.handle('chat:getSessionStatuses', async (_, usernames: string[]) => {
    return chatService.getSessionStatuses(usernames)
  })

  ipcMain.handle('chat:getExportTabCounts', async () => {
    return chatService.getExportTabCounts()
  })

  ipcMain.handle('chat:getContactTypeCounts', async () => {
    return chatService.getContactTypeCounts()
  })

  ipcMain.handle('chat:getSessionMessageCounts', async (_, sessionIds: string[], options?: { preferHintCache?: boolean; bypassSessionCache?: boolean }) => {
    return chatService.getSessionMessageCounts(sessionIds, options)
  })

  ipcMain.handle('chat:enrichSessionsContactInfo', async (_, usernames: string[], options?: {
    skipDisplayName?: boolean
    onlyMissingAvatar?: boolean
  }) => {
    return chatService.enrichSessionsContactInfo(usernames, options)
  })

  ipcMain.handle('chat:getMessages', async (_, sessionId: string, offset?: number, limit?: number, startTime?: number, endTime?: number, ascending?: boolean) => {
    return chatService.getMessages(sessionId, offset, limit, startTime, endTime, ascending)
  })

  ipcMain.handle('chat:getLatestMessages', async (_, sessionId: string, limit?: number) => {
    return chatService.getLatestMessages(sessionId, limit)
  })

  ipcMain.handle('chat:getNewMessages', async (_, sessionId: string, minTime: number, limit?: number, cursor?: {
    createTime?: number
    sortSeq?: number
    localId?: number
    serverId?: number | string
    serverIdRaw?: string
  }) => {
    return chatService.getNewMessages(sessionId, minTime, limit, cursor)
  })

  ipcMain.handle('chat:getAntiRevokeSessions', async () => {
    return chatService.getAntiRevokeSessions()
  })

  ipcMain.handle('chat:updateMessage', async (_, sessionId: string, localId: number, createTime: number, newContent: string) => {
    return chatService.updateMessage(sessionId, localId, createTime, newContent)
  })

  ipcMain.handle('chat:deleteMessage', async (_, sessionId: string, localId: number, createTime: number, dbPathHint?: string) => {
    return chatService.deleteMessage(sessionId, localId, createTime, dbPathHint)
  })

  ipcMain.handle('chat:checkAntiRevokeTriggers', async (_, sessionIds: string[]) => {
    return chatService.checkAntiRevokeTriggers(sessionIds)
  })

  ipcMain.handle('chat:installAntiRevokeTriggers', async (_, sessionIds: string[]) => {
    return chatService.installAntiRevokeTriggers(sessionIds)
  })

  ipcMain.handle('chat:uninstallAntiRevokeTriggers', async (_, sessionIds: string[]) => {
    return chatService.uninstallAntiRevokeTriggers(sessionIds)
  })

  ipcMain.handle('chat:getContact', async (_, username: string) => {
    return await chatService.getContact(username)
  })


  ipcMain.handle('chat:getContactAvatar', async (_, username: string, chatroomId?: string) => {
    return await chatService.getContactAvatar(username, chatroomId)
  })

  ipcMain.handle('chat:resolveTransferDisplayNames', async (_, chatroomId: string, payerUsername: string, receiverUsername: string) => {
    return await chatService.resolveTransferDisplayNames(chatroomId, payerUsername, receiverUsername)
  })

  ipcMain.handle('chat:getContacts', async (_, options?: { lite?: boolean }) => {
    return await chatService.getContacts(options)
  })

  ipcMain.handle('chat:getCachedMessages', async (_, sessionId: string) => {
    return chatService.getCachedSessionMessages(sessionId)
  })

  ipcMain.handle('chat:getMyAvatarUrl', async () => {
    return chatService.getMyAvatarUrl()
  })

  ipcMain.handle('chat:downloadEmoji', async (_, cdnUrl: string, md5?: string) => {
    return chatService.downloadEmoji(cdnUrl, md5)
  })

  ipcMain.handle('chat:close', async () => {
    chatService.close()
    return true
  })

  ipcMain.handle('chat:clearCurrentAccountData', async (_, options?: { clearCache?: boolean; clearExports?: boolean }) => {
    const cfg = configService
    if (!cfg) return { success: false, error: '配置服务未初始化' }

    const clearCache = options?.clearCache === true
    const clearExports = options?.clearExports === true
    if (!clearCache && !clearExports) {
      return { success: false, error: '请至少选择一项清理范围' }
    }

    const rawWxid = String(cfg.getMyWxidCleaned() || '').trim()
    if (!rawWxid) {
      return { success: false, error: '当前账号未登录或未识别，无法清理' }
    }
    const normalizedWxid = normalizeAccountId(rawWxid)
    const wxidCandidates = Array.from(new Set([rawWxid, normalizedWxid].filter(Boolean)))
    const isMatchedAccountName = buildAccountNameMatcher(wxidCandidates)
    const removedPaths: string[] = []
    const warnings: string[] = []

    try {
      wcdbService.close()
      chatService.close()
    } catch (error) {
      warnings.push(`关闭数据库连接失败: ${String(error)}`)
    }

    if (clearCache) {
      const [imageResult] = await Promise.all([
        imageDecryptService.clearCache()
      ])
      const chatResult = chatService.clearCaches()
      const cleanupResults = [imageResult, chatResult]
      for (const result of cleanupResults) {
        if (!result.success && result.error) warnings.push(result.error)
      }

      const configuredCachePath = String(cfg.get('cachePath') || '').trim()
      const documentsWeFlowDir = join(app.getPath('documents'), 'WeFlow')
      const userDataCacheDir = join(app.getPath('userData'), 'cache')
      const cacheRootCandidates = [
        configuredCachePath,
        join(documentsWeFlowDir, 'Images'),
        join(documentsWeFlowDir, 'Voices'),
        join(documentsWeFlowDir, 'Emojis'),
        userDataCacheDir
      ].filter(Boolean)

      for (const wxid of wxidCandidates) {
        if (configuredCachePath) {
          await removePathIfExists(join(configuredCachePath, wxid), removedPaths, warnings)
          await removePathIfExists(join(configuredCachePath, 'Images', wxid), removedPaths, warnings)
          await removePathIfExists(join(configuredCachePath, 'Voices', wxid), removedPaths, warnings)
          await removePathIfExists(join(configuredCachePath, 'Emojis', wxid), removedPaths, warnings)
        }
        await removePathIfExists(join(documentsWeFlowDir, 'Images', wxid), removedPaths, warnings)
        await removePathIfExists(join(documentsWeFlowDir, 'Voices', wxid), removedPaths, warnings)
        await removePathIfExists(join(documentsWeFlowDir, 'Emojis', wxid), removedPaths, warnings)
        await removePathIfExists(join(userDataCacheDir, wxid), removedPaths, warnings)
      }

      for (const cacheRoot of cacheRootCandidates) {
        await removeMatchedEntriesInDir(cacheRoot, isMatchedAccountName, removedPaths, warnings)
      }
    }

    if (clearExports) {
      const configuredExportPath = String(cfg.get('exportPath') || '').trim()
      const documentsWeFlowDir = join(app.getPath('documents'), 'WeFlow')
      const exportRootCandidates = [
        configuredExportPath,
        join(documentsWeFlowDir, 'exports'),
        join(documentsWeFlowDir, 'Exports')
      ].filter(Boolean)

      for (const exportRoot of exportRootCandidates) {
        await removeMatchedEntriesInDir(exportRoot, isMatchedAccountName, removedPaths, warnings)
      }

      const resetConfigKeys = [
        'exportSessionRecordMap',
        'exportLastSessionRunMap',
        'exportLastContentRunMap',
        'exportSessionMessageCountCacheMap',
        'exportSessionContentMetricCacheMap',
        'exportSnsStatsCacheMap',
        'snsPageCacheMap',
        'contactsListCacheMap',
        'contactsAvatarCacheMap',
        'lastSession'
      ]
      for (const key of resetConfigKeys) {
        const defaultValue = key === 'lastSession' ? '' : {}
        cfg.set(key as any, defaultValue as any)
      }

      try {
        const dbPath = String(cfg.get('dbPath') || '').trim()
        const automationMapRaw = cfg.get('exportAutomationTaskMap') as Record<string, unknown> | undefined
        if (automationMapRaw && typeof automationMapRaw === 'object') {
          const nextAutomationMap: Record<string, unknown> = { ...automationMapRaw }
          let changed = false
          for (const scopeKey of Object.keys(automationMapRaw)) {
            const normalizedScopeKey = String(scopeKey || '').trim()
            if (!normalizedScopeKey) continue
            const separatorIndex = normalizedScopeKey.lastIndexOf('::')
            const scopedDbPath = separatorIndex >= 0
              ? normalizedScopeKey.slice(0, separatorIndex)
              : ''
            const scopedWxidRaw = separatorIndex >= 0
              ? normalizedScopeKey.slice(separatorIndex + 2)
              : normalizedScopeKey
            const scopedWxid = normalizeAccountId(scopedWxidRaw)
            const wxidMatched = wxidCandidates.includes(scopedWxidRaw) || scopedWxid === normalizedWxid
            const dbPathMatched = !dbPath || !scopedDbPath || scopedDbPath === dbPath
            if (!wxidMatched || !dbPathMatched) continue
            delete nextAutomationMap[scopeKey]
            changed = true
          }
          if (changed) {
            cfg.set('exportAutomationTaskMap' as any, nextAutomationMap as any)
          } else if (!Object.keys(automationMapRaw).length) {
            cfg.set('exportAutomationTaskMap' as any, {} as any)
          }
        }
      } catch (error) {
        warnings.push(`清理自动化导出任务失败: ${String(error)}`)
      }
    }

    if (clearCache) {
      try {
        const wxidConfigsRaw = cfg.get('wxidConfigs') as Record<string, any> | undefined
        if (wxidConfigsRaw && typeof wxidConfigsRaw === 'object') {
          const nextConfigs: Record<string, any> = { ...wxidConfigsRaw }
          for (const key of Object.keys(nextConfigs)) {
            if (isMatchedAccountName(key) || normalizeAccountId(key) === normalizedWxid) {
              delete nextConfigs[key]
            }
          }
          cfg.set('wxidConfigs' as any, nextConfigs as any)
        }
        cfg.set('myWxid' as any, '')
        cfg.set('decryptKey' as any, '')
        cfg.set('imageXorKey' as any, 0)
        cfg.set('imageAesKey' as any, '')
        cfg.set('dbPath' as any, '')
        cfg.set('lastOpenedDb' as any, '')
        cfg.set('onboardingDone' as any, false)
        cfg.set('lastSession' as any, '')
      } catch (error) {
        warnings.push(`清理账号配置失败: ${String(error)}`)
      }
    }

    return {
      success: true,
      removedPaths,
      warning: warnings.length > 0 ? warnings.join('; ') : undefined
    }
  })

  ipcMain.handle('chat:getSessionDetail', async (_, sessionId: string) => {
    return chatService.getSessionDetail(sessionId)
  })

  ipcMain.handle('chat:getSessionDetailFast', async (_, sessionId: string) => {
    return chatService.getSessionDetailFast(sessionId)
  })

  ipcMain.handle('chat:getSessionDetailExtra', async (_, sessionId: string) => {
    return chatService.getSessionDetailExtra(sessionId)
  })

  ipcMain.handle('chat:getExportSessionStats', async (_, sessionIds: string[], options?: {
    includeRelations?: boolean
    forceRefresh?: boolean
    allowStaleCache?: boolean
    preferAccurateSpecialTypes?: boolean
    cacheOnly?: boolean
    beginTimestamp?: number
    endTimestamp?: number
  }) => {
    return chatService.getExportSessionStats(sessionIds, options)
  })

  ipcMain.handle('chat:getGroupMyMessageCountHint', async (_, chatroomId: string) => {
    return chatService.getGroupMyMessageCountHint(chatroomId)
  })

  ipcMain.handle('chat:getImageData', async (_, sessionId: string, msgId: string) => {
    return chatService.getImageData(sessionId, msgId)
  })

  ipcMain.handle('chat:getVoiceData', async (_, sessionId: string, msgId: string, createTime?: number, serverId?: string | number) => {
    return chatService.getVoiceData(sessionId, msgId, createTime, serverId)
  })
  ipcMain.handle('chat:getAllVoiceMessages', async (_, sessionId: string) => {
    return chatService.getAllVoiceMessages(sessionId)
  })
  ipcMain.handle('chat:getAllImageMessages', async (_, sessionId: string) => {
    return chatService.getAllImageMessages(sessionId)
  })
  ipcMain.handle('chat:getMessageDates', async (_, sessionId: string) => {
    return chatService.getMessageDates(sessionId)
  })
  ipcMain.handle('chat:getMessageDateCounts', async (_, sessionId: string) => {
    return chatService.getMessageDateCounts(sessionId)
  })
  ipcMain.handle('chat:getMessageDateCountsBatch', async (_, sessionIds: string[]) => {
    return chatService.getMessageDateCountsBatch(sessionIds)
  })

  ipcMain.handle('chat:getResourceMessages', async (_, options?: {
    sessionId?: string
    types?: Array<'image' | 'video' | 'voice' | 'file'>
    beginTimestamp?: number
    endTimestamp?: number
    limit?: number
    offset?: number
  }) => {
    return chatService.getResourceMessages(options)
  })

  ipcMain.handle('chat:getMediaStream', async (_, options?: {
    sessionId?: string
    mediaType?: 'image' | 'video' | 'all'
    beginTimestamp?: number
    endTimestamp?: number
    limit?: number
    offset?: number
  }) => {
    return wcdbService.getMediaStream(options)
  })
  ipcMain.handle('chat:resolveVoiceCache', async (_, sessionId: string, msgId: string) => {
    return chatService.resolveVoiceCache(sessionId, msgId)
  })

  ipcMain.handle('chat:getVoiceTranscript', async (event, sessionId: string, msgId: string, createTime?: number, serverId?: string | number) => {
    return chatService.getVoiceTranscript(sessionId, msgId, createTime, (text) => {
      event.sender.send('chat:voiceTranscriptPartial', { sessionId, msgId, createTime, text })
    }, undefined, serverId)
  })

  ipcMain.handle('chat:getMessage', async (_, sessionId: string, localId: number) => {
    return chatService.getMessageById(sessionId, localId)
  })

  ipcMain.handle('chat:searchMessages', async (_, keyword: string, sessionId?: string, limit?: number, offset?: number, beginTimestamp?: number, endTimestamp?: number) => {
    return chatService.searchMessages(keyword, sessionId, limit, offset, beginTimestamp, endTimestamp)
  })

  // 图片解密
  ipcMain.handle('image:decrypt', async (_, payload: {
    sessionId?: string
    imageMd5?: string
    imageDatName?: string
    createTime?: number
    force?: boolean
    preferFilePath?: boolean
    hardlinkOnly?: boolean
    disableUpdateCheck?: boolean
    allowCacheIndex?: boolean
    suppressEvents?: boolean
  }) => {
    return imageDecryptService.decryptImage(payload)
  })
  ipcMain.handle('image:resolveCache', async (_, payload: {
    sessionId?: string
    imageMd5?: string
    imageDatName?: string
    createTime?: number
    preferFilePath?: boolean
    hardlinkOnly?: boolean
    disableUpdateCheck?: boolean
    allowCacheIndex?: boolean
    allowCachePromotion?: boolean
    allowFilesystemScan?: boolean
    suppressEvents?: boolean
  }) => {
    return imageDecryptService.resolveCachedImage(payload)
  })
  ipcMain.handle(
    'image:resolveCacheBatch',
    async (
      _,
      payloads: Array<{
        sessionId?: string
        imageMd5?: string
        imageDatName?: string
        createTime?: number
        preferFilePath?: boolean
        hardlinkOnly?: boolean
        suppressEvents?: boolean
      }>,
      options?: { disableUpdateCheck?: boolean; allowCacheIndex?: boolean; allowCachePromotion?: boolean; allowFilesystemScan?: boolean; preferFilePath?: boolean; hardlinkOnly?: boolean; suppressEvents?: boolean }
    ) => {
      const list = Array.isArray(payloads) ? payloads : []
      if (list.length === 0) return { success: true, rows: [] }
      if (options?.hardlinkOnly === true && options?.allowFilesystemScan === false) {
        const hardlinkMd5s = new Set<string>()
        for (const payload of list) {
          const imageMd5 = String(payload?.imageMd5 || '').trim().toLowerCase()
          if (/^[a-f0-9]{32}$/i.test(imageMd5)) {
            hardlinkMd5s.add(imageMd5)
            continue
          }
          const imageDatName = String(payload?.imageDatName || '').trim().toLowerCase()
          const datBase = imageDatName.endsWith('.dat') ? imageDatName.slice(0, -4) : imageDatName
          if (/^[a-f0-9]{32}$/i.test(datBase)) {
            hardlinkMd5s.add(datBase)
          }
        }
        if (hardlinkMd5s.size > 0) {
          await imageDecryptService.preloadImageHardlinkMd5s(Array.from(hardlinkMd5s), {
            chunkSize: 64,
            yieldMs: 0,
            filesystemFallback: false
          })
        }
      }

      const maxConcurrentRaw = Number(process.env.WEFLOW_IMAGE_RESOLVE_BATCH_CONCURRENCY || 3)
      const maxConcurrent = Number.isFinite(maxConcurrentRaw)
        ? Math.max(1, Math.min(Math.floor(maxConcurrentRaw), 12))
        : 3
      const workerCount = Math.min(maxConcurrent, list.length)

      const rows: Array<{ success: boolean; localPath?: string; hasUpdate?: boolean; error?: string }> = new Array(list.length)
      let cursor = 0
      const dedupe = new Map<string, Promise<{ success: boolean; localPath?: string; hasUpdate?: boolean; error?: string }>>()

      const makeDedupeKey = (payload: typeof list[number]): string => {
        const sessionId = String(payload.sessionId || '').trim().toLowerCase()
        const imageMd5 = String(payload.imageMd5 || '').trim().toLowerCase()
        const imageDatName = String(payload.imageDatName || '').trim().toLowerCase()
        const createTime = Number(payload.createTime || 0) || 0
        const preferFilePath = payload.preferFilePath ?? options?.preferFilePath === true
        const hardlinkOnly = payload.hardlinkOnly ?? options?.hardlinkOnly === true
        const allowCacheIndex = options?.allowCacheIndex !== false
        const allowCachePromotion = options?.allowCachePromotion !== false
        const allowFilesystemScan = options?.allowFilesystemScan !== false
        const disableUpdateCheck = options?.disableUpdateCheck === true
        return [
          sessionId,
          imageMd5,
          imageDatName,
          String(createTime),
          preferFilePath ? 'pf1' : 'pf0',
          hardlinkOnly ? 'hl1' : 'hl0',
          allowCacheIndex ? 'ci1' : 'ci0',
          allowCachePromotion ? 'cp1' : 'cp0',
          allowFilesystemScan ? 'fs1' : 'fs0',
          disableUpdateCheck ? 'du1' : 'du0'
        ].join('|')
      }

      const resolveOne = (payload: typeof list[number]) => imageDecryptService.resolveCachedImage({
        ...payload,
        preferFilePath: payload.preferFilePath ?? options?.preferFilePath === true,
        hardlinkOnly: payload.hardlinkOnly ?? options?.hardlinkOnly === true,
        disableUpdateCheck: options?.disableUpdateCheck === true,
        allowCacheIndex: options?.allowCacheIndex !== false,
        allowCachePromotion: options?.allowCachePromotion !== false,
        allowFilesystemScan: options?.allowFilesystemScan !== false,
        suppressEvents: payload.suppressEvents ?? options?.suppressEvents === true
      })

      const worker = async () => {
        while (true) {
          const index = cursor
          cursor += 1
          if (index >= list.length) return
          const payload = list[index]
          const key = makeDedupeKey(payload)
          const existing = dedupe.get(key)
          if (existing) {
            rows[index] = await existing
            continue
          }
          const task = resolveOne(payload).catch((error) => ({
            success: false,
            error: String(error)
          }))
          dedupe.set(key, task)
          rows[index] = await task
        }
      }

      await Promise.all(Array.from({ length: workerCount }, () => worker()))
      return { success: true, rows }
    }
  )
  ipcMain.handle(
    'image:preload',
    async (
      _,
      payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }>,
      options?: { allowDecrypt?: boolean; allowCacheIndex?: boolean; allowFilesystemScan?: boolean; emitResolved?: boolean; scope?: string; priority?: 'high' | 'normal' | 'low' }
    ) => {
      return imagePreloadService.enqueue(payloads || [], options)
    })
  ipcMain.handle(
    'image:cancelPreloadScope',
    async (_, scope?: string) => {
      imagePreloadService.cancelScope(String(scope || ''))
      return true
    }
  )
  ipcMain.handle(
    'image:getPreloadStats',
    async () => imagePreloadService.getStats()
  )
  ipcMain.handle(
    'image:preloadHardlinkMd5s',
    async (_, md5List?: string[], options?: { chunkSize?: number; yieldMs?: number; filesystemFallback?: boolean }) => {
      await imageDecryptService.preloadImageHardlinkMd5s(Array.isArray(md5List) ? md5List : [], options)
      return true
    }
  )

  // Windows Hello
  ipcMain.handle('auth:hello', async (event, message?: string) => {
    // 无论哪个窗口调用，都尝试强制附着到主窗口，确保体验一致
    // 如果主窗口不存在（极其罕见），则回退到调用者窗口
    const targetWin = (mainWindow && !mainWindow.isDestroyed())
      ? mainWindow
      : (BrowserWindow.fromWebContents(event.sender) || undefined)

    const result = await windowsHelloService.verify(message, targetWin)

    // Hello 验证成功后，自动用 authHelloSecret 中的密码解锁密钥
    if (result && configService) {
      const secret = configService.getHelloSecret()
      if (secret && configService.isLockMode()) {
        configService.unlock(secret)
      }
    }

    return result
  })

  // 验证应用锁状态（检测 lock: 前缀，防篡改）
  ipcMain.handle('auth:verifyEnabled', async () => {
    return configService?.verifyAuthEnabled() ?? false
  })

  // 密码解锁（验证 + 解密密钥到内存）
  ipcMain.handle('auth:unlock', async (_event, password: string) => {
    if (!configService) return { success: false, error: '配置服务未初始化' }
    return configService.unlock(password)
  })

  // 开启应用锁
  ipcMain.handle('auth:enableLock', async (_event, password: string) => {
    if (!configService) return { success: false, error: '配置服务未初始化' }
    return configService.enableLock(password)
  })

  // 关闭应用锁
  ipcMain.handle('auth:disableLock', async (_event, password: string) => {
    if (!configService) return { success: false, error: '配置服务未初始化' }
    return configService.disableLock(password)
  })

  // 修改密码
  ipcMain.handle('auth:changePassword', async (_event, oldPassword: string, newPassword: string) => {
    if (!configService) return { success: false, error: '配置服务未初始化' }
    return configService.changePassword(oldPassword, newPassword)
  })

  // 设置 Hello Secret
  ipcMain.handle('auth:setHelloSecret', async (_event, password: string) => {
    if (!configService) return { success: false }
    configService.setHelloSecret(password)
    return { success: true }
  })

  // 清除 Hello Secret
  ipcMain.handle('auth:clearHelloSecret', async () => {
    if (!configService) return { success: false }
    configService.clearHelloSecret()
    return { success: true }
  })

  // 检查是否处于 lock: 模式
  ipcMain.handle('auth:isLockMode', async () => {
    return configService?.isLockMode() ?? false
  })

  // 打开协议窗口
  ipcMain.handle('window:openAgreementWindow', async () => {
    createAgreementWindow()
    return true
  })

  // 打开图片查看窗口
  ipcMain.handle('window:openImageViewerWindow', async (_, imagePath: string, liveVideoPath?: string) => {
    // 如果是 dataUrl，写入临时文件
    if (imagePath.startsWith('data:')) {
      const commaIdx = imagePath.indexOf(',')
      const meta = imagePath.slice(5, commaIdx) // e.g. "image/jpeg;base64"
      const ext = meta.split('/')[1]?.split(';')[0] || 'jpg'
      const tmpPath = join(app.getPath('temp'), `weflow_preview_${Date.now()}.${ext}`)
      await writeFile(tmpPath, Buffer.from(imagePath.slice(commaIdx + 1), 'base64'))
      createImageViewerWindow(`file://${tmpPath.replace(/\\/g, '/')}`, liveVideoPath)
    } else {
      createImageViewerWindow(imagePath, liveVideoPath)
    }
  })

  // 完成引导，关闭引导窗口并显示主窗口
  ipcMain.handle('window:completeOnboarding', async () => {
    try {
      configService?.set('onboardingDone', true)
    } catch (e) {
      console.error('保存引导完成状态失败:', e)
    }

    if (onboardingWindow && !onboardingWindow.isDestroyed()) {
      onboardingWindow.close()
    }
    showMainWindow()
    return true
  })

  // 重新打开首次引导窗口，并隐藏主窗口
  ipcMain.handle('window:openOnboardingWindow', async (_, options?: { mode?: 'add-account' }) => {
    shouldShowMain = false
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.hide()
    }
    const mode = options?.mode === 'add-account' ? 'add-account' : 'default'
    createOnboardingWindow(mode)
    return true
  })

  ipcMain.handle('key:autoGetDbKey', async (event) => {
    return keyService.autoGetDbKey(180_000, (message: string, level: number) => {
      event.sender.send('key:dbKeyStatus', { message, level })
    })
  })

  ipcMain.handle('key:autoGetImageKey', async (event, manualDir?: string, wxid?: string) => {
    return keyService.autoGetImageKey(manualDir, (message: string) => {
      event.sender.send('key:imageKeyStatus', { message })
    }, wxid)
  })

  ipcMain.handle('key:scanImageKeyFromMemory', async (event, userDir: string) => {
    return keyService.autoGetImageKeyByMemoryScan(userDir, (message: string) => {
      event.sender.send('key:imageKeyStatus', { message })
    })
  })

  // HTTP API 服务
  ipcMain.handle('http:start', async (_, port?: number, host?: string) => {
    const bindHost = typeof host === 'string' && host.trim() ? host.trim() : '127.0.0.1'
    return httpService.start(port || 5031, bindHost)
  })

  ipcMain.handle('http:stop', async () => {
    await httpService.stop()
    return { success: true }
  })

  ipcMain.handle('http:status', async () => {
    return {
      running: httpService.isRunning(),
      port: httpService.getPort(),
      mediaExportPath: httpService.getDefaultMediaExportPath()
    }
  })

  // 自动下载原图
  ipcMain.handle('image:startAutoDownload', async (_, whitelist?: string[]) => {
    return await imageDownloadService.startAutoDownload(whitelist || [])
  })

  ipcMain.handle('image:stopAutoDownload', async () => {
    await imageDownloadService.stopAutoDownload()
    return { success: true }
  })

  ipcMain.handle('image:getAutoDownloadStatus', async () => {
    return await imageDownloadService.getStatus()
  })

  // Bridge 进程管理
  ipcMain.handle('bridge:start', async () => {
    const result = bridgeManager.start()
    if (result.success) bridgeManager.send({ cmd: 'start' })
    return result
  })

  ipcMain.handle('bridge:stop', async () => {
    const stopped = await bridgeManager.stop()
    return { success: stopped }
  })

  ipcMain.handle('bridge:status', async () => {
    return { ...bridgeManager.status, processRunning: bridgeManager.isRunning() }
  })

  ipcMain.handle('bridge:getLogs', async () => {
    return bridgeManager.logs
  })

  ipcMain.handle('bridge:clearLogs', async () => {
    bridgeManager.logs.length = 0
    return { success: true }
  })

  ipcMain.handle('bridge:getConfig', async () => {
    const cfgPath = bridgeManager.ensureConfigFile()
    try {
      const raw = await readFile(cfgPath, 'utf8')
      return { success: true, config: JSON.parse(raw) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('bridge:saveConfig', async (_, cfg: Record<string, unknown>) => {
    const dir = bridgeManager.getBridgeDir()
    const cfgPath = join(dir, 'config.json')
    try {
      // Drop the removed legacy sampling-method setting when older config
      // files are saved by a newer UI.
      const { active_reply_method: _legacyMethod, ...cleanConfig } = cfg
      await writeFile(cfgPath, JSON.stringify(cleanConfig, null, 4), 'utf8')
      // 如果 bridge 进程在运行，推送热更新
      bridgeManager.send({ cmd: 'update_config', config: cleanConfig })
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
}

// 主窗口引用
let mainWindow: BrowserWindow | null = null

// 启动时自动检测更新
function checkForUpdatesOnStartup() {
  if (!AUTO_UPDATE_ENABLED) return
  // 开发环境不检测更新
  if (process.env.VITE_DEV_SERVER_URL) return

  // 延迟3秒检测，等待窗口完全加载
  setTimeout(async () => {
    try {
      const result = await autoUpdater.checkForUpdates()
      if (result && result.updateInfo) {
        const currentVersion = appVersion
        const latestVersion = result.updateInfo.version

        // 检查是否有新版本
        if (shouldOfferUpdateForTrack(latestVersion, currentVersion) && mainWindow) {
          // 检查该版本是否被用户忽略
          const ignoredVersion = configService?.get('ignoredUpdateVersion')
          if (ignoredVersion === latestVersion) {

            return
          }

          // 通知渲染进程有新版本
          mainWindow.webContents.send('app:updateAvailable', {
            version: latestVersion,
            releaseNotes: getDialogReleaseNotes(result.updateInfo.releaseNotes),
            minimumVersion: (result.updateInfo as any).minimumVersion
          })
        }
      }
    } catch (error) {
      console.error('启动时检查更新失败:', error)
    }
  }, 3000)
}

app.whenReady().then(async () => {
  // 先初始化配置，以便在启动早期判定是否需要静默启动
  configService = new ConfigService()
  applyAutoUpdateChannel('startup')
  syncLaunchAtStartupPreference()
  const onboardingDone = configService.get('onboardingDone') === true
  const startInBackground = onboardingDone && isSilentStartupEnabled()
  shouldShowMain = true

  const withTimeout = <T>(task: () => Promise<T>, timeoutMs: number): Promise<{ timedOut: boolean; value?: T; error?: string }> => {
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({ timedOut: true, error: `timeout(${timeoutMs}ms)` })
      }, timeoutMs)

      task()
        .then((value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ timedOut: false, value })
        })
        .catch((error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ timedOut: false, error: String(error) })
        })
    })
  }

  // 基础初始化均为毫秒级操作，直接顺序执行
  updateSplashProgress(10, '正在初始化...')
  const candidateResources = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources')
  const fallbackResources = join(process.cwd(), 'resources')
  const resourcesPath = existsSync(candidateResources) ? candidateResources : fallbackResources
  const userDataPath = app.getPath('userData')
  const runtimeFlags = [
    `nodeEnv=${process.env.NODE_ENV || ''}`,
    `viteUrl=${process.env.VITE_DEV_SERVER_URL || ''}`,
    `argv=${JSON.stringify(process.argv)}`,
    `execArgv=${JSON.stringify(process.execArgv)}`,
    `nodeIpc=${Boolean(process.send)}`,
    `nodeChannel=${process.env.NODE_CHANNEL_FD || ''}`,
    `electronRunAsNode=${process.env.ELECTRON_RUN_AS_NODE || ''}`
  ].join('; ')
  await writeDatabaseConnectionLog(`runtime identity: appName=${app.getName()}; processTitle=${process.title}; execPath=${process.execPath}; packageName=${process.env.npm_package_name || ''}; userDataPath=${userDataPath}; ${runtimeFlags}`)
  wcdbService.setPaths(resourcesPath, userDataPath)
  wcdbService.setLogEnabled(configService.get('logEnabled') === true)

  // Initialize WCDB immediately after Electron is ready, before creating any
  // BrowserWindow or Tray. The native protection layer is most reliable in
  // this clean startup context; later open() calls reuse the initialized core.
  const nativeInitWarmup = await withTimeout(() => wcdbService.initialize(), 8000)
  if (nativeInitWarmup.timedOut) {
    await writeDatabaseConnectionLog(`native init warmup timed out: ${nativeInitWarmup.error || 'timeout'}`)
  } else if (nativeInitWarmup.value?.success !== true) {
    await writeDatabaseConnectionLog(`native init warmup failed: ${nativeInitWarmup.value?.error || nativeInitWarmup.error || 'unknown'}`)
  } else {
    await writeDatabaseConnectionLog('native init warmup succeeded')
  }

  registerIpcHandlers()
  chatService.addDbMonitorListener((type, json) => {
    messagePushService.handleDbMonitorChange(type, json)
  })

  // 提前创建主窗口（隐藏），让渲染进程加载与数据库预热并行进行
  updateSplashProgress(20, '正在准备主窗口...')
  ensureWeChatRequestHeaderInterceptor()
  mainWindow = createWindow({ autoShow: false })

  const resolvedTrayIcon = resolveAppIconPath()

  try {
    const trayImage = nativeImage.createFromPath(resolvedTrayIcon)
    if (trayImage.isEmpty()) {
      throw new Error(`Failed to load tray icon: ${resolvedTrayIcon}`)
    }
    tray = new Tray(trayImage)
    tray.setToolTip('AstrWeChat')
    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          if (mainWindow) {
            mainWindow.show()
            mainWindow.focus()
          }
        }
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          void requestApplicationQuit()
        }
      }
    ])
    tray.setContextMenu(contextMenu)
    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.focus()
        } else {
          mainWindow.show()
          mainWindow.focus()
        }
      }
    })
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show()
        mainWindow.focus()
      }
    })
  } catch (e) {
    console.warn('[Tray] Failed to create tray icon:', e)
  }

  // 已完成引导时，仅验证数据库可用；连接器不需要原 WeFlow 的会话与头像预热。
  if (onboardingDone) {
    updateSplashProgress(35, '正在连接数据库...')
    const connectWarmup = await withTimeout(() => chatService.connect(), 12000)
    const connected = !connectWarmup.timedOut && connectWarmup.value?.success === true

    if (!connected) {
      const reason = connectWarmup.timedOut
        ? connectWarmup.error
        : (connectWarmup.value?.error || connectWarmup.error || 'unknown')
      console.warn('[StartupWarmup] 跳过预热，数据库连接失败:', reason)
    }
  }

  // 等待主窗口加载完成（进度条末端呼吸光点）
  updateSplashProgress(90, '正在准备主窗口...', true)
  await new Promise<void>((resolve) => {
    if (mainWindowReady) {
      resolve()
    } else {
      mainWindow!.once('ready-to-show', () => {
        mainWindowReady = true
        resolve()
      })
    }
  })

  // 加载完成，收尾
  updateSplashProgress(100, '启动完成')
  closeSplash()

  if (startInBackground && tray) {
    mainWindow?.hide()
  } else {
    mainWindow?.show()
  }

  // Bridge 所需的 SSE 推送服务在窗口显示后启动。
  messagePushService.start()

  // 启动时检测更新（不阻塞启动）
  checkForUpdatesOnStartup()

  await httpService.autoStart()

  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!mainWindow.isVisible()) {
        mainWindow.show()
      }
      mainWindow.focus()
      return
    }

    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

const shutdownAppServices = async (): Promise<void> => {
  if (shutdownPromise) return shutdownPromise
  shutdownPromise = (async () => {
    isAppQuitting = true
    // 销毁 tray 图标
    if (tray) { try { tray.destroy() } catch {} tray = null }
    // 通知窗使用 hide 而非 close，退出时主动销毁，避免残留窗口阻塞进程退出。
    destroyNotificationWindow()
    messagePushService.stop()
    // 兜底：5秒后强制退出，防止某个异步任务卡住导致进程残留
    const forceExitTimer = setTimeout(() => {
      console.warn('[App] Force exit after timeout')
      app.exit(0)
    }, 5000)
    forceExitTimer.unref()
    // 先等待 Bridge 子进程退出；正常退出最多等待 3 秒，超时会强制终止。
    try { await bridgeManager.stop() } catch {}
    // 停止 chatService（内部会关闭 cursor 与 DB），避免退出阶段仍触发监控回调
    try { chatService.close() } catch {}
    // 停止 HTTP 服务器，释放 TCP 端口占用，避免进程无法退出
    try { await httpService.stop() } catch {}
    // 终止 wcdb Worker 线程，避免线程阻止进程退出
    try { await wcdbService.shutdown() } catch {}
  })()
  return shutdownPromise
}

app.on('before-quit', () => {
  void shutdownAppServices()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
