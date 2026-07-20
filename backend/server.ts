import express, { NextFunction, Request, Response } from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { closeDatabase, query } from './database'
import {
  appendMessage,
  clearChatHistory,
  createCharacter,
  createConversationWithStarter,
  createMemory,
  getCharacter,
  getConversation,
  listCharacters,
  listConversations,
  listMessages,
  listRecentMessages,
  newId,
  updateCharacter
} from './repository'
import { Character, Conversation, Memory, Message } from './types'

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

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

  const settings = payload?.defaultSettings
  if (settings && typeof settings === 'object') {
    character.defaultSettings = {
      maxResponseTokens: Number.isFinite(Number(settings.maxResponseTokens))
        ? Math.max(1, Math.round(Number(settings.maxResponseTokens)))
        : existing?.defaultSettings?.maxResponseTokens,
      temperature: Number.isFinite(Number(settings.temperature))
        ? Math.min(2, Math.max(0, Number(settings.temperature)))
        : existing?.defaultSettings?.temperature,
      contextWindow: Number.isFinite(Number(settings.contextWindow))
        ? Math.max(1, Math.round(Number(settings.contextWindow)))
        : existing?.defaultSettings?.contextWindow
    }
  }

  return character
}

const interpolatePrompt = (template: string, character: Character) => {
  const values: Record<string, string> = {
    name: character.name || '',
    role: character.role || '',
    company: character.company || '',
    personality: character.personality || '',
    scenario: character.scenario || '',
    goal: character.goal || '',
    language: character.language || '',
    background: character.background || ''
  }

  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) => values[key] ?? match)
}

const getSystemPrompt = (character?: Character) => {
  if (!character) return 'You are a helpful conversation partner.'
  if (character.systemPromptTemplate?.trim()) {
    return interpolatePrompt(character.systemPromptTemplate, character)
  }

  return [
    `You are ${character.name}.`,
    character.role ? `Role: ${character.role}.` : '',
    character.company ? `Company: ${character.company}.` : '',
    character.personality ? `Personality: ${character.personality}.` : '',
    character.background ? `Background: ${character.background}.` : '',
    character.scenario ? `Scenario: ${character.scenario}.` : '',
    character.goal ? `Goal: ${character.goal}.` : '',
    character.language ? `Language: ${character.language}.` : '',
    'Stay in character and ask useful follow-up questions.'
  ].filter(Boolean).join('\n')
}

const getStarterMessage = (character?: Character) => {
  if (character?.id === 'c2') {
    return 'Hi. First, I will correct your English and programmer mistakes, then I will help you practice naturally. Start by telling me about your current project.'
  }

  return `Hello, I'm ${character?.name || 'Interviewer'}. Let's start the interview. Tell me briefly about your background.`
}

const extractMemoryFromText = async (
  userId: string,
  characterId: string,
  messageText: string,
  originMessageId: string
) => {
  const lowered = messageText.toLowerCase()
  if (!lowered.includes("i'm") && !lowered.includes('i am') && !lowered.includes('i was') && !lowered.includes('i worked')) {
    return null
  }

  const now = new Date().toISOString()
  const memory: Memory = {
    id: newId(),
    userId,
    characterId,
    originMessageId,
    type: 'important_fact',
    content: messageText,
    importanceScore: 0.6,
    confidence: 0.8,
    createdAt: now,
    lastUpdatedAt: now,
    metadata: { source: 'heuristic' }
  }
  return createMemory(memory)
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  await query('SELECT 1')
  return res.json({ status: 'ok', database: 'postgresql' })
}))

app.get('/api/characters', asyncRoute(async (_req, res) => {
  const characters = await listCharacters()
  return res.json({ characters })
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

app.delete('/api/chat-history', asyncRoute(async (req, res) => {
  const { userId, characterId } = req.body || {}
  if (!userId) return res.status(400).json({ error: 'userId is required' })
  if (!characterId) return res.status(400).json({ error: 'characterId is required' })

  const result = await clearChatHistory(String(userId), String(characterId))
  return res.json({ ok: true, characterId, ...result })
}))

app.post('/api/chat', asyncRoute(async (req, res) => {
  const { message, conversationId, userId, character } = req.body || {}
  if (!message) return res.status(400).json({ error: 'message is required' })
  if (!userId) return res.status(400).json({ error: 'userId is required' })
  if (!character?.id) return res.status(400).json({ error: 'character is required' })

  const storedCharacter = await getCharacter(String(character.id))
  if (!storedCharacter) return res.status(400).json({ error: 'character not found' })

  let conversation = conversationId
    ? await getConversation(String(conversationId))
    : undefined

  if (conversation && conversation.userId !== String(userId)) {
    return res.status(403).json({ error: 'conversation does not belong to this user' })
  }
  if (conversation && conversation.characterId !== storedCharacter.id) {
    return res.status(400).json({ error: 'conversation character mismatch' })
  }

  if (!conversation) {
    const now = new Date().toISOString()
    const nextConversation: Conversation = {
      id: conversationId || newId(),
      userId: String(userId),
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
    senderId: String(userId),
    content: String(message),
    createdAt: new Date().toISOString()
  }
  await appendMessage(userMessage)

  const systemPrompt = getSystemPrompt(storedCharacter)
  const contextWindow = storedCharacter.defaultSettings?.contextWindow || 8
  const recent = await listRecentMessages(conversation.id, contextWindow)
  const conversationText = recent
    .map(item => `${item.senderRole === 'user' ? 'Candidate' : 'Interviewer'}: ${item.content}`)
    .join('\n')

  const apiMode = process.env.DEEPSEEK_API_MODE || 'live'
  if (apiMode === 'mock') {
    const reply = storedCharacter.id === 'c2'
      ? `First, small correction: a more natural way to say that is: “${message}.” Now tell me a little more.`
      : `(mock) ${storedCharacter.name}: Thanks — I heard: "${message}". Can you expand on that?`
    const assistantMessage: Message = {
      id: newId(),
      conversationId: conversation.id,
      senderRole: 'assistant',
      senderId: storedCharacter.id,
      content: reply,
      createdAt: new Date().toISOString()
    }
    await appendMessage(assistantMessage)
    await extractMemoryFromText(String(userId), storedCharacter.id, String(message), userMessage.id)
    return res.json({ reply, conversationId: conversation.id })
  }

  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'missing API key' })

  const deepseekUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions'
  const deepseekModel = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'

  try {
    const response = await fetch(deepseekUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: deepseekModel,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: conversationText }
        ],
        max_tokens: storedCharacter.defaultSettings?.maxResponseTokens || 600,
        temperature: storedCharacter.defaultSettings?.temperature ?? 0.7,
        stream: false
      })
    })

    let data: any
    try {
      data = await response.json()
    } catch {
      data = await response.text().catch(() => null)
    }

    if (!response.ok) {
      console.error('DeepSeek returned error', response.status, data)
      return res.status(502).json({ error: 'Upstream AI returned an error' })
    }

    let reply = ''
    if (typeof data === 'string') reply = data
    else if (typeof data?.reply === 'string') reply = data.reply
    else if (typeof data?.result === 'string') reply = data.result
    else if (data?.choices && Array.isArray(data.choices) && data.choices[0]) {
      const first = data.choices[0]
      reply = first.message?.content || first.text || first.output || ''
    } else if (data?.output_text) reply = data.output_text

    if (!reply) reply = 'Sorry, I could not generate a response.'

    const assistantMessage: Message = {
      id: newId(),
      conversationId: conversation.id,
      senderRole: 'assistant',
      senderId: storedCharacter.id,
      content: reply,
      createdAt: new Date().toISOString()
    }
    await appendMessage(assistantMessage)
    await extractMemoryFromText(String(userId), storedCharacter.id, String(message), userMessage.id)

    return res.json({ reply, conversationId: conversation.id })
  } catch (error) {
    console.error('AI request failed', error)
    return res.status(500).json({ error: 'AI request failed' })
  }
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
  const schemaResult = await query(`SELECT to_regclass('public.characters') AS table_name`)
  if (!schemaResult.rows[0]?.table_name) {
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
