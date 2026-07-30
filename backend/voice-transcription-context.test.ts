import assert from 'node:assert/strict'
import { voiceTranscriptionContextForCharacter } from './voice-transcription-context'
import { Character } from './types'

const sofia: Character = {
  id: 'seed-sofia-argentina-spanish',
  name: 'Sofía Álvarez',
  language: 'Argentine Spanish with English explanations',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const context = voiceTranscriptionContextForCharacter(sofia)
assert.equal(context?.id, 'sofia-english-argentine-spanish')
assert.match(context?.prompt || '', /English and Argentine Spanish/u)
assert.match(context?.prompt || '', /gracias/u)
assert.equal(voiceTranscriptionContextForCharacter({ ...sofia, id: 'other' }), undefined)
console.log('voice transcription context checks passed')
