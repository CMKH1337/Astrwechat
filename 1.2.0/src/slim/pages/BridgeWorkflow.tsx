import { useEffect, useRef, useState } from 'react'
import {
  Bot,
  FileText,
  Image,
  Inbox,
  Keyboard,
  List,
  Send,
  Workflow,
  type LucideIcon
} from 'lucide-react'
import './BridgeWorkflow.scss'

interface WorkflowPattern {
  label: string
  icon: LucideIcon
  test: (line: string) => boolean
  detail: (line: string) => string
}

interface WorkflowItem {
  id: number
  label: string
  detail: string
  icon: LucideIcon
  leaving: boolean
}

interface BridgeWorkflowProps {
  logs: string[]
}

const MAX_ITEMS = 5
const ITEM_LIFETIME_MS = 7200
const COLLAPSE_MS = 320

const groupLabel = (line: string) => {
  const match = line.match(/\[(?:群|私)\|([^\]]+)\]/)
  return match?.[1]?.trim() || ''
}

const contactLabel = (line: string) => {
  const match = line.match(/contact=([^ ]+)/)
  return match?.[1]?.trim() || ''
}

const sentTextLabel = (line: string) => {
  const match = line.match(/文字已发送至\s+([^:]+):\s*(.*)/)
  if (match) return `${match[1].trim()} · ${match[2].trim()}`
  const uiaMatch = line.match(/\[UIA✓\]\s*([^:]+):\s*(.*)/)
  return uiaMatch ? `${uiaMatch[1].trim()} · ${uiaMatch[2].trim()}` : line
}

const PATTERNS: WorkflowPattern[] = [
  {
    label: 'AstrBot 已连接',
    icon: Bot,
    test: line => line.includes('已连接到 AstrBot'),
    detail: () => 'WebSocket 已建立'
  },
  {
    label: '接收微信消息',
    icon: Inbox,
    test: line => line.includes('收到来自'),
    detail: line => groupLabel(line) || 'WeFlow SSE'
  },
  {
    label: '推送至 AstrBot',
    icon: Send,
    test: line => line.includes('推送 ') && line.includes('条消息'),
    detail: line => groupLabel(line) || 'OneBot 事件'
  },
  {
    label: '进入发送队列',
    icon: List,
    test: line => line.includes('已进入发送队列'),
    detail: line => contactLabel(line) || 'FIFO 队列'
  },
  {
    label: 'UIA 发送消息',
    icon: Keyboard,
    test: line => line.includes('文字已发送至'),
    detail: sentTextLabel
  },
  {
    label: '发送文件',
    icon: FileText,
    test: line => line.includes('File sent to') || line.includes('[UIA ok] file'),
    detail: line => contactLabel(line) || line
  },
  {
    label: '发送图片',
    icon: Image,
    test: line => line.includes('图片已发送至') || line.includes('[UIA✓] 图片'),
    detail: line => contactLabel(line) || line
  }
]

const matchPattern = (line: string) => {
  const normalized = line.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').trim()
  return PATTERNS.find(pattern => pattern.test(normalized))
}

export default function BridgeWorkflow({ logs }: BridgeWorkflowProps) {
  const [items, setItems] = useState<WorkflowItem[]>([])
  const stageRef = useRef<HTMLDivElement>(null)
  const nextIdRef = useRef(1)
  const processedCountRef = useRef(0)
  const lastItemCountRef = useRef(0)
  const expireTimersRef = useRef(new Map<number, number>())
  const collapseTimersRef = useRef(new Map<number, number>())

  useEffect(() => {
    const expireTimers = expireTimersRef.current
    const collapseTimers = collapseTimersRef.current

    const clearItemTimers = (id: number) => {
      const expireTimer = expireTimers.get(id)
      if (expireTimer !== undefined) {
        window.clearTimeout(expireTimer)
        expireTimers.delete(id)
      }
      const collapseTimer = collapseTimers.get(id)
      if (collapseTimer !== undefined) {
        window.clearTimeout(collapseTimer)
        collapseTimers.delete(id)
      }
    }

    const clearAllTimers = () => {
      expireTimers.forEach(timer => window.clearTimeout(timer))
      collapseTimers.forEach(timer => window.clearTimeout(timer))
      expireTimers.clear()
      collapseTimers.clear()
    }

    if (logs.length < processedCountRef.current) {
      clearAllTimers()
      setItems([])
      processedCountRef.current = 0
      lastItemCountRef.current = 0
    }

    const startIndex = processedCountRef.current
    const appended: WorkflowItem[] = []

    for (let index = startIndex; index < logs.length; index += 1) {
      const line = logs[index]
      const pattern = matchPattern(line)
      if (!pattern) continue

      const id = nextIdRef.current
      nextIdRef.current += 1
      const item: WorkflowItem = {
        id,
        label: pattern.label,
        detail: pattern.detail(line) || line,
        icon: pattern.icon,
        leaving: false
      }
      appended.push(item)

      expireTimers.set(id, window.setTimeout(() => {
        expireTimers.delete(id)
        setItems(prev => prev.map(current =>
          current.id === id ? { ...current, leaving: true } : current
        ))
        collapseTimers.set(id, window.setTimeout(() => {
          collapseTimers.delete(id)
          setItems(prev => prev.filter(current => current.id !== id))
        }, COLLAPSE_MS))
      }, ITEM_LIFETIME_MS))
    }

    if (appended.length > 0) {
      setItems(prev => {
        const next = [...prev, ...appended]
        if (next.length <= MAX_ITEMS) return next
        const removed = next.slice(0, next.length - MAX_ITEMS)
        removed.forEach(item => clearItemTimers(item.id))
        return next.slice(-MAX_ITEMS)
      })
    }

    processedCountRef.current = logs.length
  }, [logs])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return

    if (items.length > lastItemCountRef.current) {
      window.requestAnimationFrame(() => {
        stage.scrollTo({ top: stage.scrollHeight, behavior: 'smooth' })
      })
    }
    lastItemCountRef.current = items.length
  }, [items])

  useEffect(() => {
    const expireTimers = expireTimersRef.current
    const collapseTimers = collapseTimersRef.current
    return () => {
      expireTimers.forEach(timer => window.clearTimeout(timer))
      collapseTimers.forEach(timer => window.clearTimeout(timer))
      expireTimers.clear()
      collapseTimers.clear()
    }
  }, [])

  return (
    <section className="slim-card bridge-overview-card bridge-workflow">
      <div className="bridge-card-heading">
        <span className="bridge-card-heading__icon"><Workflow size={16} /></span>
        <h3>Work</h3>
        {items.length > 0 && (
          <span className="bridge-workflow__count">{items.length}</span>
        )}
      </div>
      <div ref={stageRef} className="bridge-workflow__stage" aria-live="polite">
        {items.map(item => {
          const ItemIcon = item.icon
          return (
            <div
              key={item.id}
              className={`bridge-workflow__item ${item.leaving ? 'is-leaving' : ''}`}
            >
              <span className="bridge-workflow__icon"><ItemIcon size={17} /></span>
              <span className="bridge-workflow__copy">
                <strong>{item.label}</strong>
                <em>{item.detail}</em>
              </span>
              <span className="bridge-workflow__lifetime" aria-hidden="true" />
            </div>
          )
        })}
      </div>
    </section>
  )
}
