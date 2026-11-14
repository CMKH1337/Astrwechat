import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  CircleAlert,
  CircleCheck,
  Download,
  FileText,
  Power,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
} from 'lucide-react'
import '../AppSlim.scss'
import './BridgePage.scss'
import BridgeWorkflow from './BridgeWorkflow'
import { appendWorkflowLog, clearWorkflowLogs, type WorkflowLogBatch } from './bridgeWorkflowEvents'
import { BOT_LABELS, requiresBridgeRestart, validateBridgeConnection } from '../../../shared/bridge-connection'
import { isSameConfig, type BridgeConfig } from './bridgeConfig'
import useBridgeConfig from './useBridgeConfig'
import useBridgeStatus from './useBridgeStatus'

type BridgeTab = 'overview' | 'logs' | 'config'

const parseNicknames = (value: string) =>
  value
    .split('\n')
    .map(item => item.trim())
    .filter(Boolean)

export default function BridgePage() {
  const { status, refreshStatus } = useBridgeStatus()
  const {
    config, setConfig, savedConfig, configHydrated, configLoading,
    configLoadError, configLoadWarning,
    loadBridgeConfig, applySavedConfig
  } = useBridgeConfig()
  const [logBatch, setLogBatch] = useState<WorkflowLogBatch>({ lines: [], sequence: 0, revision: 0 })
  const logs = logBatch.lines
  const [logsHydrated, setLogsHydrated] = useState(false)
  const [tab, setTab] = useState<BridgeTab>('overview')
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dependencySetup, setDependencySetup] = useState(false)
  const [dependencyMessage, setDependencyMessage] = useState('')
  const [saveMsg, setSaveMsg] = useState('')
  const [autoScroll, setAutoScroll] = useState(() => {
    try {
      return window.localStorage.getItem('astrwechat.bridge.logs.autoScroll') !== 'false'
    } catch {
      return true
    }
  })
  const [nicknamesInput, setNicknamesInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (configHydrated) setNicknamesInput(config.bot_nicknames.join('\n'))
  }, [configHydrated])

  const mergedConfig = useMemo<BridgeConfig>(() => ({
    ...config,
    bot_nicknames: parseNicknames(nicknamesInput)
  }), [config, nicknamesInput])

  const hasUnsavedChanges = configHydrated && !isSameConfig(mergedConfig, savedConfig)

  useEffect(() => {
    let disposed = false

    const initialRevision = logBatch.revision
    window.electronAPI.bridge.getLogs().then(value => {
      if (!disposed) setLogBatch(prev => prev.revision !== initialRevision ? prev : ({
        ...prev, lines: [...value, ...(prev.sequence ? prev.lines.slice(-Math.min(prev.sequence, prev.lines.length)) : [])].slice(-500)
      }))
    }).catch(() => {}).finally(() => {
      if (!disposed) setLogsHydrated(true)
    })
    const removeLog = window.electronAPI.bridge.onLog((msg: string) => {
      if (!disposed) setLogBatch(prev => appendWorkflowLog(prev, msg))
    })
    return () => {
      disposed = true
      removeLog()
    }
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem('astrwechat.bridge.logs.autoScroll', String(autoScroll))
    } catch {
      // Keep the in-memory preference when local storage is unavailable.
    }
  }, [autoScroll])

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs, autoScroll])

  const handleStart = async () => {
    setBusy(true)
    try {
      if (hasUnsavedChanges && !await persistConfig()) return
      const result = await window.electronAPI.bridge.start()
      if (!result.success) {
        setSaveMsg('启动失败：' + (result.error || ''))
        return
      }
      setTimeout(refreshStatus, 1000)
    } catch (error) {
      setSaveMsg('启动失败：' + String(error))
    } finally {
      setBusy(false)
    }
  }

  const handleStop = async () => {
    setBusy(true)
    try {
      const result = await window.electronAPI.bridge.stop()
      refreshStatus()
      if (!result?.success) setSaveMsg('停止失败：Bridge 进程未运行')
    } catch (error) {
      setSaveMsg('停止失败：' + String(error))
    } finally {
      setBusy(false)
    }
  }

  const handleRepairDependencies = async () => {
    setDependencySetup(true)
    setDependencyMessage('正在检查 Python 环境并补齐模块…')
    try {
      const result = await window.electronAPI.bridge.repairDependencies()
      setDependencyMessage(result.success
        ? 'Bridge 模块已补齐。以后启动将使用 AstrWeChat 专用环境。'
        : '补齐失败：' + (result.error || '未知错误'))
    } catch (error) {
      setDependencyMessage('补齐失败：' + String(error))
    } finally {
      setDependencySetup(false)
    }
  }

  const persistConfig = async () => {
    const invalid = validateBridgeConnection(mergedConfig)
    if (invalid) { setSaveMsg(invalid); return false }
    const result = await window.electronAPI.bridge.saveConfig(mergedConfig as any)
    if (!result.success) { setSaveMsg('保存失败：' + (result.error || '')); return false }
    const saved = applySavedConfig(result.config || { ...mergedConfig })
    setSaveMsg(result.warning || (result.restarted ? `配置已保存，正在连接 ${BOT_LABELS[saved.bot_backend]}` : '配置已保存'))
    refreshStatus()
    return true
  }

  const handleSaveConfig = async () => {
    setSaveMsg('')
    setSaving(true)
    try { await persistConfig() }
    catch (error) { setSaveMsg('保存失败：' + String(error)) }
    finally { setSaving(false) }
  }

  const logColor = (line: string) => {
    if (line.includes('[ERROR]')) return '#333'
    if (line.includes('[WARNING]') || line.includes('[WARN]')) return '#666'
    if (line.includes('✅') || line.includes('已连接') || line.includes('正常')) {
      return 'var(--slim-accent-strong)'
    }
    return '#222'
  }

  const syncLabel = hasUnsavedChanges
    ? '有未保存的修改'
    : (saveMsg || (configHydrated ? '配置已保存' : ''))

  const astrbotControlsGroups = config.bot_backend === 'astrbot'
  const groupReplyModeLabel = astrbotControlsGroups
    ? '由 AstrBot 控制'
    : config.group_reply_mode === 'all'
    ? '响应所有消息'
    : config.group_reply_mode === 'batch'
      ? '批量合并'
      : '响应@'

  const liveBackend = status.processRunning ? (status.bot_backend || savedConfig.bot_backend) : savedConfig.bot_backend
  const liveLabel = BOT_LABELS[liveBackend]
  const connectionState = status.ob_connected ? (liveBackend === 'builtin' ? '已就绪' : '已连接')
    : status.starting ? '启动中'
    : status.ob_state === 'connecting' ? '连接中'
    : status.ob_state === 'stopping' ? '正在停止'
    : status.ob_state === 'error' ? '连接异常' : '未连接'
  const willReconnect = status.processRunning && requiresBridgeRestart(savedConfig, mergedConfig)
  const saveLabel = willReconnect
    ? (savedConfig.bot_backend !== config.bot_backend ? `保存并切换至 ${BOT_LABELS[config.bot_backend]}` : '保存并重新连接')
    : '保存配置'

  return (
    <div className="bridge-page">
      <div className="bridge-page__header">
        <h2>AstrWeChat</h2>
        <span className={`slim-badge ${status.processRunning ? (status.running ? 'slim-badge--ok' : 'slim-badge--warn') : 'slim-badge--idle'}`}>
          {status.starting ? '正在启动' : status.processRunning ? (status.running ? 'AstrWeChat 运行中' : '进程已启动') : '未启动'}
        </span>
        <span className={`slim-badge ${status.ob_connected ? 'slim-badge--ok' : 'slim-badge--idle'}`}>
          {liveLabel} {connectionState}
        </span>
        <div className="bridge-page__header-actions">
          {!status.processRunning
            ? (
              <button className="slim-btn slim-btn--primary" onClick={handleStart} disabled={busy || status.starting || saving || !configHydrated}>
                <Power size={14} />
                {busy || status.starting ? '启动中...' : hasUnsavedChanges ? '保存并启动' : '启动 AstrWeChat'}
              </button>
            )
            : (
              <button className="slim-btn slim-btn--danger" onClick={handleStop} disabled={busy || status.starting || saving || !configHydrated}>
                <Power size={14} />
                {busy ? '停止中...' : '停止 AstrWeChat'}
              </button>
            )}
        </div>
      </div>

      {configLoading && <div className="bridge-connection-notice" role="status">正在读取 Bridge 配置…</div>}
      {configLoadError && (
        <div className="bridge-connection-notice" role="alert">
          <span>配置读取失败：{configLoadError}。已有配置不会被默认值覆盖。</span>
          <button className="slim-btn slim-btn--secondary" onClick={() => void loadBridgeConfig()} disabled={configLoading}>
            <RefreshCw size={14} />重新读取配置
          </button>
        </div>
      )}
      {configLoadWarning && <div className="bridge-connection-notice" role="alert">{configLoadWarning}</div>}

      {(saveMsg || status.ob_error || status.starting) && (
        <div className="bridge-connection-notice" role="status" aria-live="polite">
          {status.starting && <span>{status.startup_stage || '正在准备微信消息接收…'}</span>}
          {saveMsg && <span>{saveMsg}</span>}
          {status.ob_error && <span>{status.ob_error}</span>}
        </div>
      )}

      <div className="bridge-tabs" role="tablist">
        {([
          ['overview', '概览', Activity],
          ['logs', '日志', FileText],
          ['config', '基础配置', Settings2]
        ] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`bridge-tab ${tab === id ? 'is-active' : ''}`}
            onClick={() => setTab(id)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
        {syncLabel && (
          <span className={`bridge-sync-label ${hasUnsavedChanges ? 'is-dirty' : ''}`}>
            {hasUnsavedChanges ? <CircleAlert size={13} /> : <CircleCheck size={13} />}
            {syncLabel}
          </span>
        )}
      </div>

      <div className={`bridge-overview-grid ${tab === 'overview' ? '' : 'is-hidden'}`}>
          <section className="slim-card bridge-overview-card">
            <div className="bridge-card-heading">
              <span className="bridge-card-heading__icon"><Activity size={16} /></span>
              <h3>运行状态</h3>
            </div>
            <div className="bridge-status-list">
              <div className={`bridge-status-row ${status.running ? 'is-ok' : ''}`}>
                <span>{status.running ? <CircleCheck size={15} /> : <CircleAlert size={15} />}</span>
                <strong>AstrWeChat</strong>
                <em>{status.running ? '运行中' : (status.processRunning ? '连接中' : '未启动')}</em>
              </div>
              <div className={`bridge-status-row ${status.ob_connected ? 'is-ok' : ''}`}>
                <span>{status.ob_connected ? <CircleCheck size={15} /> : <CircleAlert size={15} />}</span>
                <strong>{liveLabel}</strong>
                <em>{connectionState}</em>
              </div>
              <div className={`bridge-status-row ${status.processRunning ? 'is-ok' : ''}`}>
                <span>{status.processRunning ? <CircleCheck size={15} /> : <CircleAlert size={15} />}</span>
                <strong>Bridge 进程</strong>
                <em>{status.processRunning ? '已启动' : '未启动'}</em>
              </div>
              <div className={`bridge-status-row ${configHydrated && !hasUnsavedChanges ? 'is-ok' : ''}`}>
                <span>{configHydrated && !hasUnsavedChanges ? <CircleCheck size={15} /> : <CircleAlert size={15} />}</span>
                <strong>配置</strong>
                <em>{hasUnsavedChanges ? '有未保存的修改' : (configHydrated ? '已保存' : '读取中')}</em>
              </div>
            </div>
            <div className="bridge-overview-actions">
              {!status.processRunning
                ? <button className="slim-btn slim-btn--primary" onClick={handleStart} disabled={busy || status.starting || saving || !configHydrated}><Power size={14} />{busy || status.starting ? '启动中...' : '启动'}</button>
                : <button className="slim-btn slim-btn--danger" onClick={handleStop} disabled={busy || status.starting || saving || !configHydrated}><Power size={14} />{busy ? '停止中...' : '停止'}</button>}
            </div>
          </section>

          <BridgeWorkflow logs={logs} ready={logsHydrated} sequence={logBatch.sequence} revision={logBatch.revision} />

          <section className="slim-card bridge-overview-card">
            <div className="bridge-card-heading">
              <span className="bridge-card-heading__icon"><FileText size={16} /></span>
              <h3>回复策略</h3>
            </div>
            <div className="bridge-summary-list">
              <div><span>群聊回复</span><strong>{groupReplyModeLabel}</strong></div>
              {astrbotControlsGroups && <div><span>群消息转发</span><strong>逐条交给 AstrBot</strong></div>}
              <div><span>{astrbotControlsGroups ? '私聊消息缓冲' : '消息缓冲'}</span><strong>{config.buffer_seconds} 秒</strong></div>
            </div>
          </section>

      </div>

      {tab === 'logs' && (
        <div className="bridge-log-view">
          <div className="bridge-log-toolbar">
            <label>
              <input type="checkbox" checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)} />
              自动滚动到底部
            </label>
            <button
              className="slim-btn slim-btn--secondary"
              onClick={() => { void window.electronAPI.bridge.clearLogs(); setLogBatch(clearWorkflowLogs) }}
            >
              <Trash2 size={14} />
              清空
            </button>
          </div>
          <div className="slim-log-panel bridge-log-panel">
            {logs.length === 0 && (
              <div className="bridge-empty">暂无日志，启动 AstrWeChat 后显示</div>
            )}
            {logs.map((line, index) => (
              <div key={index} style={{ color: logColor(line) }}>{line}</div>
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
      )}

      {tab === 'config' && (
        <div className="bridge-config-view">
          <section className="slim-card" aria-labelledby="bridge-python-dependencies-title">
            <div className="slim-card__title" id="bridge-python-dependencies-title">Python 模块</div>
            <div className="bridge-connection-notice" role="note">
              自动检测 AstrWeChat 当前可用的 Python，并把 Bridge 模块安装到独立环境，不修改电脑上的其他 Python。首次补齐需要联网；请先停止正在运行的 Bridge。
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 12 }}>
              <button
                className="slim-btn slim-btn--secondary"
                onClick={() => void handleRepairDependencies()}
                disabled={dependencySetup || status.processRunning || status.starting}
              >
                <Download size={14} />
                {dependencySetup ? '正在补齐模块…' : '一键检查并补齐模块'}
              </button>
              {dependencyMessage && <span role="status" aria-live="polite">{dependencyMessage}</span>}
            </div>
          </section>
          <fieldset className="bridge-edit-fields" disabled={saving || busy || status.starting || !configHydrated}>


          <div className="slim-card">
            <div className="slim-card__title">机器人身份</div>
            <div className="slim-field slim-field--top">
              <label>Bot 昵称</label>
              <textarea
                value={nicknamesInput}
                onChange={event => setNicknamesInput(event.target.value)}
                placeholder="每行一个昵称（用于过滤自身消息和检测 @ 提及）"
                rows={3}
              />
            </div>
          </div>

          <div className="slim-card">
            <div className="slim-card__title">行为设置</div>
            <div className="slim-field">
              <label htmlFor="uia-direct-window">独立窗口发送
                <span>直接激活已打开的目标聊天窗口，不使用搜索；切换后保存会重启 Bridge</span>
              </label>
              <label className="slim-toggle">
                <input
                  id="uia-direct-window"
                  type="checkbox"
                  checked={config.uia_direct_window}
                  onChange={event => setConfig(prev => ({ ...prev, uia_direct_window: event.target.checked }))}
                />
                <span className="slim-toggle__track" />
              </label>
            </div>
            {config.uia_direct_window && (
              <div className="bridge-config-warning" role="alert">
                请手动将需要发送的会话打开为独立聊天窗口，并保持窗口存在，可最小化。
                发送时会将目标窗口置前，请保持聊天输入框可输入，避免同时操作微信。
                未打开、标题不匹配或存在同名窗口时将停止发送，不会回退搜索。
              </div>
            )}
            <div className="slim-field">
              <label>以微信ID查找联系人</label>
              <label className="slim-toggle">
                <input
                  type="checkbox"
                  checked={config.search_by_wxid}
                  disabled={config.uia_direct_window}
                  onChange={event => setConfig(prev => ({ ...prev, search_by_wxid: event.target.checked }))}
                />
                <span className="slim-toggle__track" />
              </label>
            </div>
            {!astrbotControlsGroups && (
              <div className="slim-field">
                <label>群聊模式</label>
                <select
                  value={config.group_reply_mode}
                  onChange={event => setConfig(prev => ({ ...prev, group_reply_mode: event.target.value }))}
                  className="bridge-select"
                >
                  <option value="mention">仅响应 @Bot</option>
                  <option value="all">响应所有消息</option>
                </select>
              </div>
            )}
            <div className="slim-field">
              <label>{astrbotControlsGroups ? '私聊消息缓冲' : '消息缓冲'}</label>
              <input
                type="number"
                value={config.buffer_seconds}
                min={0}
                max={30}
                onChange={event => setConfig(prev => ({ ...prev, buffer_seconds: Number(event.target.value) }))}
                className="bridge-number-input"
              />
              <span className="slim-field__inline-hint">{astrbotControlsGroups ? '秒（群消息始终逐条转发）' : '秒（合并短时间内连续消息）'}</span>
            </div>
            <div className="slim-field">
              <label>附件目录</label>
              <input type="text" value={config.astrbot_attachments} onChange={event => setConfig(prev => ({ ...prev, astrbot_attachments: event.target.value }))} placeholder="AstrBot 附件保存路径（可选）" />
            </div>
          </div>

          </fieldset>

          <div className="bridge-save-actions">
            <button className="slim-btn slim-btn--primary" onClick={handleSaveConfig} disabled={saving || busy || !configHydrated}>
              <Save size={14} />
              {saving ? '保存并应用中...' : saveLabel}
            </button>
            <span className="bridge-save-feedback" role="status" aria-live="polite" aria-atomic="true">
              {saving ? '正在保存并应用配置…' : saveMsg}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
