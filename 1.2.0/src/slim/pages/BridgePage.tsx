import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  FileText,
  Plus,
  Power,
  RefreshCw,
  Save,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Users,
  X
} from 'lucide-react'
import '../AppSlim.scss'
import './BridgePage.scss'
import bridgeDefaultConfig from '../../../shared/bridge-default-config.json'
import BridgeWorkflow from './BridgeWorkflow'

type GroupReplyFilterMode = 'whitelist' | 'blacklist'
type BridgeTab = 'overview' | 'logs' | 'config'
type ScanState = 'idle' | 'scanning' | 'success' | 'error'

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
  astrbot_ob_token: string
  bot_nicknames: string[]
  bot_wxid: string
  search_by_wxid: boolean
  buffer_seconds: number
  group_reply_mode: string
  active_reply_enabled: boolean
  active_reply_probability: number
  group_reply_filter_mode: GroupReplyFilterMode
  group_reply_filter_sessions: string[]
  astrbot_attachments: string
}

interface GroupSessionOption {
  id: string
  name: string
  displayName: string
}

const DEFAULT_CONFIG: BridgeConfig = {
  ...bridgeDefaultConfig,
  group_reply_filter_mode:
    bridgeDefaultConfig.group_reply_filter_mode === 'whitelist'
      ? 'whitelist'
      : 'blacklist',
  group_reply_filter_sessions: Array.isArray(
    bridgeDefaultConfig.group_reply_filter_sessions
  )
    ? [...bridgeDefaultConfig.group_reply_filter_sessions]
    : []
}

const parseTextEntries = (value: string) =>
  value
    .split(/[\s,，]+/)
    .map(item => item.trim())
    .filter(Boolean)

const parseNicknames = (value: string) =>
  value
    .split('\n')
    .map(item => item.trim())
    .filter(Boolean)

const shortSessionId = (sessionId: string) => {
  const id = sessionId.endsWith('@chatroom')
    ? sessionId.slice(0, -'@chatroom'.length)
    : sessionId
  return id.length > 8 ? `…${id.slice(-7)}` : id
}

const groupDisplayName = (
  value: {
    username?: string
    displayName?: string
    summary?: string
  } | undefined
) => {
  const username = String(value?.username || '').trim()
  const displayName = String(value?.displayName || '').trim()
  const summary = String(value?.summary || '').trim()
  return displayName && displayName !== username
    ? displayName
    : summary || displayName || username || '未命名群聊'
}

const toNumber = (value: unknown, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const normalizeSessionIds = (value: unknown) =>
  Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map(item => String(item).trim())
        .filter(Boolean)
    )
  )

const normalizeLoadedConfig = (raw: Record<string, unknown>) => {
  const legacySessions = normalizeSessionIds(raw.active_reply_whitelist)
  const hasNewFilter = (
    raw.group_reply_filter_mode === 'whitelist'
    || raw.group_reply_filter_mode === 'blacklist'
  )
  const mode: GroupReplyFilterMode = hasNewFilter
    ? raw.group_reply_filter_mode as GroupReplyFilterMode
    : (legacySessions.length > 0 ? 'whitelist' : 'blacklist')
  const sessions = hasNewFilter
    ? normalizeSessionIds(raw.group_reply_filter_sessions)
    : legacySessions

  return {
    migrated: !hasNewFilter && legacySessions.length > 0,
    config: {
      weflow_base_url: String(raw.weflow_base_url ?? DEFAULT_CONFIG.weflow_base_url),
      access_token: String(raw.access_token ?? ''),
      astrbot_ob_url: String(raw.astrbot_ob_url ?? DEFAULT_CONFIG.astrbot_ob_url),
      astrbot_ob_token: String(raw.astrbot_ob_token ?? ''),
      bot_nicknames: Array.isArray(raw.bot_nicknames)
        ? raw.bot_nicknames.map(item => String(item)).filter(Boolean)
        : [],
      bot_wxid: String(raw.bot_wxid ?? ''),
      search_by_wxid: raw.search_by_wxid === true,
      buffer_seconds: toNumber(raw.buffer_seconds, DEFAULT_CONFIG.buffer_seconds),
      group_reply_mode: String(raw.group_reply_mode ?? DEFAULT_CONFIG.group_reply_mode),
      active_reply_enabled: raw.active_reply_enabled === true,
      active_reply_probability: Math.min(
        1,
        Math.max(0, toNumber(raw.active_reply_probability, DEFAULT_CONFIG.active_reply_probability))
      ),
      group_reply_filter_mode: mode,
      group_reply_filter_sessions: sessions,
      astrbot_attachments: String(raw.astrbot_attachments ?? '')
    } satisfies BridgeConfig
  }
}

const isSameConfig = (left: BridgeConfig, right: BridgeConfig) =>
  JSON.stringify(left) === JSON.stringify(right)

export default function BridgePage() {
  const [status, setStatus] = useState<BridgeStatus>({
    running: false,
    paused: false,
    ob_connected: false,
    processRunning: false
  })
  const [config, setConfig] = useState<BridgeConfig>(DEFAULT_CONFIG)
  const [savedConfig, setSavedConfig] = useState<BridgeConfig>(DEFAULT_CONFIG)
  const [configHydrated, setConfigHydrated] = useState(false)
  const [legacyFilterMigrated, setLegacyFilterMigrated] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [tab, setTab] = useState<BridgeTab>('overview')
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [nicknamesInput, setNicknamesInput] = useState('')
  const [manualFilterInput, setManualFilterInput] = useState('')
  const [groupOptions, setGroupOptions] = useState<GroupSessionOption[]>([])
  const [groupSearch, setGroupSearch] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [scanState, setScanState] = useState<ScanState>('idle')
  const [scanMessage, setScanMessage] = useState('尚未扫描群聊')
  const [scanErrorDetail, setScanErrorDetail] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const scanningRef = useRef(false)
  const groupOptionsRef = useRef<GroupSessionOption[]>([])
  const lastScanAtRef = useRef(0)

  const mergedConfig = useMemo<BridgeConfig>(() => ({
    ...config,
    bot_nicknames: parseNicknames(nicknamesInput)
  }), [config, nicknamesInput])

  const hasUnsavedChanges = configHydrated && !isSameConfig(
    mergedConfig,
    savedConfig
  ) || legacyFilterMigrated

  const scanGroups = async (force = false) => {
    if (scanningRef.current) return
    const now = Date.now()
    if (
      !force
      && groupOptionsRef.current.length > 0
      && now - lastScanAtRef.current < 30_000
    ) {
      return
    }

    scanningRef.current = true
    setScanState('scanning')
    setScanMessage('正在扫描群聊……')
    setScanErrorDetail('')
    try {
      const result = await window.electronAPI.chat.getSessions()
      if (!result.success) {
        const error = String(result.error || '')
        const looksUnavailable = /连接|数据库|未打开|未就绪|path|key/i.test(error)
        setScanState('error')
        setScanErrorDetail(error)
        setScanMessage(
          looksUnavailable
            ? '请先在“微信连接”页面连接数据'
            : '群聊扫描失败，点击重试'
        )
        return
      }

      const groups = (result.sessions || [])
        .filter(session => String(session.username || '').endsWith('@chatroom'))
        .map(session => {
          const id = String(session.username || '').trim()
          const name = groupDisplayName(session)
          return {
            id,
            name,
            displayName: name
          }
        })

      groupOptionsRef.current = groups
      lastScanAtRef.current = Date.now()
      setGroupOptions(groups)
      setScanState('success')
      setScanMessage(`已扫描 ${groups.length} 个群聊`)
    } catch (error) {
      setScanState('error')
      setScanErrorDetail(String(error))
      setScanMessage('群聊扫描失败，点击重试')
    } finally {
      scanningRef.current = false
    }
  }

  useEffect(() => {
    let disposed = false

    window.electronAPI.bridge.status().then(value => {
      if (!disposed) setStatus(value)
    }).catch(() => {})
    window.electronAPI.bridge.getLogs().then(value => {
      if (!disposed) setLogs(value)
    }).catch(() => {})
    window.electronAPI.bridge.getConfig().then(result => {
      if (disposed || !result?.success || !result.config) return
      const loaded = normalizeLoadedConfig(result.config as Record<string, unknown>)
      setConfig(loaded.config)
      setSavedConfig(loaded.migrated ? DEFAULT_CONFIG : loaded.config)
      setLegacyFilterMigrated(loaded.migrated)
      setNicknamesInput((loaded.config.bot_nicknames || []).join('\n'))
      setConfigHydrated(true)
    }).catch(() => {})

    const removeLog = window.electronAPI.bridge.onLog((msg: string) => {
      setLogs(prev => {
        const next = [...prev, msg]
        return next.length > 500 ? next.slice(-500) : next
      })
    })
    const removeStatus = window.electronAPI.bridge.onStatus(value => {
      setStatus(prev => ({ ...prev, ...value }))
    })
    const removeWcdbChange = window.electronAPI.chat.onWcdbChange((_, data) => {
      if (
        !disposed
        && data?.type
        && Date.now() - lastScanAtRef.current >= 30_000
      ) {
        void scanGroups()
      }
    })
    const timer = setInterval(() => {
      window.electronAPI.bridge.status().then(value => {
        if (!disposed) setStatus(value)
      }).catch(() => {})
    }, 3000)

    void scanGroups(true)

    return () => {
      disposed = true
      removeLog()
      removeStatus()
      removeWcdbChange()
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs, autoScroll])

  useEffect(() => {
    if (tab !== 'config' || !configHydrated) return
    const remaining = Math.max(
      0,
      30_000 - (Date.now() - lastScanAtRef.current)
    )
    void scanGroups()
    const timer = setInterval(() => {
      if (Date.now() - lastScanAtRef.current >= 30_000) void scanGroups()
    }, 10_000)
    const refreshTimer = setTimeout(() => void scanGroups(), remaining)
    return () => {
      clearInterval(timer)
      clearTimeout(refreshTimer)
    }
  }, [tab, configHydrated])

  useEffect(() => {
    if (!pickerOpen) return
    const handlePointerDown = (event: PointerEvent) => {
      if (
        pickerRef.current
        && !pickerRef.current.contains(event.target as Node)
      ) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [pickerOpen])

  const duplicateGroupNames = useMemo(() => {
    const counts = new Map<string, number>()
    for (const group of groupOptions) {
      counts.set(group.name, (counts.get(group.name) || 0) + 1)
    }
    return new Set(
      [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([name]) => name)
    )
  }, [groupOptions])

  const groupOptionLabel = (group: GroupSessionOption) =>
    duplicateGroupNames.has(group.name)
      ? `${group.name} · ${shortSessionId(group.id)}`
      : group.name

  const filteredGroupOptions = useMemo(() => {
    const keyword = groupSearch.trim().toLocaleLowerCase()
    if (!keyword) return groupOptions
    return groupOptions.filter(group =>
      [group.id, group.name, group.displayName]
        .some(value => value.toLocaleLowerCase().includes(keyword))
    )
  }, [groupOptions, groupSearch])

  const selectedOptionMap = useMemo(
    () => new Map(groupOptions.map(group => [group.id, group])),
    [groupOptions]
  )

  const selectedScanned = config.group_reply_filter_sessions
    .filter(sessionId => selectedOptionMap.has(sessionId))
  const selectedMissing = config.group_reply_filter_sessions
    .filter(sessionId => !selectedOptionMap.has(sessionId))

  const manualEntries = useMemo(
    () => parseTextEntries(manualFilterInput),
    [manualFilterInput]
  )
  const manualNonGroupEntries = manualEntries.filter(
    entry => !entry.endsWith('@chatroom')
  )

  const refreshStatus = () => {
    window.electronAPI.bridge.status().then(value => setStatus(value)).catch(() => {})
  }

  const handleStart = async () => {
    setBusy(true)
    try {
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

  const toggleGroupOption = (group: GroupSessionOption) => {
    setConfig(prev => {
      const selected = prev.group_reply_filter_sessions.includes(group.id)
      return {
        ...prev,
        group_reply_filter_sessions: selected
          ? prev.group_reply_filter_sessions.filter(id => id !== group.id)
          : [...prev.group_reply_filter_sessions, group.id]
      }
    })
  }

  const removeFilterSession = (sessionId: string) => {
    setConfig(prev => ({
      ...prev,
      group_reply_filter_sessions: prev.group_reply_filter_sessions.filter(
        id => id !== sessionId
      )
    }))
  }

  const addManualSessions = () => {
    if (!manualEntries.length) return
    setConfig(prev => ({
      ...prev,
      group_reply_filter_sessions: Array.from(new Set([
        ...prev.group_reply_filter_sessions,
        ...manualEntries
      ]))
    }))
    setManualFilterInput('')
  }

  const handleSaveConfig = async () => {
    setSaving(true)
    try {
      const result = await window.electronAPI.bridge.saveConfig(mergedConfig as any)
      if (result.success) {
        setConfig(mergedConfig)
        setSavedConfig(mergedConfig)
        setLegacyFilterMigrated(false)
        setSaveMsg('配置已保存')
      } else {
        setSaveMsg('保存失败：' + (result.error || ''))
      }
    } catch (error) {
      setSaveMsg('保存失败：' + String(error))
    } finally {
      setSaving(false)
    }
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

  const groupReplyModeLabel = config.group_reply_mode === 'all'
    ? '响应所有消息'
    : config.group_reply_mode === 'batch'
      ? '批量合并'
      : '响应@'

  const filterDescription = config.group_reply_filter_mode === 'whitelist'
    ? '只回复选中的会话'
    : '不回复选中的会话'

  return (
    <div className="bridge-page">
      <div className="bridge-page__header">
        <h2>AstrWeChat</h2>
        <span className={`slim-badge ${status.processRunning ? (status.running ? 'slim-badge--ok' : 'slim-badge--warn') : 'slim-badge--idle'}`}>
          {status.processRunning ? (status.running ? 'AstrWeChat 运行中' : '进程已启动') : '未启动'}
        </span>
        <span className={`slim-badge ${status.ob_connected ? 'slim-badge--ok' : 'slim-badge--idle'}`}>
          {status.ob_connected ? 'AstrBot 已连接' : 'AstrBot 未连接'}
        </span>
        <div className="bridge-page__header-actions">
          {!status.processRunning
            ? (
              <button className="slim-btn slim-btn--primary" onClick={handleStart} disabled={busy}>
                <Power size={14} />
                {busy ? '启动中...' : '启动 AstrWeChat'}
              </button>
            )
            : (
              <button className="slim-btn slim-btn--danger" onClick={handleStop} disabled={busy}>
                <Power size={14} />
                {busy ? '停止中...' : '停止 AstrWeChat'}
              </button>
            )}
        </div>
      </div>

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
                <strong>AstrBot</strong>
                <em>{status.ob_connected ? '已连接' : '未连接'}</em>
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
                ? <button className="slim-btn slim-btn--primary" onClick={handleStart} disabled={busy}><Power size={14} />{busy ? '启动中...' : '启动'}</button>
                : <button className="slim-btn slim-btn--danger" onClick={handleStop} disabled={busy}><Power size={14} />{busy ? '停止中...' : '停止'}</button>}
            </div>
          </section>

          <BridgeWorkflow logs={logs} />

          <section className="slim-card bridge-overview-card">
            <div className="bridge-card-heading">
              <span className="bridge-card-heading__icon"><FileText size={16} /></span>
              <h3>回复策略</h3>
            </div>
            <div className="bridge-summary-list">
              <div><span>群聊回复</span><strong>{groupReplyModeLabel}</strong></div>
              <div><span>主动回复</span><strong>{config.active_reply_enabled ? '已开启' : '已关闭'}</strong></div>
              <div><span>主动回复概率</span><strong>{Math.round(config.active_reply_probability * 100)}%</strong></div>
              <div><span>消息缓冲</span><strong>{config.buffer_seconds} 秒</strong></div>
            </div>
          </section>

          <section className="slim-card bridge-overview-card">
            <div className="bridge-card-heading">
              <span className="bridge-card-heading__icon"><ShieldCheck size={16} /></span>
              <h3>会话过滤</h3>
            </div>
            <div className="bridge-summary-list">
              <div><span>当前模式</span><strong>{config.group_reply_filter_mode === 'whitelist' ? '白名单' : '黑名单'}</strong></div>
              <div><span>选中会话</span><strong>{config.group_reply_filter_sessions.length}</strong></div>
              <div><span>扫描群聊</span><strong>{groupOptions.length}</strong></div>
              <div><span>过滤说明</span><strong>{filterDescription}</strong></div>
            </div>
            {legacyFilterMigrated && (
              <div className="bridge-filter-migration">
                <CircleAlert size={14} />
                旧主动回复白名单已迁移为会话白名单，现在会影响所有群聊回复。
              </div>
            )}
          </section>
      </div>

      {tab === 'logs' && (
        <div className="bridge-log-view">
          <div className="bridge-log-toolbar">
            <label>
              <input type="checkbox" checked={autoScroll} onChange={event => setAutoScroll(event.target.checked)} />
              自动滚动
            </label>
            <button
              className="slim-btn slim-btn--secondary"
              onClick={() => { void window.electronAPI.bridge.clearLogs(); setLogs([]) }}
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
          <div className="slim-card">
            <div className="slim-card__title">连接设置</div>
            <div className="slim-field">
              <label>WeFlow 地址</label>
              <input type="text" value={config.weflow_base_url} onChange={event => setConfig(prev => ({ ...prev, weflow_base_url: event.target.value }))} />
            </div>
            <div className="slim-field">
              <label>Access Token</label>
              <input type="text" value={config.access_token} onChange={event => setConfig(prev => ({ ...prev, access_token: event.target.value }))} placeholder="与 WeFlow API 服务中设置的 Token 一致" />
            </div>
            <div className="slim-field">
              <label>AstrBot WS</label>
              <input type="text" value={config.astrbot_ob_url} onChange={event => setConfig(prev => ({ ...prev, astrbot_ob_url: event.target.value }))} placeholder="ws://127.0.0.1:11229/ws" />
            </div>
            <div className="slim-field">
              <label>
                反向 WebSocket Token
                <span>AstrBot 启用鉴权时填写</span>
              </label>
              <input
                type="text"
                value={config.astrbot_ob_token}
                onChange={event => setConfig(prev => ({ ...prev, astrbot_ob_token: event.target.value }))}
                placeholder="未设置则不启用 Token 验证"
                autoComplete="off"
              />
            </div>
          </div>

          <div className="slim-card">
            <div className="slim-card__title">机器人身份</div>
            <div className="slim-field">
              <label>Bot 微信 ID</label>
              <input type="text" value={config.bot_wxid} onChange={event => setConfig(prev => ({ ...prev, bot_wxid: event.target.value }))} placeholder="wxid_xxxxxxxx" />
            </div>
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

          <div className="slim-card bridge-filter-card">
            <div className="slim-card__title">会话过滤</div>
            {legacyFilterMigrated && (
              <div className="bridge-filter-migration">
                <CircleAlert size={14} />
                旧主动回复白名单已迁移为会话白名单，现在会影响所有群聊回复。
              </div>
            )}
            <div className="bridge-filter-toolbar">
              <div className="bridge-filter-segmented" role="group" aria-label="会话过滤模式">
                <button
                  type="button"
                  className={config.group_reply_filter_mode === 'whitelist' ? 'is-active' : ''}
                  onClick={() => setConfig(prev => ({ ...prev, group_reply_filter_mode: 'whitelist' }))}
                >
                  <ShieldCheck size={14} />
                  白名单
                </button>
                <button
                  type="button"
                  className={config.group_reply_filter_mode === 'blacklist' ? 'is-active' : ''}
                  onClick={() => setConfig(prev => ({ ...prev, group_reply_filter_mode: 'blacklist' }))}
                >
                  <ShieldCheck size={14} />
                  黑名单
                </button>
              </div>
              <div className="filter-tooltip" aria-live="polite">
                <span key={config.group_reply_filter_mode} className="filter-tooltip__lead">
                  {config.group_reply_filter_mode === 'whitelist' ? '只' : '不'}
                </span>
                <span>回复选中的会话</span>
              </div>
            </div>

            <div className="bridge-filter-scan-row">
              <div className="bridge-filter-scan-copy">
                <span>群聊列表</span>
                <strong className={`is-${scanState}`}>{scanMessage}</strong>
              </div>
              <button
                type="button"
                className="slim-btn slim-btn--secondary"
                onClick={() => void scanGroups(true)}
                disabled={scanState === 'scanning'}
              >
                <RefreshCw size={14} className={scanState === 'scanning' ? 'is-spinning' : ''} />
                刷新群聊
              </button>
              <button
                type="button"
                className="slim-btn slim-btn--secondary"
                onClick={() => setPickerOpen(open => !open)}
              >
                <Users size={14} />
                选择群聊
                {pickerOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            </div>
            {scanErrorDetail && scanState === 'error' && (
              <div className="bridge-filter-error" title={scanErrorDetail}>
                <CircleAlert size={13} />
                {scanErrorDetail}
              </div>
            )}

            {pickerOpen && (
              <div ref={pickerRef} className="bridge-filter-picker">
                <div className="bridge-filter-picker__search">
                  <Search size={14} />
                  <input
                    autoFocus
                    type="text"
                    value={groupSearch}
                    onChange={event => setGroupSearch(event.target.value)}
                    placeholder="搜索群聊名称……"
                  />
                </div>
                <div className="bridge-filter-picker__list" role="listbox" aria-multiselectable="true">
                  {filteredGroupOptions.map(group => {
                    const selected = config.group_reply_filter_sessions.includes(group.id)
                    return (
                      <button
                        key={group.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        className={selected ? 'is-selected' : ''}
                        title={group.id}
                        onClick={() => toggleGroupOption(group)}
                      >
                        <span className="bridge-filter-check">{selected && <Check size={14} />}</span>
                        <span className="bridge-filter-option__name">{groupOptionLabel(group)}</span>
                      </button>
                    )
                  })}
                  {filteredGroupOptions.length === 0 && (
                    <div className="bridge-filter-picker__empty">
                      {groupOptions.length === 0 ? '暂无已扫描的群聊' : '没有匹配的群聊'}
                    </div>
                  )}
                </div>
                <div className="bridge-filter-picker__footer">
                  {filteredGroupOptions.length} / {groupOptions.length} 个群聊
                </div>
              </div>
            )}

            <div className="bridge-filter-selection">
              <div className="bridge-filter-subheading">
                <span>已选择的会话</span>
                <strong>{config.group_reply_filter_sessions.length}</strong>
              </div>
              {config.group_reply_filter_sessions.length === 0
                ? <div className="bridge-filter-empty">尚未选择会话</div>
                : (
                  <div className="bridge-filter-chips">
                    {selectedScanned.map(sessionId => {
                      const group = selectedOptionMap.get(sessionId)!
                      return (
                        <span key={sessionId} className="bridge-filter-chip" title={sessionId}>
                          <span>{groupOptionLabel(group)}</span>
                          <button type="button" aria-label={`移除 ${groupOptionLabel(group)}`} onClick={() => removeFilterSession(sessionId)}>
                            <X size={12} />
                          </button>
                        </span>
                      )
                    })}
                    {selectedMissing.map(sessionId => (
                      <span key={sessionId} className="bridge-filter-chip is-missing" title={sessionId}>
                        <span>{sessionId}</span>
                        <button type="button" aria-label={`移除 ${sessionId}`} onClick={() => removeFilterSession(sessionId)}>
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
            </div>

            {selectedMissing.length > 0 && (
              <div className="bridge-filter-missing">
                <CircleAlert size={13} />
                已保存但暂未扫描到的会话：{selectedMissing.length}
              </div>
            )}

            <div className="bridge-filter-manual">
              <div className="bridge-filter-subheading">
                <span>手动输入会话 ID</span>
                <em>支持空格、换行、英文逗号、中文逗号</em>
              </div>
              <div className="bridge-filter-manual__row">
                <textarea
                  value={manualFilterInput}
                  onChange={event => setManualFilterInput(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      addManualSessions()
                    }
                  }}
                  placeholder="输入会话 ID"
                  rows={2}
                />
                <button type="button" className="slim-btn slim-btn--secondary" onClick={addManualSessions}>
                  <Plus size={14} />
                  添加
                </button>
              </div>
              {manualNonGroupEntries.length > 0 && (
                <div className="bridge-filter-manual__warning">
                  <CircleAlert size={13} />
                  以下 ID 不属于自动扫描的微信群聊：{manualNonGroupEntries.join('、')}
                </div>
              )}
            </div>
          </div>

          <div className="slim-card">
            <div className="slim-card__title">主动回复</div>
            <div className="slim-field">
              <label>主动回复</label>
              <label className="slim-toggle">
                <input
                  type="checkbox"
                  checked={config.active_reply_enabled}
                  onChange={event => setConfig(prev => ({ ...prev, active_reply_enabled: event.target.checked }))}
                />
                <span className="slim-toggle__track" />
              </label>
              <span className="slim-field__inline-hint">按概率将普通消息推送给 AstrBot</span>
            </div>
            <div className="slim-field">
              <label>
                回复概率
                <span>0.0-1.0 之间的数值</span>
              </label>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={config.active_reply_probability}
                onChange={event => setConfig(prev => ({ ...prev, active_reply_probability: Number(event.target.value) }))}
                className="bridge-probability-range"
              />
              <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={config.active_reply_probability}
                onChange={event => setConfig(prev => ({
                  ...prev,
                  active_reply_probability: Math.min(1, Math.max(0, Number(event.target.value) || 0))
                }))}
                className="bridge-probability-input"
              />
            </div>
          </div>

          <div className="slim-card">
            <div className="slim-card__title">行为设置</div>
            <div className="slim-field">
              <label>以微信ID查找联系人</label>
              <label className="slim-toggle">
                <input
                  type="checkbox"
                  checked={config.search_by_wxid}
                  onChange={event => setConfig(prev => ({ ...prev, search_by_wxid: event.target.checked }))}
                />
                <span className="slim-toggle__track" />
              </label>
            </div>
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
            <div className="slim-field">
              <label>消息缓冲</label>
              <input
                type="number"
                value={config.buffer_seconds}
                min={0}
                max={30}
                onChange={event => setConfig(prev => ({ ...prev, buffer_seconds: Number(event.target.value) }))}
                className="bridge-number-input"
              />
              <span className="slim-field__inline-hint">秒（合并短时间内连续消息）</span>
            </div>
            <div className="slim-field">
              <label>附件目录</label>
              <input type="text" value={config.astrbot_attachments} onChange={event => setConfig(prev => ({ ...prev, astrbot_attachments: event.target.value }))} placeholder="AstrBot 附件保存路径（可选）" />
            </div>
          </div>

          <button className="slim-btn slim-btn--primary" onClick={handleSaveConfig} disabled={saving}>
            <Save size={14} />
            {saving ? '保存中...' : '保存配置'}
          </button>
        </div>
      )}
    </div>
  )
}
