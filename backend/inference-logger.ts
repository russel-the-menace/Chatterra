import { v4 as uuidv4 } from 'uuid'

export type InferenceTraceStatus = 'started' | 'completed' | 'failed' | 'skipped'

export type InferenceTraceEvent = {
  stage: string
  status: InferenceTraceStatus
  at: string
  elapsedMs: number
  details?: Record<string, any>
}

export type InferenceDiagnostics = {
  traceId: string
  requestId: string
  startedAt: string
  completedAt?: string
  events: InferenceTraceEvent[]
  rejectedOutput?: {
    content: string
    originalLength: number
    truncated: boolean
    languageReason?: string
    rejectionReason?: string
  }
}

export type InferenceTrace = {
  traceId: string
  mark: (
    stage: string,
    status: InferenceTraceStatus,
    details?: Record<string, any>
  ) => void
  snapshot: () => InferenceDiagnostics
}

export const createInferenceTrace = (requestId: string): InferenceTrace => {
  const startedAt = new Date().toISOString()
  const startedAtMs = Date.now()
  const diagnostics: InferenceDiagnostics = {
    traceId: uuidv4(),
    requestId,
    startedAt,
    events: []
  }

  const mark = (
    stage: string,
    status: InferenceTraceStatus,
    details: Record<string, any> = {}
  ) => {
    const event: InferenceTraceEvent = {
      stage,
      status,
      at: new Date().toISOString(),
      elapsedMs: Math.max(0, Date.now() - startedAtMs),
      details
    }
    diagnostics.events.push(event)
    if (diagnostics.events.length > 50) diagnostics.events.shift()
    if (stage === 'request_completed' || stage === 'request_failed') {
      diagnostics.completedAt = event.at
    }

    const logEntry = {
      type: 'inference_trace',
      traceId: diagnostics.traceId,
      requestId,
      ...event
    }
    const serialized = JSON.stringify(logEntry)
    if (status === 'failed') {
      console.error(serialized)
    } else {
      console.info(serialized)
    }
  }

  return {
    traceId: diagnostics.traceId,
    mark,
    snapshot: () => ({
      ...diagnostics,
      events: diagnostics.events.map(event => ({
        ...event,
        details: event.details ? { ...event.details } : undefined
      }))
    })
  }
}
