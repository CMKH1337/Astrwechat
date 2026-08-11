import { useEffect, useRef, useState } from 'react'
import '../AppSlim.scss'

interface LogEntry {
  time: string
  type: 'new' | 'revoke' | 'info' | 'error'
  text: string
}

export default function LogPage() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [autoScroll, setAutoScroll] = useState(true)
  const [filter, setFilter] = useState<'all' | 'new' | 'revoke' | 'error'>('all')
  const [polling, setPolling] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastLogRef = useRef<string>('')

  const addLog = (entry: LogEntry) => {
    setLogs(prev => {
      const next = [...prev, entry]
      return next.length > 500 ? next.slice(-500) : next
    })
  }

  const fetchLog = async () => {
    try {
      const result = await window.electronAPI.log.read() as any
      const content: string = typeof result === 'string' ? result : (result?.content || '')
      if (!content || content === lastLogRef.current) return
      lastLogRef.current = content
      // 只取最后 100 行新增内容
      const lines = content.split('\n').filter(Boolean).slice(-100)
      setLogs(lines.map(line => {
        const type: LogEntry['type'] =
          line.includes('[push]') || line.includes('message.new') ? 'new' :
          line.includes('revoke') || line.includes('message.revoke') ? 'revoke' :
          line.includes('error') || line.includes('Error') ? 'error' : 'info'
        return { time: '', type, text: line }
      }))
    } catch {
      // 日志读取失败时静默
    }
  }

  useEffect(() => {
    addLog({ time: now(), type: 'info', text: '日志监控已启动' })
    fetchLog()
  }, [])

  useEffect(() => {
    if (!polling) return
    const id = setInterval(fetchLog, 2000)
    return () => clearInterval(id)
  }, [polling])

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs, autoScroll])

  const filtered = filter === 'all' ? logs : logs.filter(l => l.type === filter)

  const colorMap: Record<string, string> = {
    new: 'var(--slim-accent)',
    revoke: '#fbbf24',
    info: '#555',
    error: '#f87171',
  }

  const labelMap: Record<string, string> = {
    new: '推送',
    revoke: '撤回',
    info: '信息',
    error: '错误',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ color: 'var(--slim-text)', fontWeight: 600, fontSize: 16, margin: 0 }}>运行日志</h2>
        <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
          {(['all', 'new', 'revoke', 'error'] as const).map(f => (
            <button
              key={f}
              className="slim-btn slim-btn--secondary"
              style={{ height: 28, padding: '0 10px', fontSize: 12, opacity: filter === f ? 1 : 0.5 }}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? '全部' : labelMap[f]}
            </button>
          ))}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#666', cursor: 'pointer' }}>
          <input type="checkbox" checked={polling} onChange={e => setPolling(e.target.checked)} />
          自动刷新
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#666', cursor: 'pointer' }}>
          <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
          自动滚动
        </label>
        <button
          className="slim-btn slim-btn--secondary"
          style={{ height: 28, padding: '0 10px', fontSize: 12 }}
          onClick={fetchLog}
        >
          刷新
        </button>
        <button
          className="slim-btn slim-btn--secondary"
          style={{ height: 28, padding: '0 10px', fontSize: 12 }}
          onClick={async () => { await window.electronAPI.log.clear(); setLogs([]); lastLogRef.current = '' }}
        >
          清空
        </button>
      </div>

      <div className="slim-log-panel" style={{
        flex: 1,
        background: '#050505',
        border: '1px solid var(--slim-border)',
        borderRadius: 8,
        overflow: 'auto',
        fontFamily: 'monospace',
        fontSize: 12,
        padding: '12px 16px',
      }}>
        {filtered.length === 0 && (
          <div style={{ color: '#444', textAlign: 'center', marginTop: 40 }}>
            暂无日志 {polling ? '' : '— 勾选「自动刷新」实时查看'}
          </div>
        )}
        {filtered.map((entry, i) => (
          <div key={i} style={{ display: 'flex', gap: 12, marginBottom: 4, lineHeight: 1.6 }}>
            {entry.time && <span style={{ color: '#444', flexShrink: 0 }}>{entry.time}</span>}
            <span style={{ color: colorMap[entry.type], flexShrink: 0, minWidth: 40 }}>[{labelMap[entry.type]}]</span>
            <span style={{ color: 'var(--slim-text)', wordBreak: 'break-all' }}>{entry.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

function now() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false })
}


