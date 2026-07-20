import assert from 'node:assert/strict'
import { decideResponse } from './response-decision'
import { BehaviorSnapshot } from './types'

const now = new Date('2026-07-21T01:00:10.000Z')

const character = {
  id: 'character',
  name: '麻辣佬',
  personality: 'warm and balanced',
  createdAt: now.toISOString(),
  updatedAt: now.toISOString()
}

const snapshot = (activity = 'sleeping', energy = 0.7): BehaviorSnapshot => ({
  instance: {
    id: 'instance',
    userId: 'user',
    characterId: 'character',
    templateVersion: 1,
    mode: 'companion',
    eventSequence: 1,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  },
  relationship: {
    familiarity: 0.4,
    trust: 0.5,
    affinity: 0.5,
    respect: 0.5,
    reciprocity: 0.5,
    boundaryComfort: 0.5,
    unresolvedTension: 0,
    bondStrength: 0.4,
    version: 1,
    asOf: now.toISOString()
  },
  affect: {
    valence: 0,
    arousal: 0.3,
    dominance: 0,
    warmth: 0.2,
    stress: 0.2,
    energy,
    baseline: {},
    version: 1,
    asOf: now.toISOString()
  },
  simulation: {
    localTimezone: 'Asia/Shanghai',
    currentActivity: activity,
    activityStartedAt: now.toISOString(),
    lastSimulatedAt: now.toISOString(),
    version: 1
  },
  recentEvents: [],
  emotionLabel: 'tired but present'
})

const neutralAppraisal = {
  selfDisclosure: false,
  question: false,
  urgency: false,
  distress: false,
  bereavement: false,
  directedConflict: false
}

const recentQuestion = [{
  senderRole: 'assistant' as const,
  content: '你喺嗰邊做咩啊？',
  createdAt: '2026-07-21T01:00:00.000Z'
}]

const decide = (message: string, options: Record<string, any> = {}) => decideResponse({
  message,
  mode: options.mode || 'companion',
  character,
  snapshot: options.snapshot || snapshot(),
  appraisal: options.appraisal || neutralAppraisal,
  recentMessages: options.recentMessages || recentQuestion,
  now
})

const lowDemand = decide('冇嘢做啊。')
assert.equal(lowDemand.action, 'no_reply')
assert.ok(lowDemand.reasonCodes.includes('low_information_statement'))

const directQuestion = decide('你而家喺邊度？')
assert.equal(directQuestion.action, 'reply_now')
assert.ok(directQuestion.reasonCodes.includes('direct_question'))

const meaningfulStatement = decide('我今日去咗珠海。')
assert.equal(meaningfulStatement.action, 'reply_now')

const urgentDisclosure = decide('我爷爷去世了。', {
  appraisal: {
    ...neutralAppraisal,
    selfDisclosure: true,
    distress: true,
    bereavement: true
  }
})
assert.equal(urgentDisclosure.action, 'reply_now')
assert.ok(urgentDisclosure.reasonCodes.includes('high_stakes_message_requires_response'))

const practiceTurn = decide('冇嘢做啊。', { mode: 'practice' })
assert.equal(practiceTurn.action, 'reply_now')

const punctuation = decide('？')
assert.equal(punctuation.action, 'no_reply')

console.log('response decision checks passed')
