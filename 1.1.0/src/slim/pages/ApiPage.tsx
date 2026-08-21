import { useEffect, useState } from 'react'
import '../AppSlim.scss'

interface Props {
  dbConnected: boolean
}

export default function ApiPage({ dbConnected }: Props) {
  const [apiEnabled, setApiEnabled] = useState(false)
  const [pushEnabled, setPushEnabled] = useState(false)
  const [port, setPort] = useState(5031)
  const [host, setHost] = useState('127.0.0.1')
  const [token, setToken] = useState('')
  const [serverStatus, setServerStatus] = useState<'stopped' | 'running' | 'starting' | 'stopping'>('stopped')
  const [actualPort, setActualPort] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  useEffect(() => {
    ;(async () => {
      const [en, push, p, h, t] = await Promise.all([
        window.electronAPI.config.get('httpApiEnabled'),
        window.electronAPI.config.get('messagePushEnabled'),
        window.electronAPI.config.get('httpApiPort'),
        window.electronAPI.config.get('httpApiHost'),
        window.electronAPI.config.get('httpApiToken'),
      ])
      setApiEnabled(Boolean(en))
      setPushEnabled(Boolean(push))
      if (p) setPort(Number(p))
      if (h) setHost(String(h))
      if (t) setToken(String(t))

      // 查询当前运行状态
      refreshStatus()
    })()
  }, [])

  const refreshStatus = async () => {
    try {
      const s = await window.electronAPI.http.status()
      setServerStatus(s?.running ? 'running' : 'stopped')
      if (s?.port) setActualPort(s.port)
    } catch {
      setServerStatus('stopped')
    }
  }

  const handleSaveAndStart = async () => {
    setSaving(true)
    setSaveMsg('')
    try {
      const shouldRunApi = apiEnabled || pushEnabled
      if (shouldRunApi && !apiEnabled) setApiEnabled(true)
      await window.electronAPI.config.set('httpApiEnabled', shouldRunApi)
      await window.electronAPI.config.set('messagePushEnabled', pushEnabled)
      await window.electronAPI.config.set('httpApiPort', port)
      await window.electronAPI.config.set('httpApiHost', host)
      if (token) await window.electronAPI.config.set('httpApiToken', token)

      if (shouldRunApi) {
        setServerStatus('starting')
        const result = await window.electronAPI.http.start(port, host)
        if (result?.success) {
          setServerStatus('running')
          setActualPort(result.port || port)
          setSaveMsg('服务已启动')
        } else {
          setServerStatus('stopped')
          setSaveMsg('启动失败：' + (result?.error || '未知错误'))
        }
      } else {
        setServerStatus('stopping')
        await window.electronAPI.http.stop()
        setServerStatus('stopped')
        setActualPort(null)
        setSaveMsg('服务已停止')
      }
    } catch (e) {
      setSaveMsg('操作失败：' + String(e))
      setServerStatus('stopped')
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(''), 3000)
    }
  }

  const genToken = () => {
    const arr = new Uint8Array(24)
    crypto.getRandomValues(arr)
    setToken(Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join(''))
  }

  const statusBadge = () => {
    if (serverStatus === 'running') return <span className="slim-badge slim-badge--ok">运行中{actualPort ? ` :${actualPort}` : ''}</span>
    if (serverStatus === 'starting') return <span className="slim-badge slim-badge--warn">启动中...</span>
    if (serverStatus === 'stopping') return <span className="slim-badge slim-badge--warn">停止中...</span>
    return <span className="slim-badge slim-badge--idle">已停止</span>
  }

  return (
    <div>
      <h2 style={{ color: 'var(--slim-text)', fontWeight: 600, fontSize: 16, marginBottom: 20 }}>HTTP API 服务</h2>

      {!dbConnected && (
        <div style={{ background: '#2e2a1a', border: '1px solid #4a3f0a', borderRadius: 8, padding: '12px 16px', marginBottom: 16, fontSize: 13, color: '#fbbf24' }}>
          ⚠️ 请先在「连接」页面连接微信数据库，否则消息推送无法工作
        </div>
      )}

      <div className="slim-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div className="slim-card__title" style={{ margin: 0 }}>服务状态</div>
          {statusBadge()}
        </div>

        <div className="slim-field">
          <label>启用 API</label>
          <label className="slim-toggle">
            <input type="checkbox" checked={apiEnabled} onChange={async e => {
              const val = e.target.checked
              setApiEnabled(val)
              await window.electronAPI.config.set('httpApiEnabled', val)
            }} />
            <span className="slim-toggle__track" />
          </label>
        </div>

        <div className="slim-field">
          <label>主动推送</label>
          <label className="slim-toggle">
            <input type="checkbox" checked={pushEnabled} onChange={async e => {
              const val = e.target.checked
              setPushEnabled(val)
              await window.electronAPI.config.set('messagePushEnabled', val)
            }} />
            <span className="slim-toggle__track" />
          </label>
          <span style={{ fontSize: 12, color: '#555' }}>接收新消息时推送到 SSE 订阅端</span>
        </div>
      </div>

      <div className="slim-card">
        <div className="slim-card__title">监听地址</div>

        <div className="slim-field">
          <label>监听 Host</label>
          <input type="text" value={host} onChange={e => setHost(e.target.value)} placeholder="127.0.0.1" />
        </div>

        <div className="slim-field">
          <label>端口</label>
          <input type="number" value={port} onChange={e => setPort(Number(e.target.value))} min={1024} max={65535} style={{ maxWidth: 100 }} />
        </div>
      </div>

      <div className="slim-card">
        <div className="slim-card__title">鉴权 Token</div>

        <div className="slim-field">
          <label>Access Token</label>
          <input type="text" value={token} onChange={e => setToken(e.target.value)} placeholder="留空则无需鉴权（不推荐）" />
          <button className="slim-btn slim-btn--secondary" onClick={genToken}>随机生成</button>
        </div>
        <div className="slim-field__hint">SSE 订阅时在 URL 后追加 ?access_token=&lt;token&gt;</div>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button
          className="slim-btn slim-btn--primary"
          onClick={handleSaveAndStart}
          disabled={saving}
        >
          {saving ? '处理中...' : '保存并应用'}
        </button>
        <button className="slim-btn slim-btn--secondary" onClick={refreshStatus}>刷新状态</button>
        {saveMsg && <span style={{ fontSize: 13, color: saveMsg.includes('失败') ? '#f87171' : 'var(--slim-accent)' }}>{saveMsg}</span>}
      </div>

      {serverStatus === 'running' && (
        <div className="slim-card" style={{ marginTop: 20 }}>
          <div className="slim-card__title">接入端点</div>
          <div style={{ fontSize: 12, color: 'var(--slim-text-muted)', fontFamily: 'monospace', lineHeight: 2 }}>
            <div style={{ color: 'var(--slim-text-muted)' }}>消息推送 (SSE)：</div>
            <div style={{ color: 'var(--slim-accent)' }}>GET http://{host}:{actualPort || port}/api/v1/push/messages?access_token={token || '...'}</div>
            <div style={{ color: 'var(--slim-text-muted)', marginTop: 8 }}>健康检查：</div>
            <div style={{ color: 'var(--slim-accent)' }}>GET http://{host}:{actualPort || port}/health</div>
          </div>
        </div>
      )}
    </div>
  )
}
