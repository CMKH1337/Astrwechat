import { getStatsCacheKey, getStatsDateRange, type StatsScope } from '../../shared/stats-range'

interface SessionLike {
  username: string
  displayName?: string
  messageCountHint?: number
}

export interface GroupRank {
  name: string
  count: number
}

export interface StatsSnapshot {
  totalMessages: number
  groupCount: number
  groups: GroupRank[]
  dailyCounts: Record<string, number>
  updatedAt: number
}

export interface StatsProgress {
  key: string
  scope: StatsScope
  percent: number
  phase: string
  detail: string
  sessionCount?: number
}

const STATS_CACHE_STORAGE_PREFIX = 'astrwechat:stats-cache:v3:'
const memoryStatsCache = new Map<string, StatsSnapshot>()
const statsLoadsInFlight = new Map<string, Promise<StatsSnapshot>>()
const statsProgress = new Map<StatsScope, { progress: StatsProgress; startedAt: number | null }>()
const statsProgressListeners = new Set<(progress: StatsProgress, startedAt: number | null) => void>()

export function subscribeStatsProgress(scope: StatsScope, listener: (progress: StatsProgress, startedAt: number | null) => void): () => void {
  const filtered = (progress: StatsProgress, startedAt: number | null) => {
    if (progress.scope === scope) listener(progress, startedAt)
  }
  statsProgressListeners.add(filtered)
  const current = statsProgress.get(scope)
  if (current) listener(current.progress, current.startedAt)
  return () => { statsProgressListeners.delete(filtered) }
}

function getPersistedStatsCache(key: string): StatsSnapshot | null {
  if (memoryStatsCache.has(key)) return memoryStatsCache.get(key)!

  try {
    const raw = window.localStorage.getItem(`${STATS_CACHE_STORAGE_PREFIX}${encodeURIComponent(key)}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StatsSnapshot
    if (!parsed || !Array.isArray(parsed.groups) || !parsed.dailyCounts || !Number.isFinite(parsed.updatedAt)) return null
    memoryStatsCache.set(key, parsed)
    return parsed
  } catch {
    return null
  }
}

function saveStatsCache(key: string, snapshot: StatsSnapshot): void {
  memoryStatsCache.set(key, snapshot)
  try {
    window.localStorage.setItem(
      `${STATS_CACHE_STORAGE_PREFIX}${encodeURIComponent(key)}`,
      JSON.stringify(snapshot),
    )
  } catch {
    // 本地缓存失败不影响统计结果显示；内存缓存仍然有效。
  }
}

export async function loadStatsSnapshot(
  scope: StatsScope,
  forceRefresh: boolean,
  onProgress: (progress: StatsProgress) => void,
): Promise<StatsSnapshot> {
  const [dbPath, wxid] = await Promise.all([
    window.electronAPI.config.get('dbPath'),
    window.electronAPI.config.get('myWxid'),
  ])
  const now = new Date()
  const range = getStatsDateRange(scope, now)
  const cacheKey = getStatsCacheKey(dbPath, wxid, scope, now)
  let startedAt: number | null = null

  const reportProgress = (percent: number, phase: string, detail: string, sessionCount?: number) => {
    const progress: StatsProgress = { key: cacheKey, scope, percent, phase, detail, sessionCount }
    statsProgress.set(scope, { progress, startedAt })
    for (const listener of statsProgressListeners) listener(progress, startedAt)
    onProgress(progress)
  }

  // 页面切换回来时优先加入正在执行的任务，进度和计时都沿用原任务。
  const inFlight = statsLoadsInFlight.get(cacheKey)
  if (inFlight) {
    const current = statsProgress.get(scope)
    if (current?.progress.key === cacheKey) onProgress(current.progress)
    return inFlight
  }

  if (!forceRefresh) {
    const cached = getPersistedStatsCache(cacheKey)
    if (cached) {
      startedAt = null
      reportProgress(100, '读取缓存完成', '使用上次统计结果，无需重新扫描数据库')
      return cached
    }
  }

  startedAt = Date.now()
  reportProgress(5, '准备统计', '正在读取微信会话列表')

  const promise = (async () => {
    const sessionsResult = await window.electronAPI.chat.getSessions(range ? { skipMessageStats: true } : undefined)
    if (!sessionsResult.success || !sessionsResult.sessions) {
      throw new Error(sessionsResult.error || '请先连接微信数据库')
    }

    const sessions = sessionsResult.sessions as SessionLike[]
    const sessionIds = sessions.map(session => session.username).filter(Boolean)
    reportProgress(20, '读取会话完成', `已发现 ${sessionIds.length} 个会话`, sessionIds.length)
    let counts: Record<string, number> = {}
    if (!range) {
      const countsResult = await window.electronAPI.chat.getSessionMessageCounts(sessionIds, {
        preferHintCache: !forceRefresh,
        bypassSessionCache: forceRefresh,
      })
      if (!countsResult.success || !countsResult.counts) throw new Error(countsResult.error || '统计消息总数失败')
      counts = countsResult.counts
      reportProgress(58, '统计消息总数完成', `已处理 ${Object.keys(counts).length}/${sessionIds.length} 个会话`, sessionIds.length)
    }
    const groupsOnly = sessions.filter(session => session.username.endsWith('@chatroom'))
    const mergedDates: Record<string, number> = {}
    reportProgress(range ? 25 : 65, range ? '快速统计近30天消息' : '统计消息趋势',
      range ? '仅查询最近30天，按日期汇总消息数量' : '正在按日期汇总消息数量', sessionIds.length)
    // Bound each request so progress advances and the database worker can serve other requests between batches.
    const batchSize = range ? 20 : Math.max(1, sessionIds.length)
    for (let offset = 0; offset < sessionIds.length; offset += batchSize) {
      const batch = sessionIds.slice(offset, offset + batchSize)
      const datesResult = await window.electronAPI.chat.getMessageDateCountsBatch(batch, range)
      if (!datesResult.success || !datesResult.data) throw new Error(datesResult.error || '统计每日消息数失败')
      for (const sessionId of batch) {
        const sessionDates = datesResult.data[sessionId]
        if (!sessionDates) throw new Error(`会话 ${sessionId} 的每日统计不完整，请重试`)
        let sessionCount = 0
        for (const [date, count] of Object.entries(sessionDates)) {
          const value = Number(count) || 0
          mergedDates[date] = (mergedDates[date] || 0) + value
          sessionCount += value
        }
        if (range) counts[sessionId] = sessionCount
      }
      const completed = Math.min(offset + batchSize, sessionIds.length)
      reportProgress(range ? 25 + 63 * completed / sessionIds.length : 88,
        range ? '快速统计近30天消息' : '统计消息趋势', `已处理 ${completed}/${sessionIds.length} 个会话`, sessionIds.length)
    }

    reportProgress(90, '整理统计结果', '正在生成群聊排名和趋势图表', sessionIds.length)
    const snapshot: StatsSnapshot = {
      totalMessages: Object.values(counts).reduce((sum, count) => sum + (Number(count) || 0), 0),
      groupCount: range ? groupsOnly.filter(session => (counts[session.username] || 0) > 0).length : groupsOnly.length,
      groups: groupsOnly
        .map(session => ({
          name: session.displayName || session.username.replace('@chatroom', ''),
          count: Number(counts[session.username] ?? (range ? 0 : session.messageCountHint) ?? 0) || 0,
        }))
        .filter(group => !range || group.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      dailyCounts: mergedDates,
      updatedAt: Date.now(),
    }
    saveStatsCache(cacheKey, snapshot)
    reportProgress(100, '统计完成', `已完成 ${sessionIds.length} 个会话的统计`, sessionIds.length)
    return snapshot
  })()

  statsLoadsInFlight.set(cacheKey, promise)
  try {
    return await promise
  } finally {
    if (statsLoadsInFlight.get(cacheKey) === promise) statsLoadsInFlight.delete(cacheKey)
  }
}

