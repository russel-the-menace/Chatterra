import { Character } from './data/character'

export type WebLoginSession = {
  accessToken: string
  expiresAt: string
  user: {
    id: string
    username: string
    displayName: string
  }
}

export type SyncConversation = {
  id: string
  userId: string
  characterId: string
  status?: 'active' | 'archived'
  lastMessageAt?: string
  createdAt: string
  updatedAt: string
  latestMessage?: {
    id: string
    senderRole: 'user' | 'assistant' | 'system'
    content: string
    createdAt: string
  }
}

export type SyncSnapshot = {
  serverTime: string
  characters: Character[]
  conversations: SyncConversation[]
  pinnedCharacterIds: string[]
}

const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, '')

export const API_BASE_URL = normalizeBaseUrl(
  import.meta.env.VITE_API_URL || 'http://localhost:3000'
)

export const apiUrl = (path: string) => `${API_BASE_URL}${path}`

const SESSION_STORAGE_KEY = 'chatterra.web.authSession.v1'

const validSession = (value: unknown): value is WebLoginSession => {
  if (!value || typeof value !== 'object') return false
  const session = value as Partial<WebLoginSession>
  return typeof session.accessToken === 'string'
    && Boolean(session.accessToken)
    && typeof session.expiresAt === 'string'
    && !Number.isNaN(Date.parse(session.expiresAt))
    && Boolean(session.user)
    && typeof session.user?.id === 'string'
    && typeof session.user?.username === 'string'
    && typeof session.user?.displayName === 'string'
}

export const getStoredSession = (): WebLoginSession | undefined => {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || 'null')
    return validSession(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export const saveStoredSession = (session: WebLoginSession) => {
  localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session))
  localStorage.removeItem('chatterra_userId')
}

export const clearStoredSession = () => {
  localStorage.removeItem(SESSION_STORAGE_KEY)
}

export const apiFetch = (url: string, init?: RequestInit) => {
  const session = getStoredSession()
  const headers = new Headers(init?.headers)
  if (session?.accessToken) headers.set('Authorization', `Bearer ${session.accessToken}`)
  return fetch(url, { ...init, headers })
}

export const login = async (username: string, password: string): Promise<WebLoginSession> => {
  const response = await fetch(apiUrl('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Could not sign in.')
  if (!validSession(data)) throw new Error('The server returned an invalid login session.')
  saveStoredSession(data)
  return data
}

export const logout = async () => {
  try {
    await apiFetch(apiUrl('/api/auth/logout'), { method: 'POST' })
  } finally {
    clearStoredSession()
  }
}

export const getSyncSnapshot = async (_userId?: string): Promise<SyncSnapshot> => {
  const response = await apiFetch(apiUrl('/api/sync'))
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Could not synchronize Chatterra.')
  return data as SyncSnapshot
}
