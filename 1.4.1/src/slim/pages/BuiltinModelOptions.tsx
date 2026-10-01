import { useEffect, useRef, useState } from 'react'
import type { BridgeConnectionConfig } from '../../../shared/bridge-connection'
import { normalizeModelMetadata, type BuiltinModelInfo } from '../../../shared/builtin-model-config'

type Props = { config: BridgeConnectionConfig; update: (patch: Partial<BridgeConnectionConfig>) => void }
export default function BuiltinModelOptions({ config, update }: Props) {
  const [models, setModels] = useState<BuiltinModelInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const revision = useRef(0)
  const source = [config.builtin_protocol, config.builtin_base_url, config.builtin_api_key].join('\n')
  const sourceRef = useRef(source)
  sourceRef.current = source
  const configRef = useRef(config)
  configRef.current = config
  useEffect(() => { revision.current++; setModels([]); setBusy(false); setMessage(''); setError('') }, [source])
  useEffect(() => () => { revision.current++ }, [])
  const metadata = normalizeModelMetadata(config.builtin_model_metadata, config as unknown as Record<string, unknown>)
  const choose = (model: BuiltinModelInfo) => update({
    builtin_model: model.id,
    builtin_model_metadata: { ...model, baseUrl: config.builtin_base_url.trim().replace(/\/+$/, ''), protocol: config.builtin_protocol },
    ...(model.vision === false ? { builtin_send_images: false } : {})
  })
  const fetchModels = async () => {
    const current = ++revision.current, requestedSource = source
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await window.electronAPI.bridge.getModels({ builtin_protocol: config.builtin_protocol, builtin_base_url: config.builtin_base_url, builtin_api_key: config.builtin_api_key })
      if (current !== revision.current || sourceRef.current !== requestedSource) return
      if (!result.success) { setError(result.error || '[E_MODELS_UNKNOWN] 获取失败'); return }
      const list = result.models ?? []
      setModels(list)
      setMessage(list.length ? `已获取 ${list.length} 个模型${result.truncated ? '，列表已截断' : ''}。选择后应用上游能力，保存后生效。` : '上游返回空列表，仍可手动填写模型名称。')
      const selected = list.find(model => model.id === configRef.current.builtin_model)
      if (selected) choose(selected)
    } catch { if (current === revision.current) setError('[E_MODELS_IPC] 无法获取模型列表，请稍后重试。') }
    finally { if (current === revision.current) setBusy(false) }
  }
  return <>
    <div className="bridge-model-catalog">
      <button type="button" className="slim-btn slim-btn--secondary" id="builtin-fetch-models" disabled={busy || !config.builtin_api_key.trim() || !config.builtin_base_url.trim()} onClick={() => void fetchModels()}>{busy ? '正在获取…' : '获取上游模型'}</button>
      {models.length > 0 && <div className="slim-field"><label htmlFor="builtin-model-list">上游模型列表</label><select id="builtin-model-list" className="bridge-select bridge-model-select" value={models.some(m => m.id === config.builtin_model) ? config.builtin_model : ''} onChange={event => { const selected = models.find(m => m.id === event.target.value); if (selected) choose(selected) }}><option value="">选择模型，也可在上方手动填写</option>{models.map(model => <option key={model.id} value={model.id}>{model.name === model.id ? model.id : `${model.name} · ${model.id}`}</option>)}</select></div>}
      {message && <p className="bridge-connection-group__help" role="status">{message}</p>}
      {error && <p className="bridge-connection-group__help" role="alert">{error}</p>}
      <p className="bridge-connection-group__help" id="builtin-model-capabilities">上游上下文：{metadata?.contextWindow?.toLocaleString() ?? '未提供'}；输入上限：{metadata?.maxInputTokens?.toLocaleString() ?? '未提供'}；输出上限：{metadata?.maxOutputTokens?.toLocaleString() ?? '未提供'}；识图：{metadata?.vision == null ? '未提供' : metadata.vision ? '支持' : '不支持'}。</p>
      <div className="bridge-model-limits">
        <div className="slim-field"><label htmlFor="builtin-context-rounds">上下文对话轮数（每个会话独立计算）</label><input id="builtin-context-rounds" type="number" min={1} max={1000} step={1} value={config.builtin_context_rounds} onChange={e => update({ builtin_context_rounds: Math.min(1000, Math.max(1, Math.round(Number(e.target.value) || 1))) })}/><p className="bridge-connection-group__help">只保留最近 N 轮对话。群聊中被记录的每条成员消息都算一轮，即使没有触发 AI 回复；模型仍会遵守上游 token 上限。</p></div>
        <div className="slim-field"><label htmlFor="builtin-output-tokens">最大输出长度（token）</label><input id="builtin-output-tokens" type="number" min={1} max={1000000} value={config.builtin_max_output_tokens} onChange={e => update({ builtin_max_output_tokens: Number(e.target.value) })}/></div>
      </div>
    </div>
    <fieldset className="bridge-segment-options">
      <legend>分段回复</legend>
      <label className="bridge-backend-choice"><input id="builtin-segment-enabled" type="checkbox" checked={config.builtin_segment_enabled} onChange={e => update({ builtin_segment_enabled: e.target.checked })}/>启用分段回复</label>
      <label className="bridge-backend-choice"><input id="builtin-segment-only-llm" type="checkbox" disabled={!config.builtin_segment_enabled} checked={config.builtin_segment_only_llm} onChange={e => update({ builtin_segment_only_llm: e.target.checked })}/>仅对 LLM 结果分段</label>
      <p className="bridge-connection-group__help">默认只处理内置模型生成的文本；取消“仅对 LLM”后也处理内置模型错误通知。不影响 AW 本地指令、其他机器人后端或文件发送。</p>
      <div className="slim-field"><label htmlFor="builtin-segment-interval">间隔方法</label><select id="builtin-segment-interval" className="bridge-select bridge-model-select" disabled={!config.builtin_segment_enabled} value={config.builtin_segment_interval} onChange={e => update({ builtin_segment_interval: e.target.value as 'random' | 'log' })}><option value="random">random · 随机时间</option><option value="log">log · 按消息长度计算</option></select><p className="bridge-connection-group__help">random 使用随机秒数；log 使用 log_base(上一段字数)，最长 60 秒。首段立即发送。</p></div>
      <div className="slim-field"><label htmlFor="builtin-segment-random">随机间隔时间（秒，最小值,最大值）</label><input id="builtin-segment-random" type="text" disabled={!config.builtin_segment_enabled || config.builtin_segment_interval !== 'random'} value={config.builtin_segment_random} onChange={e => update({ builtin_segment_random: e.target.value })} placeholder="1.5,3.5" /></div>
      {config.builtin_segment_interval === 'log' && <div className="slim-field"><label htmlFor="builtin-segment-base">对数底数</label><input id="builtin-segment-base" type="number" min={1.01} max={100} step={0.1} disabled={!config.builtin_segment_enabled} value={config.builtin_segment_log_base} onChange={e => update({ builtin_segment_log_base: Number(e.target.value) })}/></div>}
      <div className="slim-field"><label htmlFor="builtin-segment-threshold">分段回复字数阈值</label><input id="builtin-segment-threshold" type="number" min={1} max={10000} disabled={!config.builtin_segment_enabled} value={config.builtin_segment_threshold} onChange={e => update({ builtin_segment_threshold: Number(e.target.value) })}/><p className="bridge-connection-group__help">只有字数小于此值才分段；达到或超过阈值时直接发送原文，不执行过滤。默认 150。</p></div>
      <div className="slim-field"><label htmlFor="builtin-segment-mode">分段模式</label><select id="builtin-segment-mode" className="bridge-select bridge-model-select" disabled={!config.builtin_segment_enabled} value={config.builtin_segment_mode} onChange={e => update({ builtin_segment_mode: e.target.value as 'regex' | 'newline' })}><option value="regex">正则表达式</option><option value="newline">按换行分段</option></select></div>
      <div className="slim-field"><label htmlFor="builtin-segment-regex">分段正则表达式</label><input id="builtin-segment-regex" type="text" disabled={!config.builtin_segment_enabled || config.builtin_segment_mode !== 'regex'} value={config.builtin_segment_regex} onChange={e => update({ builtin_segment_regex: e.target.value })} spellCheck={false}/><p className="bridge-connection-group__help">使用 Python regex 语法，匹配每个分段。保留未匹配内容与标点，最多发送 20 段；执行超时则按原文发送。</p></div>
      <div className="slim-field"><label htmlFor="builtin-segment-filter">内容过滤正则表达式</label><input id="builtin-segment-filter" type="text" disabled={!config.builtin_segment_enabled} value={config.builtin_segment_filter} onChange={e => update({ builtin_segment_filter: e.target.value })} placeholder="留空不过滤，例如 [。？！]" spellCheck={false}/><p className="bridge-connection-group__help">移除每段匹配的内容，过滤后为空则不发送。暂停、停止或会话权限变化会取消后续分段，失败不自动重发。</p></div>
    </fieldset>
  </>
}
