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

export type SyncConversation = Conversation & {
  latestMessage?: Pick<ServerMessage, 'id' | 'senderRole' | 'content' | 'createdAt'>
}

export type SyncSnapshot = {
  serverTime: string
  characters: Character[]
  conversations: SyncConversation[]
  pinnedCharacterIds: string[]
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

export type MessageHistoryCursor = {
  createdAt: string
  id: string
}

export type MessagePage = {
  messages: ServerMessage[]
  hasMore: boolean
  nextCursor?: MessageHistoryCursor
}

export type MessageQuote = {
  sourceMessageId?: string
  segmentIndex: number
  senderRole: 'user' | 'assistant'
  senderName: string
  text: string
}

export type ComposerQuoteDraft = MessageQuote & {
  sourceRenderKey: string
  pendingDeliveryMessageId?: string
  pendingDeliveryText?: string
  pendingDeliveryConversationId?: string
}

export type ChatMessage = {
  id: string
  renderKey?: string
  sourceMessageId?: string
  segmentIndex?: number
  sender: 'user' | 'assistant'
  text: string
  deliveryState?: 'sending' | 'failed'
  quote?: MessageQuote
  translation?: string
  translationVisible?: boolean
  translationLoading?: boolean
  translationError?: string
  loading?: boolean
  groupIndex?: number
  groupSize?: number
  animateEntry?: boolean
  animationDelayMs?: number
  createdAt?: string
}

export type ConversationHistoryCache = {
  conversationId: string | null
  messages: ChatMessage[]
  hasMoreHistory?: boolean
  oldestMessageCursor?: MessageHistoryCursor
  initialScrollOffset?: number
  cachedAt: number
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
  userMessageId?: string
  conversationId: string
  behavior?: {
    emotion?: string
    activity?: string
    decision?: string
    responseStatus?: string
  }
  traceId?: string
}

export type MessageTranslationResponse = {
  messageId?: string
  segmentIndex?: number
  targetLanguage: 'en'
  text: string
  cached: boolean
}

export type ProactiveDelivery = {
  characterId: string
  conversationId?: string
  messageId?: string
  content: string
  replySegments?: string[]
  createdAt?: string
}
