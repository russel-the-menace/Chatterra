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
  ownerUserId?: string
  runtimeConfig?: {
    mode: 'companion' | 'practice'
    language: string
    explanationLanguage?: string
    correction: 'never' | 'on_request' | 'selective' | 'always'
    replyStyle: 'concise' | 'balanced' | 'expressive'
    delivery: 'single' | 'flexible' | 'bursty'
    initiative: 'off' | 'low' | 'normal' | 'high'
    timezone?: string
    starterMessage?: string
  }
  createdAt?: string
  updatedAt?: string
}

export type DetectedLanguage =
  | 'English'
  | 'Cantonese'
  | 'Chinese'
  | 'Japanese'
  | 'Korean'
  | 'Arabic'
  | 'Russian'
  | 'Mixed'
  | 'Unknown'

export type VoiceTranscriptMetadata = {
  originalText: string
  correctedText?: string
  detectedLanguage: DetectedLanguage
  confidence?: number
  audioAvailable?: boolean
}

export type AssistantVoiceMessage = {
  provider: 'qwen3-tts'
  status: 'pending' | 'ready' | 'failed'
  segmentIndex: number
  voiceId: 'maya'
  style: string
  audioUrl?: string
  durationSeconds?: number
  mimeType?: 'audio/wav'
  generatedAt?: string
}

export type UserVoiceMessage = {
  provider: 'user-recording'
  status: 'ready'
  audioUrl: string
  durationSeconds: number
  mimeType: 'audio/mp4' | 'audio/m4a' | 'audio/x-m4a' | 'audio/3gpp' | 'audio/webm'
  transcriptStatus: 'none' | 'ready'
}

export type MessageVoice = AssistantVoiceMessage | UserVoiceMessage

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
  latestMessage?: Pick<ServerMessage, 'id' | 'senderRole' | 'content' | 'contentJson' | 'createdAt'>
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
  streaks: ChatStreak[]
}

export type ChatStreak = {
  characterId: string
  days: number
  longestDays: number
  status: 'locked' | 'active' | 'pending' | 'rekindling' | 'expired'
  lastQualifiedDay?: string
  rekindleExpiresAt?: string
  rekindleProgress?: number
  daysLeft?: number
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
  voice?: MessageVoice
  voiceTranscriptionLoading?: boolean
  voiceTranscriptVisible?: boolean
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

export type ContactPreviewCache = {
  previews: Record<string, string>
  conversationIdsByCharacter: Record<string, string | null>
  lastMessageAtByCharacter: Record<string, string>
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
  voice?: AssistantVoiceMessage
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
  targetLanguage: string
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
