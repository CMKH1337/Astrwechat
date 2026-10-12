import { useEffect, useMemo, useState } from 'react'
import { Routes, Route, Navigate, NavLink, useLocation } from 'react-router-dom'
import { Database, ScrollText, Settings, Plug, BarChart3, ShieldCheck, Bot, Star } from 'lucide-react'
import ConnectPage from './pages/ConnectPage'
import LogPage from './pages/LogPage'
import SettingsSlimPage from './pages/SettingsSlimPage'
import BridgePage from './pages/BridgePage'
import RobotPage from './pages/RobotPage'
import StatsPage from './pages/StatsPage'
import AWConfigPage from './pages/AWConfigPage'
import './AppSlim.scss'

const REPOSITORY_URL = 'https://github.com/CMKH1337/Astrwechat'

const NAV_ITEMS = [
  { to: '/connect', icon: Database, label: '微信连接' },
  { to: '/bridge', icon: Plug, label: 'Bridge' },
  { to: '/robot', icon: Bot, label: '机器人' },
  { to: '/aw', icon: ShieldCheck, label: 'AW配置' },
  { to: '/log', icon: ScrollText, label: '运行日志' },
  { to: '/settings', icon: Settings, label: '设置' },
]

const PAGE_META: Record<string, { eyebrow: string; title: string; description: string }> = {
  '/stats': { eyebrow: 'PLATFORM / ANALYTICS', title: '统计数据', description: '查看 AstrWeChat 的运行时长、消息总量、群聊排行和消息趋势。' },
  '/connect': { eyebrow: 'WORKSPACE / CONNECTION', title: '连接你的微信数据', description: '安全地配置数据库连接，开始使用 WeFlow 的本地能力。' },
  '/bridge': { eyebrow: 'WORKSPACE / BRIDGE', title: 'Bridge 桥接服务', description: '管理本地桥接进程，让外部客户端稳定接入。' },
  '/robot': { eyebrow: 'WORKSPACE / ROBOT', title: '机器人', description: '配置 AstrBot、KouriChat 或 API，管理机器人连接与切换。' },
  '/aw': { eyebrow: 'WORKSPACE / LOCAL COMMANDS', title: 'AW 配置', description: '管理本地指令管理员、消息回溯和附件缓存。' },
  '/log': { eyebrow: 'WORKSPACE / ACTIVITY', title: '运行日志', description: '追踪后台任务、连接状态和服务事件。' },
  '/settings': { eyebrow: 'WORKSPACE / SETTINGS', title: '应用设置', description: '调整外观、运行策略和本地存储选项。' },
}

function MainLayout() {
  const [dbConnected, setDbConnected] = useState(false)
  const [version, setVersion] = useState('')
  const [openingRepository, setOpeningRepository] = useState(false)
  const [repositoryError, setRepositoryError] = useState('')
  const location = useLocation()
  const page = PAGE_META[location.pathname] ?? PAGE_META['/connect']
  const appIconUrl = useMemo(() => new URL(`${import.meta.env.BASE_URL}icon.ico`, window.location.href).href, [])

  useEffect(() => {
    window.electronAPI.app.getVersion().then(setVersion).catch(() => {})
    window.electronAPI.wcdb.isConnected().then(setDbConnected).catch(() => setDbConnected(false))
  }, [])

  const openRepository = async () => {
    if (openingRepository) return
    setOpeningRepository(true)
    setRepositoryError('')
    try {
      const result = await window.electronAPI.shell.openExternal(REPOSITORY_URL)
      if (!result.success) setRepositoryError('无法打开浏览器，请稍后重试。')
    } catch {
      setRepositoryError('无法打开浏览器，请稍后重试。')
    } finally {
      setOpeningRepository(false)
    }
  }

  return (
    <div className="slim-app">
      <div className="slim-titlebar">
        <div className="slim-titlebar__brand">
          <img className="slim-titlebar__brand-mark" src={appIconUrl} alt="" />
          <span className="slim-titlebar__title">AstrWeChat</span>
          {version && <span className="slim-titlebar__version">v{version}</span>}
        </div>
        <div className="slim-titlebar__controls">
          <button aria-label="最小化" onClick={() => window.electronAPI.window.minimize()}>−</button>
          <button aria-label="关闭" onClick={() => window.electronAPI.window.close()}>×</button>
        </div>
      </div>

      <div className="slim-body">
        <aside className="slim-nav">
          <div className="slim-nav__intro">
            <img className="slim-nav__logo" src={appIconUrl} alt="" />
            <div>
              <strong>AstrWeChat</strong>
              <span>By CMKH</span>
            </div>
          </div>
          <div className="slim-nav__label">Platform</div>
          <div className="slim-nav__items">
            <NavLink
              to="/stats"
              className={({ isActive }) => `slim-nav__item${isActive ? ' active' : ''}`}
            >
              <span className="slim-nav__item-icon"><BarChart3 size={17} /></span>
              <span className="slim-nav__item-copy"><strong>统计数据</strong></span>
            </NavLink>
          </div>
          <div className="slim-nav__label slim-nav__label--secondary">Settings</div>
          <div className="slim-nav__items">
            {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) => `slim-nav__item${isActive ? ' active' : ''}`}
              >
                <span className="slim-nav__item-icon"><Icon size={17} /></span>
                <span className="slim-nav__item-copy"><strong>{label}</strong></span>
              </NavLink>
            ))}
          </div>
          <div className="slim-nav__footer">
            <button
              type="button"
              className="slim-nav__star-button"
              onClick={() => void openRepository()}
              disabled={openingRepository}
              aria-label="给AstrWechat点个star"
              title={repositoryError || '给AstrWechat点个star'}
            >
              <Star size={16} aria-hidden="true" />
              <span>给AstrWechat点个star</span>
            </button>
            {repositoryError && <p className="slim-nav__star-error" role="alert">{repositoryError}</p>}
            <div className="slim-nav__footer-meta"><span>ASTRWECHAT</span><span>LOCAL FIRST</span></div>
          </div>
        </aside>

        <main className="slim-content">
          <div className="slim-content__glow" />
          <header className="slim-page-header">
            <div>
              <div className="slim-page-header__eyebrow">{page.eyebrow}</div>
              <h1>{page.title}</h1>
              <p>{page.description}</p>
            </div>
          </header>
          <div className="slim-page-body">
            <Routes>
              <Route path="/" element={<Navigate to="/stats" replace />} />
              <Route path="/stats" element={<StatsPage />} />
              <Route path="/connect" element={<ConnectPage connected={dbConnected} onConnected={setDbConnected} />} />
              <Route path="/api" element={<Navigate to="/connect" replace />} />
              <Route path="/bridge" element={<BridgePage />} />
              <Route path="/robot" element={<RobotPage />} />
              <Route path="/aw" element={<AWConfigPage />} />
              <Route path="/log" element={<LogPage />} />
              <Route path="/settings" element={<SettingsSlimPage />} />
            </Routes>
          </div>
        </main>
      </div>
    </div>
  )
}

export default function AppSlim() {
  const [showStartup, setShowStartup] = useState(true)
  // Vite 的 BASE_URL 在开发环境是 /，生产 file:// 构建是 ./。
  // 使用 URL 解析可同时兼容 Vite HTTP 开发服务和 Electron file:// 页面。
  const startupIconUrl = useMemo(
    () => new URL(`${import.meta.env.BASE_URL}icon.ico`, window.location.href).href,
    []
  )

  useEffect(() => {
    const timer = window.setTimeout(() => setShowStartup(false), 2200)
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <>
      <MainLayout />
      {showStartup && (
        <div className="slim-startup" aria-label="AstrWeChat 正在启动">
          <div className="slim-startup__grid" />
          <div className="slim-startup__content">
            <div className="slim-startup__icon-stage" aria-hidden="true">
              <span className="slim-startup__ring" />
              <img className="slim-startup__icon" src={startupIconUrl} alt="" />
            </div>
            <span className="slim-startup__eyebrow">ASTRWECHAT</span>
            <h1>AstrWeChat</h1>
            <p>正在准备连接器服务</p>
            <span className="slim-startup__loader" aria-hidden="true" />
          </div>
        </div>
      )}
    </>
  )
}
