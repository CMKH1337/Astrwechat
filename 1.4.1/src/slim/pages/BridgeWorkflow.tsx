import { useEffect, useRef, useState } from 'react'
import {
  Bot,
  CircleAlert,
  X,
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
import { parseWorkflowEvent, workflowNewLines, type WorkflowIcon } from './bridgeWorkflowEvents'

interface WorkflowItem {
  id: number
  label: string
  detail: string
  icon: LucideIcon
  leaving: boolean
}

interface BridgeWorkflowProps {
  logs: string[]
  ready: boolean
  sequence: number
  revision: number
}

const MAX_ITEMS = 5
const ITEM_LIFETIME_MS = 7200
const COLLAPSE_MS = 320

const ICONS: Record<WorkflowIcon, LucideIcon> = {
  bot: Bot, inbox: Inbox, send: Send, list: List, keyboard: Keyboard,
  image: Image, file: FileText, error: CircleAlert, cancel: X
}

export default function BridgeWorkflow({ logs, ready, sequence, revision }: BridgeWorkflowProps) {
  const [items, setItems] = useState<WorkflowItem[]>([])
  const stageRef = useRef<HTMLDivElement>(null)
  const nextIdRef = useRef(1)
  const processedSequenceRef = useRef(0)
  const initializedRef = useRef(false)
  const revisionRef = useRef(revision)
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

    // getLogs() hydrates the complete history whenever the route mounts. Treat
    // that first snapshot as a baseline so returning from the sidebar does not
    // replay every old workflow notification.
    if (!ready) return
    if (!initializedRef.current) {
      processedSequenceRef.current = sequence
      initializedRef.current = true
      return
    }

    if (revision !== revisionRef.current || sequence < processedSequenceRef.current) {
      clearAllTimers()
      setItems([])
      revisionRef.current = revision
      lastItemCountRef.current = 0
    }

    const freshLines = workflowNewLines(logs, sequence, processedSequenceRef.current)
    const appended: WorkflowItem[] = []

    for (const line of freshLines) {
      const matched = parseWorkflowEvent(line)
      if (!matched) continue

      const id = nextIdRef.current
      nextIdRef.current += 1
      const item: WorkflowItem = {
        id,
        label: matched.label,
        detail: matched.detail,
        icon: ICONS[matched.icon],
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

    processedSequenceRef.current = sequence
  }, [logs, ready, sequence, revision])

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
