import { useEffect, useMemo, useState } from 'react'
import { Routes, Route, Navigate, NavLink } from 'react-router-dom'
import { Database, Radio, ScrollText, Settings, Plug } from 'lucide-react'
import ConnectPage from './pages/ConnectPage'
import ApiPage from './pages/ApiPage'
import LogPage from './pages/LogPage'
import SettingsSlimPage from './pages/SettingsSlimPage'
import BridgePage from './pages/BridgePage'
import './AppSlim.scss'

const NAV_ITEMS = [
  { to: '/connect', icon: Database, label: '连接' },
  { to: '/api', icon: Radio, label: 'API 服务' },
  { to: '/bridge', icon: Plug, label: 'Bridge' },
  { to: '/log', icon: ScrollText, label: '日志' },
  { to: '/settings', icon: Settings, label: '设置' },
]

function MainLayout() {
  const [dbConnected, setDbConnected] = useState(false)
  const [version, setVersion] = useState('')

  useEffect(() => {
    window.electronAPI.app.getVersion().then(setVersion).catch(() => {})
  }, [])

  return (
    <div className="slim-app">
      <div className="slim-titlebar">
        <span className="slim-titlebar__title">AstrWeChat</span>
        {version && <span className="slim-titlebar__version">v{version}</span>}
        <div className="slim-titlebar__controls">
          <button onClick={() => window.electronAPI.window.minimize()}>─</button>
          <button onClick={() => window.electronAPI.window.close()}>✕</button>
        </div>
      </div>

      <div className="slim-body">
        <nav className="slim-nav">
          {NAV_ITEMS.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => `slim-nav__item${isActive ? ' active' : ''}`}
            >
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <main className="slim-content">
          <Routes>
            <Route path="/" element={<Navigate to="/connect" replace />} />
            <Route path="/connect" element={<ConnectPage onConnected={setDbConnected} />} />
            <Route path="/api" element={<ApiPage dbConnected={dbConnected} />} />
            <Route path="/bridge" element={<BridgePage />} />
            <Route path="/log" element={<LogPage />} />
            <Route path="/settings" element={<SettingsSlimPage />} />
          </Routes>
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
    () => new URL(`${import.meta.env.BASE_URL}icon.png`, window.location.href).href,
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
