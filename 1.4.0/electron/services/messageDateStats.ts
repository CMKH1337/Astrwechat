import { validateStatsDateRange, type StatsDateRange } from '../../shared/stats-range'

interface DateStatsDatabase {
  getMessageTables(sessionId: string): Promise<{ success: boolean; tables?: any[]; error?: string }>
  execQuery(kind: string, path: string | null, sql: string): Promise<{ success: boolean; rows?: any[]; error?: string }>
}

/** Query only the requested range, without loading message bodies or counting all history. */
export async function queryRangedMessageDateCounts(
  database: DateStatsDatabase, sessionIds: string[], range: StatsDateRange,
): Promise<Record<string, Record<string, number>>> {
  validateStatsDateRange(range)
  const data: Record<string, Record<string, number>> = {}
  for (const sessionId of sessionIds) {
    // Metadata discovery only: getMessageTableStats also counts historical rows, so do not use it here.
    const result = await database.getMessageTables(sessionId)
    if (!result.success || !Array.isArray(result.tables)) {
      throw new Error(result.error || `无法读取会话 ${sessionId} 的消息表`)
    }
    const counts: Record<string, number> = {}
    const seen = new Set<string>()
    for (const table of result.tables) {
      const tableName = String(table.table_name || table.name || '').trim()
      const dbPath = String(table.db_path || '').trim()
      if (!tableName || !dbPath) throw new Error(`会话 ${sessionId} 的消息表信息不完整`)
      const key = JSON.stringify([dbPath, tableName])
      if (seen.has(key)) continue
      seen.add(key)
      const quotedTable = `"${tableName.replace(/"/g, '""')}"`
      // Keep create_time bare in WHERE so the database can use its timestamp index.
      const sql = `SELECT strftime('%Y-%m-%d', create_time, 'unixepoch', 'localtime') AS date, COUNT(*) AS count
        FROM ${quotedTable}
        WHERE create_time >= ${range.beginTimestamp} AND create_time < ${range.endTimestamp}
        GROUP BY date`
      const query = await database.execQuery('message', dbPath, sql)
      if (!query.success || !Array.isArray(query.rows)) {
        throw new Error(query.error || `查询会话 ${sessionId} 的近期消息失败`)
      }
      for (const row of query.rows) {
        const date = String(row.date || '')
        const count = Number(row.count)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(count) || count < 0) {
          throw new Error(`会话 ${sessionId} 返回了无效的每日消息统计`)
        }
        counts[date] = (counts[date] || 0) + count
      }
    }
    data[sessionId] = counts
  }
  return data
}
