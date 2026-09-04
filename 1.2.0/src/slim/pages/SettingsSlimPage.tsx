import { useEffect, useState } from 'react'
import '../AppSlim.scss'

export default function SettingsSlimPage() {
  const [launchAtStartup, setLaunchAtStartup] = useState(false)
  const [silentStartup, setSilentStartup] = useState(false)
  const [logEnabled, setLogEnabled] = useState(false)
  const [version, setVersion] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  useEffect(() => {
    ;(async () => {
      const [startup, silent, log, ver] = await Promise.all([
        window.electronAPI.app.getLaunchAtStartupStatus(),
        window.electronAPI.config.get('silentStartup'),
        window.electronAPI.config.get('logEnabled'),
        window.electronAPI.app.getVersion(),
      ])
      setLaunchAtStartup(startup?.enabled === true)
      setSilentStartup(Boolean(silent))
      setLogEnabled(Boolean(log))
      if (ver) setVersion(String(ver))
    })()
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await window.electronAPI.app.setLaunchAtStartup(launchAtStartup)
      await window.electronAPI.config.set('silentStartup', silentStartup)
      await window.electronAPI.config.set('logEnabled', logEnabled)
      setSaveMsg('已保存')
    } catch (e) {
      setSaveMsg('保存失败：' + String(e))
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(''), 3000)
    }
  }

  const handleClearConfig = async () => {
    if (!confirm('确定重置所有配置？这将停止 Bridge、HTTP 服务、断开数据库，并清除日志。')) return

    setSaving(true)
    try {
      const result = await window.electronAPI.config.clear() as any
      setLaunchAtStartup(false)
      setSilentStartup(false)
      setLogEnabled(false)
      setSaveMsg(result?.success === false
        ? `重置完成，但有部分操作失败：${(result.errors || []).join('；')}`
        : '所有配置已重置，请重启应用')
    } catch (error) {
      setSaveMsg('重置失败：' + String(error))
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(''), 5000)
    }
  }

  return (
    <div>
      <h2 style={{ color: 'var(--slim-text)', fontWeight: 600, fontSize: 16, marginBottom: 20 }}>设置</h2>

      <div className="slim-card">
        <div className="slim-card__title">启动行为</div>

        <div className="slim-field">
          <label>开机自启</label>
          <label className="slim-toggle">
            <input type="checkbox" checked={launchAtStartup} onChange={e => setLaunchAtStartup(e.target.checked)} />
            <span className="slim-toggle__track" />
          </label>
        </div>

        <div className="slim-field">
          <label>静默启动</label>
          <label className="slim-toggle">
            <input type="checkbox" checked={silentStartup} onChange={e => setSilentStartup(e.target.checked)} />
            <span className="slim-toggle__track" />
          </label>
          <span style={{ fontSize: 12, color: '#555' }}>启动时最小化到系统托盘</span>
        </div>
      </div>

      <div className="slim-card">
        <div className="slim-card__title">调试</div>

        <div className="slim-field">
          <label>记录日志</label>
          <label className="slim-toggle">
            <input type="checkbox" checked={logEnabled} onChange={e => setLogEnabled(e.target.checked)} />
            <span className="slim-toggle__track" />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
          <button
            className="slim-btn slim-btn--secondary"
            onClick={() => window.electronAPI.log.getPath().then(p => window.electronAPI.shell.openPath(p))}
          >
            打开日志文件
          </button>
          <button
            className="slim-btn slim-btn--secondary"
            onClick={() => window.electronAPI.log.clear()}
          >
            清空日志
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 24 }}>
        <button className="slim-btn slim-btn--primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中...' : '保存设置'}
        </button>
        {saveMsg && (
          <span style={{ fontSize: 13, color: saveMsg.includes('失败') ? '#f87171' : 'var(--slim-accent)' }}>
            {saveMsg}
          </span>
        )}
      </div>

      <div className="slim-card">
        <div className="slim-card__title">危险区域</div>
        <p style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>
          清除所有已保存的配置，包括数据库路径、解密密钥和 API Token。
        </p>
        <button className="slim-btn slim-btn--danger" onClick={handleClearConfig} disabled={saving}>
          {saving ? '重置中...' : '一键重置所有配置'}
        </button>
      </div>

      <div style={{ fontSize: 12, color: '#333', marginTop: 8 }}>
        AstrWeChat · v{version}
      </div>
    </div>
  )
}
