import AsyncStorage from '@react-native-async-storage/async-storage'

import { ComposerQuoteDraft } from './types'

const USER_ID_KEY = 'chatterra.mobile.userId'
const COMPOSER_QUOTE_DRAFTS_KEY = 'chatterra.mobile.composerQuoteDrafts'

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
