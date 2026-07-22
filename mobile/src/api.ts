import Constants from 'expo-constants'

import {
  Character,
  ChatResponse,
  Conversation,
  ProactiveDelivery,
  PublicCharacterState,
  ServerMessage,
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
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20_000)

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
      throw new ApiError(payload.error || `Request failed (${response.status})`, response.status)
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

  async listMessages(conversationId: string) {
    const result = await request<{ messages: ServerMessage[] }>(
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`
    )
    return result.messages
  },

  async getCharacterState(userId: string, characterId: string) {
    const result = await request<{ state: PublicCharacterState }>(
      `/api/characters/${encodeURIComponent(characterId)}/state?userId=${encodeURIComponent(userId)}`
    )
    return result.state
  },

  async sendMessage(input: {
    message: string
    conversationId?: string
    userId: string
    character: Character
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
