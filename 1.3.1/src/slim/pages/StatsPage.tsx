import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, TrendingUp } from 'lucide-react'
import ReactECharts from 'echarts-for-react'
import '../AppSlim.scss'

import { loadStatsSnapshot, subscribeStatsProgress, type GroupRank, type StatsSnapshot, type StatsProgress } from '../statsData'
import { type StatsScope } from '../../../shared/stats-range'
import './StatsPage.scss'

interface TrendPoint {
  date: string
  label: string
  count: number
}
const PERIOD_OPTIONS = [7, 30] as const
type Period = typeof PERIOD_OPTIONS[number]

export default function StatsPage() {
  const [runtimeSeconds, setRuntimeSeconds] = useState(0)
  const [totalMessages, setTotalMessages] = useState(0)
  const [groupCount, setGroupCount] = useState(0)
  const [groups, setGroups] = useState<GroupRank[]>([])
  const [dailyCounts, setDailyCounts] = useState<Record<string, number>>({})
  const [period, setPeriod] = useState<Period>(30)
  const [scope, setScope] = useState<StatsScope>('recent30')
  const requestIdRef = useRef(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [progress, setProgress] = useState<StatsProgress>({
    key: '',
    scope: 'recent30',
    percent: 0,
    phase: '准备统计',
    detail: '正在准备读取本地数据库',
  })
  const [progressElapsedMs, setProgressElapsedMs] = useState(0)
  const [progressStartedAt, setProgressStartedAt] = useState<number | null>(null)

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
    const requestId = ++requestIdRef.current
    setLoading(true)
    setError('')
    setTotalMessages(0)
    setGroupCount(0)
    setGroups([])
    setDailyCounts({})
    setLastUpdated(null)
    try {
      const snapshot = await loadStatsSnapshot(scope, forceRefresh, nextProgress => {
        if (requestId === requestIdRef.current) setProgress(nextProgress)
      })
      if (requestId === requestIdRef.current) applySnapshot(snapshot)
    } catch (reason) {
      if (requestId !== requestIdRef.current) return
      setError(String(reason).replace(/^Error:\s*/, ''))
      setTotalMessages(0)
      setGroupCount(0)
      setGroups([])
      setDailyCounts({})
    } finally {
      if (requestId === requestIdRef.current) setLoading(false)
    }
  }, [applySnapshot, scope])

  useEffect(() => {
    const listener = (nextProgress: StatsProgress, startedAt: number | null) => {
      setProgress(nextProgress)
      setProgressStartedAt(startedAt)
      setProgressElapsedMs(startedAt ? Date.now() - startedAt : 0)
    }
    return subscribeStatsProgress(scope, listener)
  }, [scope])

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
    return () => { requestIdRef.current += 1 }
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
        <div className="stats-period-control stats-scope-control" role="group" aria-label="统计范围">
          <button className={scope === 'recent30' ? 'active' : ''} aria-pressed={scope === 'recent30'}
            disabled={loading} onClick={() => setScope('recent30')}>快速统计 · 近30天</button>
          <button className={scope === 'all' ? 'active' : ''} aria-pressed={scope === 'all'}
            disabled={loading} onClick={() => setScope('all')}>全部历史</button>
        </div>
        <span className="stats-toolbar__hint">
          {lastUpdated ? `更新于 ${lastUpdated.toLocaleTimeString('zh-CN', { hour12: false })}` : '读取本地数据库统计'}
        </span>
        <button className="slim-btn slim-btn--secondary stats-refresh" onClick={() => void loadStats(true)} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'stats-spin' : ''} />
          刷新
        </button>
      </div>

      <p className="stats-scope-hint">
        {scope === 'recent30' ? '仅查询含今天在内的最近30天；消息数量、活跃群聊和排名均按此范围统计。' : '统计全部历史消息，首次加载或刷新可能需要较长时间。'}
      </p>
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
        <StatCard label={scope === 'recent30' ? '近30天消息数' : '消息总数'} value={formatNumber(animatedTotalMessages)} />
        <StatCard label={scope === 'recent30' ? '近30天活跃群聊' : '群聊数量'} value={formatNumber(animatedGroupCount)} />
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
              <p>{scope === 'recent30' ? '按近30天消息数排序' : '按全部历史消息数排序'}</p>
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
