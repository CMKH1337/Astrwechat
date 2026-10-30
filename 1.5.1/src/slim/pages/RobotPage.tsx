import { useState } from 'react'
import { CircleAlert, CircleCheck, RefreshCw, Save } from 'lucide-react'
import bridgeDefaultConfig from '../../../shared/bridge-default-config.json'
import { BOT_LABELS, normalizeBridgeConnection, requiresBridgeRestart, validateBridgeConnection } from '../../../shared/bridge-connection'
import { isSameConfig, type BridgeConfig } from './bridgeConfig'
import useBridgeConfig from './useBridgeConfig'
import useBridgeStatus from './useBridgeStatus'
import BuiltinModelOptions from './BuiltinModelOptions'
import '../AppSlim.scss'
import './BridgePage.scss'
import './RobotPage.scss'

export default function RobotPage() {
  const {
    config, setConfig, savedConfig, configHydrated, configLoading,
    configLoadError, configLoadWarning, loadBridgeConfig, applySavedConfig
  } = useBridgeConfig()
  const { status, refreshStatus } = useBridgeStatus()
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')
  const [apiLinkError, setApiLinkError] = useState('')
  const hasUnsavedChanges = configHydrated && !isSameConfig(config, savedConfig)
  const liveBackend = status.processRunning ? (status.bot_backend || savedConfig.bot_backend) : savedConfig.bot_backend
  const liveLabel = BOT_LABELS[liveBackend]
  const connectionState = status.ob_connected ? (liveBackend === 'builtin' ? '已就绪' : '已连接')
    : status.starting ? '启动中'
    : status.ob_state === 'connecting' ? '连接中'
    : status.ob_state === 'stopping' ? '正在停止'
    : status.ob_state === 'error' ? '连接异常' : '未连接'
  const willReconnect = status.processRunning && requiresBridgeRestart(savedConfig, config)
  const saveLabel = willReconnect
    ? (savedConfig.bot_backend !== config.bot_backend ? `保存并切换至 ${BOT_LABELS[config.bot_backend]}` : '保存并重新连接')
    : '保存配置'

  const openApiService = async () => {
    setApiLinkError('')
    try {
      const result = await window.electronAPI.shell.openExternal('https://hhapi.xyz/sign-up?aff=j6U0')
      if (!result.success) setApiLinkError('无法打开浏览器，请稍后重试。')
    } catch {
      setApiLinkError('无法打开浏览器，请稍后重试。')
    }
  }

  const handleSaveConfig = async () => {
    if (!configHydrated || saving || status.starting) return
    setSaveMsg('')
    const invalid = validateBridgeConnection(config)
    if (invalid) { setSaveMsg(invalid); return }
    setSaving(true)
    try {
      // Save only robot-owned fields; the main process merges the latest Bridge settings.
      const connection = normalizeBridgeConnection(config)
      const result = await window.electronAPI.bridge.saveConfig({
        ...connection,
        force_push_triggers: config.force_push_triggers
      })
      if (!result.success) { setSaveMsg('保存失败：' + (result.error || '')); return }
      const saved = applySavedConfig(result.config || { ...config, ...connection })
      setSaveMsg(result.warning || (result.restarted ? `配置已保存，正在连接 ${BOT_LABELS[saved.bot_backend]}` : '配置已保存'))
      void refreshStatus()
    } catch (error) {
      setSaveMsg('保存失败：' + String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bridge-page robot-page">
      <div className="bridge-page__header">
        <h2>机器人连接</h2>
        <span className={`slim-badge ${status.ob_connected ? 'slim-badge--ok' : 'slim-badge--idle'}`}>
          {liveLabel} {connectionState}
        </span>
        {configHydrated && (
          <span className={`bridge-sync-label ${hasUnsavedChanges ? 'is-dirty' : ''}`}>
            {hasUnsavedChanges ? <CircleAlert size={13} /> : <CircleCheck size={13} />}
            {hasUnsavedChanges ? '有未保存的修改' : '配置已保存'}
          </span>
        )}
      </div>
      {configLoading && <div className="bridge-connection-notice" role="status">正在读取机器人配置…</div>}
      {configLoadError && (
        <div className="bridge-connection-notice" role="alert">
          <span>配置读取失败：{configLoadError}。已有配置不会被默认值覆盖。</span>
          <button className="slim-btn slim-btn--secondary" onClick={() => void loadBridgeConfig()} disabled={configLoading}>
            <RefreshCw size={14} />重新读取配置
          </button>
        </div>
      )}
      {configLoadWarning && <div className="bridge-connection-notice" role="alert">{configLoadWarning}</div>}
      {(status.ob_error || status.starting) && (
        <div className="bridge-connection-notice" role="status" aria-live="polite">
          {status.starting && <span>{status.startup_stage || '正在准备微信消息接收…'}</span>}
          {status.ob_error && <span>{status.ob_error}</span>}
        </div>
      )}
      <div className="bridge-config-view">
        <fieldset className="bridge-edit-fields" disabled={saving || status.starting || !configHydrated}>
          <section className="robot-connections" aria-labelledby="bridge-connections-title">
            <div className="robot-connections__title" id="bridge-connections-title">连接方式</div>
            <p className="bridge-connections__intro">选择连接方式，填写对应配置后保存。切换方式不会清空已填写的参数。</p>
            <div className="robot-backend-control" role="radiogroup" aria-label="机器人连接方式">
              {(['astrbot', 'kourichat', 'builtin'] as const).map(backend => (
                <label key={backend} className={`robot-backend-segment ${config.bot_backend === backend ? 'is-selected' : ''}`}>
                  <input
                    type="radio"
                    name="bot-backend"
                    value={backend}
                    checked={config.bot_backend === backend}
                    onChange={() => {
                      setConfig(prev => ({ ...prev, bot_backend: backend }))
                      setSaveMsg('')
                      setApiLinkError('')
                    }}
                  />
                  <span className="robot-backend-segment__label">{BOT_LABELS[backend]}</span>
                </label>
              ))}
            </div>
            <p className="robot-backend-hint" role="status" aria-live="polite">
              {config.bot_backend !== savedConfig.bot_backend
                ? `已选择 ${BOT_LABELS[config.bot_backend]}，保存后切换连接方式。`
                : '保存后应用配置；正在运行的连接如需重连，会先安全停止旧 Bridge。'}
            </p>
            <div className="bridge-connection-groups">
              {(['astrbot', 'kourichat'] as const).filter(backend => config.bot_backend === backend).map(backend => {
                const active = savedConfig.bot_backend === backend
                const urlKey = `${backend}_ob_url` as const
                const tokenKey = `${backend}_ob_token` as const
                const label = BOT_LABELS[backend]
                return (
                  <section key={backend} className="robot-connection-config" aria-label={`${label} 连接配置`}>
                    <div className="bridge-connection-group__heading">
                      <strong>{label} 配置</strong>
                      <span className={`slim-badge ${status.processRunning && liveBackend === backend && status.ob_connected ? 'slim-badge--ok' : 'slim-badge--idle'}`}>
                        {status.processRunning && liveBackend === backend ? connectionState : active ? '当前启用' : '未启用'}
                      </span>
                    </div>
                    <div className="slim-field">
                      <label htmlFor={`${backend}-ws`}>反向 WebSocket 地址</label>
                      <input id={`${backend}-ws`} type="text" value={config[urlKey]}
                        onChange={event => setConfig(prev => ({ ...prev, [urlKey]: event.target.value }))}
                        placeholder={bridgeDefaultConfig[urlKey]} autoComplete="off" spellCheck={false} />
                    </div>
                    <div className="slim-field">
                      <label htmlFor={`${backend}-token`}>连接 Token</label>
                      <input id={`${backend}-token`} type="password" value={config[tokenKey]}
                        onChange={event => setConfig(prev => ({ ...prev, [tokenKey]: event.target.value }))}
                        placeholder="与服务端一致，未启用鉴权则留空" autoComplete="off" />
                    </div>
                    {backend === 'astrbot' && <div className="slim-field">
                      <label htmlFor="force-push-triggers">触发词</label>
                      <input id="force-push-triggers" type="text" value={config.force_push_triggers}
                        onChange={event => setConfig(prev => ({ ...prev, force_push_triggers: event.target.value }))}
                        placeholder="/, !ai, 小助手" autoComplete="off" />
                      <p className="bridge-connection-group__help">多个开头请用英文逗号分隔。消息以任一触发词开头时，会立即推送给 AstrBot，不经过群聊 @ 和主动回复概率判断。默认触发词为 /。</p>
                    </div>}
                    <p className="bridge-connection-group__help">
                      {backend === 'astrbot'
                        ? '填写 AstrBot 的 OneBot v11 反向 WebSocket 地址，原有配置保持兼容。'
                        : 'KouriChat 使用通用 OneBot 的 reverse 模式，关闭 OpenClaw 适配器；此方式不需要微信网关或扫码。'}
                    </p>
                    {backend === 'kourichat' && <details className="bridge-connection-help">
                      <summary>KouriChat 配置示例</summary>
                      <pre>{`[[adapters]]
module = "kourichat.adapter.onebot"
[adapters.config]
mode = "reverse"
ws_host = "127.0.0.1"
ws_port = 6700
token = "与此处填写的 Token 一致"`}</pre>
                      <p>同机连接使用以上地址。首次联调先关闭 KouriChat 的 logic.echo，避免其当前回显等待回执的问题；正常模型回复不依赖 echo。</p>
                    </details>}
                  </section>
                )
              })}
              {config.bot_backend === 'builtin' && (
                <section className="robot-connection-config" aria-label="API 配置">
                  <div className="bridge-connection-group__heading">
                    <strong>API 配置</strong>
                    <a className="bridge-api-service-link" href="https://hhapi.xyz/sign-up?aff=j6U0" target="_blank" rel="noopener noreferrer" title="使用我的邀请码j6U0获得两元体验金" aria-label="使用我的邀请码j6U0获得两元体验金"
                      onClick={event => { event.preventDefault(); void openApiService() }}
                      onAuxClick={event => { if (event.button === 1) { event.preventDefault(); void openApiService() } }}>
                      正在寻找合适的API服务？
                    </a>
                  </div>
                  {apiLinkError && <p className="bridge-connection-group__help" role="alert">{apiLinkError}</p>}
                  <div className="slim-field">
                    <label htmlFor="builtin-protocol">接口格式</label>
                    <select id="builtin-protocol" className="bridge-select bridge-model-select" value={config.builtin_protocol} onChange={event => setConfig(prev => ({ ...prev, builtin_protocol: event.target.value as BridgeConfig['builtin_protocol'], builtin_model_metadata: null, builtin_base_url: event.target.value === 'anthropic_messages' && prev.builtin_base_url === 'https://api.openai.com/v1' ? 'https://api.anthropic.com' : event.target.value !== 'anthropic_messages' && prev.builtin_base_url === 'https://api.anthropic.com' ? 'https://api.openai.com/v1' : prev.builtin_base_url }))}>
                      <option value="chat_completions">Chat Completions</option>
                      <option value="responses">Responses</option>
                      <option value="anthropic_messages">Anthropic Messages</option>
                    </select>
                  </div>
                  <div className="slim-field"><label htmlFor="builtin-url">API 基础地址</label><input id="builtin-url" className="bridge-model-url" type="url" autoComplete="off" autoCapitalize="none" value={config.builtin_base_url} onChange={event => setConfig(prev => ({ ...prev, builtin_base_url: event.target.value, builtin_model_metadata: null }))} placeholder={config.builtin_protocol === 'anthropic_messages' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'} spellCheck={false} /></div>
                  <div className="slim-field"><label htmlFor="builtin-key">API Key</label><input id="builtin-key" type="password" value={config.builtin_api_key} onChange={event => setConfig(prev => ({ ...prev, builtin_api_key: event.target.value, builtin_model_metadata: null }))} autoComplete="off" /></div>
                  <div className="slim-field"><label htmlFor="builtin-model">模型名称</label><input id="builtin-model" type="text" value={config.builtin_model} onChange={event => setConfig(prev => ({ ...prev, builtin_model: event.target.value, builtin_model_metadata: null }))} placeholder="填写服务商提供的模型 ID" spellCheck={false} /></div>
                  <BuiltinModelOptions config={config} update={patch => setConfig(prev => ({ ...prev, ...patch }))} />
                  <div className="slim-field"><label htmlFor="builtin-prompt">系统提示词</label><textarea id="builtin-prompt" value={config.builtin_system_prompt} onChange={event => setConfig(prev => ({ ...prev, builtin_system_prompt: event.target.value }))} rows={4} /></div>
                  <div className="slim-field"><label htmlFor="builtin-timeout">请求超时（秒）</label><input id="builtin-timeout" type="number" min={5} max={300} value={config.builtin_timeout_seconds} onChange={event => setConfig(prev => ({ ...prev, builtin_timeout_seconds: Number(event.target.value) }))} /></div>
                  <label className="bridge-backend-choice"><input type="checkbox" checked={config.builtin_send_images}
                    onChange={event => setConfig(prev => ({ ...prev, builtin_send_images: event.target.checked }))} />
                    向模型发送关联图片/表情（需要支持识图的模型）</label>
                  <div className="slim-field">
                    <label className="bridge-backend-choice"><input type="checkbox" checked={config.builtin_send_errors}
                      onChange={event => setConfig(prev => ({ ...prev, builtin_send_errors: event.target.checked }))} />
                      发送错误码到当前会话（模型调用失败时）</label>
                    <p className="bridge-connection-group__help">默认关闭。开启后发送错误码、简短原因和排查建议，不发送密钥、原始响应或聊天内容。同一会话 60 秒内最多尝试一次通知，遵守暂停和白名单；通知不进入模型历史。保存后会重启 API 模式的 Bridge。</p>
                  </div>
                  <details className="bridge-connection-help">
                    <summary>常见错误码说明</summary>
                    <p>E_MODEL_AUTH：鉴权失败，检查 API Key。E_MODEL_PERMISSION：模型权限不足。E_MODEL_NOT_FOUND：模型或接口不存在。E_MODEL_RATE_LIMIT：限流或配额不足。E_MODEL_TIMEOUT：请求超时。E_MODEL_NETWORK：网络或证书连接失败。E_MODEL_SERVER：服务商异常。E_MODEL_EMPTY：空回复。E_WECHAT_SEND：模型已回复，但微信发送失败；不会自动重发。</p>
                  </details>
                  <p className="bridge-connection-group__help">启用后图片会发往所填模型服务商。文件仅传描述，不上传原件或本机路径。历史按独立消息传入；请求失败不切换其他模式。API Key 保存在本机配置及备份中，请勿分享配置文件。</p>
                </section>
              )}
            </div>
            {willReconnect && <p className="bridge-connection-warning">保存后会停止旧 Bridge，再启动所选模式。旧进程尚未发送的回复会丢弃，已经发出的消息不会撤回。</p>}
          </section>
        </fieldset>
        <div className="bridge-save-actions">
          <button className="slim-btn slim-btn--primary" onClick={handleSaveConfig} disabled={saving || status.starting || !configHydrated}>
            <Save size={14} />
            {saving ? '保存并应用中...' : saveLabel}
          </button>
          <span className="bridge-save-feedback" role="status" aria-live="polite" aria-atomic="true">
            {saving ? '正在保存并应用配置…' : saveMsg}
          </span>
        </div>
      </div>
    </div>
  )
}
