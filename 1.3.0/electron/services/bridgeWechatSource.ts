import { randomBytes } from 'crypto'
import type { BridgeStartContext } from './bridgeManager'

interface Settings {
  host: string
  port: number
  token: string
  wxid: string
}

interface Options {
  getSettings: () => Settings
  isDatabaseConnected: () => Promise<boolean>
  saveToken: (token: string) => void
  enableApi: () => void
  enablePush: () => void
  warmupPush?: () => Promise<void>
  http: {
    isRunning: () => boolean
    getHost: () => string
    getPort: () => number
    start: (port: number, host: string) => Promise<{ success: boolean; error?: string }>
  }
}

/** The desktop's WeChat connection is the only source of Bridge API credentials. */
export class BridgeWechatSource {
  constructor(private options: Options) {}

  getConfig(): Record<string, string> {
    const settings = this.options.getSettings()
    const running = this.options.http.isRunning()
    const port = running ? this.options.http.getPort() : settings.port
    let host = (running ? this.options.http.getHost() : settings.host).trim() || '127.0.0.1'
    // Wildcard bind addresses are not client destinations. Keep IPv6 URLs valid.
    if (host === '0.0.0.0') host = '127.0.0.1'
    if (host === '::' || host === '[::]') host = '::1'
    if (host.includes(':') && !host.startsWith('[')) host = `[${host}]`
    return {
      weflow_base_url: `http://${host}:${port}`,
      access_token: settings.token.trim(),
      bot_wxid: settings.wxid.trim()
    }
  }

  async prepareStart(context?: BridgeStartContext): Promise<void> {
    const check = () => context?.signal.throwIfAborted()
    check()
    context?.reportProgress('检查微信数据库连接')
    const connected = await this.options.isDatabaseConnected()
    check()
    if (!connected) {
      throw new Error('请先在「连接」页面连接微信数据库，再启动 Bridge；微信推送会自动配置')
    }
    const settings = this.options.getSettings()
    if (!settings.wxid.trim()) throw new Error('当前微信账号信息不完整，请在「连接」页面重新连接')
    if (!settings.token.trim()) this.options.saveToken(randomBytes(32).toString('hex'))
    context?.reportProgress('启动本地微信消息服务')
    if (!this.options.http.isRunning()) {
      const result = await this.options.http.start(settings.port, settings.host)
      check()
      if (!result.success) throw new Error(`自动启动微信推送服务失败：${result.error || '未知错误'}`)
    }
    check()
    this.options.enableApi()
    context?.reportProgress('启用消息推送，会话预热在后台进行')
    this.options.enablePush()
    // Historical/session warmup must never hold the desktop's start IPC open.
    // Report failures without losing late rejections or changing a newer startup's status.
    if (this.options.warmupPush) {
      const warn = (error: unknown) => context?.reportWarning(`消息推送后台初始化失败：${error instanceof Error ? error.message : String(error)}`)
      try { void this.options.warmupPush().catch(warn) } catch (error) { warn(error) }
    }
  }
}
