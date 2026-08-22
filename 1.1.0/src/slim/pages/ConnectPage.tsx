import { useEffect, useRef, useState } from 'react'
import type { WxidInfo } from '../../types/electron'
import '../AppSlim.scss'

interface Props {
  onConnected: (connected: boolean) => void
}

export default function ConnectPage({ onConnected }: Props) {
  const [dbPath, setDbPath] = useState('')
  const [decryptKey, setDecryptKey] = useState('')
  const [wxid, setWxid] = useState('')
  const [wxidOptions, setWxidOptions] = useState<WxidInfo[]>([])
  const [wxidScanning, setWxidScanning] = useState(false)
  const [wxidScanMessage, setWxidScanMessage] = useState('')
  const [wxidPickerOpen, setWxidPickerOpen] = useState(false)
  const [status, setStatus] = useState<'idle' | 'testing' | 'ok' | 'err'>('idle')
  const [statusMsg, setStatusMsg] = useState('')
  const [autoDetecting, setAutoDetecting] = useState(false)
  const [keyFetching, setKeyFetching] = useState(false)
  const [keyProgress, setKeyProgress] = useState('')
  const [imageKeyFetching, setImageKeyFetching] = useState(false)
  const [imageKeyProgress, setImageKeyProgress] = useState('')
  const connectingRef = useRef(false)
  const wxidScanRequestRef = useRef(0)
  const wxidPickerRef = useRef<HTMLDivElement>(null)

  const scanWxidDirectories = async (path: string) => {
    const normalizedPath = path.trim()
    if (!normalizedPath) {
      wxidScanRequestRef.current += 1
      setWxidScanning(false)
      setWxidPickerOpen(false)
      setWxidOptions([])
      setWxidScanMessage('')
      return
    }

    const requestId = ++wxidScanRequestRef.current
    setWxidScanning(true)
    setWxidPickerOpen(false)
    setWxidOptions([])
    setWxidScanMessage('正在扫描微信账号目录...')

    try {
      const result = await window.electronAPI.dbPath.scanWxids(normalizedPath)
      if (requestId !== wxidScanRequestRef.current) return

      const options = Array.isArray(result) ? result : []
      setWxidOptions(options)
      setWxidScanMessage(options.length > 0
        ? '已发现 ' + options.length + ' 个微信账号，可从下拉框选择'
        : '未发现可用的微信账号目录，可继续手动填写微信 ID')

      // 只有当前没有填写 ID 时才自动填入唯一账号，避免覆盖用户的手动输入。
      if (!wxid.trim() && options.length === 1) {
        setWxid(options[0].wxid)
      }
    } catch (error) {
      if (requestId !== wxidScanRequestRef.current) return
      setWxidOptions([])
      setWxidScanMessage('扫描微信账号目录失败，可继续手动填写微信 ID')
      console.warn('扫描微信账号目录失败:', error)
    } finally {
      if (requestId === wxidScanRequestRef.current) setWxidScanning(false)
    }
  }

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      if (!wxidPickerRef.current?.contains(event.target as Node)) {
        setWxidPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [])

  // 数据目录填写完成或切换后自动扫描账号目录。使用短暂防抖，避免用户输入路径时频繁触发 IPC。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void scanWxidDirectories(dbPath)
    }, 300)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dbPath])

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

      // 页面切换回来时先检查后台 WCDB 状态，避免对同一个账号重复 open。
      const alreadyConnected = await window.electronAPI.wcdb.isConnected().catch(() => false)
      if (alreadyConnected) {
        setStatus('ok')
        setStatusMsg('数据库已连接')
        onConnected(true)
        return
      }

      // 应用首次启动且配置完整时才自动连接。
      if (savedPath && savedKey && savedWxid) {
        void tryConnect(String(savedPath), String(savedKey), String(savedWxid), false)
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

  const saveImageKeys = async (result: { xorKey?: number; aesKey?: string }) => {
    if (typeof result.xorKey !== 'number' || !result.aesKey) {
      throw new Error('没有获取到完整的图片 XOR/AES 密钥')
    }

    await window.electronAPI.config.set('imageXorKey', result.xorKey)
    await window.electronAPI.config.set('imageAesKey', result.aesKey)

    const currentWxid = wxid.trim()
    if (currentWxid) {
      const existing = await window.electronAPI.config.get('wxidConfigs')
      const configs = existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {}
      const current = configs[currentWxid]
      configs[currentWxid] = {
        ...(current && typeof current === 'object' ? current : {}),
        imageXorKey: result.xorKey,
        imageAesKey: result.aesKey,
        updatedAt: Date.now(),
      }
      await window.electronAPI.config.set('wxidConfigs', configs)
    }
  }

  const handleAutoGetImageKey = async () => {
    if (!dbPath.trim() || !wxid.trim()) {
      setStatus('err')
      setStatusMsg('请先填写或自动检测微信数据目录和微信 ID')
      return
    }

    setImageKeyFetching(true)
    setImageKeyProgress('正在扫描图片缓存...')
    const removeStatusListener = window.electronAPI.key.onImageKeyStatus((payload) => {
      setImageKeyProgress(payload.message)
    })

    try {
      const result = await window.electronAPI.key.autoGetImageKey(dbPath.trim(), wxid.trim())
      if (!result.success || typeof result.xorKey !== 'number' || !result.aesKey) {
        setStatus('err')
        setStatusMsg(result.error || '未能获取完整的图片密钥')
        return
      }
      await saveImageKeys(result)
      setStatus('ok')
      setStatusMsg('图片密钥获取成功，已保存到当前微信账号')
    } catch (e) {
      setStatus('err')
      setStatusMsg('获取图片密钥失败：' + String(e))
    } finally {
      removeStatusListener()
      setImageKeyFetching(false)
      setImageKeyProgress('')
    }
  }

  const handleScanImageKeyMemory = async () => {
    if (!dbPath.trim() || !wxid.trim()) {
      setStatus('err')
      setStatusMsg('请先填写或自动检测微信数据目录和微信 ID')
      return
    }

    setImageKeyFetching(true)
    setImageKeyProgress('请先在微信中打开 2～3 张图片大图，正在扫描微信进程内存...')
    const removeStatusListener = window.electronAPI.key.onImageKeyStatus((payload) => {
      setImageKeyProgress(payload.message)
    })

    try {
      const result = await window.electronAPI.key.scanImageKeyFromMemory(dbPath.trim())
      if (!result.success || typeof result.xorKey !== 'number' || !result.aesKey) {
        setStatus('err')
        setStatusMsg(result.error || '内存扫描未找到图片 AES 密钥')
        return
      }
      await saveImageKeys(result)
      setStatus('ok')
      setStatusMsg('图片 AES 密钥获取成功，已保存到当前微信账号')
    } catch (e) {
      setStatus('err')
      setStatusMsg('内存扫描失败：' + String(e))
    } finally {
      removeStatusListener()
      setImageKeyFetching(false)
      setImageKeyProgress('')
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
          <label>图片密钥</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="slim-btn slim-btn--secondary"
              onClick={handleAutoGetImageKey}
              disabled={imageKeyFetching}
            >
              {imageKeyFetching ? '获取中...' : '自动获取图片密钥'}
            </button>
            <button
              className="slim-btn slim-btn--secondary"
              onClick={handleScanImageKeyMemory}
              disabled={imageKeyFetching}
            >
              内存扫描 AES
            </button>
          </div>
        </div>
        {imageKeyFetching && <div className="slim-field__hint">{imageKeyProgress}</div>}
        <div className="slim-field__hint">图片密钥独立于数据库密钥；内存扫描前请在微信中打开 2～3 张图片大图。</div>

        <div className="slim-field">
          <label>微信 ID</label>
          <input
            type="text"
            value={wxid}
            onChange={e => setWxid(e.target.value)}
            placeholder="wxid_xxxxxxxx"
          />
          <div className="slim-wxid-picker" ref={wxidPickerRef}>
            <button
              type="button"
              className="slim-wxid-picker__button"
              onClick={() => setWxidPickerOpen(open => !open)}
              disabled={wxidScanning || wxidOptions.length === 0}
              aria-label="展开已扫描的微信 ID"
              aria-expanded={wxidPickerOpen}
            >
              <span aria-hidden="true">▾</span>
            </button>
            {wxidPickerOpen && wxidOptions.length > 0 && (
              <div className="slim-wxid-picker__menu" role="listbox" aria-label="已扫描的微信 ID">
                {wxidOptions.map(option => (
                  <button
                    key={option.wxid}
                    type="button"
                    className={'slim-wxid-picker__option' + (wxid === option.wxid ? ' is-selected' : '')}
                    onClick={() => {
                      setWxid(option.wxid)
                      setWxidPickerOpen(false)
                    }}
                  >
                    {option.wxid}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {(wxidScanning || wxidScanMessage) && (
          <div className="slim-field__hint">{wxidScanMessage}</div>
        )}

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
          访问 WeFlow 仓库
        </button>
      </div>
    </div>
  )
}
