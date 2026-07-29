import AsyncStorage from '@react-native-async-storage/async-storage'

import {
  ChatMessage,
  AssistantVoiceMessage,
  ComposerQuoteDraft,
  ConversationHistoryCache,
  MessageHistoryCursor,
  MessageQuote,
} from './types'

const USER_ID_KEY = 'chatterra.mobile.userId'
const COMPOSER_QUOTE_DRAFTS_KEY = 'chatterra.mobile.composerQuoteDrafts'
const CONVERSATION_CACHE_PREFIX = 'chatterra.mobile.conversationCache.v1'

const createUserId = () => (
  `mobile-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
)

export const getOrCreateUserId = async () => {
  const configuredUserId = process.env.EXPO_PUBLIC_USER_ID?.trim()
  if (configuredUserId) return configuredUserId

  const existing = await AsyncStorage.getItem(USER_ID_KEY)
  if (existing) return existing

  const created = createUserId()
  await AsyncStorage.setItem(USER_ID_KEY, created)
  return created
}

const parseComposerQuoteDraft = (value: unknown): ComposerQuoteDraft | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const quote = value as Record<string, unknown>
  if (quote.senderRole !== 'user' && quote.senderRole !== 'assistant') return undefined
  if (!Number.isInteger(quote.segmentIndex) || Number(quote.segmentIndex) < 0) return undefined
  if (typeof quote.senderName !== 'string' || !quote.senderName.trim()) return undefined
  if (typeof quote.text !== 'string' || !quote.text.trim()) return undefined
  if (typeof quote.sourceRenderKey !== 'string' || !quote.sourceRenderKey) return undefined
  if (quote.sourceMessageId != null && typeof quote.sourceMessageId !== 'string') return undefined
  if (
    quote.pendingDeliveryMessageId != null
    && typeof quote.pendingDeliveryMessageId !== 'string'
  ) return undefined
  if (quote.pendingDeliveryText != null && typeof quote.pendingDeliveryText !== 'string') {
    return undefined
  }
  if (
    quote.pendingDeliveryConversationId != null
    && typeof quote.pendingDeliveryConversationId !== 'string'
  ) return undefined

  return {
    sourceMessageId: quote.sourceMessageId || undefined,
    sourceRenderKey: quote.sourceRenderKey,
    pendingDeliveryMessageId: quote.pendingDeliveryMessageId || undefined,
    pendingDeliveryText: quote.pendingDeliveryText || undefined,
    pendingDeliveryConversationId: quote.pendingDeliveryConversationId || undefined,
    segmentIndex: Number(quote.segmentIndex),
    senderRole: quote.senderRole,
    senderName: quote.senderName,
    text: quote.text,
  }
}

const parseMessageQuote = (value: unknown): MessageQuote | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const quote = value as Record<string, unknown>
  if (quote.senderRole !== 'user' && quote.senderRole !== 'assistant') return undefined
  if (!Number.isInteger(quote.segmentIndex) || Number(quote.segmentIndex) < 0) return undefined
  if (typeof quote.senderName !== 'string' || !quote.senderName.trim()) return undefined
  if (typeof quote.text !== 'string' || !quote.text.trim()) return undefined
  if (quote.sourceMessageId != null && typeof quote.sourceMessageId !== 'string') return undefined

  return {
    sourceMessageId: quote.sourceMessageId || undefined,
    segmentIndex: Number(quote.segmentIndex),
    senderRole: quote.senderRole,
    senderName: quote.senderName,
    text: quote.text,
  }
}

const optionalString = (value: unknown) => (
  typeof value === 'string' ? value : undefined
)

const optionalBoolean = (value: unknown) => (
  typeof value === 'boolean' ? value : undefined
)

const optionalNonNegativeInteger = (value: unknown) => (
  Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined
)

const optionalNonNegativeNumber = (value: unknown) => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
)

const parseAssistantVoiceMessage = (value: unknown): AssistantVoiceMessage | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const voice = value as Record<string, unknown>
  if (voice.provider !== 'qwen3-tts' || voice.voiceId !== 'maya') return undefined
  if (voice.status !== 'pending' && voice.status !== 'ready' && voice.status !== 'failed') return undefined
  if (!Number.isInteger(voice.segmentIndex) || Number(voice.segmentIndex) < 0) return undefined
  if (typeof voice.style !== 'string' || !voice.style.trim()) return undefined
  if (voice.audioUrl != null && typeof voice.audioUrl !== 'string') return undefined
  if (voice.durationSeconds != null && !optionalNonNegativeNumber(voice.durationSeconds)) return undefined
  return {
    provider: 'qwen3-tts',
    status: voice.status,
    segmentIndex: Number(voice.segmentIndex),
    voiceId: 'maya',
    style: voice.style,
    audioUrl: optionalString(voice.audioUrl),
    durationSeconds: optionalNonNegativeNumber(voice.durationSeconds),
    mimeType: voice.mimeType === 'audio/wav' ? 'audio/wav' : undefined,
    generatedAt: optionalString(voice.generatedAt),
  }
}

const parseChatMessage = (value: unknown): ChatMessage | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const message = value as Record<string, unknown>
  if (typeof message.id !== 'string' || !message.id) return undefined
  if (message.sender !== 'user' && message.sender !== 'assistant') return undefined
  if (typeof message.text !== 'string') return undefined

  const quote = parseMessageQuote(message.quote)
  const voice = parseAssistantVoiceMessage(message.voice)
  return {
    id: message.id,
    renderKey: optionalString(message.renderKey),
    sourceMessageId: optionalString(message.sourceMessageId),
    segmentIndex: optionalNonNegativeInteger(message.segmentIndex),
    sender: message.sender,
    text: message.text,
    quote,
    translation: optionalString(message.translation),
    translationVisible: optionalBoolean(message.translationVisible),
    voice,
    voiceTranscriptVisible: optionalBoolean(message.voiceTranscriptVisible),
    groupIndex: optionalNonNegativeInteger(message.groupIndex),
    groupSize: optionalNonNegativeInteger(message.groupSize),
    createdAt: optionalString(message.createdAt),
  }
}

const parseMessageHistoryCursor = (value: unknown): MessageHistoryCursor | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const cursor = value as Record<string, unknown>
  if (typeof cursor.createdAt !== 'string' || typeof cursor.id !== 'string' || !cursor.id) {
    return undefined
  }
  return { createdAt: cursor.createdAt, id: cursor.id }
}

const parseConversationHistoryCache = (value: unknown): ConversationHistoryCache | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const cache = value as Record<string, unknown>
  if (cache.conversationId !== null && typeof cache.conversationId !== 'string') return undefined
  if (!Array.isArray(cache.messages)) return undefined
  if (!Number.isFinite(cache.cachedAt) || Number(cache.cachedAt) <= 0) return undefined

  return {
    conversationId: cache.conversationId,
    messages: cache.messages.flatMap(message => {
      const parsed = parseChatMessage(message)
      return parsed ? [parsed] : []
    }),
    hasMoreHistory: optionalBoolean(cache.hasMoreHistory),
    oldestMessageCursor: parseMessageHistoryCursor(cache.oldestMessageCursor),
    initialScrollOffset: optionalNonNegativeNumber(cache.initialScrollOffset),
    cachedAt: Number(cache.cachedAt),
  }
}

const conversationCacheKey = (apiBaseUrl: string, userId: string, characterId: string) => (
  `${CONVERSATION_CACHE_PREFIX}.${encodeURIComponent(apiBaseUrl)}.${encodeURIComponent(userId)}.${encodeURIComponent(characterId)}`
)

export const getStoredConversationCache = async (
  apiBaseUrl: string,
  userId: string,
  characterId: string
) => {
  const stored = await AsyncStorage.getItem(conversationCacheKey(apiBaseUrl, userId, characterId))
  if (!stored) return undefined

  try {
    return parseConversationHistoryCache(JSON.parse(stored) as unknown)
  } catch {
    return undefined
  }
}

export const saveStoredConversationCache = async (
  apiBaseUrl: string,
  userId: string,
  characterId: string,
  cache: ConversationHistoryCache
) => {
  await AsyncStorage.setItem(
    conversationCacheKey(apiBaseUrl, userId, characterId),
    JSON.stringify(cache)
  )
}

export const removeStoredConversationCache = async (
  apiBaseUrl: string,
  userId: string,
  characterId: string
) => {
  await AsyncStorage.removeItem(conversationCacheKey(apiBaseUrl, userId, characterId))
}

export const getStoredComposerQuoteDrafts = async () => {
  const stored = await AsyncStorage.getItem(COMPOSER_QUOTE_DRAFTS_KEY)
  if (!stored) return {} as Record<string, ComposerQuoteDraft>

  try {
    const parsed = JSON.parse(stored) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([characterId, value]) => {
        const quote = parseComposerQuoteDraft(value)
        return quote ? [[characterId, quote]] : []
      })
    ) as Record<string, ComposerQuoteDraft>
  } catch {
    return {}
  }
}

export const saveStoredComposerQuoteDrafts = async (
  drafts: Record<string, ComposerQuoteDraft>
) => {
  if (Object.keys(drafts).length === 0) {
    await AsyncStorage.removeItem(COMPOSER_QUOTE_DRAFTS_KEY)
    return
  }
  await AsyncStorage.setItem(COMPOSER_QUOTE_DRAFTS_KEY, JSON.stringify(drafts))
}
