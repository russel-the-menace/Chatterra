import assert from 'node:assert/strict'

import { parseCustomCharacterDocument } from './custom-character'
import { deriveProactivePolicy } from './proactive-policy'
import { resolveCharacterMode, timeZoneForCharacter } from './behavior'

const document = `---
mode: practice
language: Japanese
explanation_language: English
correction: on_request
reply_style: concise
delivery: single
initiative: high
timezone: Asia/Tokyo
starter_message: Let us begin with a quick introduction.
---

# Identity
You are a friendly Japanese language partner.`

const parsed = parseCustomCharacterDocument(document)
assert.equal(parsed.prompt, '# Identity\nYou are a friendly Japanese language partner.')
assert.equal(parsed.languageSetting, 'Japanese with English explanations')
assert.deepEqual(parsed.runtimeConfig, {
  mode: 'practice',
  language: 'Japanese',
  explanationLanguage: 'English',
  correction: 'on_request',
  replyStyle: 'concise',
  delivery: 'single',
  initiative: 'high',
  timezone: 'Asia/Tokyo',
  starterMessage: 'Let us begin with a quick introduction.',
})

const character = {
  id: 'custom-character',
  name: 'Practice partner',
  role: 'Anything',
  language: parsed.languageSetting,
  runtimeConfig: parsed.runtimeConfig,
  createdAt: '2026-07-30T00:00:00.000Z',
  updatedAt: '2026-07-30T00:00:00.000Z',
}

assert.equal(resolveCharacterMode(character), 'practice')
assert.equal(timeZoneForCharacter(character), 'Asia/Tokyo')
assert.deepEqual(deriveProactivePolicy(character), {
  enabled: true,
  intensity: 0.9,
  minDelayMinutes: 20,
  maxDelayMinutes: 90,
  maxUnansweredMessages: 1,
  topicDomains: ['daily life'],
})
assert.throws(() => parseCustomCharacterDocument('Just a prompt without frontmatter.'))
assert.throws(() => parseCustomCharacterDocument(`---
mode: companion
language: Klingon
---
Identity`))

console.log('custom character checks passed')
