import { useEffect, useMemo, useState } from 'react'
import { Save } from 'lucide-react'
import LocalCommandSettings from './LocalCommandSettings'
import { normalizeLocalCommandConfig, type LocalCommandConfig } from '../../../shared/local-commands'
import './AWConfigPage.scss'

const EMPTY_CONFIG = normalizeLocalCommandConfig({})

export default function AWConfigPage() {
  const [config, setConfig] = useState<LocalCommandConfig>(EMPTY_CONFIG)
  const [savedConfig, setSavedConfig] = useState<LocalCommandConfig>(EMPTY_CONFIG)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const dirty = useMemo(
    () => JSON.stringify(config) !== JSON.stringify(savedConfig),
    [config, savedConfig]
  )

  useEffect(() => {
    let disposed = false
    window.electronAPI.bridge.getConfig()
      .then(result => {
        if (disposed) return
        if (!result?.success || !result.config || typeof result.config !== 'object' || Array.isArray(result.config)) {
          throw new Error(result?.error || 'AW 配置读取失败')
        }
        const loaded = normalizeLocalCommandConfig(result.config as Record<string, unknown>)
        setConfig(loaded)
        setSavedConfig(loaded)
        setLoaded(true)
      })
      .catch(reason => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => { disposed = true }
  }, [])

  const save = async () => {
    setSaving(true)
    setMessage('')
    setError('')
    try {
      const result = await window.electronAPI.bridge.saveConfig(config as unknown as Record<string, unknown>)
      if (!result.success) throw new Error(result.error || '保存失败')
      const saved = normalizeLocalCommandConfig((result.config || config) as Record<string, unknown>)
      setConfig(saved)
      setSavedConfig(saved)
      setMessage('AW 配置已保存并立即生效')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="aw-config-page__state">正在读取 AW 配置…</div>
  if (error && !loaded) {
    return <div className="aw-config-page__state aw-config-page__state--error">读取失败：{error}</div>
  }

  return (
    <div className="aw-config-page">
      <div className="aw-config-page__intro">
        <h2>AW 配置</h2>
        <p>管理 #aw 菜单及本地指令权限、回溯附件缓存期限与容量。这里的消息不会发送给机器人服务端。</p>
      </div>
      <LocalCommandSettings
        config={config}
        onChange={patch => {
          setConfig(previous => ({ ...previous, ...patch }))
          setMessage('')
          setError('')
        }}
      />
      <div className="aw-config-page__actions">
        <span className={error ? 'is-error' : dirty ? 'is-dirty' : ''} role="status" aria-live="polite">
          {error ? `保存失败：${error}` : message || (dirty ? '有未保存的修改' : '配置已保存')}
        </span>
        <button type="button" className="slim-btn slim-btn--primary" disabled={saving || !dirty} onClick={save}>
          <Save size={14} />
          {saving ? '保存中…' : '保存 AW 配置'}
        </button>
      </div>
    </div>
  )
}
