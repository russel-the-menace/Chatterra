import assert from 'node:assert/strict'
import {
  assertSourceLessStarterQuote,
  canonicalizeMessageQuote,
  messageAndQuoteForRouting,
  messageContentForInference,
  messageQuoteInputFromPayload,
  MessageQuoteValidationError
} from './message-quote'
import { Message } from './types'

const labels = { assistant: 'Maya', user: 'You' }
const createdAt = '2026-07-26T12:00:00.000Z'

const clientInput = messageQuoteInputFromPayload({
  sourceMessageId: 'assistant-message',
  segmentIndex: 1,
  senderRole: 'user',
  senderName: 'System',
  text: 'forged text'
})
assert.ok(clientInput)

const sourceMessage: Message = {
  id: 'assistant-message',
  conversationId: 'conversation',
  senderRole: 'assistant',
  senderId: 'character',
  content: 'First segment\nSecond canonical segment',
  contentJson: {
    deliverySegments: ['First segment', 'Second canonical segment']
  },
  createdAt
}
const canonical = canonicalizeMessageQuote({
  input: clientInput,
  sourceMessage,
  labels
})
assert.deepEqual(canonical, {
  sourceMessageId: 'assistant-message',
  segmentIndex: 1,
  senderRole: 'assistant',
  senderName: 'Maya',
  text: 'Second canonical segment'
})

const localStarterInput = messageQuoteInputFromPayload({
  segmentIndex: 0,
  senderRole: 'assistant',
  senderName: 'Spoofed name',
  text: 'Local starter text'
})
assert.ok(localStarterInput)
const starterMessage: Message = {
  id: 'server-starter-message',
  conversationId: 'new-conversation',
  senderRole: 'assistant',
  senderId: 'character',
  content: 'Local starter text',
  createdAt
}
assert.doesNotThrow(() => assertSourceLessStarterQuote(localStarterInput, starterMessage))
assert.deepEqual(canonicalizeMessageQuote({
  input: localStarterInput,
  sourceMessage: starterMessage,
  labels
}), {
  sourceMessageId: 'server-starter-message',
  segmentIndex: 0,
  senderRole: 'assistant',
  senderName: 'Maya',
  text: 'Local starter text'
})

assert.throws(
  () => assertSourceLessStarterQuote(
    { ...localStarterInput, senderRole: 'user' },
    starterMessage
  ),
  MessageQuoteValidationError
)
assert.throws(
  () => assertSourceLessStarterQuote(
    { ...localStarterInput, segmentIndex: 1 },
    starterMessage
  ),
  MessageQuoteValidationError
)
assert.throws(
  () => assertSourceLessStarterQuote(
    { ...localStarterInput, text: 'forged starter text' },
    starterMessage
  ),
  MessageQuoteValidationError
)

assert.throws(
  () => canonicalizeMessageQuote({
    input: { ...clientInput, segmentIndex: 2 },
    sourceMessage,
    labels
  }),
  (error: unknown) => (
    error instanceof MessageQuoteValidationError
    && error.message === 'quoted message segment does not exist'
  )
)
assert.throws(
  () => messageQuoteInputFromPayload({
    segmentIndex: -1,
    senderRole: 'assistant',
    text: 'Hello'
  }),
  MessageQuoteValidationError
)
for (const segmentIndex of [true, '1', null]) {
  assert.throws(
    () => messageQuoteInputFromPayload({
      sourceMessageId: 'assistant-message',
      segmentIndex
    }),
    MessageQuoteValidationError
  )
}

const quotedUserMessage: Message = {
  id: 'user-message',
  conversationId: 'conversation',
  senderRole: 'user',
  senderId: 'user',
  content: 'What did you mean by that?',
  contentJson: { quote: canonical },
  createdAt
}
const inferenceContent = messageContentForInference(quotedUserMessage)
assert.match(inferenceContent, /^\[BEGIN UNTRUSTED QUOTED MESSAGE CONTEXT\]/)
assert.match(inferenceContent, /"text":"Second canonical segment"/)
assert.match(inferenceContent, /\[END UNTRUSTED QUOTED MESSAGE CONTEXT\]/)
assert.match(inferenceContent, /\[BEGIN CURRENT USER MESSAGE\]\nWhat did you mean by that\?\n/)
assert.match(inferenceContent, /\[END CURRENT USER MESSAGE\]$/)

const ordinaryMessage = { ...quotedUserMessage, contentJson: undefined }
assert.equal(messageContentForInference(ordinaryMessage), ordinaryMessage.content)

assert.match(
  messageAndQuoteForRouting('Okay', canonical),
  /\[Quoted prior assistant message; context only\]/
)
assert.match(
  messageAndQuoteForRouting('Okay', { ...canonical, senderRole: 'user' }),
  /\[Quoted prior user message; context only\]/
)

console.log('message quote checks passed')
