import defaults from './bridge-default-config.json'

export type BotBackend = 'astrbot' | 'kourichat'
export interface BridgeConnectionConfig {
  bot_backend: BotBackend
  astrbot_ob_url: string
  astrbot_ob_token: string
  kourichat_ob_url: string
  kourichat_ob_token: string
}
export const BOT_LABELS: Record<BotBackend, string> = { astrbot: 'AstrBot', kourichat: 'KouriChat' }

export function normalizeBridgeConnection(input: object): BridgeConnectionConfig {
  const raw = input as Record<string, unknown>
  return {
    bot_backend: raw.bot_backend === 'kourichat' ? 'kourichat' : 'astrbot',
    astrbot_ob_url: String(raw.astrbot_ob_url ?? defaults.astrbot_ob_url).trim(),
    astrbot_ob_token: String(raw.astrbot_ob_token ?? '').trim(),
    kourichat_ob_url: String(raw.kourichat_ob_url ?? defaults.kourichat_ob_url).trim(),
    kourichat_ob_token: String(raw.kourichat_ob_token ?? '').trim()
  }
}

export function activeBridgeConnection(input: object) {
  const config = normalizeBridgeConnection(input)
  const backend = config.bot_backend
  return { backend, label: BOT_LABELS[backend], url: config[`${backend}_ob_url`], token: config[`${backend}_ob_token`] }
}

// Validate only the selected profile: an incomplete inactive draft must not stop the live connection.
export function validateBridgeConnection(input: object): string | null {
  const raw = input as Record<string, unknown>
  if (raw.bot_backend != null && raw.bot_backend !== 'astrbot' && raw.bot_backend !== 'kourichat') return '请选择 AstrBot 或 KouriChat'
  if (raw.uia_direct_window === true && raw.group_reply_filter_mode !== 'whitelist') {
    return '独立窗口发送模式必须使用消息过滤白名单，请先切换为白名单模式'
  }
  const { backend, label, url, token } = activeBridgeConnection(input)
  if (/[\r\n]/.test(String(raw[`${backend}_ob_token`] ?? '')) || /[\r\n]/.test(token)) return `${label} Token 不能包含换行`
  try {
    const parsed = new URL(url)
    if (!['ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.hash || /\s/.test(url)) throw new Error()
  } catch {
    return `${label} 地址必须是有效的 ws:// 或 wss:// 地址；Token 请填写在单独的输入框中`
  }
  return null
}

export function requiresBridgeRestart(previous: object, next: object): boolean {
  const before = activeBridgeConnection(previous)
  const after = activeBridgeConnection(next)
  const old = previous as Record<string, unknown>
  const current = next as Record<string, unknown>
  return (old.uia_direct_window === true) !== (current.uia_direct_window === true)
    || before.backend !== after.backend || before.url !== after.url || before.token !== after.token
    || ['bot_wxid', 'weflow_base_url', 'access_token'].some(key => String(old[key] ?? '') !== String(current[key] ?? ''))
}
