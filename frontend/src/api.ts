import { Character } from './data/character'

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

export const CONFIGURED_USER_ID = import.meta.env.VITE_USER_ID?.trim() || ''

export const apiUrl = (path: string) => `${API_BASE_URL}${path}`

export const getSyncSnapshot = async (userId: string): Promise<SyncSnapshot> => {
  const response = await fetch(apiUrl(`/api/sync?userId=${encodeURIComponent(userId)}`))
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Could not synchronize Chatterra.')
  return data as SyncSnapshot
}
