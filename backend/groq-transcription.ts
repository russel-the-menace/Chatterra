import { Dispatcher, ProxyAgent } from 'undici'

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

type GroqRoute = 'direct' | 'mihomo'

const proxyAgents = new Map<string, Dispatcher>()

const getProxyDispatcher = (proxyUrl: string): Dispatcher => {
  const existing = proxyAgents.get(proxyUrl)
  if (existing) return existing

  const dispatcher = new ProxyAgent(proxyUrl)
  proxyAgents.set(proxyUrl, dispatcher)
  return dispatcher
}

const createTranscriptionForm = (input: {
  audio: Buffer
  mimeType: string
  extension: string
  model: string
  prompt?: string
}) => {
  const form = new FormData()
  form.append('model', input.model)
  form.append('response_format', 'json')
  if (input.prompt) form.append('prompt', input.prompt)
  form.append(
    'file',
    new Blob([Uint8Array.from(input.audio)], { type: input.mimeType }),
    `voice${input.extension}`
  )
  return form
}

const requestTranscription = async (input: {
  apiKey: string
  audio: Buffer
  extension: string
  mimeType: string
  model: string
  prompt?: string
  route: GroqRoute
  url: string
  proxyUrl?: string
}) => {
  const dispatcher = input.route === 'mihomo' && input.proxyUrl
    ? getProxyDispatcher(input.proxyUrl)
    : undefined
  const init = {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.apiKey}` },
    body: createTranscriptionForm(input),
    ...(dispatcher ? { dispatcher } : {}),
  }

  return fetch(input.url, init as RequestInit)
}

const shouldRetryViaMihomo = (status: number) => status === 403 || status >= 500

export const transcribeWithGroq = async (input: {
  audio: Buffer
  mimeType: string
  prompt?: string
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
  const url = process.env.GROQ_TRANSCRIPTION_URL || 'https://api.groq.com/openai/v1/audio/transcriptions'
  const proxyUrl = process.env.GROQ_PROXY_URL?.trim() || undefined
  let response: globalThis.Response | undefined
  let route: GroqRoute = 'direct'
  try {
    response = await requestTranscription({
      apiKey,
      audio: input.audio,
      extension,
      mimeType,
      model,
      prompt: input.prompt,
      route,
      url,
    })
  } catch (error) {
    console.error('Groq transcription request failed', {
      route,
      error: error instanceof Error ? error.name : 'unknown_error',
      audioBytes: input.audio.length,
    })
  }

  if (proxyUrl && (!response || shouldRetryViaMihomo(response.status))) {
    const directStatus = response?.status ?? null
    await response?.body?.cancel().catch(() => undefined)
    route = 'mihomo'
    console.warn('Retrying Groq transcription through Mihomo', {
      directStatus,
      audioBytes: input.audio.length,
    })
    try {
      response = await requestTranscription({
        apiKey,
        audio: input.audio,
        extension,
        mimeType,
        model,
        prompt: input.prompt,
        route,
        url,
        proxyUrl,
      })
    } catch (error) {
      console.error('Groq transcription proxy request failed', {
        error: error instanceof Error ? error.name : 'unknown_error',
        audioBytes: input.audio.length,
      })
      throw new GroqTranscriptionError('voice transcription service is unreachable')
    }
  }

  if (!response) throw new GroqTranscriptionError('voice transcription service is unreachable')

  let data: any
  try {
    data = await response.json()
  } catch {
    data = await response.text().catch(() => null)
  }
  if (!response.ok) {
    console.error('Groq transcription returned an error', {
      route,
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
    route,
    audioBytes: input.audio.length,
    transcriptLength: text.length,
  })
  return { text, provider: 'groq', model }
}
