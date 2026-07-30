import assert from 'node:assert/strict'
import {
  parseUserVoiceMessageMetadata,
  readUserVoiceMessage,
  removeUserVoiceMessage,
  saveUserVoiceMessage,
  userVoiceMessageMetadata,
} from './user-voice-message'

const run = async () => {
  const voice = userVoiceMessageMetadata({
    messageId: 'voice-message-test-001',
    userId: 'test-user',
    mimeType: 'audio/mp4; charset=binary',
    durationSeconds: 4.26,
  })
  assert.equal(voice.mimeType, 'audio/mp4')
  assert.equal(voice.durationSeconds, 4.3)
  assert.equal(voice.transcriptStatus, 'none')
  assert.equal(parseUserVoiceMessageMetadata(voice)?.filename, voice.filename)

  await saveUserVoiceMessage(voice, Buffer.from('voice-audio'))
  assert.deepEqual(await readUserVoiceMessage(voice), Buffer.from('voice-audio'))
  await removeUserVoiceMessage(voice)
  await assert.rejects(readUserVoiceMessage(voice), /ENOENT/)
  console.log('user voice message checks passed')
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
