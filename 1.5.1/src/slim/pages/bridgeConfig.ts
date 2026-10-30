import bridgeDefaultConfig from '../../../shared/bridge-default-config.json'
import { normalizeBridgeConnection, type BridgeConnectionConfig } from '../../../shared/bridge-connection'

export type GroupReplyFilterMode = 'whitelist' | 'blacklist'

export interface BridgeConfig extends BridgeConnectionConfig {
  astrbot_ob_url: string
  astrbot_ob_token: string
  force_push_triggers: string
  bot_nicknames: string[]
  search_by_wxid: boolean
  uia_direct_window: boolean
  buffer_seconds: number
  group_reply_mode: string
  active_reply_enabled: boolean
  active_reply_probability: number
  active_reply_context_lines: number
  group_reply_filter_mode: GroupReplyFilterMode
  group_reply_filter_sessions: string[]
  astrbot_attachments: string
}

export const DEFAULT_CONFIG: BridgeConfig = {
  ...bridgeDefaultConfig,
  ...normalizeBridgeConnection(bridgeDefaultConfig),
  group_reply_filter_mode:
    bridgeDefaultConfig.group_reply_filter_mode === 'whitelist'
      ? 'whitelist'
      : 'blacklist',
  group_reply_filter_sessions: Array.isArray(
    bridgeDefaultConfig.group_reply_filter_sessions
  )
    ? [...bridgeDefaultConfig.group_reply_filter_sessions]
    : []
}

const toNumber = (value: unknown, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const normalizeSessionIds = (value: unknown) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map(item => String(item).trim())
        .filter(Boolean)
    )
  )

export const normalizeLoadedConfig = (raw: Record<string, unknown>) => {
  const legacySessions = normalizeSessionIds(raw.active_reply_whitelist)
  const hasNewFilter = (
    raw.group_reply_filter_mode === 'whitelist'
    || raw.group_reply_filter_mode === 'blacklist'
  )
  const mode: GroupReplyFilterMode = hasNewFilter
    ? raw.group_reply_filter_mode as GroupReplyFilterMode
    : (legacySessions.length > 0 ? 'whitelist' : 'blacklist')
  const sessions = hasNewFilter
    ? normalizeSessionIds(raw.group_reply_filter_sessions)
    : legacySessions

  return {
    migrated: !hasNewFilter && legacySessions.length > 0,
    config: {
      ...normalizeBridgeConnection(raw),
      bot_nicknames: Array.isArray(raw.bot_nicknames)
        ? raw.bot_nicknames.map(item => String(item)).filter(Boolean)
        : [],
      search_by_wxid: raw.search_by_wxid === true,
      uia_direct_window: raw.uia_direct_window === true,
      buffer_seconds: toNumber(raw.buffer_seconds, DEFAULT_CONFIG.buffer_seconds),
      group_reply_mode: String(raw.group_reply_mode ?? DEFAULT_CONFIG.group_reply_mode),
      active_reply_enabled: raw.active_reply_enabled === true,
      active_reply_probability: Math.min(
        1,
        Math.max(0, toNumber(raw.active_reply_probability, DEFAULT_CONFIG.active_reply_probability))
      ),
      active_reply_context_lines: Math.min(
        100,
        Math.max(0, Math.round(toNumber(raw.active_reply_context_lines, DEFAULT_CONFIG.active_reply_context_lines)))
      ),
      group_reply_filter_mode: mode,
      group_reply_filter_sessions: sessions,
      astrbot_attachments: String(raw.astrbot_attachments ?? ''),
      force_push_triggers: String(raw.force_push_triggers ?? DEFAULT_CONFIG.force_push_triggers),
      builtin_protocol: normalizeBridgeConnection(raw).builtin_protocol,
      builtin_base_url: String(raw.builtin_base_url ?? DEFAULT_CONFIG.builtin_base_url),
      builtin_api_key: String(raw.builtin_api_key ?? ''),
      builtin_model: String(raw.builtin_model ?? ''),
      builtin_system_prompt: String(raw.builtin_system_prompt ?? ''),
      builtin_timeout_seconds: toNumber(raw.builtin_timeout_seconds, DEFAULT_CONFIG.builtin_timeout_seconds)
    } satisfies BridgeConfig
  }
}

export const isSameConfig = (left: BridgeConfig, right: BridgeConfig) =>
  JSON.stringify(left) === JSON.stringify(right)

