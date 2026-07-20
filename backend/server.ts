import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { closeDatabase, query } from './database'
import {
  getBehaviorSnapshot,
  prepareInteraction,
  recordAssistantResponse,
  recordInferenceFailure,
  resolveCharacterMode,
  resetBehaviorState
} from './behavior'
import { buildInferencePlan, postProcessInferenceOutput } from './inference-orchestrator'
import { generateModelResponse, ModelGatewayError } from './model-gateway'
import { resolveResponseLanguagePolicy, starterMessageForPolicy } from './language-policy'
import {
  clearChatHistory,
  createCharacter,
  createConversationWithStarter,
  getCharacter,
  getConversation,
  getUserPreferences,
  listCharacters,
  listConversations,
  listMessages,
  newId,
  setUserMemoryConsent,
  updateCharacter
} from './repository'
import { Character, Conversation, Message, VoiceTranscriptMetadata } from './types'

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

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
  if (character?.id === 'c2') {
    if (languagePolicy.code === 'english') {
      return 'Hi. I will help you practice English and point out useful mistakes when it helps, while keeping the conversation natural. Tell me about your current project.'
    }
  }

  return starterMessageForPolicy(character?.name || 'Interviewer', languagePolicy)
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  await query('SELECT 1')
  return res.json({ status: 'ok', database: 'postgresql' })
}))

app.get('/api/characters', asyncRoute(async (_req, res) => {
  const characters = await listCharacters()
  return res.json({ characters })
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
  const messages = await listMessages(req.params.id)
  return res.json({ messages })
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
  const voiceMetadata = voiceMetadataFromPayload(req.body?.voice)

  const storedCharacter = await getCharacter(String(character.id))
  if (!storedCharacter) return res.status(400).json({ error: 'character not found' })
  const mode = resolveCharacterMode(storedCharacter)

  let conversation = conversationId
    ? await getConversation(String(conversationId))
    : undefined

  if (conversation && conversation.userId !== normalizedUserId) {
    return res.status(403).json({ error: 'conversation does not belong to this user' })
  }
  if (conversation && conversation.characterId !== storedCharacter.id) {
    return res.status(400).json({ error: 'conversation character mismatch' })
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
    conversation = await createConversationWithStarter(nextConversation, starterMessage)
  }

  const userMessage: Message = {
    id: newId(),
    conversationId: conversation.id,
    senderRole: 'user',
    senderId: normalizedUserId,
    content: normalizedMessage,
    createdAt: new Date().toISOString()
  }

  const preparation = await prepareInteraction({
    userId: normalizedUserId,
    character: storedCharacter,
    conversationId: conversation.id,
    messageId: userMessage.id,
    message: normalizedMessage,
    contentJson: voiceMetadata ? { voice: voiceMetadata } : undefined,
    mode,
    now: new Date(userMessage.createdAt)
  })
  const inference = await buildInferencePlan({
    userId: normalizedUserId,
    character: storedCharacter,
    conversationId: conversation.id,
    currentMessageId: userMessage.id,
    message: normalizedMessage,
    mode,
    snapshot: preparation.snapshot,
    memoryEnabled: preparation.memoryEnabled
  })

  let rawReply = inference.directResponse || ''
  let generation: {
    provider?: string
    model?: string
    profile?: string
    parameters?: Record<string, any>
    contextManifest?: Record<string, any>
    latencyMs?: number
  } | undefined
  const inferenceStartedAt = Date.now()
  try {
    if (inference.route === 'model') {
      const result = await generateModelResponse(inference, storedCharacter)
      rawReply = result.content
      generation = {
        provider: result.provider,
        model: result.model,
        profile: inference.model?.profile,
        parameters: inference.parameters,
        contextManifest: inference.contextManifest,
        latencyMs: result.latencyMs
      }
    }
  } catch (error) {
    try {
      await recordInferenceFailure({
        userId: normalizedUserId,
        character: storedCharacter,
        conversationId: conversation.id,
        decisionId: preparation.decisionId,
        triggerEventId: preparation.triggerEventId,
        mode,
        inference,
        latencyMs: Date.now() - inferenceStartedAt
      })
    } catch (auditError) {
      console.error('Could not record failed inference', auditError)
    }
    if (error instanceof ModelGatewayError) {
      return res.status(error.statusCode).json({ error: error.message })
    }
    throw error
  }

  const reply = postProcessInferenceOutput(inference, rawReply)
  const assistantMessage: Message = {
    id: newId(),
    conversationId: conversation.id,
    senderRole: 'assistant',
    senderId: storedCharacter.id,
    content: reply,
    createdAt: new Date().toISOString()
  }
  await recordAssistantResponse({
    userId: normalizedUserId,
    character: storedCharacter,
    conversationId: conversation.id,
    messageId: assistantMessage.id,
    decisionId: preparation.decisionId,
    triggerEventId: preparation.triggerEventId,
    mode,
    content: reply,
    inference,
    generation,
    now: new Date(assistantMessage.createdAt)
  })

  return res.json({
    reply,
    conversationId: conversation.id,
    behavior: {
      emotion: preparation.snapshot.emotionLabel,
      activity: preparation.snapshot.simulation.currentActivity,
      decision: 'reply_now'
    }
  })
}))

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Request failed', error)
  if (error?.code === '23505') {
    return res.status(409).json({ error: 'record already exists' })
  }
  return res.status(500).json({ error: 'database operation failed' })
})

const port = process.env.PORT ? Number(process.env.PORT) : 3000

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
  app.listen(port, () => console.log(`Chatterra backend listening on ${port}`))
}

start().catch(error => {
  console.error('Backend startup failed', error)
  process.exitCode = 1
})

const shutdown = () => {
  closeDatabase().finally(() => process.exit())
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
