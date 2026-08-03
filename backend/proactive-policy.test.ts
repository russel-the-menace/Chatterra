import assert from 'node:assert/strict'
import { deriveProactivePolicy, nextProactiveActionAt } from './proactive-policy'
import { Character } from './types'

const maya = {
  id: 'c3',
  name: 'Maya',
  role: 'Girlfriend and first-year pre-med student',
  personality: 'Affectionate, clingy, curious, and proactive. She initiates conversations.',
  scenario: 'Everyday dating relationship',
  goal: 'Build a close relationship',
  language: 'English only',
  background: 'She studies in New York and talks about school, medicine, family of origin, relationships, and philosophy.',
  createdAt: '2026-07-23T00:00:00.000Z',
  updatedAt: '2026-07-23T00:00:00.000Z'
} as Character

const ordinaryCharacter = {
  ...maya,
  id: 'ordinary',
  role: 'Conversation partner',
  personality: 'Calm and thoughtful',
  background: ''
} as Character

const policy = deriveProactivePolicy(maya)
assert.equal(policy.enabled, true)
assert.equal(policy.maxUnansweredMessages, 3)
assert.deepEqual(policy.topicDomains, [
  'school life',
  'medicine',
  'intimate relationships',
  'family of origin',
  'philosophy',
  'daily life'
])
assert.equal(deriveProactivePolicy(ordinaryCharacter).enabled, false)

const now = new Date('2026-07-23T12:00:00.000Z')
const first = nextProactiveActionAt({ character: maya, now, seed: 'same-seed' })
const repeated = nextProactiveActionAt({ character: maya, now, seed: 'same-seed' })
const followUp = nextProactiveActionAt({ character: maya, now, seed: 'same-seed', unansweredCount: 1 })
assert.equal(first?.toISOString(), repeated?.toISOString())
assert.ok(first && first > now)
assert.ok(followUp && followUp > first!)
assert.equal(nextProactiveActionAt({ character: maya, now, seed: 'same-seed', unansweredCount: 3 }), undefined)
assert.equal(nextProactiveActionAt({ character: ordinaryCharacter, now, seed: 'same-seed' }), undefined)

console.log('proactive policy checks passed')
