import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { closeDatabase, withTransaction } from '../database'
import { Character, Conversation, ConversationSummary, Memory, Message, User } from '../types'

dotenv.config()

const dataDir = path.join(__dirname, '..', '..', 'data')

const readJson = <T>(name: string, fallback: T): T => {
  const filePath = path.join(dataDir, name)
  if (!fs.existsSync(filePath)) return fallback
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

const users = readJson<User[]>('users.json', [])
const characters = readJson<Character[]>('characters.json', [])
const conversations = readJson<Conversation[]>('conversations.json', [])
const messages = readJson<Message[]>('messages.json', [])
const memories = readJson<Memory[]>('memories.json', [])
const summaries = readJson<ConversationSummary[]>('conversation-summaries.json', [])

const run = async () => {
  const now = new Date().toISOString()
  const usersById = new Map(users.map(user => [user.id, user]))
  const referencedUserIds = new Set<string>([
    ...conversations.map(conversation => conversation.userId),
    ...memories.map(memory => memory.userId),
    ...messages
      .filter(message => message.senderRole === 'user' && message.senderId)
      .map(message => message.senderId!)
  ])

  referencedUserIds.forEach(userId => {
    if (usersById.has(userId)) return
    usersById.set(userId, {
      id: userId,
      displayName: 'Imported User',
      createdAt: now,
      updatedAt: now
    })
  })

  const charactersById = new Map(characters.map(character => [character.id, character]))
  const referencedCharacterIds = new Set<string>([
    ...conversations.map(conversation => conversation.characterId),
    ...memories.filter(memory => memory.characterId).map(memory => memory.characterId!)
  ])
  referencedCharacterIds.forEach(characterId => {
    if (charactersById.has(characterId)) return
    charactersById.set(characterId, {
      id: characterId,
      name: `Imported Character ${characterId}`,
      createdAt: now,
      updatedAt: now
    })
  })

  const conversationIds = new Set(conversations.map(conversation => conversation.id))
  const importableMessages = messages.filter(message => conversationIds.has(message.conversationId))
  const messageIds = new Set(importableMessages.map(message => message.id))

  await withTransaction(async client => {
    for (const user of usersById.values()) {
      await client.query(
        `INSERT INTO users (
           id, display_name, email, native_language, learning_goals, preferences,
           consent_flags, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          user.id,
          user.displayName,
          user.email ?? null,
          user.nativeLanguage ?? null,
          JSON.stringify(user.learningGoals || {}),
          JSON.stringify(user.preferences || {}),
          JSON.stringify({
            ...(user.consentFlags || {}),
            memoryPersonalization: user.consentFlags?.memoryPersonalization !== false
          }),
          user.createdAt || now,
          user.updatedAt || user.createdAt || now
        ]
      )
    }

    for (const character of charactersById.values()) {
      await client.query(
        `INSERT INTO characters (
           id, name, avatar, role, personality, company, scenario, goal, language,
           background, system_prompt_template, default_settings, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
         ON CONFLICT (id) DO NOTHING`,
        [
          character.id,
          character.name,
          character.avatar ?? null,
          character.role ?? null,
          character.personality ?? null,
          character.company ?? null,
          character.scenario ?? null,
          character.goal ?? null,
          character.language ?? null,
          character.background ?? null,
          character.systemPromptTemplate ?? null,
          JSON.stringify({}),
          character.createdAt || now,
          character.updatedAt || character.createdAt || now
        ]
      )
    }

    for (const character of charactersById.values()) {
      await client.query(
        `INSERT INTO character_versions (id, character_id, version, definition, created_at)
         SELECT $1, c.id, COALESCE(c.current_version, 1), jsonb_build_object(
           'name', c.name,
           'avatar', COALESCE(c.avatar, ''),
           'role', COALESCE(c.role, ''),
           'company', COALESCE(c.company, ''),
           'personality', COALESCE(c.personality, ''),
           'scenario', COALESCE(c.scenario, ''),
           'goal', COALESCE(c.goal, ''),
           'language', COALESCE(c.language, ''),
           'background', COALESCE(c.background, ''),
           'systemPromptTemplate', COALESCE(c.system_prompt_template, '')
         ), c.updated_at
         FROM characters c
         WHERE c.id = $2
         ON CONFLICT (character_id, version) DO NOTHING`,
        [`${character.id}:v${character.currentVersion || 1}`, character.id]
      )
    }

    for (const conversation of conversations) {
      await client.query(
        `INSERT INTO conversations (
           id, user_id, character_id, title, status, last_message_at, metadata, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          conversation.id,
          conversation.userId,
          conversation.characterId,
          conversation.title ?? null,
          conversation.status || 'active',
          conversation.lastMessageAt ?? null,
          JSON.stringify(conversation.metadata || {}),
          conversation.createdAt,
          conversation.updatedAt
        ]
      )
    }

    for (const message of importableMessages) {
      await client.query(
        `INSERT INTO messages (
           id, conversation_id, sender_role, sender_id, content, content_json, token_count, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          message.id,
          message.conversationId,
          message.senderRole,
          message.senderId ?? null,
          message.content,
          message.contentJson ? JSON.stringify(message.contentJson) : null,
          message.tokenCount ?? null,
          message.createdAt
        ]
      )
    }

    for (const memory of memories) {
      await client.query(
        `INSERT INTO memories (
           id, user_id, character_id, origin_message_id, type, content, importance_score,
           confidence, created_at, last_accessed_at, last_updated_at, metadata
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          memory.id,
          memory.userId,
          memory.characterId && charactersById.has(memory.characterId) ? memory.characterId : null,
          memory.originMessageId && messageIds.has(memory.originMessageId) ? memory.originMessageId : null,
          memory.type,
          memory.content,
          memory.importanceScore,
          memory.confidence ?? null,
          memory.createdAt,
          memory.lastAccessedAt ?? null,
          memory.lastUpdatedAt ?? memory.createdAt,
          JSON.stringify(memory.metadata || {})
        ]
      )
    }

    for (const summary of summaries.filter(item => conversationIds.has(item.conversationId))) {
      await client.query(
        `INSERT INTO conversation_summaries (
           id, conversation_id, summary_text, last_generated_at, coverage
         ) VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [
          summary.id,
          summary.conversationId,
          summary.summaryText,
          summary.lastGeneratedAt,
          JSON.stringify(summary.coverage || {})
        ]
      )
    }
  })

  console.log(JSON.stringify({
    users: usersById.size,
    characters: charactersById.size,
    conversations: conversations.length,
    messages: importableMessages.length,
    skippedMessages: messages.length - importableMessages.length,
    memories: memories.length,
    summaries: summaries.filter(item => conversationIds.has(item.conversationId)).length
  }, null, 2))
}

run()
  .catch(error => {
    console.error('JSON import failed', error)
    process.exitCode = 1
  })
  .finally(() => closeDatabase())
