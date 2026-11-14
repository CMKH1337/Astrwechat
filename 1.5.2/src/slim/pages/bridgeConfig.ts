import bridgeDefaultConfig from '../../../shared/bridge-default-config.json'
import { normalizeBridgeConnection, type BridgeConnectionConfig } from '../../../shared/bridge-connection'


export interface BridgeConfig extends BridgeConnectionConfig {
  astrbot_ob_url: string
  astrbot_ob_token: string

  bot_nicknames: string[]
  search_by_wxid: boolean
  uia_direct_window: boolean
  buffer_seconds: number
  group_reply_mode: string
  astrbot_attachments: string
}

export const DEFAULT_CONFIG: BridgeConfig = {
  ...bridgeDefaultConfig,
  ...normalizeBridgeConnection(bridgeDefaultConfig),
}

const toNumber = (value: unknown, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const normalizeLoadedConfig = (raw: Record<string, unknown>) => {
  return {
    config: {
      ...normalizeBridgeConnection(raw),
      bot_nicknames: Array.isArray(raw.bot_nicknames)
        ? raw.bot_nicknames.map(item => String(item)).filter(Boolean)
        : [],
      search_by_wxid: raw.search_by_wxid === true,
      uia_direct_window: raw.uia_direct_window === true,
      buffer_seconds: toNumber(raw.buffer_seconds, DEFAULT_CONFIG.buffer_seconds),
      group_reply_mode: String(raw.group_reply_mode ?? DEFAULT_CONFIG.group_reply_mode),
      astrbot_attachments: String(raw.astrbot_attachments ?? ''),

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
