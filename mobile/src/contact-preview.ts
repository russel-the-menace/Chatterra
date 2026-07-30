import {
  Character,
  ContactPreviewCache,
  ConversationHistoryCache,
} from './types'
import { starterMessageForCharacter } from './starter-message'

export type ContactPreviewState = Pick<
  ContactPreviewCache,
  'previews' | 'conversationIdsByCharacter' | 'lastMessageAtByCharacter'
>

const latestDisplayableMessage = (cache?: ConversationHistoryCache) => (
  cache?.messages.slice().reverse().find(message => (
    !message.loading && Boolean(message.text.trim())
  ))
)

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
    previews[character.id] = latestMessage?.text
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
