export interface LocalCommandAdmin { uid: string; note: string }
export const AW_ATTACHMENT_LABEL = '回溯码' as const
export interface LocalCommandConfig {
  local_command_admins: LocalCommandAdmin[]
  ac_cache_hours: number
  ac_file_max_mb: number
  ac_cache_max_mb: number
}
export const isLocalAdminUid = (value: string) => /^AW-[A-F0-9]{24}$/.test(value.trim().toUpperCase())
const integer = (value: unknown, fallback: number, max: number) => {
  if (value == null || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? Math.min(max, Math.max(1, Math.floor(number))) : fallback
}
export function normalizeLocalCommandConfig(raw: Record<string, unknown>): LocalCommandConfig {
  const admins = new Map<string, LocalCommandAdmin>()
  for (const item of Array.isArray(raw.local_command_admins) ? raw.local_command_admins : []) {
    const uid = String(typeof item === 'string' ? item : item?.uid ?? '').trim().toUpperCase()
    if (isLocalAdminUid(uid) && !admins.has(uid) && admins.size < 100) {
      admins.set(uid, { uid, note: String(typeof item === 'object' ? item?.note ?? '' : '').trim().slice(0, 80) })
    }
  }
  return {
    local_command_admins: [...admins.values()],
    ac_cache_hours: integer(raw.ac_cache_hours, 24, 168),
    ac_file_max_mb: integer(raw.ac_file_max_mb, 100, 1024),
    ac_cache_max_mb: integer(raw.ac_cache_max_mb, 512, 4096)
  }
}
