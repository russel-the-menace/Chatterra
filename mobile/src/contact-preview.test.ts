import { buildContactPreviewState } from './contact-preview'
import { Character, ConversationHistoryCache } from './types'

const expect = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message)
}

const maya: Character = { id: 'c3', name: 'Maya', language: 'English' }
const sofia: Character = { id: 'seed-sofia-argentina-spanish', name: 'Sofía Álvarez', language: 'Spanish' }
const cachedMaya: ConversationHistoryCache = {
  conversationId: 'maya-conversation',
  messages: [{ id: 'maya-last', sender: 'assistant', text: 'see you after class', createdAt: '2026-07-30T12:00:00.000Z' }],
  cachedAt: Date.now(),
}

const state = buildContactPreviewState(
  [maya, sofia],
  undefined,
  new Map([[maya.id, cachedMaya]])
)

expect(state.previews[maya.id] === 'see you after class', 'latest cached message should be the preview')
expect(state.conversationIdsByCharacter[maya.id] === 'maya-conversation', 'cached conversation ID should be restored')
expect(state.lastMessageAtByCharacter[maya.id] === '2026-07-30T12:00:00.000Z', 'cached timestamp should be restored')
expect(
  state.previews[sofia.id].startsWith("Hi, I'm Sofía."),
  'a character without a conversation should show its greeting instead of personality'
)
console.log('contact preview checks passed')
