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
  SyncSnapshot,
  VoiceTranscriptMetadata,
} from './types'

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

export const setApiAccessToken = (nextAccessToken?: string) => {
  accessToken = nextAccessToken?.trim() || undefined
}

const request = async <T>(path: string, init?: RequestInit, timeoutMs = 20_000): Promise<T> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new ApiError(
        payload.error || `Request failed (${response.status})`,
        response.status,
        payload
      )
    }
    return payload as T
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
    const result = await request<{ characters: Character[] }>(
      `/api/characters?userId=${encodeURIComponent(userId)}`
    )
    return result.characters
  },

  async getSyncSnapshot(userId: string) {
    return request<SyncSnapshot>(`/api/sync?userId=${encodeURIComponent(userId)}`)
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

  async updateUserProfile(userId: string, input: { displayName: string; avatar?: string }) {
    return request<{ userName?: string; userAvatar?: string }>(
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
    const result = await request<{ pinnedCharacterIds: string[] }>(
      `/api/users/${encodeURIComponent(userId)}/contact-preferences`
    )
    return result.pinnedCharacterIds
  },

  async setCharacterPinned(userId: string, characterId: string, pinned: boolean) {
    return request<{ characterId: string; pinned: boolean }>(
      `/api/users/${encodeURIComponent(userId)}/characters/${encodeURIComponent(characterId)}/pin`,
      { method: 'PUT', body: JSON.stringify({ pinned }) }
    )
  },

  async translateMessage(userId: string, messageId: string, segmentIndex = 0) {
    const result = await request<{ translation: MessageTranslationResponse }>(
      `/api/messages/${encodeURIComponent(messageId)}/translations`,
      {
        method: 'POST',
        body: JSON.stringify({ userId, targetLanguage: 'en', segmentIndex }),
      }
    )
    return result.translation
  },

  async translateText(text: string) {
    const result = await request<{ translation: MessageTranslationResponse }>('/api/translations', {
      method: 'POST',
      body: JSON.stringify({ text, targetLanguage: 'en' }),
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
