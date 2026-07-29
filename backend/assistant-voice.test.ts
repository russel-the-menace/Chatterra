import assert from 'node:assert/strict'
import { MAYA_CHARACTER_ID, planMayaVoiceMessage } from './assistant-voice'

process.env.MAYA_VOICE_MESSAGES_ENABLED = 'true'
process.env.QWEN_TTS_URL = 'http://localhost:8001'

const forcedVoice = planMayaVoiceMessage({
  characterId: MAYA_CHARACTER_ID,
  messageId: 'maya-voice-test',
  replySegments: ['I was saving this one for a voice note, because it is easier to say softly.'],
  recentMessages: [],
  userMessage: 'Could you send me a voice note?',
})

assert.equal(forcedVoice?.status, 'pending')
assert.equal(forcedVoice?.segmentIndex, 0)
assert.equal(forcedVoice?.voiceId, 'maya')

assert.equal(planMayaVoiceMessage({
  characterId: 'seed-minjun-friend',
  messageId: 'other-character-test',
  replySegments: ['Could you send me a voice note too?'],
  recentMessages: [],
  userMessage: 'Could you send me a voice note?',
}), undefined)

assert.equal(planMayaVoiceMessage({
  characterId: MAYA_CHARACTER_ID,
  messageId: 'maya-cooldown-test',
  replySegments: ['Could you send me a voice note too? I want to hear you say it.'],
  recentMessages: [
    {
      senderRole: 'assistant',
      contentJson: {
        voice: {
          provider: 'qwen3-tts',
          status: 'ready',
          segmentIndex: 0,
          voiceId: 'maya',
          style: 'warm',
        },
      },
    },
    { senderRole: 'user' },
    { senderRole: 'assistant' },
  ],
  userMessage: 'Could you send me a voice note?',
}), undefined)

console.log('assistant voice tests passed')
