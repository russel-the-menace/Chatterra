import express, { NextFunction, Request, Response } from 'express'
import { createServer } from 'node:http'
import cors from 'cors'
import dotenv from 'dotenv'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import { createHash } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
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
import { recordChatStreakInteraction } from './chat-streak'
import {
  looksLikeInjectionInput,
  looksLikeSuspiciousPath,
  recordSecurityEvent,
  SecurityEventInput,
} from './security-audit'
import { compactConversationIfNeeded } from './conversation-compaction'
import { processDueProactiveActions } from './proactive-service'
import { isExpoPushToken } from './push-notifications'
import { translateText, TranslationServiceError } from './translation-service'
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
  userVoiceMessageDirectory,
  userVoiceMessageMetadata,
} from './user-voice-message'
import { parseCustomCharacterDocument } from './custom-character'
import {
  appendMessages,
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
  markConversationRead,
  getSyncSnapshot,
  getUserPreferences,
  listCharacters,
  listConversations,
  listMessagePage,
  listPinnedCharacterIds,
  normalizeConversationStarterCreatedAt,
  newId,
  getUserCreatedAt,
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
import {
  isRestrictedTestAccountOperation,
  reserveTestAccountReply,
  TEST_ACCOUNT_DAILY_REPLY_LIMIT,
  TEST_ACCOUNT_HOURLY_REPLY_LIMIT,
  TEST_ACCOUNT_USERNAME,
} from './test-account-policy'

dotenv.config()

const app = express()
const httpServer = createServer(app)

type RealtimeEvent = {
  type: 'conversation_updated' | 'history_cleared'
  characterId: string
  conversationId?: string
}

const realtimeConnections = new Map<string, Set<WebSocket>>()

const broadcastRealtimeEvent = (userId: string, event: RealtimeEvent) => {
  const payload = JSON.stringify(event)
  realtimeConnections.get(userId)?.forEach(socket => {
    if (socket.readyState === WebSocket.OPEN) socket.send(payload)
  })
}

const realtimeServer = new WebSocketServer({ noServer: true })

realtimeServer.on('connection', socket => {
  let authenticatedUserId: string | undefined
  const authenticationTimeout = setTimeout(() => socket.close(1008, 'Authentication required'), 5_000)

  socket.on('message', async payload => {
    if (authenticatedUserId) return
    try {
      const message = JSON.parse(String(payload)) as { type?: unknown; accessToken?: unknown }
      if (message.type !== 'authenticate' || typeof message.accessToken !== 'string') {
        socket.close(1008, 'Authentication required')
        return
      }
      const user = await getAuthenticatedUser(message.accessToken)
      if (!user || socket.readyState !== WebSocket.OPEN) {
        socket.close(1008, 'Authentication failed')
        return
      }
      authenticatedUserId = user.id
      clearTimeout(authenticationTimeout)
      const sockets = realtimeConnections.get(user.id) || new Set<WebSocket>()
      sockets.add(socket)
      realtimeConnections.set(user.id, sockets)
      socket.send(JSON.stringify({ type: 'ready' }))
    } catch {
      socket.close(1008, 'Authentication failed')
    }
  })

  socket.on('close', () => {
    clearTimeout(authenticationTimeout)
    if (!authenticatedUserId) return
    const sockets = realtimeConnections.get(authenticatedUserId)
    sockets?.delete(socket)
    if (sockets?.size === 0) realtimeConnections.delete(authenticatedUserId)
  })
})

httpServer.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname
  if (pathname !== '/api/realtime') {
    socket.destroy()
    return
  }
  realtimeServer.handleUpgrade(request, socket, head, upgradedSocket => {
    realtimeServer.emit('connection', upgradedSocket, request)
  })
})
const REJECTED_OUTPUT_LOG_LIMIT = 4000
const SYNC_PROTOCOL_VERSION = 1
const TRANSCRIPTION_RATE_LIMIT_WINDOW_MS = 60_000
const TRANSCRIPTION_RATE_LIMIT_MAX_REQUESTS = 6
const transcriptionRequests = new Map<string, number[]>()
const voiceMessageTranscriptionInFlight = new Map<string, Promise<Message>>()
const productionWebOrigin = 'https://russel-the-menace.github.io'
const configuredOrigins = (process.env.CORS_ALLOWED_ORIGINS || productionWebOrigin)
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean)
const allowedOrigins = new Set([
  ...configuredOrigins,
  ...(process.env.NODE_ENV === 'production'
    ? []
    : ['http://localhost:5173', 'http://127.0.0.1:5173']),
])
const allowedHosts = new Set((process.env.ALLOWED_HOSTS || 'api.feiwan.online,localhost,127.0.0.1')
  .split(',')
  .map(host => host.trim().toLowerCase())
  .filter(Boolean))

const requestHost = (req: Request) => {
  const forwardedHost = req.header('x-forwarded-host')?.split(',')[0]?.trim()
  const rawHost = forwardedHost || req.header('host') || ''
  if (rawHost.startsWith('[')) return rawHost.slice(1, rawHost.indexOf(']')).toLowerCase()
  return rawHost.split(':')[0].toLowerCase()
}

const auditRequest = (
  req: Request,
  event: Omit<SecurityEventInput, 'ipAddress' | 'requestId' | 'method' | 'path' | 'userAgent'>
) => recordSecurityEvent({
  ...event,
  ipAddress: req.ip,
  requestId: req.header('x-chatterra-request-id') || undefined,
  method: req.method,
  path: req.originalUrl.split('?')[0],
  userAgent: req.header('user-agent') || undefined,
})

app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use((req, res, next) => {
  const host = requestHost(req)
  if (allowedHosts.has(host)) return next()
  void auditRequest(req, {
    eventType: 'invalid_host_header',
    severity: 'critical',
    metadata: { hostFingerprint: host ? createHash('sha256').update(host).digest('hex') : null },
  })
  return res.status(421).json({ error: 'Request host is not accepted.' })
})
app.use(helmet({ crossOriginResourcePolicy: false }))
app.use((req, res, next) => {
  if (looksLikeSuspiciousPath(req.originalUrl)) {
    void auditRequest(req, { eventType: 'suspicious_request_path', severity: 'warning' })
    return res.status(400).json({ error: 'Request is invalid.', code: 'INVALID_REQUEST' })
  }
  const origin = req.header('origin')
  if (origin && !allowedOrigins.has(origin)) {
    void auditRequest(req, {
      eventType: 'invalid_origin',
      severity: 'warning',
      metadata: { originFingerprint: createHash('sha256').update(origin).digest('hex') },
    })
  }
  next()
})
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true)
    return callback(new Error('Origin is not allowed by CORS'))
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'X-Chatterra-Request-Id',
    'X-Chatterra-User-Id', 'X-Chatterra-Character-Id', 'X-Chatterra-Conversation-Id',
    'X-Chatterra-Voice-Duration-Ms', 'X-Chatterra-Voice-Request-Id'],
  maxAge: 86_400,
}))
app.use(express.json({ limit: '2mb' }))
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.', code: 'API_RATE_LIMIT_REACHED' },
  handler: (req, res, _next, options) => {
    void auditRequest(req, { eventType: 'api_rate_limit_reached', severity: 'warning' })
    res.status(options.statusCode).json(options.message)
  },
}))
// User recordings and generated assistant speech use separate persistent directories.
// Keep one public media route so existing message metadata remains playable.
app.use('/media/voice', express.static(userVoiceMessageDirectory, {
  immutable: true,
  maxAge: '30d',
}))
app.use('/media/voice', express.static(voiceMediaDirectory, {
  immutable: true,
  maxAge: '30d',
}))
app.use('/api', (req, res, next) => {
  // Conversation data is user-specific. Never let an intermediary reuse it.
  res.setHeader('Cache-Control', 'private, no-store, max-age=0, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.append('Vary', 'Authorization')
  next()
})

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

const isPublicTestRequest = (req: Request) => (
  (req as AuthenticatedRequest).authenticatedUser?.username.toLowerCase() === TEST_ACCOUNT_USERNAME
)

const testAccountLimitResponse = (res: Response, quota: Awaited<ReturnType<typeof reserveTestAccountReply>>) => (
  res.status(429).json({
    error: 'This public test account has reached its reply limit. Please try again after the limit resets.',
    code: 'TEST_ACCOUNT_REPLY_LIMIT_REACHED',
    limits: {
      hourly: TEST_ACCOUNT_HOURLY_REPLY_LIMIT,
      daily: TEST_ACCOUNT_DAILY_REPLY_LIMIT,
    },
    usage: {
      hourly: quota.hourlyUsed,
      daily: quota.dailyUsed,
    },
    resetAt: quota.resetAt,
  })
)

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

const apiRequestId = (req: Request) => {
  const value = typeof req.headers['x-chatterra-request-id'] === 'string'
    ? req.headers['x-chatterra-request-id'].trim()
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

const starterMessagesForNormalization = (character: Character) => {
  const messages = [getStarterMessage(character)]
  if (character.id === 'seed-minjun-friend') {
    messages.push('안녕, 민준이야. 오늘 수업 어땠어? 난 선형대수 과제에 아직도 붙잡혀 있어.')
  }
  if (character.id === 'seed-ren-friend') {
    messages.push('やあ、蓮だよ。今日の授業どうだった？こっちは解析の課題にずっと捕まってた。')
  }
  return [...new Set(messages)]
}

// v2 marks conversations after the one-time legacy starter correction has run.
const STARTER_TIMESTAMP_POLICY = 'account-or-character-created-at-v2'

const fixedStarterMessageCreatedAt = () => {
  const year = new Date().getFullYear()
  return new Date(`${year}-07-01T12:00:00+08:00`).toISOString()
}

const starterMessageCreatedAt = (userCreatedAt: string, character: Character) => (
  character.ownerUserId ? character.createdAt : userCreatedAt
)

const starterMessageCreatedAtForUser = async (userId: string, character: Character) => {
  const userCreatedAt = await getUserCreatedAt(userId)
  if (!userCreatedAt) throw new Error('authenticated user not found')
  return starterMessageCreatedAt(userCreatedAt, character)
}

const starterConversationMetadata = {
  starterTimestampPolicy: STARTER_TIMESTAMP_POLICY
}

const ensuredStarterKeys = new Set<string>()

const ensureConversationForCharacter = async (
  userId: string,
  character: Character,
  userCreatedAt?: string
) => {
  const accountCreatedAt = userCreatedAt || await getUserCreatedAt(userId)
  if (!accountCreatedAt) throw new Error('authenticated user not found')
  const now = new Date().toISOString()
  const starterCreatedAt = starterMessageCreatedAt(accountCreatedAt, character)
  const conversationId = newId()
  const result = await getOrCreateConversationWithStarter(
    {
      id: conversationId,
      userId,
      characterId: character.id,
      title: `${character.name} chat`,
      status: 'active',
      metadata: starterConversationMetadata,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: newId(),
      conversationId,
      senderRole: 'assistant',
      senderId: character.id,
      content: getStarterMessage(character),
      createdAt: starterCreatedAt,
    }
  )
  if (
    result.conversation.metadata?.starterTimestampPolicy !== STARTER_TIMESTAMP_POLICY
  ) {
    await normalizeConversationStarterCreatedAt(
      userId,
      character.id,
      starterMessagesForNormalization(character),
      fixedStarterMessageCreatedAt(),
      STARTER_TIMESTAMP_POLICY
    )
  }
  ensuredStarterKeys.add(`${userId}:${character.id}`)
  return result
}

const ensureContactStarters = async (userId: string, characters: Character[]) => {
  const pending = characters.filter(character => !ensuredStarterKeys.has(`${userId}:${character.id}`))
  if (pending.length === 0) return false
  const userCreatedAt = await getUserCreatedAt(userId)
  if (!userCreatedAt) throw new Error('authenticated user not found')
  await Promise.all(pending.map(character => ensureConversationForCharacter(userId, character, userCreatedAt)))
  return true
}

type ForwardReplyResult = {
  assistantMessage?: Message
  behavior: {
    emotion: string
    activity: string
    decision: string
    responseStatus?: 'inference_failed'
  }
  reply: string | null
  replySegments?: string[]
  voice?: ReturnType<typeof planMayaVoiceMessage>
}

// A forward is persisted as a consecutive user-message bundle first. The last
// item then enters the same behavior and inference pipeline as a normal chat
// turn, without inserting a duplicate user message.
const generateForwardReply = async ({
  userId,
  character,
  conversation,
  triggerMessage,
}: {
  userId: string
  character: Character
  conversation: Conversation
  triggerMessage: Message
}): Promise<ForwardReplyResult> => {
  const trace = createInferenceTrace(newId())
  const mode = resolveCharacterMode(character)
  const interactionNow = new Date(triggerMessage.createdAt)
  const preparation = await prepareInteraction({
    userId,
    character,
    conversationId: conversation.id,
    messageId: triggerMessage.id,
    message: triggerMessage.content,
    contentJson: triggerMessage.contentJson,
    messageAlreadyPersisted: true,
    forceReply: true,
    mode,
    now: interactionNow,
  })
  const inference = await buildInferencePlan({
    userId,
    character,
    conversationId: conversation.id,
    currentMessageId: triggerMessage.id,
    message: triggerMessage.content,
    mode,
    snapshot: preparation.snapshot,
    memoryEnabled: preparation.memoryEnabled,
    decision: preparation.decision,
  })

  const behavior = {
    emotion: preparation.snapshot.emotionLabel,
    activity: preparation.snapshot.simulation.currentActivity,
    decision: preparation.decision.action,
  }

  if (inference.route === 'none') {
    await recordSkippedInference({
      userId,
      character,
      conversationId: conversation.id,
      decisionId: preparation.decisionId,
      triggerEventId: preparation.triggerEventId,
      mode,
      inference,
      diagnostics: trace.snapshot(),
      now: new Date(),
    })
    return { behavior, reply: null }
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
      const result = await generateModelResponse(inference, character, trace)
      rawReply = result.content
      generation = {
        provider: result.provider,
        model: result.model,
        profile: inference.model?.profile,
        parameters: {
          ...inference.parameters,
          maxResponseTokens: result.diagnostics.maxResponseTokens,
        },
        contextManifest: inference.contextManifest,
        diagnostics: result.diagnostics,
        latencyMs: result.latencyMs,
      }
    }
  } catch (error) {
    trace.mark('request_failed', 'failed', {
      stage: 'forward_provider_request',
      error: error instanceof ModelGatewayError
        ? error.message
        : error instanceof Error ? error.name : 'unknown_error',
    })
    await recordInferenceFailure({
      userId,
      character,
      conversationId: conversation.id,
      decisionId: preparation.decisionId,
      triggerEventId: preparation.triggerEventId,
      mode,
      inference,
      diagnostics: trace.snapshot(),
      latencyMs: Date.now() - inferenceStartedAt,
    }).catch(auditError => {
      console.error('Could not record failed forward inference', auditError)
    })
    console.error('Could not generate a reply for a forwarded message', error)
    return {
      behavior: { ...behavior, responseStatus: 'inference_failed' },
      reply: null,
    }
  }

  const outputDiagnostics = diagnoseInferenceOutput(inference, rawReply)
  const { reply, deliverySegments, ...traceOutputDiagnostics } = outputDiagnostics
  trace.mark('output_processed', 'completed', traceOutputDiagnostics)
  if (!outputDiagnostics.accepted || !reply) {
    const failureReason = outputDiagnostics.rejectionReason || 'output_rejected'
    await recordInferenceFailure({
      userId,
      character,
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
          rejectionReason: failureReason,
        },
      },
      latencyMs: generation?.latencyMs ?? Date.now() - inferenceStartedAt,
      failureReason,
    })
    return {
      behavior: { ...behavior, responseStatus: 'inference_failed' },
      reply: null,
    }
  }

  const replySegments = deliverySegments.length > 0 ? deliverySegments : [reply]
  const assistantMessageId = newId()
  const recentMessages = await listRecentMessages(conversation.id, 8)
  const voice = planMayaVoiceMessage({
    characterId: character.id,
    messageId: assistantMessageId,
    replySegments,
    recentMessages,
    userMessage: triggerMessage.content,
  })
  const assistantMessage: Message = {
    id: assistantMessageId,
    conversationId: conversation.id,
    senderRole: 'assistant',
    senderId: character.id,
    content: reply,
    contentJson: {
      deliverySegments: replySegments,
      ...(voice ? { voice } : {}),
    },
    createdAt: new Date().toISOString(),
  }
  await recordAssistantResponse({
    userId,
    character,
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
    now: new Date(assistantMessage.createdAt),
  })
  void compactConversationIfNeeded(conversation.id).catch(compactionError => {
    console.warn('Conversation context compaction failed after a forwarded message', {
      conversationId: conversation.id,
      error: compactionError instanceof Error ? compactionError.message : 'unknown_error',
    })
  })
  if (voice) {
    void synthesizeMayaVoiceMessage({
      messageId: assistantMessage.id,
      text: replySegments[voice.segmentIndex],
      voice,
    })
      .then(readyVoice => updateAssistantMessageVoice(assistantMessage.id, readyVoice))
      .catch(async error => {
        console.error('Could not synthesize forwarded Maya voice message', error)
        await updateAssistantMessageVoice(assistantMessage.id, {
          ...voice,
          status: 'failed',
        }).catch(updateError => {
          console.error('Could not mark forwarded Maya voice message as failed', updateError)
        })
      })
  }

  return {
    assistantMessage,
    behavior,
    reply,
    replySegments,
    voice,
  }
}

app.post('/api/auth/login', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'Too many sign-in attempts. Please try again later.', code: 'LOGIN_RATE_LIMIT_REACHED' },
  handler: (req, res, _next, options) => {
    void auditRequest(req, { eventType: 'login_rate_limit_reached', severity: 'critical' })
    res.status(options.statusCode).json(options.message)
  },
}), asyncRoute(async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
  const password = typeof req.body?.password === 'string' ? req.body.password : ''
  const suspiciousCredentials = looksLikeInjectionInput(username)
    || looksLikeInjectionInput(password)
    || !/^[A-Za-z0-9_.-]{1,64}$/.test(username)
    || password.length > 200
  if (!username || !password || suspiciousCredentials) {
    if (suspiciousCredentials) {
      void auditRequest(req, {
        eventType: 'suspicious_login_input',
        severity: 'critical',
        username,
        metadata: { usernameLength: username.length, passwordLength: password.length },
      })
    }
    return res.status(401).json({ error: 'Invalid username or password.' })
  }

  const session = await authenticateUser(username, password)
  if (!session) {
    void auditRequest(req, {
      eventType: 'login_failed',
      severity: 'warning',
      username,
    })
    return res.status(401).json({ error: 'Invalid username or password.' })
  }
  return res.json(session)
}))

app.get('/api/health', asyncRoute(async (_req, res) => {
  await query('SELECT 1')
  return res.json({ status: 'ok' })
}))

app.use('/api', asyncRoute(async (req, res, next) => {
  if (req.method === 'OPTIONS') return next()
  const token = accessTokenFromRequest(req)
  const user = await getAuthenticatedUser(token)
  if (!user) {
    if (token) void auditRequest(req, { eventType: 'invalid_access_token', severity: 'warning' })
    return res.status(401).json({ error: 'Authentication is required.' })
  }
  ;(req as AuthenticatedRequest).authenticatedUser = user
  next()
}))

app.use('/api', (req, res, next) => {
  if (isPublicTestRequest(req) && isRestrictedTestAccountOperation(req.method, req.path)) {
    void auditRequest(req, {
      eventType: 'test_account_restricted_feature',
      severity: 'info',
      userId: authenticatedUserId(req),
    })
    return res.status(403).json({
      error: 'This feature is disabled for the shared public test account.',
      code: 'TEST_ACCOUNT_RESTRICTED_FEATURE',
    })
  }
  next()
})

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
  const startedAt = Date.now()
  const characters = await listCharacters(authenticatedUserId(req))
  console.info('Character list served', {
    characterCount: characters.length,
    durationMs: Date.now() - startedAt,
    requestId: apiRequestId(req),
    responseBytes: Buffer.byteLength(JSON.stringify({ characters })),
  })
  return res.json({ characters })
}))

app.get('/api/sync', asyncRoute(async (req, res) => {
  const userId = authenticatedUserId(req)
  const snapshot = await getSyncSnapshot(userId)
  const startersChanged = await ensureContactStarters(userId, snapshot.characters)
  if (startersChanged) {
    return res.json(await getSyncSnapshot(userId))
  }
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
  if (isPublicTestRequest(req) && req.body.memoryEnabled) {
    return res.status(403).json({ error: 'Memory personalization is disabled for the public test account.' })
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
  const translationTargetLanguage = typeof req.body?.translationTargetLanguage === 'string'
    ? req.body.translationTargetLanguage.trim().slice(0, 120)
    : undefined
  if (!displayName) return res.status(400).json({ error: 'displayName is required' })
  const profile = await updateUserProfile(req.params.id, { displayName, avatar, translationTargetLanguage })
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

app.post('/api/conversations/ensure', asyncRoute(async (req, res) => {
  const userId = authenticatedUserId(req)
  const characterId = typeof req.body?.characterId === 'string' ? req.body.characterId.trim() : ''
  if (!characterId) return res.status(400).json({ error: 'characterId is required' })

  const character = await getCharacterForUser(userId, characterId)
  if (!character) return res.status(404).json({ error: 'character not found' })

  const result = await ensureConversationForCharacter(userId, character)
  return res.status(result.created ? 201 : 200).json(result)
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

app.post('/api/conversations/:id/read', asyncRoute(async (req, res) => {
  const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId.trim() : ''
  if (!messageId) return res.status(400).json({ error: 'messageId is required' })

  const updated = await markConversationRead(
    authenticatedUserId(req),
    req.params.id,
    messageId
  )
  if (!updated) return res.status(404).json({ error: 'conversation or message not found' })
  return res.status(204).end()
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
  const requestedTargetLanguage = typeof req.body?.targetLanguage === 'string'
    ? req.body.targetLanguage.trim()
    : ''
  if (!text) return res.status(400).json({ error: 'text is required' })

  const targetLanguage = requestedTargetLanguage
    ? requestedTargetLanguage.toLowerCase() === 'en' || requestedTargetLanguage.toLowerCase() === 'english'
      ? 'English'
      : requestedTargetLanguage.toLowerCase() === 'zh' || requestedTargetLanguage.toLowerCase() === 'cn' || requestedTargetLanguage.toLowerCase() === 'chinese'
        ? 'Chinese'
        : requestedTargetLanguage
    : 'English'

  const generated = await translateText(text, targetLanguage)
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
          metadata: starterConversationMetadata,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: newId(),
          conversationId,
          senderRole: 'assistant',
          senderId: character.id,
          content: getStarterMessage(character),
          createdAt: await starterMessageCreatedAtForUser(userId, character),
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
      broadcastRealtimeEvent(userId, {
        type: 'conversation_updated',
        characterId: character.id,
        conversationId: conversation.id,
      })
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
  const requestedTargetLanguage = typeof req.body?.targetLanguage === 'string'
    ? req.body.targetLanguage.trim()
    : ''
  const segmentIndex = Number(req.body?.segmentIndex ?? 0)
  const targetLanguage = requestedTargetLanguage
    ? requestedTargetLanguage.toLowerCase() === 'en' || requestedTargetLanguage.toLowerCase() === 'english'
      ? 'English'
      : requestedTargetLanguage.toLowerCase() === 'zh' || requestedTargetLanguage.toLowerCase() === 'cn' || requestedTargetLanguage.toLowerCase() === 'chinese'
        ? 'Chinese'
        : requestedTargetLanguage
    : 'English'
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

  const generated = await translateText(sourceText, targetLanguage)
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
  if (isPublicTestRequest(req)) return res.json({ deliveries: [] })
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
  broadcastRealtimeEvent(String(userId), {
    type: 'history_cleared',
    characterId: String(characterId),
    conversationId: result.conversation.id,
  })
  return res.json({ ok: true, characterId, ...result })
}))

app.post('/api/messages/forward', asyncRoute(async (req, res) => {
  const userId = authenticatedUserId(req)
  const targetCharacterId = typeof req.body?.targetCharacterId === 'string'
    ? req.body.targetCharacterId.trim()
    : ''
  const forwardedText = typeof req.body?.message === 'string'
    ? req.body.message.trim().slice(0, 20_000)
    : ''
  const note = typeof req.body?.note === 'string'
    ? req.body.note.trim().slice(0, 20_000)
    : ''

  if (!targetCharacterId) return res.status(400).json({ error: 'targetCharacterId is required' })
  if (!forwardedText) return res.status(400).json({ error: 'message is required' })

  const character = await getCharacterForUser(userId, targetCharacterId)
  if (!character) return res.status(404).json({ error: 'character not found' })

  const now = new Date()
  const nextConversationId = newId()
  const created = await getOrCreateConversationWithStarter(
    {
      id: nextConversationId,
      userId,
      characterId: character.id,
      title: `${character.name} chat`,
      status: 'active',
      metadata: starterConversationMetadata,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    },
    {
      id: newId(),
      conversationId: nextConversationId,
      senderRole: 'assistant',
      senderId: character.id,
      content: getStarterMessage(character),
      createdAt: await starterMessageCreatedAtForUser(userId, character),
    }
  )

  const conversation = created.conversation
  const forwardedAt = new Date(now.getTime() + 1).toISOString()
  const forwardBundleId = newId()
  const messages: Message[] = [{
    id: newId(),
    conversationId: conversation.id,
    senderRole: 'user',
    senderId: userId,
    content: forwardedText,
    contentJson: {
      forward: {
        bundleId: forwardBundleId,
        position: 'forwarded_message',
      },
    },
    createdAt: forwardedAt,
  }]
  if (note) {
    messages.push({
      id: newId(),
      conversationId: conversation.id,
      senderRole: 'user',
      senderId: userId,
      content: note,
      contentJson: {
        forward: {
          bundleId: forwardBundleId,
          position: 'forward_note',
        },
      },
      createdAt: new Date(now.getTime() + 2).toISOString(),
    })
  }

  const quota = await reserveTestAccountReply(userId)
  if (!quota.allowed) return testAccountLimitResponse(res, quota)

  const persistedMessages = await appendMessages(messages)
  const triggerMessage = persistedMessages.at(-1)
  const generated = triggerMessage
    ? await generateForwardReply({
        userId,
        character,
        conversation,
        triggerMessage,
      })
    : undefined
  if (generated?.assistantMessage) {
    await recordChatStreakInteraction({
      userId,
      characterId: character.id,
      sourceMessageId: generated.assistantMessage.id,
    }).catch(error => {
      console.warn('Could not record chat streak interaction', error)
    })
  }
  broadcastRealtimeEvent(userId, {
    type: 'conversation_updated',
    characterId: character.id,
    conversationId: conversation.id,
  })
  return res.status(201).json({
    conversationId: conversation.id,
    characterId: character.id,
    starterMessage: created.starterMessage,
    messages: persistedMessages,
    assistantMessage: generated?.assistantMessage,
    reply: generated?.reply || null,
    replySegments: generated?.replySegments || [],
    voice: generated?.voice,
    behavior: generated?.behavior,
  })
}))

app.post('/api/chat', asyncRoute(async (req, res) => {
  const { message, conversationId, character } = req.body || {}
  const userId = authenticatedUserId(req)
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message must be a non-empty string' })
  }
  if (message.length > 20_000) return res.status(400).json({ error: 'message is too long' })
  if (!character || typeof character !== 'object' || typeof character.id !== 'string') {
    return res.status(400).json({ error: 'character is required' })
  }
  const requestedCharacterId = character.id.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestedCharacterId)) {
    return res.status(400).json({ error: 'character id is invalid' })
  }

  const normalizedUserId = String(userId)
  const normalizedMessage = message.trim()
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
    characterId: requestedCharacterId,
    conversationId: conversationId ? String(conversationId) : null,
    messageLength: normalizedMessage.length,
    hasVoiceMetadata: Boolean(voiceMetadata),
    hasQuote: Boolean(quoteInput)
  })

  const storedCharacter = await getCharacterForUser(normalizedUserId, requestedCharacterId)
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
      metadata: starterConversationMetadata,
      createdAt: now,
      updatedAt: now
    }
    const starterMessage: Message = {
      id: newId(),
      conversationId: nextConversation.id,
      senderRole: 'assistant',
      senderId: storedCharacter.id,
      content: getStarterMessage(storedCharacter),
      createdAt: await starterMessageCreatedAtForUser(normalizedUserId, storedCharacter)
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
    broadcastRealtimeEvent(normalizedUserId, {
      type: 'conversation_updated',
      characterId: storedCharacter.id,
      conversationId: conversation.id,
    })
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
      const quota = await reserveTestAccountReply(normalizedUserId)
      if (!quota.allowed) return testAccountLimitResponse(res, quota)
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
    await recordChatStreakInteraction({
      userId: normalizedUserId,
      characterId: storedCharacter.id,
      sourceMessageId: assistantMessage.id,
    }).catch(error => {
      console.warn('Could not record chat streak interaction', error)
    })
    trace.mark('request_completed', 'completed', { messageId: assistantMessage.id })
    void compactConversationIfNeeded(conversation.id)
      .then(compacted => {
        if (compacted) console.info('Conversation context compacted', { conversationId: conversation.id })
      })
      .catch(compactionError => {
        console.warn('Conversation context compaction failed', {
          conversationId: conversation.id,
          error: compactionError instanceof Error ? compactionError.message : 'unknown_error'
        })
      })
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

  broadcastRealtimeEvent(normalizedUserId, {
    type: 'conversation_updated',
    characterId: storedCharacter.id,
    conversationId: conversation.id,
  })
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

app.use('/api', (req, res) => {
  void auditRequest(req, { eventType: 'unknown_api_route', severity: 'warning' })
  return res.status(404).json({ error: 'Not found.' })
})

app.use((error: any, req: Request, res: Response, _next: NextFunction) => {
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
    void auditRequest(req, { eventType: 'malformed_json', severity: 'warning' })
    return res.status(400).json({ error: 'request body contains invalid JSON' })
  }
  if (error?.type === 'entity.too.large' || Number(error?.status) === 413) {
    void auditRequest(req, { eventType: 'request_body_too_large', severity: 'warning' })
    return res.status(413).json({ error: 'request body is too large' })
  }
  if (error instanceof Error && error.message === 'Origin is not allowed by CORS') {
    return res.status(403).json({ error: 'Origin is not allowed.' })
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
  if (error?.code === 'P0001' && error?.message === 'test_account_custom_character_limit') {
    return res.status(409).json({
      error: 'The shared test account can create up to 3 custom characters.',
      code: 'TEST_ACCOUNT_CUSTOM_CHARACTER_LIMIT_REACHED',
    })
  }
  void auditRequest(req, {
    eventType: 'unhandled_request_error',
    severity: 'critical',
    metadata: { errorType: error instanceof Error ? error.name : 'unknown_error' },
  })
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
  httpServer.listen(port, '0.0.0.0', () => console.log(`Chatterra backend listening on ${port}`))
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
