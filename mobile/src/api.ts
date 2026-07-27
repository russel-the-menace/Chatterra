import Constants from 'expo-constants'

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
  SyncSnapshot,
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

const request = async <T>(path: string, init?: RequestInit, timeoutMs = 20_000): Promise<T> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
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

export const api = {
  async health() {
    return request<{ status: string; database: string }>('/api/health')
  },

  async listCharacters() {
    const result = await request<{ characters: Character[] }>('/api/characters')
    return result.characters
  },

  async getSyncSnapshot(userId: string) {
    return request<SyncSnapshot>(`/api/sync?userId=${encodeURIComponent(userId)}`)
  },

  async createCharacter(character: Omit<Character, 'id'>) {
    const result = await request<{ character: Character }>('/api/characters', {
      method: 'POST',
      body: JSON.stringify(character),
    })
    return result.character
  },

  async updateCharacter(character: Character) {
    const result = await request<{ character: Character }>(`/api/characters/${encodeURIComponent(character.id)}`, {
      method: 'PUT',
      body: JSON.stringify(character),
    })
    return result.character
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
  }) {
    return request<ChatResponse>('/api/chat', {
      method: 'POST',
      body: JSON.stringify(input),
    })
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
}
