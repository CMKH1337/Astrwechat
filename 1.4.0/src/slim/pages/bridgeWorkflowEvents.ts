// Parse operational log prefixes, never keywords inside chat/model content.
export type WorkflowIcon = 'bot' | 'inbox' | 'send' | 'list' | 'keyboard' | 'image' | 'file' | 'error' | 'cancel'
export interface WorkflowEvent { label: string; detail: string; icon: WorkflowIcon }
export function normalizeWorkflowLine(line: string): string {
  return line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim().replace(/^\[(?:INFO|WARN|WARNING|ERROR|DEBUG)\]\s*/i, '')
}
const groupLabel = (line: string) => line.match(/\[(?:群|私)\|([^\]]+)\]/)?.[1]?.trim() || ''
const contactLabel = (line: string) => line.match(/contact=(.*?)(?=\s+(?:operations|session|type|echo)=|$)/)?.[1]?.trim() || ''
const event = (label: string, detail: string, icon: WorkflowIcon): WorkflowEvent => ({ label, detail, icon })

export function parseWorkflowEvent(value: string): WorkflowEvent | null {
  const line = normalizeWorkflowLine(value)
  if (/^(?:\[OB11\]\s*)?(?:✅\s*)?已连接到 (AstrBot|KouriChat)/.test(line)) return event('机器人已连接', `${line.includes('KouriChat') ? 'KouriChat' : 'AstrBot'} · WebSocket 已建立`, 'bot')
  if (/^\[内置模型\] 正在请求模型 /.test(line)) return event('请求内置模型', groupLabel(line) || '内置模型', 'send')
  if (/^\[内置模型\] 已收到模型回复 /.test(line)) return event('模型回复已生成', groupLabel(line) || '准备 UIA 发送', 'bot')
  if (/^\[内置模型\] 本次回复已取消 /.test(line)) return event('内置模型回复已取消', groupLabel(line) || '本次任务已中止', 'cancel')
  if (/^\[E_(?:MODEL_[A-Z_]+|REPLY_SEGMENT|REPLY_FILTERED|WECHAT_SEND|ERROR_NOTIFY_SEND)\]/.test(line)) {
    const detail = line.replace(/\s+异常类型：.*$/, '')
    return event(line.startsWith('[E_REPLY_FILTERED]') ? '已跳过空回复' : line.startsWith('[E_REPLY_SEGMENT]') ? '分段规则回退' : '内置模型处理异常', detail, 'error')
  }
  const received = line.match(/^(?:📩\s*)?收到来自 (.+) 的消息/)
  if (received) return event('接收微信消息', groupLabel(line) || received[1], 'inbox')
  // Raw SSE receipt lines are intentionally omitted: the buffered receipt above
  // is the single workflow event for messages that enter processing.
  const forwarded = line.match(/^推送 \d+ 条消息 至 (AstrBot|KouriChat) /)
  if (forwarded) return event('推送至机器人', `${forwarded[1]} · ${groupLabel(line) || 'OneBot 事件'}`, 'send')
  if (/^\[OB11\] 已进入发送队列:/.test(line)) return event('进入发送队列', contactLabel(line) || 'FIFO 队列', 'list')
  const image = line.match(/^\[UIA✓\] 图片 → (.*?): (.*)/)
  if (image) return event('发送图片', `${image[1]} · ${image[2]}`, 'image')
  const file = line.match(/^\[UIA ok\] file -> (.*?): (.*)/)
  if (file) return event('发送文件', `${file[1]} · ${file[2]}`, 'file')
  const text = line.match(/^\[UIA✓\] (.*?): ([\s\S]*)/)
  if (text) return event('UIA 发送消息', `${text[1]} · ${text[2].trim()}`, 'keyboard')
  // OB11 logs the same success immediately after the shared UIA sender. Use only
  // the underlying confirmation for all backends to avoid duplicate Work cards.
  if (/^\[UIA(?:✗| failed)\]/.test(line)) return event('UIA 发送失败', line.replace(/^\[UIA(?:✗| failed)\]\s*/, ''), 'error')
  return null
}

export interface WorkflowLogBatch { lines: string[]; sequence: number; revision: number }
export const appendWorkflowLog = (batch: WorkflowLogBatch, line: string): WorkflowLogBatch => ({
  lines: [...batch.lines, line].slice(-500), sequence: batch.sequence + 1, revision: batch.revision
})
export const clearWorkflowLogs = (batch: WorkflowLogBatch): WorkflowLogBatch => ({
  lines: [], sequence: batch.sequence, revision: batch.revision + 1
})
// Live sequence numbers remain increasing when the 500-line buffer rolls over,
// including when consecutive log lines have identical text.
export const workflowNewLines = (logs: string[], sequence: number, previous: number): string[] =>
  logs.slice(logs.length - Math.min(logs.length, Math.max(0, sequence - previous)))
