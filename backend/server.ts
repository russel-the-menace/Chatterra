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
  clearChatHistory,
  createCharacter,
  getOrCreateConversationWithStarter,
  getCharacter,
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
  setCharacterPinned,
  setUserMemoryConsent,
  listRecentMessages,
  upsertExpoPushDevice,
  updateAssistantMessageVoice,
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
app.use(cors())
app.use(express.json({ limit: '2mb' }))
app.use('/media/voice', express.static(voiceMediaDirectory, {
  immutable: true,
  maxAge: '30d',
}))

const asyncRoute = (
  handler: (req: Request, res: Response, next: NextFunction) => Promise<any>
) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(handler(req, res, next)).catch(next)
}

const characterTextFields: Array<keyof Character> = [
  'name',
  'avatar',
  'role',
  'company',
  'personality',
  'scenario',
  'goal',
  'language',
  'background',
  'systemPromptTemplate'
]

const characterFromPayload = (payload: any, existing?: Character): Character => {
  const now = new Date().toISOString()
  const character: Character = {
    ...(existing || {} as Character),
    id: existing?.id || newId(),
    name: existing?.name || '',
    createdAt: existing?.createdAt || now,
    updatedAt: now
  }

  characterTextFields.forEach(field => {
    if (typeof payload?.[field] === 'string') {
      ;(character as any)[field] = payload[field].trim()
    }
  })

  return character
}

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
    return '안녕, 민준이야. 오늘 수업 어땠어? 난 선형대수 과제에 아직도 붙잡혀 있어.'
  }
  if (character?.id === 'seed-ren-friend') {
    return 'やあ、蓮だよ。今日の授業どうだった？こっちは解析の課題にずっと捕まってた。'
  }
  if (character?.id === 'c3') {
    return "Hey, it's Maya. I just finished sorting out my notes for the day. Come keep me company for a minute?"
  }
  if (character?.id === 'c2') {
    if (languagePolicy.code === 'english') {
      return 'Hi. I will help you practice English and point out useful mistakes when it helps, while keeping the conversation natural. Tell me about your current project.'
    }
  }

  return starterMessageForPolicy(character?.name || 'Interviewer', languagePolicy)
}

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

app.get('/api/characters', asyncRoute(async (_req, res) => {
  const characters = await listCharacters()
  return res.json({ characters })
}))

app.get('/api/sync', asyncRoute(async (req, res) => {
  const userId = String(req.query.userId || '').trim()
  if (!userId) return res.status(400).json({ error: 'userId required' })

  const snapshot = await getSyncSnapshot(userId)
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

app.post('/api/characters', asyncRoute(async (req, res) => {
  const character = characterFromPayload(req.body || {})
  if (!character.name) return res.status(400).json({ error: 'name is required' })

  const created = await createCharacter(character)
  return res.status(201).json({ character: created })
}))

app.put('/api/characters/:id', asyncRoute(async (req, res) => {
  const id = req.params.id
  if (!id) return res.status(400).json({ error: 'id required' })

  const existing = await getCharacter(id)
  if (!existing) return res.status(404).json({ error: 'character not found' })

  const nextCharacter = characterFromPayload(req.body || {}, existing)
  if (!nextCharacter.name) return res.status(400).json({ error: 'name is required' })

  const updated = await updateCharacter(nextCharacter)
  return res.json({ character: updated })
}))

app.get('/api/conversations', asyncRoute(async (req, res) => {
  const userId = String(req.query.userId || '')
  if (!userId) return res.status(400).json({ error: 'userId required' })

  const conversations = await listConversations(userId)
  return res.json({ conversations })
}))

app.get('/api/conversations/:id/messages', asyncRoute(async (req, res) => {
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
  const userId = String(req.query.userId || '')
  if (!userId) return res.status(400).json({ error: 'userId required' })
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

app.post('/api/messages/:id/translations', asyncRoute(async (req, res) => {
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''
  const targetLanguage = typeof req.body?.targetLanguage === 'string'
    ? req.body.targetLanguage.trim().toLowerCase()
    : ''
  const segmentIndex = Number(req.body?.segmentIndex ?? 0)
  if (!userId) return res.status(400).json({ error: 'userId is required' })
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
  const userId = String(req.query.userId || '')
  if (!userId) return res.status(400).json({ error: 'userId required' })

  const character = await getCharacter(req.params.id)
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
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''
  if (!userId) return res.status(400).json({ error: 'userId required' })
  const deliveries = await processDueProactiveActions({ userId, limit: 2 })
  return res.json({ deliveries })
}))

app.put('/api/push-devices/expo', asyncRoute(async (req, res) => {
  const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : ''
  const expoPushToken = typeof req.body?.expoPushToken === 'string'
    ? req.body.expoPushToken.trim()
    : ''
  const platform = req.body?.platform
  if (!userId) return res.status(400).json({ error: 'userId is required' })
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
  const { userId, characterId } = req.body || {}
  if (!userId) return res.status(400).json({ error: 'userId is required' })
  if (!characterId) return res.status(400).json({ error: 'characterId is required' })

  const result = await clearChatHistory(String(userId), String(characterId))
  await resetBehaviorState(String(userId), String(characterId))
  return res.json({ ok: true, characterId, ...result })
}))

app.post('/api/chat', asyncRoute(async (req, res) => {
  const { message, conversationId, userId, character } = req.body || {}
  if (!message) return res.status(400).json({ error: 'message is required' })
  if (!userId) return res.status(400).json({ error: 'userId is required' })
  if (!character?.id) return res.status(400).json({ error: 'character is required' })

  const normalizedUserId = String(userId)
  const normalizedMessage = String(message)
  const clientMessageId = typeof req.body?.clientMessageId === 'string'
    ? req.body.clientMessageId.trim()
    : ''
  if (
    clientMessageId
    && !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,199}$/.test(clientMessageId)
  ) {
    return res.status(400).json({ error: 'clientMessageId is invalid' })
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

  const storedCharacter = await getCharacter(String(character.id))
  if (!storedCharacter) return res.status(400).json({ error: 'character not found' })
  if (clientMessageId) {
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

  let conversation = conversationId
    ? await getConversation(String(conversationId))
    : undefined

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

  const userContentJson = voiceMetadata || quote
    ? {
        ...(voiceMetadata ? { voice: voiceMetadata } : {}),
        ...(quote ? { quote } : {})
      }
    : undefined

  const userMessage: Message = {
    id: clientMessageId || newId(),
    conversationId: conversation.id,
    senderRole: 'user',
    senderId: normalizedUserId,
    content: normalizedMessage,
    contentJson: userContentJson,
    createdAt: new Date().toISOString()
  }

  const preparation = await prepareInteraction({
    userId: normalizedUserId,
    character: storedCharacter,
    conversationId: conversation.id,
    messageId: userMessage.id,
    message: normalizedMessage,
    contentJson: userContentJson,
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
  if (error instanceof TranslationServiceError) {
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
