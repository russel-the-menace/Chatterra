import {
  Character,
  ChatMessage,
  ContactPreviewCache,
  ConversationHistoryCache,
  ServerMessage,
} from './types'
import { starterMessageForCharacter } from './starter-message'

export type ContactPreviewState = Pick<
  ContactPreviewCache,
  'previews' | 'conversationIdsByCharacter' | 'lastMessageAtByCharacter'
>

export type ContactPreviewUpdate = {
  characterId: string
  conversationId?: string
  preview?: string
  timestamp?: string
}

export const latestDisplayableMessage = (cache?: ConversationHistoryCache) => (
  cache?.messages.slice().reverse().find(message => (
    !message.loading && (Boolean(message.voice) || Boolean(message.text.trim()))
  ))
)

export const contactPreviewForMessage = (message?: ChatMessage) => {
  if (!message) return undefined
  if (message.voice) {
    const duration = Math.max(1, Math.round(message.voice.durationSeconds || 1))
    return `[Audio] ${duration}\"`
  }
  return message.text.trim() || undefined
}

export const contactPreviewForServerMessage = (
  message?: Pick<ServerMessage, 'content' | 'contentJson'>
) => {
  if (!message) return undefined
  const segments = message.contentJson?.deliverySegments
  if (Array.isArray(segments)) {
    const latestSegment = segments.findLast(segment => (
      typeof segment === 'string' && Boolean(segment.trim())
    ))
    if (typeof latestSegment === 'string') return latestSegment.trim()
  }
  return message.content.trim() || undefined
}

export const applyContactPreviewUpdates = (
  current: ContactPreviewCache | undefined,
  updates: ContactPreviewUpdate[]
): ContactPreviewCache => {
  const previews = { ...(current?.previews || {}) }
  const conversationIdsByCharacter = { ...(current?.conversationIdsByCharacter || {}) }
  const lastMessageAtByCharacter = { ...(current?.lastMessageAtByCharacter || {}) }

  updates.forEach(update => {
    if (!update.characterId) return
    const currentTimestamp = lastMessageAtByCharacter[update.characterId]
    const incomingIsCurrent = !currentTimestamp
      || !update.timestamp
      || update.timestamp >= currentTimestamp

    if (incomingIsCurrent && update.preview?.trim()) {
      previews[update.characterId] = update.preview
    }
    if (update.timestamp && (!currentTimestamp || update.timestamp > currentTimestamp)) {
      lastMessageAtByCharacter[update.characterId] = update.timestamp
    }
    if (update.conversationId) {
      conversationIdsByCharacter[update.characterId] = update.conversationId
    }
  })

  return {
    previews,
    conversationIdsByCharacter,
    lastMessageAtByCharacter,
    cachedAt: Date.now(),
  }
}

export const buildContactPreviewState = (
  characters: Character[],
  persisted?: ContactPreviewCache,
  conversationCaches: ReadonlyMap<string, ConversationHistoryCache> = new Map()
): ContactPreviewState => {
  const previews: Record<string, string> = {}
  const conversationIdsByCharacter: Record<string, string | null> = {}
  const lastMessageAtByCharacter: Record<string, string> = {}

  characters.forEach(character => {
    const conversationCache = conversationCaches.get(character.id)
    const latestMessage = latestDisplayableMessage(conversationCache)
    previews[character.id] = contactPreviewForMessage(latestMessage)
      || persisted?.previews[character.id]
      || starterMessageForCharacter(character)
    conversationIdsByCharacter[character.id] = conversationCache?.conversationId
      || persisted?.conversationIdsByCharacter[character.id]
      || null
    const lastMessageAt = latestMessage?.createdAt || persisted?.lastMessageAtByCharacter[character.id]
    if (lastMessageAt) lastMessageAtByCharacter[character.id] = lastMessageAt
  })

  return { previews, conversationIdsByCharacter, lastMessageAtByCharacter }
}
