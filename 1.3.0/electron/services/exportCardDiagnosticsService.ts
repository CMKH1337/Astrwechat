export type ExportCardDiagLevel = 'debug' | 'info' | 'warn' | 'error'
export type ExportCardDiagStatus = 'running' | 'done' | 'failed' | 'timeout'

export interface ExportCardDiagLogInput {
  traceId: string
  source?: string
  level?: ExportCardDiagLevel
  message: string
  stepId?: string
  stepName?: string
  status?: ExportCardDiagStatus
  durationMs?: number
  data?: Record<string, unknown>
}

export interface ExportCardDiagStepStartInput {
  traceId: string
  stepId: string
  stepName: string
  source?: string
  message: string
  data?: Record<string, unknown>
}

export interface ExportCardDiagStepEndInput {
  traceId: string
  stepId: string
  stepName: string
  source?: string
  status: ExportCardDiagStatus
  message: string
  durationMs?: number
  data?: Record<string, unknown>
}

export interface ExportCardDiagRecord {
  traceId: string
  source: string
  level: ExportCardDiagLevel
  message: string
  stepId?: string
  stepName?: string
  status?: ExportCardDiagStatus
  durationMs?: number
  data?: Record<string, unknown>
  loggedAt: number
}

const MAX_RECORDS_PER_TRACE = 500
const MAX_TRACES = 20

/**
 * 导出卡片链路诊断：按 traceId 在内存中留存最近的步骤日志，供排查导出卡片失败使用。
 * 仅内存留存，不落盘。
 */
class ExportCardDiagnosticsService {
  private readonly traces = new Map<string, ExportCardDiagRecord[]>()

  log(input: ExportCardDiagLogInput): void {
    const traceId = (input.traceId || '').trim()
    if (!traceId) return

    this.append(traceId, {
      traceId,
      source: input.source || 'backend',
      level: input.level || 'info',
      message: input.message,
      stepId: input.stepId,
      stepName: input.stepName,
      status: input.status,
      durationMs: input.durationMs,
      data: input.data,
      loggedAt: Date.now()
    })
  }

  stepStart(input: ExportCardDiagStepStartInput): void {
    this.log({
      traceId: input.traceId,
      source: input.source,
      level: 'info',
      message: input.message,
      stepId: input.stepId,
      stepName: input.stepName,
      status: 'running',
      data: input.data
    })
  }

  stepEnd(input: ExportCardDiagStepEndInput): void {
    this.log({
      traceId: input.traceId,
      source: input.source,
      level: input.status === 'done' ? 'info' : 'warn',
      message: input.message,
      stepId: input.stepId,
      stepName: input.stepName,
      status: input.status,
      durationMs: input.durationMs,
      data: input.data
    })
  }

  getTrace(traceId: string): ExportCardDiagRecord[] {
    const key = (traceId || '').trim()
    if (!key) return []
    return [...(this.traces.get(key) || [])]
  }

  clearTrace(traceId: string): void {
    const key = (traceId || '').trim()
    if (!key) return
    this.traces.delete(key)
  }

  clearAll(): void {
    this.traces.clear()
  }

  private append(traceId: string, record: ExportCardDiagRecord): void {
    let records = this.traces.get(traceId)
    if (!records) {
      records = []
      this.traces.set(traceId, records)
    }

    records.push(record)
    if (records.length > MAX_RECORDS_PER_TRACE) {
      records.splice(0, records.length - MAX_RECORDS_PER_TRACE)
    }

    // Map 按插入序迭代，最早写入的 trace 即最旧
    while (this.traces.size > MAX_TRACES) {
      const oldest = this.traces.keys().next()
      if (oldest.done) break
      this.traces.delete(oldest.value)
    }
  }
}

export const exportCardDiagnosticsService = new ExportCardDiagnosticsService()
