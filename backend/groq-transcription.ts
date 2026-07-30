export class GroqTranscriptionError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 502) {
    super(message)
    this.name = 'GroqTranscriptionError'
    this.statusCode = statusCode
  }
}

export type GroqTranscriptionResult = {
  text: string
  provider: 'groq'
  model: string
}

const AUDIO_EXTENSIONS: Record<string, string> = {
  'audio/mp4': '.m4a',
  'audio/m4a': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/3gpp': '.3gp',
  'audio/webm': '.webm',
}

export const MAX_TRANSCRIPTION_AUDIO_BYTES = 2 * 1024 * 1024

export const isSupportedTranscriptionAudioType = (value: string | undefined) => {
  const mimeType = (value || '').split(';')[0].trim().toLowerCase()
  return mimeType in AUDIO_EXTENSIONS
}

const normalizedMimeType = (value: string) => value.split(';')[0].trim().toLowerCase()

export const transcribeWithGroq = async (input: {
  audio: Buffer
  mimeType: string
}): Promise<GroqTranscriptionResult> => {
  const mimeType = normalizedMimeType(input.mimeType)
  const extension = AUDIO_EXTENSIONS[mimeType]
  if (!extension) throw new GroqTranscriptionError('unsupported audio format', 415)
  if (input.audio.length === 0) throw new GroqTranscriptionError('audio is empty', 400)
  if (input.audio.length > MAX_TRANSCRIPTION_AUDIO_BYTES) {
    throw new GroqTranscriptionError('audio is too large to transcribe', 413)
  }

  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new GroqTranscriptionError('voice transcription is not configured', 503)

  const model = process.env.GROQ_TRANSCRIPTION_MODEL || 'whisper-large-v3-turbo'
  const form = new FormData()
  form.append('model', model)
  form.append('response_format', 'json')
  form.append(
    'file',
    new Blob([Uint8Array.from(input.audio)], { type: mimeType }),
    `voice${extension}`
  )

  let response: globalThis.Response
  try {
    response = await fetch(
      process.env.GROQ_TRANSCRIPTION_URL || 'https://api.groq.com/openai/v1/audio/transcriptions',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      }
    )
  } catch (error) {
    console.error('Groq transcription request failed', {
      error: error instanceof Error ? error.name : 'unknown_error',
      audioBytes: input.audio.length,
    })
    throw new GroqTranscriptionError('voice transcription service is unreachable')
  }

  let data: any
  try {
    data = await response.json()
  } catch {
    data = await response.text().catch(() => null)
  }
  if (!response.ok) {
    console.error('Groq transcription returned an error', {
      httpStatus: response.status,
      responseKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 12) : [],
    })
    throw new GroqTranscriptionError('voice transcription provider returned an error')
  }

  const text = typeof data?.text === 'string' ? data.text.trim() : ''
  if (!text) throw new GroqTranscriptionError('voice transcription provider returned no text')

  console.info('Voice transcription completed', {
    provider: 'groq',
    model,
    audioBytes: input.audio.length,
    transcriptLength: text.length,
  })
  return { text, provider: 'groq', model }
}
