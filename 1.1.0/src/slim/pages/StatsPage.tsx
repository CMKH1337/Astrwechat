import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw, TrendingUp } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import '../AppSlim.scss'

interface SessionLike {
  username: string
  displayName?: string
  messageCountHint?: number
}

interface GroupRank {
  name: string
  count: number
}

interface TrendPoint {
  date: string
  label: string
  count: number
}

interface StatsSnapshot {
  totalMessages: number
  groupCount: number
  groups: GroupRank[]
  dailyCounts: Record<string, number>
  updatedAt: number
}

interface StatsCacheEntry {
  key: string
  snapshot: StatsSnapshot
}

interface StatsProgress {
  key: string
  percent: number
  phase: string
  detail: string
  sessionCount?: number
}

const PERIOD_OPTIONS = [7, 30] as const
type Period = typeof PERIOD_OPTIONS[number]

const STATS_CACHE_STORAGE_PREFIX = 'astrwechat:stats-cache:v1:'
let memoryStatsCache: StatsCacheEntry | null = null
let statsLoadInFlight: { key: string; promise: Promise<StatsSnapshot>; startedAt: number } | null = null
let statsProgressSnapshot: StatsProgress | null = null
let statsProgressStartedAt: number | null = null
const statsProgressListeners = new Set<(progress: StatsProgress, startedAt: number | null) => void>()

function publishStatsProgress(progress: StatsProgress): void {
  statsProgressSnapshot = progress
  for (const listener of statsProgressListeners) listener(progress, statsProgressStartedAt)
}

function getStatsCacheKey(dbPath: unknown, wxid: unknown): string {
  return `${String(dbPath || '').trim()}::${String(wxid || '').trim()}`
}

function getPersistedStatsCache(key: string): StatsSnapshot | null {
  if (!key || key === '::') return null
  if (memoryStatsCache?.key === key) return memoryStatsCache.snapshot

  try {
    const raw = window.localStorage.getItem(`${STATS_CACHE_STORAGE_PREFIX}${encodeURIComponent(key)}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as StatsSnapshot
    if (!parsed || !Array.isArray(parsed.groups) || !parsed.dailyCounts || !Number.isFinite(parsed.updatedAt)) return null
    memoryStatsCache = { key, snapshot: parsed }
    return parsed
  } catch {
    return null
  }
}

function saveStatsCache(key: string, snapshot: StatsSnapshot): void {
  memoryStatsCache = { key, snapshot }
  if (!key || key === '::') return
  try {
    window.localStorage.setItem(
      `${STATS_CACHE_STORAGE_PREFIX}${encodeURIComponent(key)}`,
      JSON.stringify(snapshot),
    )
  } catch {
    // 本地缓存失败不影响统计结果显示；内存缓存仍然有效。
  }
}

async function loadStatsSnapshot(
  forceRefresh: boolean,
  onProgress: (progress: StatsProgress) => void,
): Promise<StatsSnapshot> {
  const [dbPath, wxid] = await Promise.all([
    window.electronAPI.config.get('dbPath'),
    window.electronAPI.config.get('myWxid'),
  ])
  const cacheKey = getStatsCacheKey(dbPath, wxid)

  const reportProgress = (percent: number, phase: string, detail: string, sessionCount?: number) => {
    const progress: StatsProgress = { key: cacheKey, percent, phase, detail, sessionCount }
    publishStatsProgress(progress)
    onProgress(progress)
  }

  // 页面切换回来时优先加入正在执行的任务，进度和计时都沿用原任务。
  if (statsLoadInFlight?.key === cacheKey) {
    if (statsProgressSnapshot?.key === cacheKey) onProgress(statsProgressSnapshot)
    return statsLoadInFlight.promise
  }

  if (!forceRefresh) {
    const cached = getPersistedStatsCache(cacheKey)
    if (cached) {
      statsProgressStartedAt = null
      reportProgress(100, '读取缓存完成', '使用上次统计结果，无需重新扫描数据库')
      return cached
    }
  }

  statsProgressStartedAt = Date.now()
  reportProgress(5, '准备统计', '正在读取微信会话列表')

  const promise = (async () => {
    const sessionsResult = await window.electronAPI.chat.getSessions()
    if (!sessionsResult.success || !sessionsResult.sessions) {
      throw new Error(sessionsResult.error || '请先连接微信数据库')
    }

    const sessions = sessionsResult.sessions as SessionLike[]
    const sessionIds = sessions.map(session => session.username).filter(Boolean)
    reportProgress(20, '读取会话完成', `已发现 ${sessionIds.length} 个会话`, sessionIds.length)
    const countsResult = await window.electronAPI.chat.getSessionMessageCounts(sessionIds, {
      // 普通进入优先使用后端已有缓存；手动刷新才强制重新扫描。
      preferHintCache: !forceRefresh,
      bypassSessionCache: forceRefresh,
    })
    const counts = countsResult.counts || {}
    const groupsOnly = sessions.filter(session => session.username.endsWith('@chatroom'))
    reportProgress(58, '统计消息总数完成', `已处理 ${Object.keys(counts).length}/${sessionIds.length} 个会话`, sessionIds.length)

    const mergedDates: Record<string, number> = {}
    reportProgress(65, '统计消息趋势', '正在按日期汇总消息数量', sessionIds.length)
    const datesResult = await window.electronAPI.chat.getMessageDateCountsBatch(sessionIds)
    Object.values(datesResult.data || {}).forEach(sessionDates => {
      Object.entries(sessionDates).forEach(([date, count]) => {
        mergedDates[date] = (mergedDates[date] || 0) + (Number(count) || 0)
      })
    })

    reportProgress(90, '整理统计结果', '正在生成群聊排名和趋势图表', sessionIds.length)
    const snapshot: StatsSnapshot = {
      totalMessages: Object.values(counts).reduce((sum, count) => sum + (Number(count) || 0), 0),
      groupCount: groupsOnly.length,
      groups: groupsOnly
        .map(session => ({
          name: session.displayName || session.username.replace('@chatroom', ''),
          count: Number(counts[session.username] ?? session.messageCountHint ?? 0) || 0,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8),
      dailyCounts: mergedDates,
      updatedAt: Date.now(),
    }
    saveStatsCache(cacheKey, snapshot)
    reportProgress(100, '统计完成', `已完成 ${sessionIds.length} 个会话的统计`, sessionIds.length)
    return snapshot
  })()

  statsLoadInFlight = { key: cacheKey, promise, startedAt: statsProgressStartedAt || Date.now() }
  try {
    return await promise
  } finally {
    if (statsLoadInFlight?.promise === promise) statsLoadInFlight = null
  }
}

export default function StatsPage() {
  const [runtimeSeconds, setRuntimeSeconds] = useState(0)
  const [totalMessages, setTotalMessages] = useState(0)
  const [groupCount, setGroupCount] = useState(0)
  const [groups, setGroups] = useState<GroupRank[]>([])
  const [dailyCounts, setDailyCounts] = useState<Record<string, number>>({})
  const [period, setPeriod] = useState<Period>(7)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [progress, setProgress] = useState<StatsProgress>({
    key: '',
    percent: 0,
    phase: '准备统计',
    detail: '正在准备读取本地数据库',
  })
  const [progressElapsedMs, setProgressElapsedMs] = useState(0)
  const [progressStartedAt, setProgressStartedAt] = useState<number | null>(statsProgressStartedAt)

  useEffect(() => {
    let active = true
    const syncRuntime = async () => {
      try {
        const runtime = await window.electronAPI.app.getRuntimeSeconds()
        if (active) setRuntimeSeconds(Number(runtime) || 0)
      } catch {
        // 运行时间仅用于展示，读取失败不应阻塞统计数据。
      }
    }
    void syncRuntime()
    const timer = window.setInterval(() => setRuntimeSeconds(seconds => seconds + 1), 1000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  const applySnapshot = useCallback((snapshot: StatsSnapshot) => {
    setTotalMessages(snapshot.totalMessages)
    setGroupCount(snapshot.groupCount)
    setGroups(snapshot.groups)
    setDailyCounts(snapshot.dailyCounts)
    setLastUpdated(new Date(snapshot.updatedAt))
  }, [])

  const loadStats = useCallback(async (forceRefresh = false) => {
    setLoading(true)
    setError('')
    try {
      const snapshot = await loadStatsSnapshot(forceRefresh, setProgress)
      applySnapshot(snapshot)
    } catch (reason) {
      setError(String(reason).replace(/^Error:\s*/, ''))
      setTotalMessages(0)
      setGroupCount(0)
      setGroups([])
      setDailyCounts({})
    } finally {
      setLoading(false)
    }
  }, [applySnapshot])

  useEffect(() => {
    const listener = (nextProgress: StatsProgress, startedAt: number | null) => {
      setProgress(nextProgress)
      setProgressStartedAt(startedAt)
      setProgressElapsedMs(startedAt ? Date.now() - startedAt : 0)
    }
    statsProgressListeners.add(listener)
    if (statsProgressSnapshot) listener(statsProgressSnapshot, statsProgressStartedAt)
    return () => { statsProgressListeners.delete(listener) }
  }, [])

  useEffect(() => {
    if (!loading || !progressStartedAt) return
    setProgressElapsedMs(Date.now() - progressStartedAt)
    const timer = window.setInterval(() => {
      setProgressElapsedMs(Date.now() - progressStartedAt)
    }, 250)
    return () => window.clearInterval(timer)
  }, [loading, progressStartedAt])

  useEffect(() => {
    void loadStats(false)
  }, [loadStats])

  const trend = useMemo<TrendPoint[]>(() => {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return Array.from({ length: period }, (_, offset) => {
      const date = new Date(today)
      date.setDate(today.getDate() - (period - 1 - offset))
      const key = formatDateKey(date)
      return {
        date: key,
        label: `${date.getMonth() + 1}/${date.getDate()}`,
        count: dailyCounts[key] || 0,
      }
    })
  }, [dailyCounts, period])

  const animatedTotalMessages = useAnimatedNumber(totalMessages)
  const animatedGroupCount = useAnimatedNumber(groupCount)
  const animatedPeriodMessages = useAnimatedNumber(trend.reduce((sum, item) => sum + item.count, 0))
  const startedAt = useMemo(() => new Date(Date.now() - runtimeSeconds * 1000), [runtimeSeconds])
  const chartOption = useMemo(() => ({
    animation: true,
    animationDuration: 900,
    animationDurationUpdate: 0,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicOut',
    grid: { left: 44, right: 12, top: 18, bottom: 30, containLabel: true },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: '#222',
      borderWidth: 0,
      textStyle: { color: '#fff', fontSize: 11 },
      formatter: (params: Array<{ axisValue: string; value: number }>) => `${params[0]?.axisValue || ''}<br/>消息数：${formatNumber(Number(params[0]?.value || 0))}`,
    },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: trend.map(point => point.label),
      axisLine: { lineStyle: { color: '#d8d8d8' } },
      axisTick: { show: false },
      axisLabel: { color: '#999', fontSize: 10, interval: Math.max(0, Math.ceil(trend.length / 7) - 1) },
    },
    yAxis: {
      type: 'value',
      min: 0,
      splitNumber: 4,
      minInterval: 1,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: '#aaa', fontSize: 10 },
      splitLine: { lineStyle: { color: '#e8e8e8', type: 'dashed' } },
    },
    series: [{
      name: '消息数',
      type: 'line',
      smooth: false,
      showSymbol: trend.length <= 14,
      symbol: 'circle',
      symbolSize: 5,
      data: trend.map(point => point.count),
      lineStyle: { color: '#222', width: 2 },
      itemStyle: { color: '#222' },
      areaStyle: { color: 'rgba(0,0,0,0.035)' },
      emphasis: { focus: 'series' },
    }],
  }), [trend])

  return (
    <div className="stats-page">
      <div className="stats-toolbar">
        <span className="stats-toolbar__hint">
          {lastUpdated ? `更新于 ${lastUpdated.toLocaleTimeString('zh-CN', { hour12: false })}` : '读取本地数据库统计'}
        </span>
        <button className="slim-btn slim-btn--secondary stats-refresh" onClick={() => void loadStats(true)} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'stats-spin' : ''} />
          刷新
        </button>
      </div>

      {error && <div className="stats-error">{error}</div>}

      {loading && (
        <section className="slim-card stats-progress-card" aria-live="polite">
          <div className="stats-progress-card__header">
            <div>
              <div className="slim-card__title">统计进度</div>
              <p>{progress.phase} · 已用时 {formatElapsed(progressElapsedMs)}</p>
            </div>
            <strong>{Math.round(progress.percent)}%</strong>
          </div>
          <div className="stats-progress-track"><span style={{ width: `${Math.max(3, progress.percent)}%` }} /></div>
          <div className="stats-progress-card__detail">
            <span>{progress.detail}</span>
            {progress.sessionCount ? <em>{progress.sessionCount} 个会话</em> : null}
          </div>
        </section>
      )}

      <div className="stats-overview-grid">
        <StatCard label="正常运行时间" value={formatRuntime(runtimeSeconds)} detail={`启动于：${formatStartTime(startedAt)}`} />
        <StatCard label="消息总数" value={formatNumber(animatedTotalMessages)} />
        <StatCard label="群聊数量" value={formatNumber(animatedGroupCount)} />
        <StatCard label={`最近 ${period} 天`} value={formatNumber(animatedPeriodMessages)} />
      </div>

      <div className="stats-main-grid">
        <section className="slim-card stats-trend-card">
          <div className="stats-card-header">
            <div>
              <div className="slim-card__title">消息趋势</div>
              <p>每日消息数量</p>
            </div>
            <div className="stats-period-control">
              <TrendingUp size={15} />
              {PERIOD_OPTIONS.map(option => (
                <button
                  key={option}
                  className={period === option ? 'active' : ''}
                  onClick={() => setPeriod(option)}
                >
                  最近 {option} 天
                </button>
              ))}
            </div>
          </div>
          <div className="stats-chart-wrap">
            {loading && <div className="stats-chart-overlay">正在读取统计数据…</div>}
            <ReactECharts key={`stats-trend-${period}`} className="stats-chart" option={chartOption} notMerge lazyUpdate style={{ height: '252px', width: '100%' }} />
          </div>
        </section>

        <section className="slim-card stats-ranking-card">
          <div className="stats-card-header">
            <div>
              <div className="slim-card__title">群聊消息排名</div>
              <p>按消息总数排序</p>
            </div>
          </div>
          {groups.length === 0 && !loading && <div className="stats-empty">暂无群聊消息数据</div>}
          <div className="stats-ranking-list">
            {groups.map((group, index) => (
              <div className="stats-ranking-item" key={`${group.name}-${index}`}>
                <div className="stats-ranking-name"><span>{index + 1}</span><strong>{group.name}</strong><em>{formatNumber(group.count)}</em></div>
                <div className="stats-ranking-bar"><span style={{ width: `${Math.max(3, (group.count / Math.max(1, groups[0]?.count || 1)) * 100)}%` }} /></div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}

function StatCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="stats-stat-card"><span>{label}</span><strong>{value}</strong>{detail && <small>{detail}</small>}</div>
}

function useAnimatedNumber(target: number, duration = 700) {
  const [value, setValue] = useState(0)
  useEffect(() => {
    const start = performance.now()
    const initial = value
    let frame = 0
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      setValue(Math.round(initial + (target - initial) * eased))
      if (progress < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target])
  return value
}

function formatDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatRuntime(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const hours = String(Math.floor(total / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const secs = String(total % 60).padStart(2, '0')
  return `${hours}:${minutes}:${secs}`
}

function formatElapsed(milliseconds: number) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0')
  const seconds = String(totalSeconds % 60).padStart(2, '0')
  return `${minutes}:${seconds}`
}

function formatStartTime(date: Date) {
  const day = String(date.getDate()).padStart(2, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${day}/${month} ${hours}:${minutes}`
}
