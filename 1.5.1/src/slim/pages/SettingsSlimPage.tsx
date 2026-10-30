import { useEffect, useState } from 'react'
import '../AppSlim.scss'

type AudioOutputDevice = {
  deviceId: string
  label: string
}

type AudioOutputDevicePicker = MediaDevices & {
  selectAudioOutput?: () => Promise<MediaDeviceInfo>
}

const getAudioOutputDevices = async (): Promise<AudioOutputDevice[]> => {
  if (!navigator.mediaDevices?.enumerateDevices) return []

  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices
    .filter(device => device.kind === 'audiooutput' && Boolean(device.deviceId))
    .map(device => ({
      deviceId: device.deviceId,
      label: device.label || '未命名播放设备',
    }))
}

export default function SettingsSlimPage() {
  const [launchAtStartup, setLaunchAtStartup] = useState(false)
  const [silentStartup, setSilentStartup] = useState(false)
  const [logEnabled, setLogEnabled] = useState(false)
  const [uiaDetailedLogging, setUiaDetailedLogging] = useState(false)
  const [voiceBubbleEnabled, setVoiceBubbleEnabled] = useState(false)
  const [voiceAudioTruncateOver60s, setVoiceAudioTruncateOver60s] = useState(false)
  const [voiceAudioOutputDeviceId, setVoiceAudioOutputDeviceId] = useState('')
  const [voiceAudioOutputDeviceLabel, setVoiceAudioOutputDeviceLabel] = useState('')
  const [audioOutputDevices, setAudioOutputDevices] = useState<AudioOutputDevice[]>([])
  const [loadingAudioOutputs, setLoadingAudioOutputs] = useState(false)
  const [audioOutputMessage, setAudioOutputMessage] = useState('')
  const [installingAudioDriver, setInstallingAudioDriver] = useState(false)
  const [version, setVersion] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  const refreshAudioOutputDevices = async (): Promise<AudioOutputDevice[]> => {
    setLoadingAudioOutputs(true)
    try {
      const devices = await getAudioOutputDevices()
      setAudioOutputDevices(devices)
      return devices
    } catch (error) {
      setAudioOutputMessage(`读取播放设备失败：${String(error)}`)
      return []
    } finally {
      setLoadingAudioOutputs(false)
    }
  }

  useEffect(() => {
    let disposed = false

    ;(async () => {
      const [startup, silent, log, uiaLog, voiceEnabled, voiceTruncateOver60s, voiceDeviceId, voiceDeviceLabel, ver] = await Promise.all([
        window.electronAPI.app.getLaunchAtStartupStatus(),
        window.electronAPI.config.get('silentStartup'),
        window.electronAPI.config.get('logEnabled'),
        window.electronAPI.config.get('uiaDetailedLogging'),
        window.electronAPI.config.get('voiceBubbleEnabled'),
        window.electronAPI.config.get('voiceAudioTruncateOver60s'),
        window.electronAPI.config.get('voiceAudioOutputDeviceId'),
        window.electronAPI.config.get('voiceAudioOutputDeviceLabel'),
        window.electronAPI.app.getVersion(),
      ])
      if (disposed) return

      setLaunchAtStartup(startup?.enabled === true)
      setSilentStartup(Boolean(silent))
      setLogEnabled(Boolean(log))
      setUiaDetailedLogging(Boolean(uiaLog))
      setVoiceBubbleEnabled(Boolean(voiceEnabled))
      setVoiceAudioTruncateOver60s(Boolean(voiceTruncateOver60s))
      setVoiceAudioOutputDeviceId(String(voiceDeviceId || ''))
      setVoiceAudioOutputDeviceLabel(String(voiceDeviceLabel || ''))
      if (ver) setVersion(String(ver))
      void refreshAudioOutputDevices()
    })()

    const mediaDevices = navigator.mediaDevices
    const handleDeviceChange = () => {
      void refreshAudioOutputDevices()
    }
    mediaDevices?.addEventListener('devicechange', handleDeviceChange)

    return () => {
      disposed = true
      mediaDevices?.removeEventListener('devicechange', handleDeviceChange)
    }
  }, [])

  const handleChooseAudioOutput = async () => {
    const mediaDevices = navigator.mediaDevices as AudioOutputDevicePicker | undefined
    if (mediaDevices?.selectAudioOutput) {
      setAudioOutputMessage('')
      try {
        const device = await mediaDevices.selectAudioOutput()
        setVoiceAudioOutputDeviceId(device.deviceId)
        setVoiceAudioOutputDeviceLabel(device.label || '已选择的播放设备')
        await refreshAudioOutputDevices()
        setAudioOutputMessage('设备已选择，点击下方“保存设置”后生效。')
      } catch (error) {
        const name = error instanceof DOMException ? error.name : ''
        setAudioOutputMessage(name === 'NotAllowedError'
          ? '未选择设备，当前设置保持不变。'
          : `选择设备失败：${String(error)}`)
      }
      return
    }

    const devices = await refreshAudioOutputDevices()
    setAudioOutputMessage(devices.length > 0
      ? '请在下方列表中选择播放设备。'
      : '没有检测到播放设备，请确认虚拟声卡已经安装后重试。')
  }

  const handleAudioOutputChange = (deviceId: string) => {
    const device = audioOutputDevices.find(item => item.deviceId === deviceId)
    setVoiceAudioOutputDeviceId(deviceId)
    setVoiceAudioOutputDeviceLabel(device?.label || '')
    setAudioOutputMessage(device ? '设备已选择，点击下方“保存设置”后生效。' : '')
  }

  const handleInstallAudioDriver = async () => {
    setInstallingAudioDriver(true)
    setAudioOutputMessage('')
    try {
      const result = await window.electronAPI.virtualAudio.installDriver()
      setAudioOutputMessage(result.success
        ? '驱动安装程序已完成。请重启电脑；重启后微信选择 CABLE Output 麦克风，本软件播放端选择 CABLE Input。'
        : `驱动安装未完成：${result.error || '未知错误'}`)
    } catch (error) {
      setAudioOutputMessage(`驱动安装未完成：${String(error)}`)
    } finally {
      setInstallingAudioDriver(false)
    }
  }

  const handleSave = async () => {
    if (voiceBubbleEnabled && !voiceAudioOutputDeviceId) {
      setSaveMsg('请先选择虚拟声卡播放端，再启用语音气泡发送。')
      return
    }
    setSaving(true)
    try {
      await window.electronAPI.app.setLaunchAtStartup(launchAtStartup)
      await window.electronAPI.config.set('silentStartup', silentStartup)
      await window.electronAPI.config.set('logEnabled', logEnabled)
      await window.electronAPI.config.set('uiaDetailedLogging', uiaDetailedLogging)
      await window.electronAPI.config.set('voiceBubbleEnabled', voiceBubbleEnabled)
      await window.electronAPI.config.set('voiceAudioTruncateOver60s', voiceAudioTruncateOver60s)
      await window.electronAPI.config.set('voiceAudioOutputDeviceId', voiceAudioOutputDeviceId)
      await window.electronAPI.config.set('voiceAudioOutputDeviceLabel', voiceAudioOutputDeviceLabel)
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
      setUiaDetailedLogging(false)
      setVoiceBubbleEnabled(false)
      setVoiceAudioOutputDeviceId('')
      setVoiceAudioOutputDeviceLabel('')
      setAudioOutputDevices([])
      setAudioOutputMessage('')
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
        <div className="slim-card__title">语音气泡</div>
        <div className="slim-field">
          <label>启用语音气泡发送</label>
          <label className="slim-toggle">
            <input type="checkbox" checked={voiceBubbleEnabled} onChange={event => setVoiceBubbleEnabled(event.target.checked)} />
            <span className="slim-toggle__track" />
          </label>
        </div>
        <div className="slim-field">
          <label>超过 60 秒时截断并发送语音气泡</label>
          <label className="slim-toggle">
            <input
              type="checkbox"
              checked={voiceAudioTruncateOver60s}
              onChange={event => setVoiceAudioTruncateOver60s(event.target.checked)}
              disabled={!voiceBubbleEnabled}
            />
            <span className="slim-toggle__track" />
          </label>
          <span style={{ fontSize: 12, color: '#555' }}>
            开启后仅播放音频开头约 59.5 秒并录成语音气泡；关闭时仍把超长 MP3 作为原文件发送。
          </span>
        </div>
        <div className="slim-field" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <label htmlFor="voice-audio-output">虚拟声卡播放端</label>
          <select
            id="voice-audio-output"
            className="bridge-select"
            style={{ minWidth: 220, flex: 1 }}
            value={voiceAudioOutputDeviceId}
            onChange={event => handleAudioOutputChange(event.target.value)}
            disabled={loadingAudioOutputs || saving}
          >
            <option value="">未选择设备</option>
            {voiceAudioOutputDeviceId && !audioOutputDevices.some(device => device.deviceId === voiceAudioOutputDeviceId) && (
              <option value={voiceAudioOutputDeviceId}>{voiceAudioOutputDeviceLabel || '已保存的设备（当前未检测到）'}</option>
            )}
            {audioOutputDevices.map(device => (
              <option key={device.deviceId} value={device.deviceId}>{device.label}</option>
            ))}
          </select>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="slim-btn slim-btn--secondary"
              onClick={handleChooseAudioOutput}
              disabled={loadingAudioOutputs || saving}
            >
              选择设备
            </button>
            <button
              className="slim-btn slim-btn--secondary"
              onClick={() => { void refreshAudioOutputDevices() }}
              disabled={loadingAudioOutputs || saving}
            >
              {loadingAudioOutputs ? '读取中…' : '刷新列表'}
            </button>
          </div>
        </div>
        <p style={{ fontSize: 12, color: '#666', lineHeight: 1.7, marginTop: 8 }}>
          开启后，AstrBot 的 record/voice/audio 音频段会优先发送为微信语音气泡；超长 MP3 的处理方式由上面的开关决定。普通 MP3 文件段保持文件发送。微信需选中目标会话并保持前台，并在微信设置中自行选择 CABLE Output 麦克风。
        </p>
        {window.electronAPI.process.platform === 'win32' && (
          <div style={{ marginTop: 12 }}>
            <button
              className="slim-btn slim-btn--secondary"
              onClick={() => { void handleInstallAudioDriver() }}
              disabled={installingAudioDriver || saving}
            >
              {installingAudioDriver ? '正在准备驱动安装…' : '一键安装虚拟麦克风和声卡'}
            </button>
            <p style={{ fontSize: 12, color: '#666', lineHeight: 1.7, marginTop: 8 }}>
              驱动由 VB-Audio 提供。点击后会请求 Windows 管理员权限并启动官方安装程序；安装完成需重启。软件不会更改系统默认设备。VB-CABLE 为捐赠软件，欢迎前往{' '}
              <button className="slim-btn slim-btn--link" onClick={() => { void window.electronAPI.shell.openExternal('https://vb-audio.com/Cable/') }}>
                VB-Audio 官网了解或捐赠
              </button>
            </p>
          </div>
        )}
        {audioOutputMessage && (
          <p style={{ fontSize: 12, color: audioOutputMessage.includes('失败') || audioOutputMessage.includes('没有') ? '#f87171' : 'var(--slim-accent)', marginTop: 8 }}>
            {audioOutputMessage}
          </p>
        )}
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

        <div className="slim-field">
          <label>UIA 详细日志</label>
          <label className="slim-toggle">
            <input
              type="checkbox"
              checked={uiaDetailedLogging}
              onChange={e => setUiaDetailedLogging(e.target.checked)}
            />
            <span className="slim-toggle__track" />
          </label>
          <span style={{ fontSize: 12, color: '#555' }}>仅排查微信窗口识别或联系人切换问题时开启</span>
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

