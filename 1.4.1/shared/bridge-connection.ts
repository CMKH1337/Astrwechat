import { normalizeModelMetadata, type BuiltinModelMetadata } from './builtin-model-config'
import defaults from './bridge-default-config.json'

export type BotBackend = 'astrbot' | 'kourichat' | 'builtin'
export type BuiltinProtocol = 'responses' | 'chat_completions' | 'anthropic_messages'
export interface BridgeConnectionConfig {
  bot_backend: BotBackend
  astrbot_ob_url: string
  astrbot_ob_token: string
  kourichat_ob_url: string
  kourichat_ob_token: string
  builtin_protocol: BuiltinProtocol
  builtin_base_url: string
  builtin_api_key: string
  builtin_model: string
  builtin_system_prompt: string
  builtin_send_images: boolean
  builtin_send_errors: boolean
  builtin_model_metadata: BuiltinModelMetadata | null
  builtin_context_tokens: number
  builtin_context_rounds: number
  builtin_max_output_tokens: number
  builtin_segment_enabled: boolean
  builtin_segment_only_llm: boolean
  builtin_segment_interval: 'random' | 'log'
  builtin_segment_random: string
  builtin_segment_log_base: number
  builtin_segment_threshold: number
  builtin_segment_mode: 'regex' | 'newline'
  builtin_segment_regex: string
  builtin_segment_filter: string
  builtin_timeout_seconds: number
}
export const BOT_LABELS: Record<BotBackend, string> = { astrbot: 'AstrBot', kourichat: 'KouriChat', builtin: '内置模型' }

export function normalizeBridgeConnection(input: object): BridgeConnectionConfig {
  const raw = input as Record<string, unknown>
  return {
    bot_backend: raw.bot_backend === 'kourichat' || raw.bot_backend === 'builtin' ? raw.bot_backend : 'astrbot',
    astrbot_ob_url: String(raw.astrbot_ob_url ?? defaults.astrbot_ob_url).trim(),
    astrbot_ob_token: String(raw.astrbot_ob_token ?? '').trim(),
    kourichat_ob_url: String(raw.kourichat_ob_url ?? defaults.kourichat_ob_url).trim(),
    kourichat_ob_token: String(raw.kourichat_ob_token ?? '').trim(),
    builtin_protocol: ['responses', 'chat_completions', 'anthropic_messages'].includes(String(raw.builtin_protocol)) ? raw.builtin_protocol as BuiltinProtocol : 'chat_completions',
    builtin_base_url: String(raw.builtin_base_url ?? defaults.builtin_base_url).trim(),
    builtin_api_key: String(raw.builtin_api_key ?? '').trim(),
    builtin_model: String(raw.builtin_model ?? '').trim(),
    builtin_system_prompt: String(raw.builtin_system_prompt ?? ''),
    builtin_send_images: raw.builtin_send_images === true,
    builtin_send_errors: raw.builtin_send_errors === true,
    builtin_model_metadata: normalizeModelMetadata(raw.builtin_model_metadata, raw),
    builtin_context_tokens: Number(raw.builtin_context_tokens ?? defaults.builtin_context_tokens),
    builtin_context_rounds: Number(raw.builtin_context_rounds ?? defaults.builtin_context_rounds),
    builtin_max_output_tokens: Number(raw.builtin_max_output_tokens ?? defaults.builtin_max_output_tokens),
    builtin_segment_enabled: raw.builtin_segment_enabled === true,
    builtin_segment_only_llm: raw.builtin_segment_only_llm !== false,
    builtin_segment_interval: raw.builtin_segment_interval === 'log' ? 'log' : 'random',
    builtin_segment_random: String(raw.builtin_segment_random ?? defaults.builtin_segment_random),
    builtin_segment_log_base: Number(raw.builtin_segment_log_base ?? defaults.builtin_segment_log_base),
    builtin_segment_threshold: Number(raw.builtin_segment_threshold ?? defaults.builtin_segment_threshold),
    builtin_segment_mode: raw.builtin_segment_mode === 'newline' ? 'newline' : 'regex',
    builtin_segment_regex: String(raw.builtin_segment_regex ?? defaults.builtin_segment_regex),
    builtin_segment_filter: String(raw.builtin_segment_filter ?? ''),
    builtin_timeout_seconds: Number(raw.builtin_timeout_seconds ?? defaults.builtin_timeout_seconds)
  }
}

export function activeBridgeConnection(input: object) {
  const config = normalizeBridgeConnection(input)
  const backend = config.bot_backend
  return { backend, label: BOT_LABELS[backend], url: backend === 'builtin' ? config.builtin_base_url : config[`${backend}_ob_url`], token: backend === 'builtin' ? config.builtin_api_key : config[`${backend}_ob_token`] }
}

// Validate only the selected profile: an incomplete inactive draft must not stop the live connection.
export function validateBridgeConnection(input: object): string | null {
  const raw = input as Record<string, unknown>
  if (raw.bot_backend != null && !['astrbot', 'kourichat', 'builtin'].includes(String(raw.bot_backend))) return '请选择 AstrBot、KouriChat 或内置模型'
  if (raw.uia_direct_window === true && raw.group_reply_filter_mode !== 'whitelist') {
    return '独立窗口发送模式必须使用消息过滤白名单，请先切换为白名单模式'
  }
  const { backend, label, url, token } = activeBridgeConnection(input)
  if (backend === 'builtin') {
    const config = normalizeBridgeConnection(input)
    if (raw.builtin_protocol != null && !['responses', 'chat_completions', 'anthropic_messages'].includes(String(raw.builtin_protocol))) return '不支持的模型接口格式'
    if (!config.builtin_model || !config.builtin_api_key || /[\r\n]/.test(String(raw.builtin_api_key ?? ''))) return '请填写模型名称和有效的 API Key'
    if (/\/(?:chat\/completions|responses|messages)\/?$/i.test(url)) return '请填写 API 基础地址，不要填写完整接口路径'
    if (!Number.isFinite(config.builtin_timeout_seconds) || config.builtin_timeout_seconds < 5 || config.builtin_timeout_seconds > 300) return '请求超时必须在 5 到 300 秒之间'
    try {
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash || /\s/.test(url)) throw new Error()
      if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error()
    } catch { return 'API 基础地址须为 HTTPS，或本机 HTTP 地址；不要填写完整接口路径' }
    if (!Number.isSafeInteger(config.builtin_context_tokens) || config.builtin_context_tokens < 0 || config.builtin_context_tokens > 100_000_000) return '上下文长度须为 0（自动）或正整数，最大 100000000'
    if (!Number.isSafeInteger(config.builtin_context_rounds) || config.builtin_context_rounds < 1 || config.builtin_context_rounds > 1000) return '上下文对话轮数须为 1 至 1000 的整数'
    if (!Number.isSafeInteger(config.builtin_max_output_tokens) || config.builtin_max_output_tokens < 1 || config.builtin_max_output_tokens > 1_000_000) return '最大输出长度须为 1 至 1000000 的整数'
    if (config.builtin_segment_enabled) {
      const range = config.builtin_segment_random.split(',').map(Number)
      if (range.length !== 2 || config.builtin_segment_random.split(',').some(value => !value.trim()) || range.some(n => !Number.isFinite(n)) || range[0] < 0 || range[1] < range[0] || range[1] > 60) return '随机间隔格式：最小值,最大值，范围为 0 至 60 秒'
      if (!Number.isFinite(config.builtin_segment_log_base) || config.builtin_segment_log_base <= 1 || config.builtin_segment_log_base > 100) return '对数底数须大于 1 且不大于 100'
      if (!Number.isSafeInteger(config.builtin_segment_threshold) || config.builtin_segment_threshold < 1 || config.builtin_segment_threshold > 10000) return '分段字数阈值须为 1 至 10000 的整数'
      if (config.builtin_segment_regex.length > 512 || config.builtin_segment_filter.length > 512 || (config.builtin_segment_mode === 'regex' && !config.builtin_segment_regex)) return '分段正则不能为空，正则最长 512 字符'
      // Python validates syntax with the actual regex engine at startup, with a runtime timeout.
    }
    return null
  }
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
  const oldModel = normalizeBridgeConnection(previous)
  const nextModel = normalizeBridgeConnection(next)
  const modelSettings = Object.keys(defaults).filter(key => key.startsWith('builtin_segment_') || ['builtin_context_tokens', 'builtin_context_rounds', 'builtin_max_output_tokens', 'builtin_model_metadata'].includes(key)) as (keyof BridgeConnectionConfig)[]
  return (old.uia_direct_window === true) !== (current.uia_direct_window === true)
    || before.backend !== after.backend || before.url !== after.url || before.token !== after.token
    || (after.backend === 'builtin' && ['builtin_protocol', 'builtin_model', 'builtin_system_prompt', 'builtin_timeout_seconds', 'builtin_send_images'].some(key => String(old[key] ?? '') !== String(current[key] ?? '')))
    || (after.backend === 'builtin' && modelSettings.some(key => JSON.stringify(oldModel[key]) !== JSON.stringify(nextModel[key])))
    || (after.backend === 'builtin' && (old.builtin_send_errors === true) !== (current.builtin_send_errors === true))
    || ['bot_wxid', 'weflow_base_url', 'access_token'].some(key => String(old[key] ?? '') !== String(current[key] ?? ''))
}
