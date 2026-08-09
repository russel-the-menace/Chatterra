import Constants from 'expo-constants'
import * as FileSystem from 'expo-file-system/legacy'

import {
  Character,
  ChatResponse,
  Conversation,
  MessageQuote,
  MessageHistoryCursor,
  MessagePage,
  ProactiveDelivery,
  PublicCharacterState,
  MessageTranslationResponse,
  ServerMessage,
  SyncConversation,
  SyncSnapshot,
  VoiceTranscriptMetadata,
} from './types'
import { clearStoredAuthSession } from './storage'

const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, '')

const metroHost = () => {
  const hostUri = Constants.expoConfig?.hostUri || Constants.expoGoConfig?.debuggerHost
  if (!hostUri) return undefined
  const withoutProtocol = hostUri.replace(/^https?:\/\//, '')
  const bracketedIpv6 = withoutProtocol.match(/^\[([^\]]+)]/)
  return bracketedIpv6?.[1] || withoutProtocol.split(':')[0]
}

const configuredUrl = process.env.EXPO_PUBLIC_API_URL
export const API_BASE_URL = normalizeBaseUrl(
  configuredUrl || (metroHost() ? `http://${metroHost()}:3000` : 'http://localhost:3000')
)

export const mediaUrl = (value: string) => (
  /^https?:\/\//i.test(value) ? value : `${API_BASE_URL}${value.startsWith('/') ? value : `/${value}`}`
)

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly payload?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

const requiredArray = <T>(value: unknown, endpoint: string, field: string): T[] => {
  if (Array.isArray(value)) return value as T[]

  const responseKeys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).slice(0, 12)
    : []
  console.warn('[api] invalid_response_shape', {
    endpoint,
    field,
    receivedType: value === null ? 'null' : typeof value,
    responseKeys,
  })
  throw new ApiError(`The server returned an invalid ${field} list. Please retry.`, undefined, {
    endpoint,
    field,
  })
}

export type VoiceCapability = {
  mode: 'cloud' | 'local'
  checkedAt: string
  checks: {
    mihomo: 'ready' | 'failed' | 'not_configured'
    node: 'ready' | 'failed' | 'not_configured'
    groq: 'ready' | 'failed' | 'not_configured'
  }
}

export type LoginSession = {
  accessToken: string
  expiresAt: string
  user: {
    id: string
    username: string
    displayName: string
  }
}

let accessToken: string | undefined
let unauthorizedHandler: (() => void) | undefined

export const setApiAccessToken = (nextAccessToken?: string) => {
  accessToken = nextAccessToken?.trim() || undefined
}

export const setApiUnauthorizedHandler = (handler?: () => void) => {
  unauthorizedHandler = handler
}

const handleUnauthorized = async () => {
  setApiAccessToken()
  await clearStoredAuthSession().catch(() => undefined)
  unauthorizedHandler?.()
}

const clientRequestId = () => (
  `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
)

const request = async <T>(path: string, init?: RequestInit, timeoutMs = 20_000): Promise<T> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const method = (init?.method || 'GET').toUpperCase()
  const canRetryUnreadableResponse = method === 'GET'
  const requestId = clientRequestId()

  try {
    for (let attempt = 0; attempt <= Number(canRetryUnreadableResponse); attempt += 1) {
      const separator = path.includes('?') ? '&' : '?'
      const requestPath = canRetryUnreadableResponse
        ? `${path}${separator}_chatterra_request=${encodeURIComponent(`${requestId}-${attempt}`)}`
        : path
      const response = await fetch(`${API_BASE_URL}${requestPath}`, {
        ...init,
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-store',
          Pragma: 'no-cache',
          'X-Chatterra-Request-Id': requestId,
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
        signal: controller.signal,
      })
      if (response.status === 401) await handleUnauthorized()
      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        console.warn('[api] unreadable_json_response', {
          attempt,
          contentType: response.headers.get('content-type') || undefined,
          endpoint: path.split('?')[0],
          requestId,
          serverRevision: response.headers.get('x-chatterra-api-revision') || undefined,
          status: response.status,
        })
        if (canRetryUnreadableResponse && attempt === 0) continue
        throw new ApiError('The server sent an unreadable response. Please retry.', response.status)
      }
      if (!response.ok) {
        const error = payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>).error
          : undefined
        throw new ApiError(
          typeof error === 'string' ? error : `Request failed (${response.status})`,
          response.status,
          payload && typeof payload === 'object' && !Array.isArray(payload)
            ? payload as Record<string, unknown>
            : undefined
        )
      }
      return payload as T
    }
    throw new ApiError('The server did not return a response.')
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError('The server took too long to respond.')
    }
    throw new ApiError('Could not reach the Chatterra server.')
  } finally {
    clearTimeout(timeout)
  }
}

const uploadVoiceFile = async <T>(input: {
  path: string
  fileUri: string
  headers: Record<string, string>
}) => {
  const response = await FileSystem.uploadAsync(`${API_BASE_URL}${input.path}`, input.fileUri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: {
      Accept: 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...input.headers,
    },
  })
  if (response.status === 401) await handleUnauthorized()
  const payload = JSON.parse(response.body || '{}') as Record<string, unknown>
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(
      typeof payload.error === 'string' ? payload.error : `Request failed (${response.status})`,
      response.status,
      payload
    )
  }
  return payload as T
}

export const api = {
  async login(username: string, password: string) {
    return request<LoginSession>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  },

  async logout() {
    await request<void>('/api/auth/logout', { method: 'POST' })
  },

  async health() {
    return request<{ status: string; database: string }>('/api/health')
  },

  async getVoiceCapability() {
    const result = await request<{ capability: VoiceCapability }>('/api/voice/capability', undefined, 30_000)
    return result.capability
  },

  async listCharacters(userId: string) {
    const result = await request<{ characters?: unknown }>(
      `/api/characters?userId=${encodeURIComponent(userId)}`
    )
    return requiredArray<Character>(result.characters, '/api/characters', 'characters')
  },

  async getSyncSnapshot(userId: string) {
    const snapshot = await request<SyncSnapshot>(`/api/sync?userId=${encodeURIComponent(userId)}`)
    return {
      ...snapshot,
      characters: requiredArray<Character>(snapshot.characters, '/api/sync', 'characters'),
      conversations: requiredArray<SyncConversation>(snapshot.conversations, '/api/sync', 'conversations'),
      pinnedCharacterIds: requiredArray<string>(snapshot.pinnedCharacterIds, '/api/sync', 'pinnedCharacterIds'),
    }
  },

  async createCharacter(userId: string, character: Omit<Character, 'id'>) {
    const result = await request<{ character: Character }>('/api/characters', {
      method: 'POST',
      body: JSON.stringify({ ...character, userId }),
    })
    return result.character
  },

  async updateCharacter(userId: string, character: Character) {
    const result = await request<{ character: Character }>(`/api/characters/${encodeURIComponent(character.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ ...character, userId }),
    })
    return result.character
  },

  async updateBuiltInCharacterAvatar(userId: string, characterId: string, avatar: string) {
    const result = await request<{ character: Character }>(
      `/api/users/${encodeURIComponent(userId)}/characters/${encodeURIComponent(characterId)}/avatar`,
      { method: 'PUT', body: JSON.stringify({ avatar }) }
    )
    return result.character
  },

  async updateUserAvatar(userId: string, avatar: string) {
    return request<{ userAvatar?: string }>(
      `/api/users/${encodeURIComponent(userId)}/avatar`,
      { method: 'PUT', body: JSON.stringify({ avatar }) }
    )
  },

  async updateUserProfile(userId: string, input: { displayName: string; avatar?: string; translationTargetLanguage?: string }) {
    return request<{ userName?: string; userAvatar?: string; userTranslationTargetLanguage?: string }>(
      `/api/users/${encodeURIComponent(userId)}/profile`,
      { method: 'PUT', body: JSON.stringify(input) }
    )
  },

  async listConversations(userId: string) {
    const result = await request<{ conversations: Conversation[] }>(
      `/api/conversations?userId=${encodeURIComponent(userId)}`
    )
    return result.conversations
  },

  async ensureConversation(userId: string, characterId: string) {
    const result = await request<{ conversation: Conversation }>(
      '/api/conversations/ensure',
      { method: 'POST', body: JSON.stringify({ userId, characterId }) }
    )
    return result.conversation
  },

  async listMessagePage(
    conversationId: string,
    options: { limit?: number; before?: MessageHistoryCursor } = {}
  ) {
    const parameters = new URLSearchParams({ limit: String(options.limit ?? 50) })
    if (options.before) {
      parameters.set('beforeCreatedAt', options.before.createdAt)
      parameters.set('beforeId', options.before.id)
    }
    return request<MessagePage>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages?${parameters.toString()}`
    )
  },

  async markConversationRead(conversationId: string, messageId: string) {
    await request<void>(`/api/conversations/${encodeURIComponent(conversationId)}/read`, {
      method: 'POST',
      body: JSON.stringify({ messageId }),
    })
  },

  async getMessageDeliveryStatus(userId: string, messageId: string) {
    return request<{
      persisted: boolean
      userMessageId?: string
      conversationId?: string
    }>(
      `/api/messages/${encodeURIComponent(messageId)}/delivery-status?userId=${encodeURIComponent(userId)}`,
      undefined,
      3_000
    )
  },

  async listPinnedCharacterIds(userId: string) {
    const result = await request<{ pinnedCharacterIds?: unknown }>(
      `/api/users/${encodeURIComponent(userId)}/contact-preferences`
    )
    return requiredArray<string>(
      result.pinnedCharacterIds,
      '/api/users/:id/contact-preferences',
      'pinnedCharacterIds'
    )
  },

  async setCharacterPinned(userId: string, characterId: string, pinned: boolean) {
    return request<{ characterId: string; pinned: boolean }>(
      `/api/users/${encodeURIComponent(userId)}/characters/${encodeURIComponent(characterId)}/pin`,
      { method: 'PUT', body: JSON.stringify({ pinned }) }
    )
  },

  async translateMessage(userId: string, messageId: string, segmentIndex = 0, targetLanguage = 'English') {
    const result = await request<{ translation: MessageTranslationResponse }>(
      `/api/messages/${encodeURIComponent(messageId)}/translations`,
      {
        method: 'POST',
        body: JSON.stringify({ userId, targetLanguage, segmentIndex }),
      }
    )
    return result.translation
  },

  async translateText(text: string, targetLanguage = 'English') {
    const result = await request<{ translation: MessageTranslationResponse }>('/api/translations', {
      method: 'POST',
      body: JSON.stringify({ text, targetLanguage }),
    })
    return result.translation
  },

  async transcribeVoice(input: {
    userId: string
    characterId?: string
    fileUri: string
    mimeType: string
    byteLength: number
    requestId?: string
  }) {
    console.info('[voice] transcription_upload_started', {
      requestId: input.requestId,
      mimeType: input.mimeType,
      byteLength: input.byteLength,
    })
    try {
      const result = await uploadVoiceFile<{
        transcription: { text: string; provider: 'groq'; model: string }
      }>({
        path: '/api/voice/transcriptions',
        fileUri: input.fileUri,
        headers: {
          'Content-Type': input.mimeType,
          'X-Chatterra-User-Id': input.userId,
          ...(input.characterId ? { 'X-Chatterra-Character-Id': input.characterId } : {}),
          ...(input.requestId ? { 'X-Chatterra-Voice-Request-Id': input.requestId } : {}),
        },
      })
      console.info('[voice] transcription_upload_succeeded', {
        requestId: input.requestId,
        transcriptLength: result.transcription.text.length,
      })
      return result.transcription
    } catch (error) {
      console.warn('[voice] transcription_upload_failed', {
        requestId: input.requestId,
        mimeType: input.mimeType,
        byteLength: input.byteLength,
        error: error instanceof Error ? error.message : 'unknown_error',
      })
      throw error
    }
  },

  async sendVoiceMessage(input: {
    userId: string
    characterId: string
    conversationId?: string
    fileUri: string
    durationMilliseconds: number
    mimeType: string
    byteLength: number
    requestId?: string
  }) {
    console.info('[voice] voice_message_upload_started', {
      requestId: input.requestId,
      mimeType: input.mimeType,
      byteLength: input.byteLength,
      durationMilliseconds: Math.round(input.durationMilliseconds),
    })
    try {
      const result = await uploadVoiceFile<{
        conversation: Conversation
        message: ServerMessage
        starterMessage?: ServerMessage
        reply?: ChatResponse['reply']
        replySegments?: string[]
        messageId?: string
        voice?: ChatResponse['voice']
        behavior?: ChatResponse['behavior']
      }>({
        path: '/api/voice/messages',
        fileUri: input.fileUri,
        headers: {
          'Content-Type': input.mimeType,
          'X-Chatterra-User-Id': input.userId,
          'X-Chatterra-Character-Id': input.characterId,
          ...(input.conversationId ? { 'X-Chatterra-Conversation-Id': input.conversationId } : {}),
          'X-Chatterra-Voice-Duration-Ms': String(Math.round(input.durationMilliseconds)),
          ...(input.requestId ? { 'X-Chatterra-Voice-Request-Id': input.requestId } : {}),
        },
      })
      console.info('[voice] voice_message_upload_succeeded', { requestId: input.requestId })
      return result
    } catch (error) {
      console.warn('[voice] voice_message_upload_failed', {
        requestId: input.requestId,
        mimeType: input.mimeType,
        byteLength: input.byteLength,
        error: error instanceof Error ? error.message : 'unknown_error',
      })
      throw error
    }
  },

  async convertVoiceMessageToText(userId: string, messageId: string) {
    return request<{ message: ServerMessage }>(
      `/api/voice/messages/${encodeURIComponent(messageId)}/transcription`,
      { method: 'POST', body: JSON.stringify({ userId }) },
      60_000
    )
  },

  async discardVoiceMessageText(userId: string, messageId: string) {
    return request<{ message: ServerMessage }>(
      `/api/voice/messages/${encodeURIComponent(messageId)}/transcription`,
      { method: 'DELETE', body: JSON.stringify({ userId }) }
    )
  },

  async forwardMessage(input: {
    targetCharacterId: string
    message: string
    note?: string
  }) {
    return request<{
      conversationId: string
      characterId: string
      starterMessage?: ServerMessage
      messages: ServerMessage[]
      assistantMessage?: ServerMessage
      reply?: string | null
      replySegments?: string[]
    }>('/api/messages/forward', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  },

  async getCharacterState(userId: string, characterId: string) {
    const result = await request<{ state: PublicCharacterState }>(
      `/api/characters/${encodeURIComponent(characterId)}/state?userId=${encodeURIComponent(userId)}`
    )
    return result.state
  },

  async sendMessage(input: {
    message: string
    clientMessageId: string
    conversationId?: string
    userId: string
    character: Character
    quote?: MessageQuote
    voice?: VoiceTranscriptMetadata
  }) {
    return request<ChatResponse>('/api/chat', {
      method: 'POST',
      body: JSON.stringify(input),
    }, 60_000)
  },

  async clearHistory(userId: string, characterId: string) {
    return request<{ ok: boolean }>('/api/chat-history', {
      method: 'DELETE',
      body: JSON.stringify({ userId, characterId }),
    })
  },

  async pollProactive(userId: string) {
    const result = await request<{ deliveries: ProactiveDelivery[] }>('/api/proactive/poll', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    })
    return result.deliveries
  },

  async registerExpoPushDevice(input: {
    userId: string
    expoPushToken: string
    platform: 'ios' | 'android'
  }) {
    await request<void>('/api/push-devices/expo', {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  },
}
