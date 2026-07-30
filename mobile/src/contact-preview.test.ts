import {
  applyContactPreviewUpdates,
  buildContactPreviewState,
  contactPreviewForServerMessage,
} from './contact-preview'
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

const updated = applyContactPreviewUpdates({
  ...state,
  cachedAt: Date.now(),
}, [{
  characterId: sofia.id,
  conversationId: 'sofia-conversation',
  preview: 'gracias means thank you',
  timestamp: '2026-07-30T13:00:00.000Z',
}])
expect(updated.previews[sofia.id] === 'gracias means thank you',
  'a latest message should replace the contact preview')
expect(updated.lastMessageAtByCharacter[sofia.id] === '2026-07-30T13:00:00.000Z',
  'a latest message should update contact ordering time')
expect(updated.conversationIdsByCharacter[sofia.id] === 'sofia-conversation',
  'a latest message should persist the conversation identity')

const afterOlderUpdate = applyContactPreviewUpdates(updated, [{
  characterId: sofia.id,
  preview: 'older text',
  timestamp: '2026-07-30T12:00:00.000Z',
}])
expect(afterOlderUpdate.previews[sofia.id] === 'gracias means thank you',
  'an older server update must not overwrite a newer local preview')

const voiceCache: ConversationHistoryCache = {
  conversationId: 'voice-conversation',
  messages: [{
    id: 'voice-last',
    sender: 'user',
    text: 'the transcript should not be shown in the contact list',
    voice: {
      provider: 'user-recording',
      status: 'ready',
      audioUrl: '/voice.m4a',
      durationSeconds: 18.2,
      mimeType: 'audio/m4a',
      transcriptStatus: 'ready',
    },
  }],
  cachedAt: Date.now(),
}
const voiceState = buildContactPreviewState([maya], undefined, new Map([[maya.id, voiceCache]]))
expect(voiceState.previews[maya.id] === '[Audio] 18\"',
  'a latest voice message should display its rounded audio duration')

expect(contactPreviewForServerMessage({
  content: 'hey, i am just lying here.\nmy brain is finally quiet for once 🥺💕\nwhat are you up to?',
  contentJson: {
    deliverySegments: [
      'hey, i am just lying here.',
      'my brain is finally quiet for once 🥺💕\nwhat are you up to?',
    ],
  },
}) === 'my brain is finally quiet for once 🥺💕\nwhat are you up to?',
'a sync snapshot should use the final delivery segment as its contact preview')
console.log('contact preview checks passed')
