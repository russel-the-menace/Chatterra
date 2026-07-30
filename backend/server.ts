import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { closeDatabase, query } from './database'
import {
  getBehaviorSnapshot,
  prepareInteraction,
  recordAssistantResponse,
  recordInferenceFailure,
  recordSkippedInference,
  resolveCharacterMode,
  resetBehaviorState
} from './behavior'
import {
  buildInferencePlan,
  diagnoseInferenceOutput
} from './inference-orchestrator'
import { generateModelResponse, ModelGatewayError } from './model-gateway'
import {
  assertSourceLessStarterQuote,
  canonicalizeMessageQuote,
  messageQuoteInputFromPayload,
  MessageQuoteInput,
  MessageQuoteValidationError
} from './message-quote'
import { resolveResponseLanguagePolicy, starterMessageForPolicy } from './language-policy'
import { createInferenceTrace } from './inference-logger'
import { processDueProactiveActions } from './proactive-service'
import { isExpoPushToken } from './push-notifications'
import { translateToEnglish, TranslationServiceError } from './translation-service'
import {
  GroqTranscriptionError,
  isSupportedTranscriptionAudioType,
  MAX_TRANSCRIPTION_AUDIO_BYTES,
  transcribeWithGroq,
} from './groq-transcription'
import { getVoiceCapability } from './voice-capability'
import { voiceTranscriptionContextForCharacter } from './voice-transcription-context'
import {
  isSupportedUserVoiceMessageType,
  MAX_USER_VOICE_MESSAGE_BYTES,
  MAX_USER_VOICE_MESSAGE_DURATION_SECONDS,
  parseUserVoiceMessageMetadata,
  readUserVoiceMessage,
  removeUserVoiceMessage,
  saveUserVoiceMessage,
  userVoiceMessageMetadata,
} from './user-voice-message'
import { parseCustomCharacterDocument } from './custom-character'
import {
  appendMessage,
  authenticateUser,
  clearUserVoiceMessageTranscript,
  clearChatHistory,
  createCharacter,
  deleteAuthenticatedSession,
  getAuthenticatedUser,
  getOrCreateConversationWithStarter,
  getCharacterForUser,
  getConversation,
  getMessageTranslation,
  getOwnedMessage,
  getSyncSnapshot,
  getUserPreferences,
  listCharacters,
  listConversations,
  listMessagePage,
  listPinnedCharacterIds,
  newId,
  setBuiltInCharacterAvatar,
  setCharacterPinned,
  setUserAvatar,
  setUserMemoryConsent,
  updateUserProfile,
  listRecentMessages,
  upsertExpoPushDevice,
  updateAssistantMessageVoice,
  updateUserVoiceMessageTranscript,
  upsertMessageTranslation,
  updateCharacter
} from './repository'
import {
  planMayaVoiceMessage,
  synthesizeMayaVoiceMessage,
  voiceMediaDirectory,
} from './assistant-voice'
import {
  Character,
  Conversation,
  Message,
  MessageQuote,
  VoiceTranscriptMetadata
} from './types'

dotenv.config()

const app = express()
const REJECTED_OUTPUT_LOG_LIMIT = 4000
const SYNC_PROTOCOL_VERSION = 1
const TRANSCRIPTION_RATE_LIMIT_WINDOW_MS = 60_000
const TRANSCRIPTION_RATE_LIMIT_MAX_REQUESTS = 6
const transcriptionRequests = new Map<string, number[]>()
const voiceMessageTranscriptionInFlight = new Map<string, Promise<Message>>()
app.use(cors())
app.use(express.json({ limit: '2mb' }))
app.use('/media/voice', express.static(voiceMediaDirectory, {
  immutable: true,
  maxAge: '30d',
}))

type AuthenticatedRequest = Request & {
  authenticatedUser?: {
    id: string
    username: string
    displayName: string
  }
}

const asyncRoute = (
  handler: (req: Request, res: Response, next: NextFunction) => Promise<any>
) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(handler(req, res, next)).catch(next)
}

const accessTokenFromRequest = (req: Request) => {
  const authorization = req.header('authorization') || ''
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match?.[1]?.trim() || ''
}

const authenticatedUserId = (req: Request) => {
  const user = (req as AuthenticatedRequest).authenticatedUser
  if (!user) throw new Error('authenticated user is required')
  return user.id
}

const canTranscribe = (key: string) => {
  const now = Date.now()
  const activeRequests = (transcriptionRequests.get(key) || []).filter(
    startedAt => now - startedAt < TRANSCRIPTION_RATE_LIMIT_WINDOW_MS
  )
  if (activeRequests.length >= TRANSCRIPTION_RATE_LIMIT_MAX_REQUESTS) return false
  activeRequests.push(now)
  transcriptionRequests.set(key, activeRequests)
  return true
}

const voiceRequestId = (req: Request) => {
  const value = typeof req.headers['x-chatterra-voice-request-id'] === 'string'
    ? req.headers['x-chatterra-voice-request-id'].trim()
    : ''
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96) || 'untracked'
}

const voiceRequestLogDetails = (req: Request, details: Record<string, unknown> = {}) => ({
  requestId: voiceRequestId(req),
  contentLength: req.headers['content-length'] || undefined,
  contentType: req.headers['content-type'] || undefined,
  receivedBytes: Buffer.isBuffer(req.body) ? req.body.length : 0,
  ...details,
})

const voiceMetadataFromPayload = (payload: any): VoiceTranscriptMetadata | undefined => {
  if (!payload || typeof payload.originalText !== 'string') return undefined
  const originalText = payload.originalText.trim().slice(0, 20000)
  if (!originalText) return undefined
  const correctedText = typeof payload.correctedText === 'string'
    ? payload.correctedText.trim().slice(0, 20000)
    : undefined
  const confidence = Number(payload.confidence)
  return {
    originalText,
    correctedText: correctedText || undefined,
    detectedLanguage: typeof payload.detectedLanguage === 'string'
      ? payload.detectedLanguage.trim().slice(0, 32) || undefined
      : undefined,
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : undefined,
    audioAvailable: payload.audioAvailable === true
  }
}

const getStarterMessage = (character?: Character) => {
  const languagePolicy = resolveResponseLanguagePolicy(character?.language)
  if (character?.id === 'seed-arjun-client') {
    return "Let us get straight to it. Which DJI model are you offering, what lawful route gets the complete units into India, and what is your landed unit price at the proposed volume? I will not accept 'we handle customs' as an answer."
  }
  if (character?.id === 'seed-minjun-friend') {
    return '안녕, 민지야. 오늘 수업 어땠어? 난 선형대수 과제에 아직도 붙잡혀 있어.'
  }
  if (character?.id === 'seed-ren-friend') {
    return 'やあ、結衣だよ。今日の授業どうだった？こっちは解析の課題にずっと捕まってた。'
  }
  if (character?.id === 'c3') {
    return "Hey, it's Maya. I just finished sorting out my notes for the day. Come keep me company for a minute?"
  }
  if (character?.id === 'seed-sofia-argentina-spanish') {
    return "Hi, I'm Sofía. We can start from zero and work toward B2, one small step at a time. First Spanish word: hola means hello. Want to try writing hola?"
  }
  if (character?.id === 'c2') {
    if (languagePolicy.code === 'english') {
      return "Hi, I'm Emma. I will help you practice English and point out useful mistakes when it helps, while keeping the conversation natural. Tell me about your current project."
    }
  }

  if (character?.runtimeConfig?.starterMessage) {
    return character.runtimeConfig.starterMessage
  }

  return starterMessageForPolicy(character?.name || 'Interviewer', languagePolicy)
}

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const username = typeof req.body?.username === 'string'
    ? req.body.username.trim().slice(0, 64)
    : ''
  const password = typeof req.body?.password === 'string'
    ? req.body.password.slice(0, 200)
    : ''
  if (!username || !password) return res.status(401).json({ error: 'Invalid username or password.' })

  const session = await authenticateUser(username, password)
  if (!session) return res.status(401).json({ error: 'Invalid username or password.' })
  return res.json(session)
}))

app.get('/api/health', asyncRoute(async (_req, res) => {
  await query('SELECT 1')
  return res.json({
    status: 'ok',
    database: 'postgresql',
    synchronization: {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      transport: 'snapshot-polling'
    }
  })
}))

app.use('/api', asyncRoute(async (req, res, next) => {
  if (req.method === 'OPTIONS') return next()
  const token = accessTokenFromRequest(req)
  const user = await getAuthenticatedUser(token)
  if (!user) return res.status(401).json({ error: 'Authentication is required.' })
  ;(req as AuthenticatedRequest).authenticatedUser = user
  next()
}))

app.use('/api/users/:id', (req, res, next) => {
  if (req.params.id !== authenticatedUserId(req)) {
    return res.status(403).json({ error: 'You can only access your own profile.' })
  }
  next()
})

app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  await deleteAuthenticatedSession(accessTokenFromRequest(req))
  return res.status(204).end()
}))

app.get('/api/characters', asyncRoute(async (req, res) => {
  const characters = await listCharacters(authenticatedUserId(req))
  return res.json({ characters })
}))

app.get('/api/sync', asyncRoute(async (req, res) => {
  const snapshot = await getSyncSnapshot(authenticatedUserId(req))
  return res.json(snapshot)
}))

app.get('/api/users/:id/preferences', asyncRoute(async (req, res) => {
  const preferences = await getUserPreferences(req.params.id)
  return res.json(preferences)
}))

app.put('/api/users/:id/preferences', asyncRoute(async (req, res) => {
  if (typeof req.body?.memoryEnabled !== 'boolean') {
    return res.status(400).json({ error: 'memoryEnabled must be a boolean' })
  }
  const memoryEnabled = await setUserMemoryConsent(req.params.id, req.body.memoryEnabled)
  return res.json({ memoryEnabled })
}))

app.put('/api/users/:id/avatar', asyncRoute(async (req, res) => {
  const avatar = typeof req.body?.avatar === 'string' ? req.body.avatar.trim().slice(0, 1_500_000) : ''
  if (!avatar) return res.status(400).json({ error: 'avatar is required' })
  const userAvatar = await setUserAvatar(req.params.id, avatar)
  return res.json({ userAvatar })
}))

app.put('/api/users/:id/profile', asyncRoute(async (req, res) => {
  const displayName = typeof req.body?.displayName === 'string'
    ? req.body.displayName.trim().slice(0, 120)
    : ''
  const avatar = typeof req.body?.avatar === 'string'
    ? req.body.avatar.trim().slice(0, 1_500_000)
    : undefined
  if (!displayName) return res.status(400).json({ error: 'displayName is required' })
  const profile = await updateUserProfile(req.params.id, { displayName, avatar })
  return res.json(profile)
}))

app.get('/api/users/:id/contact-preferences', asyncRoute(async (req, res) => {
  const pinnedCharacterIds = await listPinnedCharacterIds(req.params.id)
  return res.json({ pinnedCharacterIds })
}))

app.put('/api/users/:id/characters/:characterId/pin', asyncRoute(async (req, res) => {
  if (typeof req.body?.pinned !== 'boolean') {
    return res.status(400).json({ error: 'pinned must be a boolean' })
  }
  const pinned = await setCharacterPinned(req.params.id, req.params.characterId, req.body.pinned)
  if (pinned === undefined) return res.status(404).json({ error: 'character not found' })
  return res.json({ characterId: req.params.characterId, pinned })
}))

app.put('/api/users/:id/characters/:characterId/avatar', asyncRoute(async (req, res) => {
  const avatar = typeof req.body?.avatar === 'string' ? req.body.avatar.trim().slice(0, 1_500_000) : ''
  if (!avatar) return res.status(400).json({ error: 'avatar is required' })
  const character = await setBuiltInCharacterAvatar(req.params.id, req.params.characterId, avatar)
  if (!character) return res.status(404).json({ error: 'built-in character not found' })
  return res.json({ character })
}))

app.post('/api/characters', asyncRoute(async (req, res) => {
  const userId = authenticatedUserId(req)
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : ''
  const document = typeof req.body?.systemPromptTemplate === 'string' ? req.body.systemPromptTemplate : ''
  if (!name) return res.status(400).json({ error: 'name is required' })

  let parsed
  try {
    parsed = parseCustomCharacterDocument(document)
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid character document' })
  }
  const now = new Date().toISOString()
  const character: Character = {
    id: newId(),
    name,
    avatar: typeof req.body?.avatar === 'string' ? req.body.avatar.slice(0, 1_500_000) : undefined,
    role: parsed.runtimeConfig.mode === 'practice' ? 'Custom practice character' : 'Custom companion',
    personality: 'User-authored custom character',
    language: parsed.languageSetting,
    systemPromptTemplate: document,
    runtimeConfig: parsed.runtimeConfig,
    createdAt: now,
    updatedAt: now,
  }
  const created = await createCharacter(userId, character)
  return res.status(201).json({ character: created })
}))

app.put('/api/characters/:id', asyncRoute(async (req, res) => {
  const userId = authenticatedUserId(req)
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : ''
  const document = typeof req.body?.systemPromptTemplate === 'string' ? req.body.systemPromptTemplate : ''
  if (!name) return res.status(400).json({ error: 'name is required' })
  const existing = await getCharacterForUser(userId, req.params.id)
  if (!existing) return res.status(404).json({ error: 'character not found' })
  if (!existing.ownerUserId) return res.status(403).json({ error: 'built-in characters are source-managed' })

  let parsed
  try {
    parsed = parseCustomCharacterDocument(document)
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid character document' })
  }
  const updated = await updateCharacter(userId, {
    ...existing,
    name,
    avatar: typeof req.body?.avatar === 'string' ? req.body.avatar.slice(0, 1_500_000) : undefined,
    role: parsed.runtimeConfig.mode === 'practice' ? 'Custom practice character' : 'Custom companion',
    personality: 'User-authored custom character',
    language: parsed.languageSetting,
    systemPromptTemplate: document,
    runtimeConfig: parsed.runtimeConfig,
    updatedAt: new Date().toISOString(),
  })
  return res.json({ character: updated })
}))

app.get('/api/conversations', asyncRoute(async (req, res) => {
  const conversations = await listConversations(authenticatedUserId(req))
  return res.json({ conversations })
}))

app.get('/api/conversations/:id/messages', asyncRoute(async (req, res) => {
  const conversation = await getConversation(req.params.id)
  if (!conversation || conversation.userId !== authenticatedUserId(req)) {
    return res.status(404).json({ error: 'conversation not found' })
  }
  const requestedLimit = req.query.limit === undefined ? 50 : Number(req.query.limit)
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    return res.status(400).json({ error: 'limit must be a positive integer' })
  }

  const beforeCreatedAt = typeof req.query.beforeCreatedAt === 'string'
    ? req.query.beforeCreatedAt
    : undefined
  const beforeId = typeof req.query.beforeId === 'string' ? req.query.beforeId : undefined
  if (Boolean(beforeCreatedAt) !== Boolean(beforeId)) {
    return res.status(400).json({ error: 'beforeCreatedAt and beforeId must be provided together' })
  }
  if (beforeCreatedAt && Number.isNaN(Date.parse(beforeCreatedAt))) {
    return res.status(400).json({ error: 'beforeCreatedAt must be an ISO date' })
  }

  const page = await listMessagePage(req.params.id, {
    limit: Math.min(requestedLimit, 100),
    before: beforeCreatedAt && beforeId ? { createdAt: beforeCreatedAt, id: beforeId } : undefined
  })
  return res.json(page)
}))

app.get('/api/messages/:id/delivery-status', asyncRoute(async (req, res) => {
  const userId = authenticatedUserId(req)
  const message = await getOwnedMessage(userId, req.params.id)
  const persisted = Boolean(
    message
    && message.senderRole === 'user'
    && message.senderId === userId
  )
  return res.json({
    persisted,
    ...(persisted && message
      ? { userMessageId: message.id, conversationId: message.conversationId }
      : {})
  })
}))

app.post('/api/translations', asyncRoute(async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : ''
  const targetLanguage = typeof req.body?.targetLanguage === 'string'
    ? req.body.targetLanguage.trim().toLowerCase()
    : ''
  if (!text) return res.status(400).json({ error: 'text is required' })
  if (targetLanguage !== 'en') {
    return res.status(400).json({ error: 'only English translation is currently supported' })
  }

  const generated = await translateToEnglish(text)
  return res.status(201).json({
    translation: {
      targetLanguage,
      text: generated.text,
      cached: false
    }
  })
}))

app.get('/api/voice/capability', asyncRoute(async (_req, res) => {
  res.set('Cache-Control', 'no-store')
  return res.json({ capability: await getVoiceCapability() })
}))

app.post(
  '/api/voice/messages',
  express.raw({
    type: request => isSupportedUserVoiceMessageType(request.headers['content-type']),
    limit: MAX_USER_VOICE_MESSAGE_BYTES,
  }),
  asyncRoute(async (req, res) => {
    const userId = authenticatedUserId(req)
    const characterId = typeof req.headers['x-chatterra-character-id'] === 'string'
      ? req.headers['x-chatterra-character-id'].trim()
      : ''
    const requestedConversationId = typeof req.headers['x-chatterra-conversation-id'] === 'string'
      ? req.headers['x-chatterra-conversation-id'].trim()
      : ''
    const mimeType = req.headers['content-type'] || ''
    const durationMilliseconds = Number(req.headers['x-chatterra-voice-duration-ms'])
    const logDetails = voiceRequestLogDetails(req, {
      durationMilliseconds: Number.isFinite(durationMilliseconds)
        ? Math.round(durationMilliseconds)
        : undefined,
      hasCharacterId: Boolean(characterId),
      hasConversationId: Boolean(requestedConversationId),
      hasUserId: Boolean(userId),
    })
    console.info('Voice message upload received', logDetails)
    if (!characterId) {
      console.warn('Voice message upload rejected', { ...logDetails, reason: 'missing_identity' })
      return res.status(400).json({ error: 'user ID and character ID are required' })
    }
    if (!isSupportedUserVoiceMessageType(mimeType)) {
      console.warn('Voice message upload rejected', { ...logDetails, reason: 'unsupported_format' })
      return res.status(415).json({ error: 'unsupported voice message format' })
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      console.warn('Voice message upload rejected', { ...logDetails, reason: 'missing_audio' })
      return res.status(400).json({ error: 'voice message audio is required' })
    }
    if (!Number.isFinite(durationMilliseconds) || durationMilliseconds < 250) {
      console.warn('Voice message upload rejected', { ...logDetails, reason: 'invalid_duration' })
      return res.status(400).json({ error: 'voice message is too short' })
    }

    const character = await getCharacterForUser(userId, characterId)
    if (!character) return res.status(404).json({ error: 'character not found' })

    let conversation: Conversation
    let starterMessage: Message | undefined
    if (requestedConversationId) {
      const existingConversation = await getConversation(requestedConversationId)
      if (
        !existingConversation
        || existingConversation.userId !== userId
        || existingConversation.characterId !== character.id
      ) {
        return res.status(404).json({ error: 'conversation not found' })
      }
      conversation = existingConversation
    } else {
      const now = new Date().toISOString()
      const conversationId = newId()
      const created = await getOrCreateConversationWithStarter(
        {
          id: conversationId,
          userId,
          characterId: character.id,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: newId(),
          conversationId,
          senderRole: 'assistant',
          senderId: character.id,
          content: getStarterMessage(character),
          createdAt: now,
        }
      )
      conversation = created.conversation
      starterMessage = created.starterMessage
    }

    const messageId = newId()
    const voice = userVoiceMessageMetadata({
      messageId,
      userId,
      mimeType,
      durationSeconds: Math.min(
        MAX_USER_VOICE_MESSAGE_DURATION_SECONDS,
        durationMilliseconds / 1_000
      ),
    })
    await saveUserVoiceMessage(voice, req.body)
    try {
      const message = await appendMessage({
        id: messageId,
        conversationId: conversation.id,
        senderRole: 'user',
        senderId: userId,
        content: '',
        contentJson: { voice },
        createdAt: new Date().toISOString(),
      })
      let reply: Record<string, any> | undefined
      if (canTranscribe(`${req.ip}:${userId}`)) {
        try {
          const transcriptionContext = voiceTranscriptionContextForCharacter(character)
          console.info('Voice message reply transcription context selected', {
            ...logDetails,
            context: transcriptionContext?.id || 'generic',
          })
          const transcription = await transcribeWithGroq({
            audio: req.body,
            mimeType,
            prompt: transcriptionContext?.prompt,
          })
          const transcribedMessage = await updateUserVoiceMessageTranscript(
            message.id,
            transcription.text
          )
          if (!transcribedMessage) throw new Error('voice message not found')
          console.info('Voice message transcript persisted for reply', {
            messageId: message.id,
            transcriptLength: transcription.text.length,
          })
          const response = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/chat`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: req.header('authorization') || '',
            },
            body: JSON.stringify({
              character: { id: character.id },
              conversationId: conversation.id,
              message: transcription.text,
              userId,
              voiceMessageId: transcribedMessage.id,
              voiceMessageReply: true,
            }),
            signal: AbortSignal.timeout(90_000),
          })
          reply = await response.json().catch(() => ({})) as Record<string, any>
          if (!response.ok) {
            throw new Error(typeof reply.error === 'string' ? reply.error : 'voice reply request failed')
          }
        } catch (error) {
          console.error('Voice message reply generation failed', {
            ...logDetails,
            error: error instanceof Error ? error.name : 'unknown_error',
          })
        }
      } else {
        console.warn('Voice message reply transcription skipped', { ...logDetails, reason: 'rate_limited' })
      }
      const storedMessage = await getOwnedMessage(userId, message.id) || message
      return res.status(201).json({
        conversation,
        message: storedMessage,
        starterMessage,
        ...(reply ? {
          behavior: reply.behavior,
          messageId: reply.messageId,
          reply: reply.reply,
          replySegments: reply.replySegments,
          voice: reply.voice,
        } : {}),
      })
    } catch (error) {
      console.error('Voice message upload failed', {
        ...logDetails,
        error: error instanceof Error ? error.name : 'unknown_error',
      })
      await removeUserVoiceMessage(voice).catch(() => undefined)
      throw error
    }
  })
)

app.get('/api/voice/messages/:id/audio', asyncRoute(async (req, res) => {
  const userId = authenticatedUserId(req)
  const message = await getOwnedMessage(userId, req.params.id)
  const voice = parseUserVoiceMessageMetadata(message?.contentJson?.voice)
  if (!message || message.senderRole !== 'user' || !voice) {
    return res.status(404).json({ error: 'voice message not found' })
  }
  try {
    let audio: Buffer
    try {
      audio = await readUserVoiceMessage(voice)
    } catch {
      throw new GroqTranscriptionError('voice message audio not found', 404)
    }
    res.set('Cache-Control', 'private, max-age=3600')
    res.type(voice.mimeType)
    return res.send(audio)
  } catch {
    return res.status(404).json({ error: 'voice message audio not found' })
  }
}))

app.post('/api/voice/messages/:id/transcription', asyncRoute(async (req, res) => {
  const userId = authenticatedUserId(req)
  const message = await getOwnedMessage(userId, req.params.id)
  const voice = parseUserVoiceMessageMetadata(message?.contentJson?.voice)
  if (!message || message.senderRole !== 'user' || !voice) {
    return res.status(404).json({ error: 'voice message not found' })
  }
  if (voice.transcriptStatus === 'ready' && message.content.trim()) {
    return res.json({ message })
  }
  if (message.content.trim()) {
    const updated = await updateUserVoiceMessageTranscript(message.id, message.content)
    if (!updated) return res.status(404).json({ error: 'voice message not found' })
    return res.json({ message: updated })
  }
  const inFlight = voiceMessageTranscriptionInFlight.get(message.id)
  if (inFlight) {
    console.info('Voice message transcription joined existing request', { messageId: message.id })
    return res.json({ message: await inFlight })
  }

  const transcriptionPromise = (async () => {
    const rateLimitKey = `${req.ip}:${userId}`
    if (!canTranscribe(rateLimitKey)) {
      throw new GroqTranscriptionError('voice transcription rate limit reached; try again shortly', 429)
    }
    const audio = await readUserVoiceMessage(voice)
    const conversation = await getConversation(message.conversationId)
    const character = conversation?.userId === userId
      ? await getCharacterForUser(userId, conversation.characterId)
      : undefined
    const transcriptionContext = voiceTranscriptionContextForCharacter(character)
    console.info('Voice message transcription context selected', {
      messageId: message.id,
      context: transcriptionContext?.id || 'generic',
    })
    const transcription = await transcribeWithGroq({
      audio,
      mimeType: voice.mimeType,
      prompt: transcriptionContext?.prompt,
    })
    const updated = await updateUserVoiceMessageTranscript(message.id, transcription.text)
    if (!updated) throw new GroqTranscriptionError('voice message not found', 404)
    return updated
  })()
  voiceMessageTranscriptionInFlight.set(message.id, transcriptionPromise)
  try {
    return res.json({ message: await transcriptionPromise })
  } finally {
    if (voiceMessageTranscriptionInFlight.get(message.id) === transcriptionPromise) {
      voiceMessageTranscriptionInFlight.delete(message.id)
    }
  }
}))

app.delete('/api/voice/messages/:id/transcription', asyncRoute(async (req, res) => {
  const userId = authenticatedUserId(req)
  const message = await getOwnedMessage(userId, req.params.id)
  const voice = parseUserVoiceMessageMetadata(message?.contentJson?.voice)
  if (!message || message.senderRole !== 'user' || !voice) {
    return res.status(404).json({ error: 'voice message not found' })
  }
  const updated = await clearUserVoiceMessageTranscript(message.id)
  if (!updated) return res.status(404).json({ error: 'voice message not found' })
  return res.json({ message: updated })
}))

app.post(
  '/api/voice/transcriptions',
  express.raw({
    type: request => isSupportedTranscriptionAudioType(request.headers['content-type']),
    limit: MAX_TRANSCRIPTION_AUDIO_BYTES,
  }),
  asyncRoute(async (req, res) => {
    const userId = authenticatedUserId(req)
    const characterId = typeof req.headers['x-chatterra-character-id'] === 'string'
      ? req.headers['x-chatterra-character-id'].trim()
      : ''
    const mimeType = req.headers['content-type'] || ''
    const logDetails = voiceRequestLogDetails(req, { hasUserId: Boolean(userId) })
    console.info('Voice transcription received', logDetails)
    if (!isSupportedTranscriptionAudioType(mimeType)) {
      console.warn('Voice transcription rejected', { ...logDetails, reason: 'unsupported_format' })
      return res.status(415).json({ error: 'unsupported audio format' })
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      console.warn('Voice transcription rejected', { ...logDetails, reason: 'missing_audio' })
      return res.status(400).json({ error: 'audio is required' })
    }
    const rateLimitKey = `${req.ip}:${userId}`
    if (!canTranscribe(rateLimitKey)) {
      console.warn('Voice transcription rejected', { ...logDetails, reason: 'rate_limited' })
      return res.status(429).json({ error: 'voice transcription rate limit reached; try again shortly' })
    }

    const character = characterId ? await getCharacterForUser(userId, characterId) : undefined
    const transcriptionContext = voiceTranscriptionContextForCharacter(character)
    console.info('Voice transcription context selected', {
      ...logDetails,
      context: transcriptionContext?.id || 'generic',
      hasKnownCharacter: Boolean(character),
    })

    try {
      const transcription = await transcribeWithGroq({
        audio: req.body,
        mimeType,
        prompt: transcriptionContext?.prompt,
      })
      console.info('Voice transcription succeeded', {
        ...logDetails,
        provider: transcription.provider,
        model: transcription.model,
        transcriptLength: transcription.text.length,
      })
      return res.status(201).json({
        transcription: {
          text: transcription.text,
          provider: transcription.provider,
          model: transcription.model,
        },
      })
    } catch (error) {
      console.error('Voice transcription failed', {
        ...logDetails,
        error: error instanceof Error ? error.name : 'unknown_error',
      })
      throw error
    }
  })
)

app.post('/api/messages/:id/translations', asyncRoute(async (req, res) => {
  const userId = authenticatedUserId(req)
  const targetLanguage = typeof req.body?.targetLanguage === 'string'
    ? req.body.targetLanguage.trim().toLowerCase()
    : ''
  const segmentIndex = Number(req.body?.segmentIndex ?? 0)
  if (targetLanguage !== 'en') {
    return res.status(400).json({ error: 'only English translation is currently supported' })
  }
  if (!Number.isInteger(segmentIndex) || segmentIndex < 0) {
    return res.status(400).json({ error: 'segmentIndex must be a non-negative integer' })
  }

  const message = await getOwnedMessage(userId, req.params.id)
  if (!message) return res.status(404).json({ error: 'message not found' })
  const segments = Array.isArray(message.contentJson?.deliverySegments)
    ? message.contentJson.deliverySegments.filter((value: unknown): value is string => typeof value === 'string')
    : [message.content]
  const sourceText = segments[segmentIndex]
  if (typeof sourceText !== 'string' || !sourceText.trim()) {
    return res.status(400).json({ error: 'message segment does not exist' })
  }

  const cachedTranslation = await getMessageTranslation(message.id, segmentIndex, targetLanguage)
  if (cachedTranslation) {
    return res.json({
      translation: {
        messageId: message.id,
        segmentIndex,
        targetLanguage,
        text: cachedTranslation.translatedText,
        cached: true
      }
    })
  }

  const generated = await translateToEnglish(sourceText)
  const now = new Date().toISOString()
  const translation = await upsertMessageTranslation({
    id: newId(),
    messageId: message.id,
    segmentIndex,
    targetLanguage,
    translatedText: generated.text,
    provider: generated.provider,
    model: generated.model,
    createdAt: now,
    updatedAt: now
  })
  return res.status(201).json({
    translation: {
      messageId: message.id,
      segmentIndex,
      targetLanguage,
      text: translation.translatedText,
      cached: false
    }
  })
}))

app.get('/api/characters/:id/state', asyncRoute(async (req, res) => {
  const userId = authenticatedUserId(req)

  const character = await getCharacterForUser(userId, req.params.id)
  if (!character) return res.status(404).json({ error: 'character not found' })

  const mode = resolveCharacterMode(character)
  const snapshot = await getBehaviorSnapshot(userId, character, mode)
  const familiarity = snapshot.relationship.familiarity
  const relationshipStage = familiarity < 0.15
    ? 'new'
    : familiarity < 0.45
      ? 'familiar'
      : familiarity < 0.75
        ? 'close'
        : 'established'
  const publicState = {
    instanceId: snapshot.instance.id,
    currentActivity: snapshot.simulation.currentActivity,
    emotion: snapshot.emotionLabel,
    relationshipStage,
    asOf: snapshot.affect.asOf
  }
  if (process.env.BEHAVIOR_DEBUG === 'true') {
    return res.json({ state: publicState, debug: snapshot })
  }
  return res.json({ state: publicState })
}))

app.post('/api/proactive/poll', asyncRoute(async (req, res) => {
  const userId = authenticatedUserId(req)
  const deliveries = await processDueProactiveActions({ userId, limit: 2 })
  return res.json({ deliveries })
}))

app.put('/api/push-devices/expo', asyncRoute(async (req, res) => {
  const userId = authenticatedUserId(req)
  const expoPushToken = typeof req.body?.expoPushToken === 'string'
    ? req.body.expoPushToken.trim()
    : ''
  const platform = req.body?.platform
  if (!isExpoPushToken(expoPushToken)) {
    return res.status(400).json({ error: 'expoPushToken is invalid' })
  }
  if (platform !== 'ios' && platform !== 'android') {
    return res.status(400).json({ error: 'platform must be ios or android' })
  }

  await upsertExpoPushDevice({ userId, expoPushToken, platform })
  return res.status(204).end()
}))

app.delete('/api/chat-history', asyncRoute(async (req, res) => {
  const { characterId } = req.body || {}
  const userId = authenticatedUserId(req)
  if (!characterId) return res.status(400).json({ error: 'characterId is required' })

  const result = await clearChatHistory(String(userId), String(characterId))
  await resetBehaviorState(String(userId), String(characterId))
  return res.json({ ok: true, characterId, ...result })
}))

app.post('/api/chat', asyncRoute(async (req, res) => {
  const { message, conversationId, character } = req.body || {}
  const userId = authenticatedUserId(req)
  if (!message) return res.status(400).json({ error: 'message is required' })
  if (!character?.id) return res.status(400).json({ error: 'character is required' })

  const normalizedUserId = String(userId)
  const normalizedMessage = String(message)
  const clientMessageId = typeof req.body?.clientMessageId === 'string'
    ? req.body.clientMessageId.trim()
    : ''
  const voiceMessageId = typeof req.body?.voiceMessageId === 'string'
    ? req.body.voiceMessageId.trim()
    : ''
  const voiceMessageReply = req.body?.voiceMessageReply === true
  if (
    clientMessageId
    && !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(clientMessageId)
  ) {
    return res.status(400).json({ error: 'clientMessageId is invalid' })
  }
  if (voiceMessageId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(voiceMessageId)) {
    return res.status(400).json({ error: 'voiceMessageId is invalid' })
  }
  if (voiceMessageId && clientMessageId && voiceMessageId !== clientMessageId) {
    return res.status(400).json({ error: 'voiceMessageId must match clientMessageId' })
  }
  if (voiceMessageReply && !voiceMessageId) {
    return res.status(400).json({ error: 'voiceMessageReply requires voiceMessageId' })
  }
  const voiceMetadata = voiceMetadataFromPayload(req.body?.voice)
  let quoteInput: MessageQuoteInput | undefined
  try {
    quoteInput = messageQuoteInputFromPayload(req.body?.quote)
  } catch (error) {
    if (error instanceof MessageQuoteValidationError) {
      return res.status(400).json({ error: error.message })
    }
    throw error
  }
  const requestId = newId()
  const trace = createInferenceTrace(requestId)
  trace.mark('request_received', 'started', {
    userId: normalizedUserId,
    characterId: String(character.id),
    conversationId: conversationId ? String(conversationId) : null,
    messageLength: normalizedMessage.length,
    hasVoiceMetadata: Boolean(voiceMetadata),
    hasQuote: Boolean(quoteInput)
  })

  const storedCharacter = await getCharacterForUser(normalizedUserId, String(character.id))
  if (!storedCharacter) return res.status(400).json({ error: 'character not found' })
  const existingVoiceMessage = voiceMessageId
    ? await getOwnedMessage(normalizedUserId, voiceMessageId)
    : undefined
  const existingVoice = parseUserVoiceMessageMetadata(existingVoiceMessage?.contentJson?.voice)
  if (voiceMessageId && (
    !existingVoiceMessage
    || existingVoiceMessage.senderRole !== 'user'
    || !existingVoice
  )) {
    return res.status(404).json({ error: 'voice message not found' })
  }
  if (existingVoiceMessage?.content.trim() && !voiceMessageReply) {
    return res.json({
      reply: null,
      userMessageId: existingVoiceMessage.id,
      conversationId: existingVoiceMessage.conversationId,
      behavior: {
        decision: 'already_persisted',
        responseStatus: 'already_persisted'
      },
      traceId: newId(),
    })
  }
  if (clientMessageId && !voiceMessageId) {
    const existingClientMessage = await getOwnedMessage(normalizedUserId, clientMessageId)
    if (existingClientMessage) {
      const existingConversation = await getConversation(existingClientMessage.conversationId)
      const matchesOriginalRequest = existingClientMessage.senderRole === 'user'
        && existingClientMessage.senderId === normalizedUserId
        && existingClientMessage.content === normalizedMessage
        && existingConversation?.characterId === storedCharacter.id
      if (!matchesOriginalRequest) {
        return res.status(409).json({ error: 'clientMessageId is already in use' })
      }
      trace.mark('request_completed', 'completed', {
        decision: 'already_persisted',
        userMessageId: existingClientMessage.id
      })
      return res.json({
        reply: null,
        userMessageId: existingClientMessage.id,
        conversationId: existingClientMessage.conversationId,
        behavior: {
          decision: 'already_persisted',
          responseStatus: 'already_persisted'
        },
        traceId: trace.traceId
      })
    }
  }
  const mode = resolveCharacterMode(storedCharacter)
  trace.mark('character_loaded', 'completed', {
    characterId: storedCharacter.id,
    language: storedCharacter.language || null,
    mode
  })

  let conversation = existingVoiceMessage
    ? await getConversation(existingVoiceMessage.conversationId)
    : conversationId
      ? await getConversation(String(conversationId))
      : undefined

  if (
    existingVoiceMessage
    && conversationId
    && existingVoiceMessage.conversationId !== String(conversationId)
  ) {
    return res.status(400).json({ error: 'voice message conversation mismatch' })
  }

  if (conversation && conversation.userId !== normalizedUserId) {
    return res.status(403).json({ error: 'conversation does not belong to this user' })
  }
  if (conversation && conversation.characterId !== storedCharacter.id) {
    return res.status(400).json({ error: 'conversation character mismatch' })
  }

  let quoteSourceMessage: Message | undefined
  if (quoteInput?.sourceMessageId) {
    quoteSourceMessage = await getOwnedMessage(normalizedUserId, quoteInput.sourceMessageId)
    const requestedConversationId = conversationId ? String(conversationId) : undefined
    if (
      !quoteSourceMessage
      || !requestedConversationId
      || quoteSourceMessage.conversationId !== requestedConversationId
    ) {
      return res.status(400).json({ error: 'quoted message was not found in this conversation' })
    }
  }

  if (quoteInput && !quoteInput.sourceMessageId && conversation) {
    return res.status(400).json({ error: 'source-less quote is only valid for a new conversation starter' })
  }

  if (!conversation) {
    const now = new Date().toISOString()
    const nextConversation: Conversation = {
      id: conversationId || newId(),
      userId: normalizedUserId,
      characterId: storedCharacter.id,
      title: `${storedCharacter.name} chat`,
      status: 'active',
      createdAt: now,
      updatedAt: now
    }
    const starterMessage: Message = {
      id: newId(),
      conversationId: nextConversation.id,
      senderRole: 'assistant',
      senderId: storedCharacter.id,
      content: getStarterMessage(storedCharacter),
      createdAt: now
    }
    if (quoteInput && !quoteInput.sourceMessageId) {
      try {
        assertSourceLessStarterQuote(quoteInput, starterMessage)
      } catch (error) {
        if (error instanceof MessageQuoteValidationError) {
          return res.status(400).json({ error: error.message })
        }
        throw error
      }
    }
    const resolution = await getOrCreateConversationWithStarter(nextConversation, starterMessage)
    conversation = resolution.conversation
    if (quoteInput && !quoteInput.sourceMessageId) {
      if (!resolution.created || !resolution.starterMessage) {
        return res.status(400).json({ error: 'source-less quote is only valid for a new conversation starter' })
      }
      quoteSourceMessage = resolution.starterMessage
    }
    trace.mark('conversation_resolved', 'completed', { conversationId: conversation.id })
  }

  let quote: MessageQuote | undefined
  if (quoteInput) {
    if (!quoteSourceMessage) {
      return res.status(400).json({ error: 'quoted message source could not be resolved' })
    }
    try {
      quote = canonicalizeMessageQuote({
        input: quoteInput,
        sourceMessage: quoteSourceMessage,
        labels: {
          assistant: storedCharacter.name,
          user: 'You'
        }
      })
    } catch (error) {
      if (error instanceof MessageQuoteValidationError) {
        return res.status(400).json({ error: error.message })
      }
      throw error
    }
  }

  const userContentJson = existingVoiceMessage?.contentJson
    ? {
        ...existingVoiceMessage.contentJson,
        ...(existingVoice
          ? { voice: { ...existingVoice, transcriptStatus: 'ready' } }
          : {}),
      }
    : (voiceMetadata || quote
      ? {
          ...(voiceMetadata ? { voice: voiceMetadata } : {}),
          ...(quote ? { quote } : {})
        }
      : undefined)

  const userMessage: Message = {
    id: existingVoiceMessage?.id || clientMessageId || newId(),
    conversationId: conversation.id,
    senderRole: 'user',
    senderId: normalizedUserId,
    content: normalizedMessage,
    contentJson: userContentJson,
    createdAt: existingVoiceMessage?.createdAt || new Date().toISOString()
  }

  const preparation = await prepareInteraction({
    userId: normalizedUserId,
    character: storedCharacter,
    conversationId: conversation.id,
    messageId: userMessage.id,
    message: normalizedMessage,
    contentJson: userContentJson,
    messageAlreadyPersisted: Boolean(existingVoiceMessage),
    mode,
    now: new Date(userMessage.createdAt)
  })
  res.locals.persistedUserMessage = {
    userMessageId: userMessage.id,
    conversationId: conversation.id
  }
  trace.mark('interaction_prepared', 'completed', {
    mode: preparation.mode,
    memoryEnabled: preparation.memoryEnabled,
    decisionId: preparation.decisionId,
    decision: preparation.decision.action,
    reasonCodes: preparation.decision.reasonCodes,
    scoreDetails: preparation.decision.scoreDetails
  })
  const inference = await buildInferencePlan({
    userId: normalizedUserId,
    character: storedCharacter,
    conversationId: conversation.id,
    currentMessageId: userMessage.id,
    message: normalizedMessage,
    mode,
    snapshot: preparation.snapshot,
    memoryEnabled: preparation.memoryEnabled,
    decision: preparation.decision,
    quote
  })
  trace.mark('inference_plan_built', 'completed', {
    inferenceId: inference.id,
    route: inference.route,
    provider: inference.model?.provider || null,
    model: inference.model?.model || null,
    responseLanguage: inference.responseLanguage.code,
    estimatedContextTokens: inference.contextManifest.estimatedTokens,
    selectedMessages: inference.contextManifest.messages.length,
    selectedMemories: inference.contextManifest.memories.length,
    selectedEvents: inference.contextManifest.events.length
  })

  if (inference.route === 'none') {
    trace.mark('inference_skipped', 'skipped', {
      decision: preparation.decision.action,
      reasonCodes: inference.reasonCodes
    })
    try {
      await recordSkippedInference({
        userId: normalizedUserId,
        character: storedCharacter,
        conversationId: conversation.id,
        decisionId: preparation.decisionId,
        triggerEventId: preparation.triggerEventId,
        mode,
        inference,
        diagnostics: trace.snapshot(),
        now: new Date()
      })
      trace.mark('request_completed', 'completed', { decision: 'no_reply' })
    } catch (error) {
      trace.mark('request_failed', 'failed', {
        stage: 'skip_persistence',
        error: error instanceof Error ? error.name : 'unknown_error'
      })
      throw error
    }
    return res.json({
      reply: null,
      userMessageId: userMessage.id,
      conversationId: conversation.id,
      behavior: {
        emotion: preparation.snapshot.emotionLabel,
        activity: preparation.snapshot.simulation.currentActivity,
        decision: preparation.decision.action
      },
      traceId: trace.traceId
    })
  }

  let rawReply = inference.directResponse || ''
  let generation: {
    provider?: string
    model?: string
    profile?: string
    parameters?: Record<string, any>
    contextManifest?: Record<string, any>
    diagnostics?: Record<string, any>
    latencyMs?: number
  } | undefined
  const inferenceStartedAt = Date.now()
  try {
    if (inference.route === 'model') {
      const result = await generateModelResponse(inference, storedCharacter, trace)
      rawReply = result.content
      generation = {
        provider: result.provider,
        model: result.model,
        profile: inference.model?.profile,
        parameters: {
          ...inference.parameters,
          maxResponseTokens: result.diagnostics.maxResponseTokens
        },
        contextManifest: inference.contextManifest,
        diagnostics: result.diagnostics,
        latencyMs: result.latencyMs
      }
    } else {
      trace.mark('provider_request', 'skipped', { route: inference.route })
    }
  } catch (error) {
    trace.mark('request_failed', 'failed', {
      stage: 'provider_request',
      error: error instanceof ModelGatewayError ? error.message : error instanceof Error ? error.name : 'unknown_error'
    })
    try {
      await recordInferenceFailure({
        userId: normalizedUserId,
        character: storedCharacter,
        conversationId: conversation.id,
        decisionId: preparation.decisionId,
        triggerEventId: preparation.triggerEventId,
        mode,
        inference,
        diagnostics: trace.snapshot(),
        latencyMs: Date.now() - inferenceStartedAt
      })
    } catch (auditError) {
      console.error('Could not record failed inference', auditError)
    }
    if (error instanceof ModelGatewayError) {
      return res.status(error.statusCode).json({
        error: error.message,
        messagePersisted: true,
        userMessageId: userMessage.id,
        conversationId: conversation.id
      })
    }
    throw error
  }

  const outputDiagnostics = diagnoseInferenceOutput(inference, rawReply)
  const {
    reply: processedReply,
    deliverySegments,
    ...traceOutputDiagnostics
  } = outputDiagnostics
  if (!outputDiagnostics.languageCompliant && processedReply) {
    trace.mark('language_policy_observed', 'completed', outputDiagnostics.languageObservation)
  }
  trace.mark('output_processed', 'completed', traceOutputDiagnostics)
  if (!outputDiagnostics.accepted || !processedReply) {
    const rejectionReason = outputDiagnostics.rejectionReason || 'output_rejected'
    trace.mark('response_not_generated', 'failed', { reason: rejectionReason })
    try {
      await recordInferenceFailure({
        userId: normalizedUserId,
        character: storedCharacter,
        conversationId: conversation.id,
        decisionId: preparation.decisionId,
        triggerEventId: preparation.triggerEventId,
        mode,
        inference,
        diagnostics: {
          ...trace.snapshot(),
          rejectedOutput: {
            content: rawReply.slice(0, REJECTED_OUTPUT_LOG_LIMIT),
            originalLength: rawReply.length,
            truncated: rawReply.length > REJECTED_OUTPUT_LOG_LIMIT,
            languageReason: outputDiagnostics.languageReason,
            rejectionReason
          }
        },
        latencyMs: generation?.latencyMs ?? Date.now() - inferenceStartedAt,
        failureReason: rejectionReason
      })
      trace.mark('request_completed', 'completed', {
        responseStatus: 'inference_failed',
        reason: rejectionReason
      })
    } catch (error) {
      trace.mark('request_failed', 'failed', {
        stage: 'rejection_persistence',
        error: error instanceof Error ? error.name : 'unknown_error'
      })
      throw error
    }
    return res.json({
      reply: null,
      userMessageId: userMessage.id,
      conversationId: conversation.id,
      behavior: {
        emotion: preparation.snapshot.emotionLabel,
        activity: preparation.snapshot.simulation.currentActivity,
        decision: preparation.decision.action,
        responseStatus: 'inference_failed'
      },
      traceId: trace.traceId
    })
  }
  const reply = processedReply
  const replySegments = deliverySegments.length > 0 ? deliverySegments : [reply]
  const assistantMessageId = newId()
  const recentMessages = await listRecentMessages(conversation.id, 8)
  const voice = planMayaVoiceMessage({
    characterId: storedCharacter.id,
    messageId: assistantMessageId,
    replySegments,
    recentMessages,
    userMessage: String(message),
  })
  const assistantMessage: Message = {
    id: assistantMessageId,
    conversationId: conversation.id,
    senderRole: 'assistant',
    senderId: storedCharacter.id,
    content: reply,
    contentJson: {
      deliverySegments: replySegments,
      ...(voice ? { voice } : {}),
    },
    createdAt: new Date().toISOString()
  }
  trace.mark('response_ready_for_persistence', 'completed', {
    messageId: assistantMessage.id,
    replyLength: reply.length,
    deliverySegmentCount: replySegments.length
  })
  try {
    await recordAssistantResponse({
      userId: normalizedUserId,
      character: storedCharacter,
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      decisionId: preparation.decisionId,
      triggerEventId: preparation.triggerEventId,
      mode,
      content: reply,
      contentJson: assistantMessage.contentJson,
      inference,
      generation,
      diagnostics: trace.snapshot(),
      now: new Date(assistantMessage.createdAt)
    })
    trace.mark('request_completed', 'completed', { messageId: assistantMessage.id })
  } catch (error) {
    trace.mark('request_failed', 'failed', {
      stage: 'response_persistence',
      error: error instanceof Error ? error.name : 'unknown_error'
    })
    throw error
  }

  if (voice) {
    void synthesizeMayaVoiceMessage({
      messageId: assistantMessage.id,
      text: replySegments[voice.segmentIndex],
      voice,
    })
      .then(readyVoice => updateAssistantMessageVoice(assistantMessage.id, readyVoice))
      .catch(async error => {
        console.error('Could not synthesize Maya voice message', error)
        await updateAssistantMessageVoice(assistantMessage.id, {
          ...voice,
          status: 'failed',
        }).catch(updateError => {
          console.error('Could not mark Maya voice message as failed', updateError)
        })
      })
  }

  return res.json({
    reply,
    replySegments,
    messageId: assistantMessage.id,
    voice,
    userMessageId: userMessage.id,
    conversationId: conversation.id,
    behavior: {
      emotion: preparation.snapshot.emotionLabel,
      activity: preparation.snapshot.simulation.currentActivity,
      decision: preparation.decision.action
    },
    traceId: trace.traceId
  })
}))

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Request failed', error)
  const persistedUserMessage = res.locals.persistedUserMessage
  const persistenceDetails = persistedUserMessage
    && typeof persistedUserMessage.userMessageId === 'string'
    && typeof persistedUserMessage.conversationId === 'string'
    ? {
        messagePersisted: true,
        userMessageId: persistedUserMessage.userMessageId,
        conversationId: persistedUserMessage.conversationId
      }
    : {}
  if (
    error?.type === 'entity.parse.failed'
    || (error instanceof SyntaxError && Number((error as any).status) === 400)
  ) {
    return res.status(400).json({ error: 'request body contains invalid JSON' })
  }
  if (error?.type === 'entity.too.large' || Number(error?.status) === 413) {
    return res.status(413).json({ error: 'request body is too large' })
  }
  if (error instanceof TranslationServiceError) {
    return res.status(error.statusCode).json({ error: error.message, ...persistenceDetails })
  }
  if (error instanceof GroqTranscriptionError) {
    return res.status(error.statusCode).json({ error: error.message, ...persistenceDetails })
  }
  if (error?.code === '23505') {
    return res.status(409).json({ error: 'record already exists', ...persistenceDetails })
  }
  return res.status(500).json({ error: 'database operation failed', ...persistenceDetails })
})

const port = process.env.PORT ? Number(process.env.PORT) : 3000
const proactiveIntervalMs = Math.max(
  10_000,
  Number(process.env.PROACTIVE_SCHEDULER_INTERVAL_MS) || 30_000
)
let proactiveTimer: NodeJS.Timeout | undefined
let proactiveSchedulerRunning = false

const runProactiveScheduler = async () => {
  if (proactiveSchedulerRunning) return
  proactiveSchedulerRunning = true
  try {
    await processDueProactiveActions({ limit: 3 })
  } catch (error) {
    console.error('Proactive scheduler failed', error)
  } finally {
    proactiveSchedulerRunning = false
  }
}

const start = async () => {
  const schemaResult = await query(
    `SELECT
       to_regclass('public.characters') AS characters_table,
       to_regclass('public.character_instances') AS instances_table,
       to_regclass('public.domain_events') AS events_table,
       to_regclass('public.inference_records') AS inference_records_table`
  )
  if (
    !schemaResult.rows[0]?.characters_table
    || !schemaResult.rows[0]?.instances_table
    || !schemaResult.rows[0]?.events_table
    || !schemaResult.rows[0]?.inference_records_table
  ) {
    throw new Error('Database schema is missing. Run npm run db:migrate first.')
  }
  app.listen(port, '0.0.0.0', () => console.log(`Chatterra backend listening on ${port}`))
  if (process.env.PROACTIVE_SCHEDULER_ENABLED !== 'false') {
    proactiveTimer = setInterval(() => void runProactiveScheduler(), proactiveIntervalMs)
    proactiveTimer.unref()
    const initialRun = setTimeout(() => void runProactiveScheduler(), 1000)
    initialRun.unref()
  }
}

start().catch(error => {
  console.error('Backend startup failed', error)
  process.exitCode = 1
})

const shutdown = () => {
  if (proactiveTimer) clearInterval(proactiveTimer)
  closeDatabase().finally(() => process.exit())
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
