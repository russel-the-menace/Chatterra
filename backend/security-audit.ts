import { createHash } from 'node:crypto'
import { query } from './database'
import { v4 as uuidv4 } from 'uuid'

export type SecurityEventSeverity = 'info' | 'warning' | 'critical'

export type SecurityEventInput = {
  eventType: string
  severity?: SecurityEventSeverity
  ipAddress?: string
  userId?: string
  username?: string
  requestId?: string
  method?: string
  path?: string
  userAgent?: string
  metadata?: Record<string, unknown>
}

const recentEvents = new Map<string, number[]>()
const EVENT_WINDOW_MS = 60 * 60 * 1000
const EVENT_LIMIT_PER_KEY = 20

const bounded = (value: string | undefined, limit: number) => value?.slice(0, limit)
const usernameFingerprint = (username: string | undefined) => username
  ? createHash('sha256').update(username.trim().toLowerCase()).digest('hex')
  : undefined

const canRecord = (event: SecurityEventInput) => {
  const now = Date.now()
  const key = `${event.eventType}:${event.ipAddress || 'unknown'}`
  const active = (recentEvents.get(key) || []).filter(timestamp => now - timestamp < EVENT_WINDOW_MS)
  if (active.length >= EVENT_LIMIT_PER_KEY) return false
  active.push(now)
  recentEvents.set(key, active)
  return true
}

export const looksLikeInjectionInput = (value: string) => (
  /(?:union\s+(?:all\s+)?select|(?:or|and)\s+['"\d]+\s*=\s*['"\d]+|--|\/\*|\*\/|;\s*(?:drop|alter|select|insert|update|delete)\b)/i.test(value)
  || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
)

export const looksLikeSuspiciousPath = (value: string) => {
  let decoded = value
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return true
  }
  return looksLikeInjectionInput(value)
    || looksLikeInjectionInput(decoded)
    || /(?:\.\.\/|\.\.\\|%00|%2e%2e|%252e%252e)/i.test(value)
}

export const recordSecurityEvent = async (event: SecurityEventInput) => {
  if (!canRecord(event)) return
  const safeEvent = {
    eventType: bounded(event.eventType.replace(/[^a-zA-Z0-9_.:-]/g, '_'), 80) || 'unknown',
    severity: event.severity || 'warning',
    ipAddress: bounded(event.ipAddress, 96),
    userId: bounded(event.userId, 160),
    usernameFingerprint: usernameFingerprint(event.username),
    requestId: bounded(event.requestId, 160),
    method: bounded(event.method, 16),
    path: bounded(event.path, 500),
    userAgent: bounded(event.userAgent, 500),
    metadata: event.metadata || {},
  }

  try {
    await query(
      `INSERT INTO security_events (
         id, event_type, severity, ip_address, user_id, username_fingerprint,
         request_id, method, path, user_agent, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
      [
        uuidv4(),
        safeEvent.eventType,
        safeEvent.severity,
        safeEvent.ipAddress || null,
        safeEvent.userId || null,
        safeEvent.usernameFingerprint || null,
        safeEvent.requestId || null,
        safeEvent.method || null,
        safeEvent.path || null,
        safeEvent.userAgent || null,
        JSON.stringify(safeEvent.metadata),
      ]
    )
    await query(`DELETE FROM security_events WHERE created_at < NOW() - INTERVAL '90 days'`)
    console.warn(JSON.stringify({ type: 'security_event', ...safeEvent }))
  } catch (error) {
    console.error('Could not persist security event', {
      eventType: safeEvent.eventType,
      error: error instanceof Error ? error.name : 'unknown_error',
    })
  }
}
