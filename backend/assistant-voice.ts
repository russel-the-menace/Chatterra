import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const MAYA_CHARACTER_ID = 'c3'

export type AssistantVoiceMetadata = {
  provider: 'qwen3-tts'
  status: 'pending' | 'ready' | 'failed'
  segmentIndex: number
  voiceId: 'maya'
  style: string
  audioUrl?: string
  durationSeconds?: number
  mimeType?: 'audio/wav'
  generatedAt?: string
}

type VoiceCandidateInput = {
  characterId: string
  messageId: string
  replySegments: string[]
  recentMessages: Array<{
    senderRole: string
    contentJson?: Record<string, unknown>
  }>
  userMessage: string
}

const MAX_AUDIO_BYTES = 4 * 1024 * 1024

const normalizedEnv = (name: string) => process.env[name]?.trim() || ''

export const voiceMediaDirectory = path.resolve(
  normalizedEnv('TTS_MEDIA_DIR') || path.join(process.cwd(), 'data', 'voice')
)

export const mayaVoiceMessagesEnabled = () => (
  process.env.MAYA_VOICE_MESSAGES_ENABLED === 'true'
  && Boolean(normalizedEnv('QWEN_TTS_URL'))
)

const stableUnitInterval = (seed: string) => {
  let hash = 2166136261
  for (const character of seed) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) / 0x100000000
}

const voiceMetadata = (value: unknown): AssistantVoiceMetadata | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const voice = value as Record<string, unknown>
  if (voice.voiceId !== 'maya') return undefined
  if (voice.status !== 'pending' && voice.status !== 'ready' && voice.status !== 'failed') {
    return undefined
  }
  return voice as unknown as AssistantVoiceMetadata
}

const assistantRepliesSinceLastVoice = (recentMessages: VoiceCandidateInput['recentMessages']) => {
  let replies = 0
  for (const message of [...recentMessages].reverse()) {
    if (message.senderRole !== 'assistant') continue
    if (voiceMetadata(message.contentJson?.voice)) return replies
    replies += 1
  }
  return Number.POSITIVE_INFINITY
}

const speechStyle = (text: string) => {
  const lower = text.toLowerCase()
  if (/\b(?:sorry|here for you|miss you|lonely|hurt|rough|sleep well|goodnight)\b/.test(lower)) {
    return {
      boost: 0.2,
      style: 'soft, close, and reassuring; speak a little more slowly with a gentle warmth'
    }
  }
  if (/\b(?:wait|no way|omg|oh my god|excited|cute|stop|haha|lol)\b/.test(lower) || /[!]{1,}/.test(text)) {
    return {
      boost: 0.15,
      style: 'bright, playful, and lightly amused; let a small smile come through without sounding performed'
    }
  }
  if (/\b(?:i mean|maybe|honestly|kind of|not sure|think)\b/.test(lower)) {
    return {
      boost: 0.08,
      style: 'thoughtful and intimate, with a natural little hesitation before the important part'
    }
  }
  return {
    boost: 0,
    style: 'warm, relaxed, and conversational, like a short personal voice note to someone close'
  }
}

const requestedVoiceNote = (text: string) => (
  /(?:voice note|voice message|send (?:me )?a voice|say it out loud|发个语音|语音说)/i.test(text)
)

export const planMayaVoiceMessage = ({
  characterId,
  messageId,
  replySegments,
  recentMessages,
  userMessage,
}: VoiceCandidateInput): AssistantVoiceMetadata | undefined => {
  if (!mayaVoiceMessagesEnabled() || characterId !== MAYA_CHARACTER_ID) return undefined
  if (assistantRepliesSinceLastVoice(recentMessages) < 2) return undefined

  const segmentIndex = replySegments.findIndex(segment => {
    const trimmed = segment.trim()
    const wordCount = trimmed.split(/\s+/u).filter(Boolean).length
    return trimmed.length >= 18 && trimmed.length <= 280 && wordCount >= 3
  })
  if (segmentIndex < 0) return undefined

  const text = replySegments[segmentIndex].trim()
  const style = speechStyle(text)
  const chance = requestedVoiceNote(userMessage)
    ? 1
    : Math.min(0.36, 0.11 + style.boost)
  if (stableUnitInterval(`${messageId}:${text}`) >= chance) return undefined

  return {
    provider: 'qwen3-tts',
    status: 'pending',
    segmentIndex,
    voiceId: 'maya',
    style: style.style,
  }
}

const wavDurationSeconds = (data: Buffer) => {
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    return undefined
  }
  let offset = 12
  let byteRate: number | undefined
  let dataLength: number | undefined
  while (offset + 8 <= data.length) {
    const chunkId = data.toString('ascii', offset, offset + 4)
    const chunkLength = data.readUInt32LE(offset + 4)
    const dataOffset = offset + 8
    if (chunkId === 'fmt ' && dataOffset + 16 <= data.length) {
      byteRate = data.readUInt32LE(dataOffset + 8)
    }
    if (chunkId === 'data') {
      dataLength = Math.min(chunkLength, Math.max(0, data.length - dataOffset))
      break
    }
    offset = dataOffset + chunkLength + (chunkLength % 2)
  }
  if (!byteRate || !dataLength) return undefined
  return Number((dataLength / byteRate).toFixed(1))
}

const publicAudioUrl = (filename: string) => {
  const configuredBase = normalizedEnv('TTS_PUBLIC_BASE_URL').replace(/\/+$/, '')
  return configuredBase ? `${configuredBase}/${filename}` : `/media/voice/${filename}`
}

export const synthesizeMayaVoiceMessage = async ({
  messageId,
  text,
  voice,
}: {
  messageId: string
  text: string
  voice: AssistantVoiceMetadata
}): Promise<AssistantVoiceMetadata> => {
  const serviceUrl = normalizedEnv('QWEN_TTS_URL').replace(/\/+$/, '')
  if (!serviceUrl) throw new Error('Qwen3-TTS is not configured')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 60_000)
  try {
    const response = await fetch(`${serviceUrl}/v1/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'audio/wav' },
      body: JSON.stringify({
        text,
        language: 'English',
        style: voice.style,
        voiceId: voice.voiceId,
      }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Qwen3-TTS returned ${response.status}`)
    const data = Buffer.from(await response.arrayBuffer())
    if (data.length === 0 || data.length > MAX_AUDIO_BYTES) {
      throw new Error('Qwen3-TTS returned an invalid audio payload')
    }
    const durationSeconds = wavDurationSeconds(data)
    if (!durationSeconds || durationSeconds > 30) {
      throw new Error('Qwen3-TTS returned an invalid voice-message duration')
    }

    const filename = `${messageId}.wav`
    await mkdir(voiceMediaDirectory, { recursive: true })
    const destination = path.join(voiceMediaDirectory, filename)
    const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, data)
    await rename(temporary, destination)
    return {
      ...voice,
      status: 'ready',
      audioUrl: publicAudioUrl(filename),
      durationSeconds,
      mimeType: 'audio/wav',
      generatedAt: new Date().toISOString(),
    }
  } finally {
    clearTimeout(timeout)
  }
}
