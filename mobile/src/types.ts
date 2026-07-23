export type Character = {
  id: string
  name: string
  avatar?: string
  role?: string
  company?: string
  personality?: string
  scenario?: string
  goal?: string
  language?: string
  background?: string
  systemPromptTemplate?: string
  createdAt?: string
  updatedAt?: string
}

export type Conversation = {
  id: string
  userId: string
  characterId: string
  title?: string
  status?: 'active' | 'archived'
  lastMessageAt?: string
  createdAt: string
  updatedAt: string
}

export type ServerMessage = {
  id: string
  conversationId: string
  senderRole: 'user' | 'assistant' | 'system'
  senderId?: string
  content: string
  contentJson?: Record<string, unknown>
  createdAt: string
}

export type ChatMessage = {
  id: string
  sender: 'user' | 'assistant'
  text: string
  loading?: boolean
  groupIndex?: number
  groupSize?: number
  animateEntry?: boolean
  animationDelayMs?: number
  createdAt?: string
}

export type PublicCharacterState = {
  instanceId: string
  currentActivity: string
  emotion: string
  relationshipStage: string
  asOf: string
}

export type ChatResponse = {
  reply: string | null
  replySegments?: string[]
  messageId?: string
  conversationId: string
  behavior?: {
    emotion?: string
    activity?: string
    decision?: string
    responseStatus?: string
  }
  traceId?: string
}

export type ProactiveDelivery = {
  characterId: string
  conversationId?: string
  messageId?: string
  content: string
  replySegments?: string[]
  createdAt?: string
}
