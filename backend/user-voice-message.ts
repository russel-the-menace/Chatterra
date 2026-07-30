import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { voiceMediaDirectory } from './assistant-voice'

const MIME_EXTENSIONS: Record<string, string> = {
  'audio/mp4': '.m4a',
  'audio/m4a': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/3gpp': '.3gp',
  'audio/webm': '.webm',
}

export const MAX_USER_VOICE_MESSAGE_BYTES = 4 * 1024 * 1024
export const MAX_USER_VOICE_MESSAGE_DURATION_SECONDS = 60

export type UserVoiceMessageMetadata = {
  provider: 'user-recording'
  status: 'ready'
  audioUrl: string
  durationSeconds: number
  filename: string
  mimeType: keyof typeof MIME_EXTENSIONS
  transcriptStatus: 'none' | 'ready'
}

export const normalizedVoiceMessageMimeType = (value: string | undefined) => (
  (value || '').split(';')[0].trim().toLowerCase()
)

export const isSupportedUserVoiceMessageType = (value: string | undefined) => (
  normalizedVoiceMessageMimeType(value) in MIME_EXTENSIONS
)

export const userVoiceMessageDirectory = path.resolve(
  process.env.USER_VOICE_MEDIA_DIR?.trim() || path.join(path.dirname(voiceMediaDirectory), 'user-voice')
)

const filenameFor = (messageId: string, mimeType: string) => {
  const extension = MIME_EXTENSIONS[mimeType]
  if (!extension || !/^[a-z0-9-]+$/i.test(messageId)) throw new Error('invalid voice message metadata')
  return `${messageId}${extension}`
}

export const userVoiceMessageMetadata = (input: {
  messageId: string
  mimeType: string
  durationSeconds: number
  userId: string
}): UserVoiceMessageMetadata => {
  const mimeType = normalizedVoiceMessageMimeType(input.mimeType)
  const filename = filenameFor(input.messageId, mimeType)
  const durationSeconds = Number(Math.min(
    MAX_USER_VOICE_MESSAGE_DURATION_SECONDS,
    Math.max(1, input.durationSeconds)
  ).toFixed(1))
  return {
    provider: 'user-recording',
    status: 'ready',
    audioUrl: `/api/voice/messages/${encodeURIComponent(input.messageId)}/audio?userId=${encodeURIComponent(input.userId)}`,
    durationSeconds,
    filename,
    mimeType: mimeType as UserVoiceMessageMetadata['mimeType'],
    transcriptStatus: 'none',
  }
}

export const parseUserVoiceMessageMetadata = (value: unknown): UserVoiceMessageMetadata | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const voice = value as Record<string, unknown>
  if (voice.provider !== 'user-recording' || voice.status !== 'ready') return undefined
  if (typeof voice.audioUrl !== 'string' || typeof voice.filename !== 'string') return undefined
  if (!/^[a-z0-9-]+\.(?:m4a|3gp|webm)$/i.test(voice.filename)) return undefined
  if (!isSupportedUserVoiceMessageType(typeof voice.mimeType === 'string' ? voice.mimeType : undefined)) return undefined
  if (typeof voice.durationSeconds !== 'number' || !Number.isFinite(voice.durationSeconds)) return undefined
  if (voice.transcriptStatus !== 'none' && voice.transcriptStatus !== 'ready') return undefined
  return {
    provider: 'user-recording',
    status: 'ready',
    audioUrl: voice.audioUrl,
    durationSeconds: voice.durationSeconds,
    filename: voice.filename,
    mimeType: voice.mimeType as UserVoiceMessageMetadata['mimeType'],
    transcriptStatus: voice.transcriptStatus,
  }
}

const mediaPath = (voice: UserVoiceMessageMetadata) => path.join(userVoiceMessageDirectory, voice.filename)

export const saveUserVoiceMessage = async (voice: UserVoiceMessageMetadata, audio: Buffer) => {
  if (audio.length === 0 || audio.length > MAX_USER_VOICE_MESSAGE_BYTES) {
    throw new Error('invalid voice message audio size')
  }
  await mkdir(userVoiceMessageDirectory, { recursive: true })
  const destination = mediaPath(voice)
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, audio)
  await rename(temporary, destination)
}

export const readUserVoiceMessage = (voice: UserVoiceMessageMetadata) => readFile(mediaPath(voice))

export const removeUserVoiceMessage = async (voice: UserVoiceMessageMetadata) => {
  await unlink(mediaPath(voice)).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  })
}
