export type StatsScope = 'recent30' | 'all'

/** Unix seconds; the upper bound is exclusive. */
export interface StatsDateRange {
  beginTimestamp: number
  endTimestamp: number
}

export function formatStatsDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Includes today and the preceding 29 local calendar days, including DST changes. */
export function getStatsDateRange(scope: StatsScope, now = new Date()): StatsDateRange | undefined {
  if (scope === 'all') return undefined
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - 29)
  return { beginTimestamp: Math.floor(start.getTime() / 1000), endTimestamp: Math.floor(now.getTime() / 1000) + 1 }
}

export function validateStatsDateRange(range: StatsDateRange): void {
  if (!Number.isSafeInteger(range?.beginTimestamp) || !Number.isSafeInteger(range?.endTimestamp)
    || range.beginTimestamp <= 0 || range.endTimestamp <= range.beginTimestamp) {
    throw new Error('统计时间范围无效')
  }
}

export function getStatsCacheKey(dbPath: unknown, wxid: unknown, scope: StatsScope, now = new Date()): string {
  return JSON.stringify([String(dbPath || '').trim(), String(wxid || '').trim(), scope,
    scope === 'recent30' ? formatStatsDate(now) : 'all'])
}
