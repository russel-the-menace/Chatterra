import { PoolClient } from 'pg'
import { v4 as uuidv4 } from 'uuid'
import { query, withTransaction } from './database'
import { Character, Conversation, ConversationSummary, Memory, Message } from './types'

const iso = (value: Date | string | null | undefined): string | undefined => {
  if (!value) return undefined
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

const mapCharacter = (row: any): Character => ({
  id: row.id,
  name: row.name,
  avatar: row.avatar ?? undefined,
  role: row.role ?? undefined,
  personality: row.personality ?? undefined,
  company: row.company ?? undefined,
  scenario: row.scenario ?? undefined,
  goal: row.goal ?? undefined,
  language: row.language ?? undefined,
  background: row.background ?? undefined,
  systemPromptTemplate: row.system_prompt_template ?? undefined,
  currentVersion: Number(row.current_version || 1),
  createdAt: iso(row.created_at)!,
  updatedAt: iso(row.updated_at)!
})

const mapConversation = (row: any): Conversation => ({
  id: row.id,
  userId: row.user_id,
  characterId: row.character_id,
  title: row.title ?? undefined,
  status: row.status,
  lastMessageAt: iso(row.last_message_at),
  metadata: row.metadata || undefined,
  createdAt: iso(row.created_at)!,
  updatedAt: iso(row.updated_at)!
})

const mapMessage = (row: any): Message => ({
  id: row.id,
  conversationId: row.conversation_id,
  senderRole: row.sender_role,
  senderId: row.sender_id ?? undefined,
  content: row.content,
  contentJson: row.content_json ?? undefined,
  tokenCount: row.token_count ?? undefined,
  createdAt: iso(row.created_at)!
})

const mapMemory = (row: any): Memory => ({
  id: row.id,
  userId: row.user_id,
  characterId: row.character_id ?? undefined,
  originMessageId: row.origin_message_id ?? undefined,
  type: row.type,
  content: row.content,
  importanceScore: Number(row.importance_score),
  confidence: row.confidence == null ? undefined : Number(row.confidence),
  createdAt: iso(row.created_at)!,
  lastAccessedAt: iso(row.last_accessed_at),
  lastUpdatedAt: iso(row.last_updated_at),
  metadata: row.metadata || undefined,
  representation: row.representation || 'semantic',
  retentionTier: row.retention_tier || 'durable',
  retrievalStrength: Number(row.retrieval_strength ?? row.importance_score ?? 0.6),
  halfLifeHours: Number(row.half_life_hours || 720),
  sensitivity: row.sensitivity || 'normal',
  validFrom: iso(row.valid_from),
  validTo: iso(row.valid_to),
  supersedesId: row.supersedes_id || undefined,
  confirmed: Boolean(row.confirmed)
})

const ensureUser = async (client: PoolClient, userId: string) => {
  await client.query(
    `INSERT INTO users (id, display_name, consent_flags)
     VALUES ($1, $2, '{"memoryPersonalization": true}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [userId, 'Local User']
  )
  await client.query(
    `INSERT INTO user_learning_profiles (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  )
}

const characterDefinition = (character: Character) => JSON.stringify({
  name: character.name,
  avatar: character.avatar || '',
  role: character.role || '',
  company: character.company || '',
  personality: character.personality || '',
  scenario: character.scenario || '',
  goal: character.goal || '',
  language: character.language || '',
  background: character.background || '',
  systemPromptTemplate: character.systemPromptTemplate || ''
})

const insertCharacterVersion = async (
  client: PoolClient,
  character: Character,
  version: number
) => {
  await client.query(
    `INSERT INTO character_versions (id, character_id, version, definition, created_at)
     VALUES ($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (character_id, version) DO NOTHING`,
    [
      `${character.id}:v${version}`,
      character.id,
      version,
      characterDefinition(character),
      character.updatedAt || new Date().toISOString()
    ]
  )
}

export const getUserPreferences = async (userId: string) => {
  return withTransaction(async client => {
    await ensureUser(client, userId)
    const result = await client.query(
      `SELECT preferences, consent_flags
       FROM users
       WHERE id = $1`,
      [userId]
    )
    const row = result.rows[0] || {}
    const configuredMemory = row.consent_flags?.memoryPersonalization
    return {
      preferences: row.preferences || {},
      memoryEnabled: configuredMemory !== false
    }
  })
}

export const setUserMemoryConsent = async (userId: string, enabled: boolean) => {
  return withTransaction(async client => {
    await ensureUser(client, userId)
    const result = await client.query(
      `UPDATE users SET
         consent_flags = jsonb_set(consent_flags, '{memoryPersonalization}', $2::jsonb, TRUE),
         updated_at = NOW()
       WHERE id = $1
       RETURNING consent_flags`,
      [userId, JSON.stringify(enabled)]
    )
    return Boolean(result.rows[0]?.consent_flags?.memoryPersonalization)
  })
}

export const listCharacters = async (): Promise<Character[]> => {
  const result = await query('SELECT * FROM characters ORDER BY created_at, name')
  return result.rows.map(mapCharacter)
}

export const getCharacter = async (id: string): Promise<Character | undefined> => {
  const result = await query('SELECT * FROM characters WHERE id = $1', [id])
  return result.rows[0] ? mapCharacter(result.rows[0]) : undefined
}

export const createCharacter = async (character: Character): Promise<Character> => {
  return withTransaction(async client => {
    const result = await client.query(
      `INSERT INTO characters (
         id, name, avatar, role, personality, company, scenario, goal, language,
         background, system_prompt_template, default_settings, current_version,
         created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}'::jsonb, 1, $12, $13
       )
       RETURNING *`,
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
        character.createdAt,
        character.updatedAt
      ]
    )
    const created = mapCharacter(result.rows[0])
    await insertCharacterVersion(client, created, 1)
    return created
  })
}

export const updateCharacter = async (character: Character): Promise<Character | undefined> => {
  return withTransaction(async client => {
    const currentResult = await client.query(
      'SELECT current_version FROM characters WHERE id = $1 FOR UPDATE',
      [character.id]
    )
    if (!currentResult.rows[0]) return undefined

    const nextVersion = Number(currentResult.rows[0].current_version || 1) + 1
    const result = await client.query(
      `UPDATE characters SET
         name = $2,
         avatar = $3,
         role = $4,
         personality = $5,
         company = $6,
         scenario = $7,
         goal = $8,
         language = $9,
         background = $10,
         system_prompt_template = $11,
         current_version = $12,
         updated_at = $13
       WHERE id = $1
       RETURNING *`,
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
        nextVersion,
        character.updatedAt
      ]
    )
    const updated = result.rows[0] ? mapCharacter(result.rows[0]) : undefined
    if (updated) {
      await insertCharacterVersion(client, updated, nextVersion)
      await client.query(
        `UPDATE character_instances
         SET template_version = $2, updated_at = $3
         WHERE character_id = $1`,
        [updated.id, nextVersion, updated.updatedAt]
      )
    }
    return updated
  })
}

export const listConversations = async (userId: string): Promise<Conversation[]> => {
  const result = await query(
    `SELECT * FROM conversations
     WHERE user_id = $1
     ORDER BY last_message_at DESC NULLS LAST, created_at DESC`,
    [userId]
  )
  return result.rows.map(mapConversation)
}

export const getConversation = async (id: string): Promise<Conversation | undefined> => {
  const result = await query('SELECT * FROM conversations WHERE id = $1', [id])
  return result.rows[0] ? mapConversation(result.rows[0]) : undefined
}

export const listMessages = async (conversationId: string): Promise<Message[]> => {
  const result = await query(
    `SELECT * FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at, id`,
    [conversationId]
  )
  return result.rows.map(mapMessage)
}

export const listRecentMessages = async (conversationId: string, limit: number): Promise<Message[]> => {
  const result = await query(
    `SELECT * FROM (
       SELECT * FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2
     ) recent
     ORDER BY created_at, id`,
    [conversationId, limit]
  )
  return result.rows.map(mapMessage)
}

export const getLatestConversationSummary = async (
  conversationId: string
): Promise<ConversationSummary | undefined> => {
  const result = await query(
    `SELECT * FROM conversation_summaries
     WHERE conversation_id = $1
     ORDER BY last_generated_at DESC
     LIMIT 1`,
    [conversationId]
  )
  const row = result.rows[0]
  if (!row) return undefined
  return {
    id: row.id,
    conversationId: row.conversation_id,
    summaryText: row.summary_text,
    lastGeneratedAt: iso(row.last_generated_at)!,
    coverage: row.coverage || undefined
  }
}

export const getUserLearningContext = async (userId: string) => {
  const result = await query(
    `SELECT
       u.learning_goals,
       lp.target_language,
       lp.proficiency,
       lp.correction_mode,
       lp.goals
     FROM users u
     LEFT JOIN user_learning_profiles lp ON lp.user_id = u.id
     WHERE u.id = $1`,
    [userId]
  )
  const row = result.rows[0]
  return {
    userGoals: row?.learning_goals || {},
    targetLanguage: row?.target_language || undefined,
    proficiency: row?.proficiency || {},
    correctionMode: row?.correction_mode || 'selective',
    learningGoals: row?.goals || {}
  }
}

export const listMemoryCandidates = async (
  userId: string,
  characterId: string,
  limit = 100
): Promise<Memory[]> => {
  const result = await query(
    `SELECT * FROM memories
     WHERE user_id = $1
       AND (character_id = $2 OR character_id IS NULL)
       AND retention_tier <> 'archived'
       AND (valid_to IS NULL OR valid_to > NOW())
     ORDER BY importance_score DESC, retrieval_strength DESC, created_at DESC
     LIMIT $3`,
    [userId, characterId, Math.max(1, Math.min(250, Math.round(limit)))]
  )
  return result.rows.map(mapMemory)
}

export const touchMemories = async (memoryIds: string[]) => {
  if (memoryIds.length === 0) return
  await query(
    `UPDATE memories
     SET last_accessed_at = NOW()
     WHERE id = ANY($1::text[])`,
    [memoryIds]
  )
}

export const createConversationWithStarter = async (
  conversation: Conversation,
  starterMessage: Message
): Promise<Conversation> => {
  return withTransaction(async client => {
    await ensureUser(client, conversation.userId)
    const conversationResult = await client.query(
      `INSERT INTO conversations (
         id, user_id, character_id, title, status, last_message_at, metadata, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       RETURNING *`,
      [
        conversation.id,
        conversation.userId,
        conversation.characterId,
        conversation.title ?? null,
        conversation.status || 'active',
        starterMessage.createdAt,
        JSON.stringify(conversation.metadata || {}),
        conversation.createdAt,
        conversation.updatedAt
      ]
    )
    await client.query(
      `INSERT INTO messages (
         id, conversation_id, sender_role, sender_id, content, content_json, token_count, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        starterMessage.id,
        starterMessage.conversationId,
        starterMessage.senderRole,
        starterMessage.senderId ?? null,
        starterMessage.content,
        starterMessage.contentJson ? JSON.stringify(starterMessage.contentJson) : null,
        starterMessage.tokenCount ?? null,
        starterMessage.createdAt
      ]
    )
    return mapConversation(conversationResult.rows[0])
  })
}

export const appendMessage = async (message: Message): Promise<Message> => {
  return withTransaction(async client => {
    const result = await client.query(
      `INSERT INTO messages (
         id, conversation_id, sender_role, sender_id, content, content_json, token_count, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING *`,
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
    await client.query(
      `UPDATE conversations
       SET last_message_at = $2, updated_at = $2
       WHERE id = $1`,
      [message.conversationId, message.createdAt]
    )
    return mapMessage(result.rows[0])
  })
}

export const createMemory = async (memory: Memory): Promise<Memory> => {
  const result = await query(
    `INSERT INTO memories (
       id, user_id, character_id, origin_message_id, type, content, importance_score,
       confidence, created_at, last_accessed_at, last_updated_at, metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
     RETURNING *`,
    [
      memory.id,
      memory.userId,
      memory.characterId ?? null,
      memory.originMessageId ?? null,
      memory.type,
      memory.content,
      memory.importanceScore,
      memory.confidence ?? null,
      memory.createdAt,
      memory.lastAccessedAt ?? null,
      memory.lastUpdatedAt ?? null,
      JSON.stringify(memory.metadata || {})
    ]
  )
  return mapMemory(result.rows[0])
}

export const clearChatHistory = async (userId: string, characterId: string) => {
  return withTransaction(async client => {
    const conversationsResult = await client.query(
      `SELECT id FROM conversations WHERE user_id = $1 AND character_id = $2`,
      [userId, characterId]
    )
    const conversationIds = conversationsResult.rows.map(row => row.id)

    const messageCountResult = conversationIds.length > 0
      ? await client.query(
          `SELECT COUNT(*)::int AS count FROM messages WHERE conversation_id = ANY($1::text[])`,
          [conversationIds]
        )
      : { rows: [{ count: 0 }] }

    const memoryDeleteResult = await client.query(
      `DELETE FROM memories WHERE user_id = $1 AND character_id = $2`,
      [userId, characterId]
    )
    const conversationDeleteResult = await client.query(
      `DELETE FROM conversations WHERE user_id = $1 AND character_id = $2`,
      [userId, characterId]
    )

    return {
      deletedConversations: conversationDeleteResult.rowCount || 0,
      deletedMessages: Number(messageCountResult.rows[0].count),
      deletedMemories: memoryDeleteResult.rowCount || 0
    }
  })
}

export const newId = () => uuidv4()
