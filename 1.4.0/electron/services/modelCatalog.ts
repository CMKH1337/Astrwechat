/** Read only the configured provider; never probe another host or follow redirects. */
import type { BuiltinProtocol } from '../../shared/bridge-connection'
import type { BuiltinModelInfo, ModelCatalogResult } from '../../shared/builtin-model-config'

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
const positive = (...values: unknown[]): number | null => {
  for (const value of values) {
    if ((typeof value === 'number' || typeof value === 'string') && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 100_000_000) return Number(value)
  }
  return null
}
export function parseModel(value: unknown): BuiltinModelInfo | null {
  const raw = object(value)
  if (typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 256 || /[\x00-\x1f]/.test(raw.id)) return null
  const top = object(raw.top_provider), limits = object(raw.limits), architecture = object(raw.architecture)
  const modalities = architecture.input_modalities ?? raw.input_modalities
  const imageSupport = object(object(raw.capabilities).image_input).supported
  return {
    id: raw.id.trim(), name: String(raw.display_name || raw.name || raw.id).slice(0, 256),
    contextWindow: positive(top.context_length, raw.context_length, raw.context_window, raw.max_context_length, limits.context_window),
    maxInputTokens: positive(raw.max_input_tokens, raw.max_input_length, limits.max_input_tokens),
    maxOutputTokens: positive(top.max_completion_tokens, raw.max_output_tokens, raw.max_completion_tokens, raw.max_tokens, limits.max_output_tokens),
    vision: Array.isArray(modalities) ? modalities.includes('image') : typeof raw.supports_vision === 'boolean' ? raw.supports_vision : typeof imageSupport === 'boolean' ? imageSupport : null
  }
}
class CatalogError extends Error { constructor(readonly code: string, message: string) { super(message) } }
export async function fetchModelCatalog(raw: Record<string, unknown>, fetcher: typeof fetch = fetch): Promise<ModelCatalogResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const abort = new AbortController()
  try {
    const protocol = String(raw.builtin_protocol ?? '') as BuiltinProtocol
    const base = String(raw.builtin_base_url ?? '').trim(), key = String(raw.builtin_api_key ?? '').trim()
    if (!['chat_completions', 'responses', 'anthropic_messages'].includes(protocol) || !key || /[\x00-\x1f\x7f]/.test(key)) throw new CatalogError('E_MODELS_CONFIG', '请先填写接口格式、API 基础地址和有效的 API Key。')
    let url: URL
    try {
      url = new URL(base)
      if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || /\s/.test(base) || (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) || /\/(chat\/completions|responses|messages|models)\/?$/i.test(url.pathname)) throw new Error()
    } catch { throw new CatalogError('E_MODELS_CONFIG', '请填写 HTTPS 或本机 HTTP API 基础地址，不要填写完整接口路径。') }
    const path = url.pathname.replace(/\/+$/, '')
    url.pathname = protocol === 'anthropic_messages' && !path.endsWith('/v1') ? `${path}/v1/models` : `${path}/models`
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (protocol === 'anthropic_messages') { headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01' }
    else headers.Authorization = `Bearer ${key}`
    timer = setTimeout(() => abort.abort(), 20_000)
    const models = new Map<string, BuiltinModelInfo>(), cursors = new Set<string>()
    let totalBytes = 0, truncated = false
    for (let page = 0; page < 10; page++) {
      const response = await fetcher(url.toString(), { headers, signal: abort.signal, redirect: 'manual' })
      if (!response.ok) {
        await response.body?.cancel()
        const status = response.status
        const hint = status === 401 ? '鉴权失败，请检查 API Key。' : status === 403 ? '没有读取模型列表的权限。' : status === 404 ? '上游不提供此模型列表接口，可手动填写模型名称。' : status === 429 ? '请求过于频繁，请稍后重试。' : status >= 300 && status < 400 ? '已阻止重定向，请直接填写最终 API 基础地址。' : status >= 500 ? '上游服务异常，请稍后重试。' : '上游拒绝获取模型列表。'
        throw new CatalogError(`E_MODELS_HTTP_${status}`, hint)
      }
      const reader = response.body?.getReader()
      if (!reader) throw new CatalogError('E_MODELS_RESPONSE', '模型列表响应为空。')
      const chunks: Uint8Array[] = []
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          totalBytes += value.byteLength
          if (totalBytes > 8 * 1024 * 1024) { await reader.cancel(); throw new CatalogError('E_MODELS_TOO_LARGE', '模型列表过大，已停止读取。') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      let body: any
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new CatalogError('E_MODELS_RESPONSE', '上游未返回有效的 JSON 模型列表。') }
      const entries = Array.isArray(body) ? body : body?.data ?? body?.models
      if (!Array.isArray(entries)) throw new CatalogError('E_MODELS_RESPONSE', '上游模型列表格式不受支持，可手动填写模型名称。')
      for (const entry of entries) { const model = parseModel(entry); if (model) models.set(model.id, model); if (models.size >= 2000) { truncated = true; break } }
      if (truncated || !body?.has_more) break
      const cursor = body.last_id ?? object(entries[entries.length - 1]).id
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new CatalogError('E_MODELS_PAGINATION', '上游返回了无效或重复的分页游标。')
      cursors.add(cursor)
      url.searchParams.set(protocol === 'anthropic_messages' ? 'after_id' : 'after', cursor)
      if (page === 9) truncated = true
    }
    return { success: true, models: [...models.values()].sort((a, b) => a.id.localeCompare(b.id)), truncated }
  } catch (error) {
    // Never return provider bodies, headers, URLs containing credentials, or exception messages.
    if (error instanceof CatalogError) return { success: false, error: `[${error.code}] ${error.message}` }
    return { success: false, error: abort.signal.aborted ? '[E_MODELS_TIMEOUT] 获取模型列表超时，请稍后重试。' : '[E_MODELS_NETWORK] 无法连接上游，请检查网络、证书和 API 基础地址。' }
  } finally { if (timer) clearTimeout(timer) }
}
