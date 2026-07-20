export type UUID = string

export interface User {
  id: UUID
  displayName: string
  email?: string
  nativeLanguage?: string
  learningGoals?: Record<string, any>
  preferences?: Record<string, any>
  consentFlags?: Record<string, boolean>
  createdAt: string
  updatedAt: string
}

export interface Character {
  id: UUID
  name: string
  avatar?: string
  role?: string
  personality?: string
  company?: string
  scenario?: string
  goal?: string
  language?: string
  background?: string
  systemPromptTemplate?: string
  defaultSettings?: {
    maxResponseTokens?: number
    temperature?: number
    contextWindow?: number
  }
  createdAt: string
  updatedAt: string
}

export interface Conversation {
  id: UUID
  userId: UUID
  characterId: UUID
  title?: string
  status?: 'active' | 'archived'
  lastMessageAt?: string
  metadata?: Record<string, any>
  createdAt: string
  updatedAt: string
}

export interface Message {
  id: UUID
  conversationId: UUID
  senderRole: 'user' | 'assistant' | 'system'
  senderId?: UUID
  content: string
  contentJson?: Record<string, any>
  tokenCount?: number
  createdAt: string
}

export type MemoryType =
  | 'user_profile'
  | 'background'
  | 'preference'
  | 'past_event'
  | 'learning_weakness'
  | 'important_fact'
  | 'other'

export interface Memory {
  id: UUID
  userId: UUID
  characterId?: UUID
  originMessageId?: UUID
  type: MemoryType
  content: string
  importanceScore: number // 0..1
  confidence?: number
  createdAt: string
  lastAccessedAt?: string
  lastUpdatedAt?: string
  metadata?: Record<string, any>
}

export interface ConversationSummary {
  id: UUID
  conversationId: UUID
  summaryText: string
  lastGeneratedAt: string
  coverage?: { start?: string; end?: string; topics?: string[] }
}
