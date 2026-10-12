export interface BuiltinModelInfo {
  id: string
  name: string
  contextWindow: number | null
  maxInputTokens: number | null
  maxOutputTokens: number | null
  vision: boolean | null
}
export interface BuiltinModelMetadata extends BuiltinModelInfo { baseUrl: string; protocol: string }
export interface ModelCatalogResult { success: boolean; models?: BuiltinModelInfo[]; error?: string; truncated?: boolean }
export function normalizeModelMetadata(value: unknown, raw: Record<string, unknown>): BuiltinModelMetadata | null {
  if (!value || typeof value !== 'object') return null
  const v = value as BuiltinModelMetadata
  if (v.id !== String(raw.builtin_model ?? '').trim() || v.protocol !== raw.builtin_protocol || v.baseUrl !== String(raw.builtin_base_url ?? '').trim().replace(/\/+$/, '')) return null
  const limit = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 100_000_000 ? n : null
  return { id: v.id, name: String(v.name ?? v.id).slice(0, 256), baseUrl: v.baseUrl, protocol: v.protocol, contextWindow: limit(v.contextWindow), maxInputTokens: limit(v.maxInputTokens), maxOutputTokens: limit(v.maxOutputTokens), vision: typeof v.vision === 'boolean' ? v.vision : null }
}
