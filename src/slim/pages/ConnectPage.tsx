import { useEffect, useRef, useState } from 'react'
import '../AppSlim.scss'

interface Props {
  onConnected: (connected: boolean) => void
}

export default function ConnectPage({ onConnected }: Props) {
  const [dbPath, setDbPath] = useState('')
  const [decryptKey, setDecryptKey] = useState('')
  const [wxid, setWxid] = useState('')
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'err'>('idle')
  const [statusMsg, setStatusMsg] = useState('')
  const [autoDetecting, setAutoDetecting] = useState(false)
  const [keyFetching, setKeyFetching] = useState(false)
  const [keyProgress, setKeyProgress] = useState('')
  const connectingRef = useRef(false)

  // 启动时读取已保存的配置
  useEffect(() => {
    ;(async () => {
      const [savedPath, savedKey, savedWxid] = await Promise.all([
        window.electronAPI.config.get('dbPath'),
        window.electronAPI.config.get('decryptKey'),
        window.electronAPI.config.get('myWxid'),
      ])
      if (savedPath) setDbPath(String(savedPath))
      if (savedKey) setDecryptKey(String(savedKey))
      if (savedWxid) setWxid(String(savedWxid))

      // 如果配置完整，尝试自动连接
      if (savedPath && savedKey && savedWxid) {
        tryConnect(String(savedPath), String(savedKey), String(savedWxid), false)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tryConnect = async (path: string, key: string, id: string, save = true) => {
    if (connectingRef.current) return
    if (!path || !key || !id) {
      setStatus('err')
      setStatusMsg('请填写完整的路径、密钥和微信 ID')
      return
    }
    connectingRef.current = true
    setStatus('testing')
    setStatusMsg('正在连接...')
    try {
      const result = await window.electronAPI.wcdb.open(path, key, id) as any
      if (result?.success) {
        if (save) {
          await window.electronAPI.config.set('dbPath', path)
          await window.electronAPI.config.set('decryptKey', key)
          await window.electronAPI.config.set('myWxid', id)
        }
        setStatus('ok')
        setStatusMsg('数据库连接成功')
        onConnected(true)
      } else {
        setStatus('err')
        setStatusMsg(result?.error || '连接失败')
        onConnected(false)
      }
    } catch (e) {
      setStatus('err')
      setStatusMsg(String(e))
      onConnected(false)
    } finally {
      connectingRef.current = false
    }
  }

  const handleAutoDetect = async () => {
    setAutoDetecting(true)
    setStatusMsg('')
    try {
      const result = await window.electronAPI.dbPath.autoDetect() as any
      if (result?.path || result?.dbPath) {
        setDbPath(result.path || result.dbPath)
        if (result.wxid) setWxid(result.wxid)
        setStatusMsg('自动检测成功，请填写解密密钥后连接')
      } else {
        setStatusMsg('未检测到微信数据目录，请手动填写')
      }
    } catch (e) {
      setStatusMsg('自动检测失败：' + String(e))
    } finally {
      setAutoDetecting(false)
    }
  }

  const handleAutoGetKey = async () => {
    setKeyFetching(true)
    setKeyProgress('正在等待微信进程...')
    const removeStatusListener = window.electronAPI.key.onDbKeyStatus((payload) => {
      setKeyProgress(payload.message)
    })

    try {
      const result = await window.electronAPI.key.autoGetDbKey()
      if (!result.success || !result.key) {
        setStatus('err')
        setStatusMsg(result.error || '未能获取数据库密钥')
        return
      }

      setDecryptKey(result.key)
      await window.electronAPI.config.set('decryptKey', result.key)
      setStatusMsg('密钥获取成功，填写或确认微信 ID 后即可连接')
    } catch (e) {
      setStatus('err')
      setStatusMsg('获取密钥失败：' + String(e))
    } finally {
      removeStatusListener()
      setKeyFetching(false)
      setKeyProgress('')
    }
  }

  const handleBrowse = async () => {
    const result = await window.electronAPI.dialog.openDirectory({ title: '选择微信数据目录' })
    if (result?.filePaths?.[0]) setDbPath(result.filePaths[0])
  }

  const badgeClass =
    status === 'ok' ? 'slim-badge--ok' :
    status === 'err' ? 'slim-badge--err' :
    status === 'testing' ? 'slim-badge--warn' :
    'slim-badge--idle'

  return (
    <div>
      <h2 style={{ color: 'var(--slim-text)', fontWeight: 600, fontSize: 16, marginBottom: 20 }}>微信数据库连接</h2>

      <div className="slim-card">
        <div className="slim-card__title">数据库路径</div>

        <div className="slim-field">
          <label>数据目录</label>
          <input
            type="text"
            value={dbPath}
            onChange={e => setDbPath(e.target.value)}
            placeholder="微信数据文件夹路径"
          />
          <button className="slim-btn slim-btn--secondary" onClick={handleBrowse}>浏览</button>
        </div>

        <div className="slim-field">
          <label>解密密钥</label>
          <input
            type="password"
            value={decryptKey}
            onChange={e => setDecryptKey(e.target.value)}
            placeholder="数据库解密密钥（hex）"
          />
          <button
            className="slim-btn slim-btn--secondary"
            onClick={handleAutoGetKey}
            disabled={keyFetching}
          >
            {keyFetching ? '获取中...' : '自动获取'}
          </button>
        </div>
        {keyFetching && <div className="slim-field__hint">{keyProgress}</div>}

        <div className="slim-field">
          <label>微信 ID</label>
          <input
            type="text"
            value={wxid}
            onChange={e => setWxid(e.target.value)}
            placeholder="wxid_xxxxxxxx"
          />
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8 }}>
          <button
            className="slim-btn slim-btn--secondary"
            onClick={handleAutoDetect}
            disabled={autoDetecting}
          >
            {autoDetecting ? '检测中...' : '自动检测'}
          </button>
          <button
            className="slim-btn slim-btn--primary"
            onClick={() => tryConnect(dbPath, decryptKey, wxid)}
            disabled={status === 'testing'}
          >
            连接数据库
          </button>

          {(status !== 'idle' || statusMsg) && (
            <span className={`slim-badge ${badgeClass}`}>
              {statusMsg || (status === 'ok' ? '已连接' : status === 'testing' ? '连接中' : '未连接')}
            </span>
          )}
        </div>
      </div>

      <div className="slim-card">
        <div className="slim-card__title">如何获取解密密钥</div>
        <p style={{ fontSize: 13, color: '#666', lineHeight: 1.7, margin: 0 }}>
          1. 确保微信正在运行<br />
          2. 点击上方「自动获取」，并在微信客户端完成登录<br />
          3. 获取到 64 位十六进制密钥后，确认微信 ID 并连接
        </p>
        <button
          className="slim-btn slim-btn--secondary"
          style={{ marginTop: 12 }}
          onClick={() => window.electronAPI.shell.openExternal('https://github.com/hicccc77/WeFlow')}
        >
          查看文档
        </button>
      </div>
    </div>
  )
}
