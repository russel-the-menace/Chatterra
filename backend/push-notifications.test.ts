import assert from 'node:assert/strict'
import {
  buildExpoPushMessages,
  isExpoPushToken,
  notificationPreview,
} from './push-notifications'

assert.equal(isExpoPushToken('ExponentPushToken[abc_123-xyz]'), true)
assert.equal(isExpoPushToken('not-a-push-token'), false)
assert.equal(notificationPreview('  Maya\njust   sent  a message. '), 'Maya just sent a message.')
assert.equal(notificationPreview('a'.repeat(200)).endsWith('…'), true)

const messages = buildExpoPushMessages(['ExpoPushToken[token]'], {
  characterId: 'c3',
  characterName: 'Maya',
  conversationId: 'conversation-1',
  messageId: 'message-1',
  content: 'I was thinking about you on my way back from class.',
})

assert.equal(messages[0]?.title, 'Maya')
assert.equal(messages[0]?.data.url, '/chat/c3')
assert.equal(messages[0]?.sound, 'default')

console.log('push notification checks passed')
