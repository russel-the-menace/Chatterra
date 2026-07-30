import assert from 'node:assert/strict'
import {
  isSupportedTranscriptionAudioType,
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  transcribeWithGroq,
} from './groq-transcription'

const originalFetch = globalThis.fetch
const originalApiKey = process.env.GROQ_API_KEY
const originalUrl = process.env.GROQ_TRANSCRIPTION_URL

const run = async () => {
  try {
    process.env.GROQ_API_KEY = 'test-key'
    process.env.GROQ_TRANSCRIPTION_URL = 'https://provider.invalid/audio/transcriptions'
    let requestBody: FormData | undefined
    globalThis.fetch = (async (_input, init) => {
      requestBody = init?.body as FormData
      return new Response(JSON.stringify({ text: '今日は meeting がある。' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const result = await transcribeWithGroq({
      audio: Buffer.from('audio-bytes'),
      mimeType: 'audio/mp4; charset=binary',
    })
    assert.equal(result.text, '今日は meeting がある。')
    assert.equal(result.model, 'whisper-large-v3-turbo')
    assert.equal(requestBody?.get('model'), 'whisper-large-v3-turbo')
    assert.equal(requestBody?.get('response_format'), 'json')
    assert.ok(requestBody?.get('file') instanceof Blob)
    assert.equal(isSupportedTranscriptionAudioType('audio/mp4'), true)
    assert.equal(isSupportedTranscriptionAudioType('audio/wav'), false)
    await assert.rejects(
      transcribeWithGroq({
        audio: Buffer.alloc(MAX_TRANSCRIPTION_AUDIO_BYTES + 1),
        mimeType: 'audio/mp4',
      }),
      /too large/
    )
    console.log('groq transcription checks passed')
  } finally {
    globalThis.fetch = originalFetch
    if (originalApiKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = originalApiKey
    if (originalUrl === undefined) delete process.env.GROQ_TRANSCRIPTION_URL
    else process.env.GROQ_TRANSCRIPTION_URL = originalUrl
  }
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
