import { Character } from './data/character'

export type WebLoginSession = {
  accessToken: string
  expiresAt: string
  user: {
    id: string
    username: string
    displayName: string
    avatar?: string
    translationTargetLanguage?: string
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
  unreadCount?: number
}

export type SyncSnapshot = {
  serverTime: string
  userName?: string
  userAvatar?: string
  userTranslationTargetLanguage?: string
  characters: Character[]
  conversations: SyncConversation[]
  pinnedCharacterIds: string[]
}

export const markConversationRead = async (conversationId: string, messageId: string) => {
  const response = await apiFetch(apiUrl(`/api/conversations/${encodeURIComponent(conversationId)}/read`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId }),
  })
  if (!response.ok) throw new Error('Could not mark conversation as read.')
}

export const ensureConversation = async (characterId: string): Promise<SyncConversation> => {
  const response = await apiFetch(apiUrl('/api/conversations/ensure'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ characterId }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.conversation?.id) {
    throw new Error(typeof data.error === 'string' ? data.error : 'Could not start the conversation.')
  }
  return data.conversation as SyncConversation
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

export const apiFetch = async (url: string, init?: RequestInit) => {
  const session = getStoredSession()
  const headers = new Headers(init?.headers)
  if (session?.accessToken) headers.set('Authorization', `Bearer ${session.accessToken}`)
  const response = await fetch(url, { ...init, headers })
  if (response.status === 401) {
    clearStoredSession()
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('chatterra-auth-expired'))
    }
  }
  return response
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

export const updateUserProfile = async (
  userId: string,
  input: { displayName: string; avatar?: string; translationTargetLanguage?: string }
): Promise<{ userName?: string; userAvatar?: string; userTranslationTargetLanguage?: string }> => {
  const response = await apiFetch(apiUrl(`/api/users/${encodeURIComponent(userId)}/profile`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : 'Could not save your profile.')
  return data
}

export const getSyncSnapshot = async (_userId?: string): Promise<SyncSnapshot> => {
  const response = await apiFetch(apiUrl('/api/sync'))
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Could not synchronize Chatterra.')
  return data as SyncSnapshot
}

type VoiceUploadInput = {
  userId: string
  characterId?: string
  conversationId?: string
  audio: Blob
  durationMilliseconds: number
}

const voiceRequestId = () => `web-voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

const responsePayload = async (response: Response) => {
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    throw new Error(typeof payload.error === 'string' ? payload.error : `Voice request failed (${response.status})`)
  }
  return payload
}

export const transcribeVoiceRecording = async (input: VoiceUploadInput) => {
  const requestId = voiceRequestId()
  const response = await apiFetch(apiUrl('/api/voice/transcriptions'), {
    method: 'POST',
    headers: {
      'Content-Type': input.audio.type || 'audio/webm',
      'X-Chatterra-User-Id': input.userId,
      ...(input.characterId ? { 'X-Chatterra-Character-Id': input.characterId } : {}),
      'X-Chatterra-Voice-Request-Id': requestId,
    },
    body: input.audio,
  })
  const payload = await responsePayload(response)
  const transcription = payload.transcription as Record<string, unknown> | undefined
  if (typeof transcription?.text !== 'string' || !transcription.text.trim()) {
    throw new Error('The transcription service returned no text.')
  }
  return {
    text: transcription.text.trim(),
    provider: typeof transcription.provider === 'string' ? transcription.provider : undefined,
    model: typeof transcription.model === 'string' ? transcription.model : undefined,
  }
}

export const uploadVoiceMessage = async (input: Required<Pick<VoiceUploadInput, 'userId' | 'characterId' | 'audio' | 'durationMilliseconds'>> & Pick<VoiceUploadInput, 'conversationId'>) => {
  const requestId = voiceRequestId()
  const response = await apiFetch(apiUrl('/api/voice/messages'), {
    method: 'POST',
    headers: {
      'Content-Type': input.audio.type || 'audio/webm',
      'X-Chatterra-User-Id': input.userId,
      'X-Chatterra-Character-Id': input.characterId,
      ...(input.conversationId ? { 'X-Chatterra-Conversation-Id': input.conversationId } : {}),
      'X-Chatterra-Voice-Duration-Ms': String(Math.round(input.durationMilliseconds)),
      'X-Chatterra-Voice-Request-Id': requestId,
    },
    body: input.audio,
  })
  return responsePayload(response)
}
