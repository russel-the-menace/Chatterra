import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { v4 as uuidv4 } from 'uuid'
import fs from 'fs'
import path from 'path'
import { User, Character, Conversation, Message, Memory } from './types'

dotenv.config()
const app = express()
app.use(cors())
app.use(express.json())

const DATA_DIR = path.join(__dirname, '..', 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

// simple file store (MVP)
const writeJson = (name: string, obj: any) => fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(obj, null, 2))
const readJson = (name: string, fallback: any) => {
  const p = path.join(DATA_DIR, name)
  if (!fs.existsSync(p)) return fallback
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fallback }
}

// bootstrapped stores
const users: User[] = readJson('users.json', [])
const characters: Character[] = readJson('characters.json', [])
const conversations: Conversation[] = readJson('conversations.json', [])
const messages: Message[] = readJson('messages.json', [])
const memories: Memory[] = readJson('memories.json', [])

const persistAll = () => {
  writeJson('users.json', users)
  writeJson('characters.json', characters)
  writeJson('conversations.json', conversations)
  writeJson('messages.json', messages)
  writeJson('memories.json', memories)
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))

// list conversations for a user
app.get('/api/conversations', (req, res) => {
  const userId = String(req.query.userId || '')
  if (!userId) return res.status(400).json({ error: 'userId required' })
  const list = conversations.filter(c => c.userId === userId)
  // sort by lastMessageAt desc
  list.sort((a,b) => (b.lastMessageAt || '')!.localeCompare(a.lastMessageAt || ''))
  res.json({ conversations: list })
})

// messages for a conversation
app.get('/api/conversations/:id/messages', (req, res) => {
  const id = req.params.id
  const list = messages.filter(m => m.conversationId === id)
  // sort by createdAt
  list.sort((a,b) => a.createdAt.localeCompare(b.createdAt))
  res.json({ messages: list })
})

// lightweight memory extraction (rule-based MVP)
function extractMemoryFromText(userId: string, conversationId: string, messageText: string, originMessageId: string) {
  // simple heuristics: look for "I am/I'm/I worked as/I was" patterns
  const lowered = messageText.toLowerCase()
  let match: string | null = null
  if (lowered.includes("i'm") || lowered.includes('i am') || lowered.includes('i was') || lowered.includes('i worked')) {
    match = messageText
  }
  if (!match) return null

  const mem: Memory = {
    id: uuidv4(),
    userId,
    characterId: undefined,
    originMessageId,
    type: 'important_fact',
    content: match,
    importanceScore: 0.6,
    confidence: 0.8,
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    metadata: { source: 'heuristic' }
  }
  memories.push(mem)
  persistAll()
  return mem
}

app.post('/api/chat', async (req, res) => {
  const { message, conversationId, userId, character } = req.body || {}

  if (!message) return res.status(400).json({ error: 'message is required' })
  if (!userId) return res.status(400).json({ error: 'userId is required' })

  // ensure conversation
  let convo = conversations.find(c => c.id === conversationId)
  if (!convo) {
    const newConvo: Conversation = {
      id: conversationId || uuidv4(),
      userId,
      characterId: character?.id || 'unknown',
      title: `${character?.name || 'Character'} chat`,
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }
    conversations.push(newConvo)
    convo = newConvo
  }

  // save user message
  const userMsg: Message = {
    id: uuidv4(),
    conversationId: convo.id,
    senderRole: 'user',
    senderId: userId,
    content: message,
    createdAt: new Date().toISOString()
  }
  messages.push(userMsg)
  convo.lastMessageAt = userMsg.createdAt
  persistAll()

  // call upstream AI (DeepSeek) using previous simple prompt
  const systemPrompt = `You are ${character?.name || 'an interviewer'}. Role: ${character?.role || ''}. Personality: ${character?.personality || ''}.\nRules: speak English, ask follow-ups.`
  const recent = messages.filter(m => m.conversationId === convo!.id).slice(-8)
  const convoText = recent.map(m => `${m.senderRole === 'user' ? 'Candidate' : 'Interviewer'}: ${m.content}`).join('\n')
  const finalPrompt = [systemPrompt, convoText, `Candidate: ${message}`].join('\n\n')

  const deepseekUrl = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.ai/v1/generate'
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'missing API key' })

  // Test shortcut: when running with DEEPSEEK_API_KEY=test, return a canned reply
    if (apiKey === 'test') {
    const canned = `(mock) ${character?.name || 'Interviewer'}: Thanks — I heard: "${message}". Can you expand on that?`
    const aiMsg: Message = {
      id: uuidv4(),
      conversationId: convo.id,
      senderRole: 'assistant',
      senderId: character?.id,
      content: canned,
      createdAt: new Date().toISOString()
    }
    messages.push(aiMsg)
    convo.lastMessageAt = aiMsg.createdAt
    persistAll()
    extractMemoryFromText(userId, convo.id, message, userMsg.id)
    return res.json({ reply: canned, conversationId: convo.id })
  }

  try {
    const resp = await fetch(deepseekUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ prompt: finalPrompt, max_tokens: 600 })
    })
    let data: any
    try { data = await resp.json() } catch (e) { data = await resp.text().catch(()=>null) }

    if (!resp.ok) {
      console.error('DeepSeek returned error', resp.status, data)
      return res.status(502).json({ error: 'Upstream AI returned an error' })
    }

    // flexible parsing for different provider shapes
    let reply: string = ''
    if (!reply && data) {
      if (typeof data === 'string') reply = data
      else if (typeof data.reply === 'string') reply = data.reply
      else if (typeof data.result === 'string') reply = data.result
      else if (data.choices && Array.isArray(data.choices) && data.choices[0]) {
        const first = data.choices[0]
        reply = first.message?.content || first.text || first.output || ''
      } else if (data.output_text) reply = data.output_text
    }

    if (!reply) reply = 'Sorry, I could not generate a response.'

    // save assistant message
    const aiMsg: Message = {
      id: uuidv4(),
      conversationId: convo.id,
      senderRole: 'assistant',
      senderId: character?.id,
      content: reply,
      createdAt: new Date().toISOString()
    }
    messages.push(aiMsg)
    convo.lastMessageAt = aiMsg.createdAt
    persistAll()

    // quick memory extraction from user message (MVP rule-based)
    extractMemoryFromText(userId, convo.id, message, userMsg.id)

    return res.json({ reply, conversationId: convo.id })
  } catch (err: any) {
    console.error('AI request failed', err)
    return res.status(500).json({ error: 'AI request failed' })
  }
})

const port = process.env.PORT ? Number(process.env.PORT) : 3000
app.listen(port, () => console.log(`Chatterra backend listening on ${port}`))
