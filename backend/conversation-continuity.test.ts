import assert from 'node:assert/strict'
import { activeConversationEpisode } from './conversation-continuity'
import { Message } from './types'

const message = (id: string, createdAt: string): Message => ({
  id,
  conversationId: 'conversation',
  senderRole: id.startsWith('user') ? 'user' : 'assistant',
  content: id,
  createdAt,
})

const referenceTime = new Date('2026-08-03T20:00:00.000Z')
const acrossTwoDays = [
  message('assistant-old', '2026-08-01T12:00:00.000Z'),
  message('user-new', '2026-08-03T19:00:00.000Z'),
]
assert.deepEqual(
  activeConversationEpisode(acrossTwoDays, referenceTime).map(item => item.id),
  ['user-new']
)

const sameEvening = [
  message('assistant-early', '2026-08-03T14:00:00.000Z'),
  message('user-later', '2026-08-03T19:00:00.000Z'),
]
assert.deepEqual(
  activeConversationEpisode(sameEvening, referenceTime).map(item => item.id),
  ['assistant-early', 'user-later']
)

assert.deepEqual(
  activeConversationEpisode([message('assistant-old', '2026-08-01T12:00:00.000Z')], referenceTime),
  []
)

console.log('conversation continuity checks passed')
