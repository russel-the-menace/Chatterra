import AsyncStorage from '@react-native-async-storage/async-storage'

import {
  ChatMessage,
  AssistantVoiceMessage,
  MessageVoice,
  ComposerQuoteDraft,
  ContactPreviewCache,
  ConversationHistoryCache,
  MessageHistoryCursor,
  MessageQuote,
} from './types'

const LEGACY_USER_ID_KEY = 'chatterra.mobile.userId'
const AUTH_SESSION_KEY = 'chatterra.mobile.authSession.v1'
const COMPOSER_QUOTE_DRAFTS_PREFIX = 'chatterra.mobile.composerQuoteDrafts.v2'
const CONVERSATION_CACHE_PREFIX = 'chatterra.mobile.conversationCache.v1'
const CONTACT_PREVIEW_CACHE_PREFIX = 'chatterra.mobile.contactPreviewCache.v1'

export type StoredAuthSession = {
  accessToken: string
  expiresAt: string
  user: {
    id: string
    username: string
    displayName: string
    avatar?: string
  }
}

const parseStoredAuthSession = (value: unknown): StoredAuthSession | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const session = value as Record<string, unknown>
  if (typeof session.accessToken !== 'string' || !session.accessToken) return undefined
  if (typeof session.expiresAt !== 'string' || Number.isNaN(Date.parse(session.expiresAt))) return undefined
  if (!session.user || typeof session.user !== 'object' || Array.isArray(session.user)) return undefined
  const user = session.user as Record<string, unknown>
  if (
    typeof user.id !== 'string'
    || typeof user.username !== 'string'
    || typeof user.displayName !== 'string'
  ) return undefined
  return {
    accessToken: session.accessToken,
    expiresAt: session.expiresAt,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatar: typeof user.avatar === 'string' && user.avatar ? user.avatar : undefined,
    }
  }
}

export const getStoredAuthSession = async () => {
  const stored = await AsyncStorage.getItem(AUTH_SESSION_KEY)
  if (!stored) return undefined
  try {
    return parseStoredAuthSession(JSON.parse(stored) as unknown)
  } catch {
    return undefined
  }
}

export const saveStoredAuthSession = async (session: StoredAuthSession) => {
  await AsyncStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session))
  await AsyncStorage.removeItem(LEGACY_USER_ID_KEY)
}

export const clearStoredAuthSession = async () => {
  await AsyncStorage.removeItem(AUTH_SESSION_KEY)
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

const parseUserVoiceMessage = (value: unknown): Extract<MessageVoice, { provider: 'user-recording' }> | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const voice = value as Record<string, unknown>
  if (voice.provider !== 'user-recording' || voice.status !== 'ready') return undefined
  if (typeof voice.audioUrl !== 'string' || !voice.audioUrl) return undefined
  if (!optionalNonNegativeNumber(voice.durationSeconds)) return undefined
  if (
    voice.mimeType !== 'audio/mp4'
    && voice.mimeType !== 'audio/m4a'
    && voice.mimeType !== 'audio/x-m4a'
    && voice.mimeType !== 'audio/3gpp'
    && voice.mimeType !== 'audio/webm'
  ) return undefined
  if (voice.transcriptStatus !== 'none' && voice.transcriptStatus !== 'ready') return undefined
  return {
    provider: 'user-recording',
    status: 'ready',
    audioUrl: voice.audioUrl,
    durationSeconds: Number(voice.durationSeconds),
    mimeType: voice.mimeType as Extract<MessageVoice, { provider: 'user-recording' }>['mimeType'],
    transcriptStatus: voice.transcriptStatus,
  }
}

const parseChatMessage = (value: unknown): ChatMessage | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const message = value as Record<string, unknown>
  if (typeof message.id !== 'string' || !message.id) return undefined
  if (message.sender !== 'user' && message.sender !== 'assistant') return undefined
  if (typeof message.text !== 'string') return undefined

  const quote = parseMessageQuote(message.quote)
  const voice = parseAssistantVoiceMessage(message.voice) || parseUserVoiceMessage(message.voice)
  return {
    id: message.id,
    renderKey: optionalString(message.renderKey),
    sourceMessageId: optionalString(message.sourceMessageId),
    segmentIndex: optionalNonNegativeInteger(message.segmentIndex),
    sender: message.sender,
    text: message.text,
    quote,
    translation: optionalString(message.translation),
    voice,
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

const contactPreviewCacheKey = (apiBaseUrl: string, userId: string) => (
  `${CONTACT_PREVIEW_CACHE_PREFIX}.${encodeURIComponent(apiBaseUrl)}.${encodeURIComponent(userId)}`
)

const stringRecord = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (
      typeof item === 'string' ? [[key, item]] : []
    ))
  ) as Record<string, string>
}

const nullableStringRecord = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => (
      typeof item === 'string' || item === null ? [[key, item]] : []
    ))
  ) as Record<string, string | null>
}

const parseContactPreviewCache = (value: unknown): ContactPreviewCache | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const cache = value as Record<string, unknown>
  const previews = stringRecord(cache.previews)
  const conversationIdsByCharacter = nullableStringRecord(cache.conversationIdsByCharacter)
  const lastMessageAtByCharacter = stringRecord(cache.lastMessageAtByCharacter)
  if (
    !previews
    || !conversationIdsByCharacter
    || !lastMessageAtByCharacter
    || !Number.isFinite(cache.cachedAt)
    || Number(cache.cachedAt) <= 0
  ) return undefined
  return {
    previews,
    conversationIdsByCharacter,
    lastMessageAtByCharacter,
    cachedAt: Number(cache.cachedAt),
  }
}

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

export const getStoredContactPreviewCache = async (apiBaseUrl: string, userId: string) => {
  const stored = await AsyncStorage.getItem(contactPreviewCacheKey(apiBaseUrl, userId))
  if (!stored) return undefined
  try {
    return parseContactPreviewCache(JSON.parse(stored) as unknown)
  } catch {
    return undefined
  }
}

export const saveStoredContactPreviewCache = async (
  apiBaseUrl: string,
  userId: string,
  cache: ContactPreviewCache
) => {
  await AsyncStorage.setItem(
    contactPreviewCacheKey(apiBaseUrl, userId),
    JSON.stringify(cache)
  )
}

const composerQuoteDraftsKey = (userId: string) => (
  `${COMPOSER_QUOTE_DRAFTS_PREFIX}.${encodeURIComponent(userId)}`
)

export const getStoredComposerQuoteDrafts = async (userId: string) => {
  const stored = await AsyncStorage.getItem(composerQuoteDraftsKey(userId))
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
  userId: string,
  drafts: Record<string, ComposerQuoteDraft>
) => {
  if (Object.keys(drafts).length === 0) {
    await AsyncStorage.removeItem(composerQuoteDraftsKey(userId))
    return
  }
  await AsyncStorage.setItem(composerQuoteDraftsKey(userId), JSON.stringify(drafts))
}
