import assert from 'node:assert/strict'
import {
  diagnoseInferenceOutput,
  estimateTokens,
  fitCurrentMessageToTokenBudget,
  inferResponseStyle,
  InferencePlan,
  MESSAGE_BREAK_TOKEN,
  modelTarget
} from './inference-orchestrator'
import { resolveResponseLanguagePolicy } from './language-policy'
import {
  messageAndQuoteForRouting,
  messageAndQuoteForResponseStyle,
  messageContentForInference,
  storedMessageQuote
} from './message-quote'
import { BehaviorSnapshot, Character, Message, MessageQuote } from './types'

const now = '2026-07-24T12:00:00.000Z'
const character: Character = {
  id: 'balanced-character',
  name: 'Alex',
  personality: 'Warm and balanced',
  createdAt: now,
  updatedAt: now
}

const snapshot = (energy = 0.7): BehaviorSnapshot => ({
  instance: {
    id: 'instance',
    userId: 'user',
    characterId: character.id,
    templateVersion: 1,
    mode: 'companion',
    eventSequence: 1,
    createdAt: now,
    updatedAt: now
  },
  relationship: {
    familiarity: 0.5,
    trust: 0.55,
    affinity: 0.55,
    respect: 0.5,
    reciprocity: 0.5,
    boundaryComfort: 0.6,
    unresolvedTension: 0,
    bondStrength: 0.5,
    version: 1,
    asOf: now
  },
  affect: {
    valence: 0.2,
    arousal: 0.4,
    dominance: 0,
    warmth: 0.45,
    stress: 0.2,
    energy,
    baseline: {},
    version: 1,
    asOf: now
  },
  simulation: {
    localTimezone: 'America/New_York',
    currentActivity: 'relaxing',
    activityStartedAt: now,
    lastSimulatedAt: now,
    version: 1
  },
  recentEvents: [],
  emotionLabel: 'content'
})

const casual = inferResponseStyle(character, snapshot(), 'hey, what are you doing?', 'companion')
const detailed = inferResponseStyle(
  character,
  snapshot(),
  'Tell me the whole story of what happened in class, why it mattered to you, and how you want to handle it tomorrow.',
  'companion'
)
const tired = inferResponseStyle(character, snapshot(0.15), 'hey, what are you doing?', 'companion')

assert.ok(casual.targetWords < 55)
assert.ok(detailed.targetWords > casual.targetWords)
assert.ok(tired.targetWords < casual.targetWords)

const distressedQuote: MessageQuote = {
  sourceMessageId: 'quoted-user-message',
  segmentIndex: 0,
  senderRole: 'user',
  senderName: 'You',
  text: 'My father died and I feel devastated and overwhelmed.'
}
const quotedRoutingText = messageAndQuoteForRouting('👍', distressedQuote)
const quotedStyle = inferResponseStyle(
  character,
  snapshot(),
  quotedRoutingText,
  'companion'
)
assert.equal(quotedStyle.turnPriority, 'emotional_support')
assert.equal(modelTarget('companion', quotedRoutingText, snapshot()).tier, 'primary')

const distressedAssistantQuote: MessageQuote = {
  ...distressedQuote,
  sourceMessageId: 'quoted-assistant-message',
  senderRole: 'assistant',
  senderName: 'Alex'
}
const assistantStyleText = messageAndQuoteForResponseStyle('👍', distressedAssistantQuote)
const assistantQuotedStyle = inferResponseStyle(
  character,
  snapshot(),
  assistantStyleText,
  'companion'
)
assert.equal(assistantQuotedStyle.turnPriority, 'conversation')
assert.equal(
  modelTarget(
    'companion',
    messageAndQuoteForRouting('👍', distressedAssistantQuote),
    snapshot()
  ).tier,
  'primary'
)

const oversizedQuoteText = '引'.repeat(20_000)
const oversizedCurrentMessage: Message = {
  id: 'oversized-current-message',
  conversationId: 'conversation',
  senderRole: 'user',
  senderId: 'user',
  content: '现'.repeat(20_000),
  contentJson: {
    quote: {
      ...distressedQuote,
      text: oversizedQuoteText
    }
  },
  createdAt: now
}
const fittedCurrentMessage = fitCurrentMessageToTokenBudget(oversizedCurrentMessage, 1_000)
const fittedQuote = storedMessageQuote(fittedCurrentMessage.contentJson?.quote)
assert.ok(fittedQuote)
assert.ok(fittedCurrentMessage.content.length < oversizedCurrentMessage.content.length)
assert.ok(fittedQuote.text.length < oversizedQuoteText.length)
assert.ok(estimateTokens(messageContentForInference(fittedCurrentMessage)) <= 1_000)

const maya: Character = {
  ...character,
  id: 'c3',
  name: 'Maya',
  personality: 'Affectionate, playful, expressive, clingy, and casual. Her texting voice uses short messages.'
}
const mayaStyle = inferResponseStyle(maya, snapshot(), 'how was class today?', 'companion')
assert.equal(mayaStyle.messageCadence.maxCount, 2)
assert.equal(mayaStyle.messageCadence.pattern, 'flexible')

const responseLanguage = resolveResponseLanguagePolicy('English only')
const plan = {
  route: 'model',
  sourceText: 'what happened?',
  responseLanguage,
  responseStyle: {
    ...mayaStyle,
    messageCadence: {
      pattern: 'bursty',
      preferredCount: 2,
      maxCount: 3,
      reasonCodes: []
    }
  },
  messages: [],
  mode: 'companion'
} as InferencePlan

const segmented = diagnoseInferenceOutput(
  plan,
  `That lab was chaos 😭\n${MESSAGE_BREAK_TOKEN}\nMy partner dropped an entire tray.\n${MESSAGE_BREAK_TOKEN}\nEveryone just froze.`
)
assert.equal(segmented.accepted, true)
assert.deepEqual(segmented.deliverySegments, [
  'That lab was chaos 😭',
  'My partner dropped an entire tray.',
  'Everyone just froze.'
])
assert.equal(segmented.reply, 'That lab was chaos 😭\nMy partner dropped an entire tray.\nEveryone just froze.')

const twoBubblePlan = {
  ...plan,
  responseStyle: {
    ...plan.responseStyle,
    messageCadence: { ...plan.responseStyle.messageCadence, maxCount: 2 }
  }
} as InferencePlan
const overflow = diagnoseInferenceOutput(
  twoBubblePlan,
  `One.\n${MESSAGE_BREAK_TOKEN}\nTwo.\n${MESSAGE_BREAK_TOKEN}\nThree.`
)
assert.deepEqual(overflow.deliverySegments, ['One.', 'Two. Three.'])

console.log('response style checks passed')
