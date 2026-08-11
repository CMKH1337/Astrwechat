import { useEffect, useRef, useState } from 'react'
import '../AppSlim.scss'

interface BridgeStatus {
  running: boolean
  paused: boolean
  ob_connected: boolean
  weflow_url?: string
  ob_url?: string
  processRunning: boolean
}

interface BridgeConfig {
  weflow_base_url: string
  access_token: string
  astrbot_ob_url: string
  bot_nicknames: string[]
  bot_wxid: string
  buffer_seconds: number
  group_reply_mode: string
  astrbot_attachments: string
}

const DEFAULT_CONFIG: BridgeConfig = {
  weflow_base_url: 'http://127.0.0.1:5031',
  access_token: '',
  astrbot_ob_url: 'ws://127.0.0.1:11229/ws',
  bot_nicknames: [],
  bot_wxid: '',
  buffer_seconds: 0,
  group_reply_mode: 'mention',
  astrbot_attachments: '',
}

export default function BridgePage() {
  const [status, setStatus] = useState<BridgeStatus>({ running: false, paused: false, ob_connected: false, processRunning: false })
  const [config, setConfig] = useState<BridgeConfig>(DEFAULT_CONFIG)
  const [logs, setLogs] = useState<string[]>([])
  const [tab, setTab] = useState<'status' | 'config'>('status')
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [nicknamesInput, setNicknamesInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // 加载初始状态和配置
    window.electronAPI.bridge.status().then((s: any) => setStatus(s)).catch(() => {})
    window.electronAPI.bridge.getLogs().then((l: string[]) => setLogs(l)).catch(() => {})
    window.electronAPI.bridge.getConfig().then((r: any) => {
      if (r?.success && r.config) {
        setConfig({ ...DEFAULT_CONFIG, ...r.config })
        setNicknamesInput((r.config.bot_nicknames || []).join('\n'))
      }
    }).catch(() => {})

    // 监听实时日志和状态
    const removeLog = window.electronAPI.bridge.onLog((msg: string) => {
      setLogs(prev => {
        const next = [...prev, msg]
        return next.length > 500 ? next.slice(-500) : next
      })
    })
    const removeStatus = window.electronAPI.bridge.onStatus((s: any) => setStatus(prev => ({ ...prev, ...s })))

    const timer = setInterval(() => {
      window.electronAPI.bridge.status().then((s: any) => setStatus(s)).catch(() => {})
    }, 3000)

    return () => { removeLog(); removeStatus(); clearInterval(timer) }
  }, [])

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs, autoScroll])

  const refreshStatus = () => {
    window.electronAPI.bridge.status().then((s: any) => setStatus(s)).catch(() => {})
  }

  const handleStart = async () => {
    setBusy(true)
    try {
      const r = await window.electronAPI.bridge.start() as any
      if (!r.success) {
        setSaveMsg('启动失败：' + (r.error || ''))
        setTimeout(() => setSaveMsg(''), 3000)
        return
      }
      setTimeout(refreshStatus, 1000)
    } catch (e) {
      setSaveMsg('启动失败：' + String(e))
      setTimeout(() => setSaveMsg(''), 3000)
    } finally {
      setBusy(false)
    }
  }

  const handleStop = async () => {
    setBusy(true)
    try {
      const result = await window.electronAPI.bridge.stop() as any
      refreshStatus()
      if (!result?.success) {
        setSaveMsg('停止失败：Bridge 进程未运行')
        setTimeout(() => setSaveMsg(''), 3000)
      }
    } catch (e) {
      setSaveMsg('停止失败：' + String(e))
      setTimeout(() => setSaveMsg(''), 3000)
    } finally {
      setBusy(false)
    }
  }

  const handleSaveConfig = async () => {
    setSaving(true)
    const merged = {
      ...config,
      bot_nicknames: nicknamesInput.split('\n').map(s => s.trim()).filter(Boolean)
    }
    try {
      const r = await window.electronAPI.bridge.saveConfig(merged as any) as any
      setSaveMsg(r.success ? '配置已保存' : '保存失败：' + r.error)
      if (r.success) setConfig(merged)
    } catch (e) {
      setSaveMsg('保存失败：' + String(e))
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(''), 3000)
    }
  }

  const logColor = (line: string) => {
    if (line.includes('[ERROR]')) return '#f87171'
    if (line.includes('[WARNING]') || line.includes('[WARN]')) return '#fbbf24'
    if (line.includes('✅') || line.includes('已连接') || line.includes('正常')) return 'var(--slim-accent)'
    return 'var(--slim-text)'
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 16 }}>
      {/* 状态栏 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ color: 'var(--slim-text)', fontWeight: 600, fontSize: 16, margin: 0 }}>AstrWeChat</h2>
        <span className={`slim-badge ${status.processRunning ? (status.running ? 'slim-badge--ok' : 'slim-badge--warn') : 'slim-badge--idle'}`}>
          {status.processRunning ? (status.running ? 'AstrWeChat 运行中' : '进程已启动') : '未启动'}
        </span>
        <span className={`slim-badge ${status.ob_connected ? 'slim-badge--ok' : 'slim-badge--idle'}`}>
          {status.ob_connected ? 'AstrBot 已连接' : 'AstrBot 未连接'}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {!status.processRunning
            ? <button className="slim-btn slim-btn--primary" onClick={handleStart} disabled={busy}>{busy ? '启动中...' : '启动 AstrWeChat'}</button>
            : <button className="slim-btn slim-btn--danger" onClick={handleStop} disabled={busy}>{busy ? '停止中...' : '停止 AstrWeChat'}</button>
          }
        </div>
      </div>

      {/* 子标签 */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #222', paddingBottom: 8 }}>
        {(['status', 'config'] as const).map(t => (
          <button
            key={t}
            className="slim-btn slim-btn--secondary"
            style={{ height: 28, padding: '0 14px', fontSize: 12, opacity: tab === t ? 1 : 0.5 }}
            onClick={() => setTab(t)}
          >
            {{ status: '日志', config: '基础配置' }[t]}
          </button>
        ))}
        {saveMsg && <span style={{ marginLeft: 'auto', fontSize: 12, color: saveMsg.includes('失败') ? '#f87171' : 'var(--slim-accent)', alignSelf: 'center' }}>{saveMsg}</span>}
      </div>

      {/* 日志面板 */}
      {tab === 'status' && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: '#666', cursor: 'pointer' }}>
              <input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)} />
              自动滚动
            </label>
            <button className="slim-btn slim-btn--secondary" style={{ height: 26, padding: '0 10px', fontSize: 11 }}
              onClick={() => { window.electronAPI.bridge.clearLogs(); setLogs([]) }}>
              清空
            </button>
          </div>
          <div className="slim-log-panel" style={{
            flex: 1, background: '#050505', border: '1px solid var(--slim-border)', borderRadius: 8,
            overflow: 'auto', fontFamily: 'monospace', fontSize: 12, padding: '10px 14px'
          }}>
            {logs.length === 0 && <div style={{ color: '#444', textAlign: 'center', marginTop: 30 }}>暂无日志，启动 AstrWeChat 后显示</div>}
            {logs.map((line, i) => (
              <div key={i} style={{ color: logColor(line), marginBottom: 3, lineHeight: 1.6, wordBreak: 'break-all' }}>{line}</div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
      )}

      {/* 基础配置 */}
      {tab === 'config' && (
        <div style={{ overflow: 'auto', flex: 1 }}>
          <div className="slim-card">
            <div className="slim-card__title">连接设置</div>
            <div className="slim-field">
              <label>WeFlow 地址</label>
              <input type="text" value={config.weflow_base_url} onChange={e => setConfig(p => ({ ...p, weflow_base_url: e.target.value }))} />
            </div>
            <div className="slim-field">
              <label>Access Token</label>
              <input type="text" value={config.access_token} onChange={e => setConfig(p => ({ ...p, access_token: e.target.value }))} placeholder="与 WeFlow API 服务中设置的 Token 一致" />
            </div>
            <div className="slim-field">
              <label>AstrBot WS</label>
              <input type="text" value={config.astrbot_ob_url} onChange={e => setConfig(p => ({ ...p, astrbot_ob_url: e.target.value }))} placeholder="ws://127.0.0.1:11229/ws" />
            </div>
          </div>

          <div className="slim-card">
            <div className="slim-card__title">机器人身份</div>
            <div className="slim-field">
              <label>Bot 微信 ID</label>
              <input type="text" value={config.bot_wxid} onChange={e => setConfig(p => ({ ...p, bot_wxid: e.target.value }))} placeholder="wxid_xxxxxxxx" />
            </div>
            <div className="slim-field" style={{ alignItems: 'flex-start' }}>
              <label style={{ paddingTop: 8 }}>Bot 昵称</label>
              <textarea
                value={nicknamesInput}
                onChange={e => setNicknamesInput(e.target.value)}
                placeholder="每行一个昵称（用于过滤自身消息和检测 @ 提及）"
                rows={3}
                style={{
                  flex: 1, background: '#050505', border: '1px solid var(--slim-border)', borderRadius: 6,
                  color: 'var(--slim-text)', fontSize: 13, padding: '8px 10px', resize: 'vertical', outline: 'none'
                }}
              />
            </div>
          </div>

          <div className="slim-card">
            <div className="slim-card__title">行为设置</div>
            <div className="slim-field">
              <label>群聊模式</label>
              <select
                value={config.group_reply_mode}
                onChange={e => setConfig(p => ({ ...p, group_reply_mode: e.target.value }))}
                style={{ flex: 1, height: 34, background: '#050505', border: '1px solid var(--slim-border)', borderRadius: 6, color: 'var(--slim-text)', fontSize: 13, padding: '0 10px' }}
              >
                <option value="mention">仅响应 @Bot</option>
                <option value="all">响应所有消息</option>
              </select>
            </div>
            <div className="slim-field">
              <label>消息缓冲</label>
              <input type="number" value={config.buffer_seconds} min={0} max={30}
                onChange={e => setConfig(p => ({ ...p, buffer_seconds: Number(e.target.value) }))}
                style={{ maxWidth: 80 }} />
              <span style={{ fontSize: 12, color: '#555' }}>秒（合并短时间内连续消息）</span>
            </div>
            <div className="slim-field">
              <label>附件目录</label>
              <input type="text" value={config.astrbot_attachments} onChange={e => setConfig(p => ({ ...p, astrbot_attachments: e.target.value }))} placeholder="AstrBot 附件保存路径（可选）" />
            </div>
          </div>

          <button className="slim-btn slim-btn--primary" onClick={handleSaveConfig} disabled={saving}>
            {saving ? '保存中...' : '保存配置'}
          </button>
        </div>
      )}

    </div>
  )
}
