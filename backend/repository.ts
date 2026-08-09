import { PoolClient } from 'pg'
import { v4 as uuidv4 } from 'uuid'
import {
  createAccessToken,
  hashAccessToken,
  PERMANENT_SESSION_EXPIRES_AT,
  verifyPasswordHash,
} from './authentication'
import { query, withTransaction } from './database'
import {
  Character,
  Conversation,
  ConversationSyncRecord,
  ConversationSummary,
  Memory,
  Message,
  MessageTranslation,
  SyncSnapshot,
  ChatStreak
} from './types'
import { chatStreakStatusFor, streakDateKey } from './chat-streak'

const iso = (value: Date | string | null | undefined): string | undefined => {
  if (!value) return undefined
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString()
}

const defaultTranslationTargetLanguage = (username?: string) => {
  const normalizedUsername = username?.trim().toLowerCase() || ''
  if (normalizedUsername === 'junling') return 'Chinese'
  return 'English'
}

const normalizeTranslationTargetLanguage = (value: unknown, username?: string) => {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return defaultTranslationTargetLanguage(username)
}

const mapCharacter = (row: any): Character => ({
  id: row.id,
  name: row.name,
  avatar: row.avatar_override ?? row.avatar ?? undefined,
  role: row.role ?? undefined,
  personality: row.personality ?? undefined,
  company: row.company ?? undefined,
  scenario: row.scenario ?? undefined,
  goal: row.goal ?? undefined,
  language: row.language ?? undefined,
  background: row.background ?? undefined,
  systemPromptTemplate: row.system_prompt_template ?? undefined,
  ownerUserId: row.owner_user_id ?? undefined,
  runtimeConfig: row.default_settings && Object.keys(row.default_settings).length > 0
    ? row.default_settings
    : undefined,
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

const mapMessage = (row: any): Message => {
  const englishTranslations = row.english_translations || {}
  const hasEnglishTranslations = Object.keys(englishTranslations).length > 0
  const existingContentJson = row.content_json || {}
  const contentJson = hasEnglishTranslations
    ? {
        ...existingContentJson,
        translations: {
          ...(existingContentJson.translations || {}),
          en: englishTranslations
        }
      }
    : row.content_json ?? undefined

  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderRole: row.sender_role,
    senderId: row.sender_id ?? undefined,
    content: row.content,
    contentJson,
    tokenCount: row.token_count ?? undefined,
    createdAt: iso(row.created_at)!
  }
}

const mapMessageTranslation = (row: any): MessageTranslation => ({
  id: row.id,
  messageId: row.message_id,
  segmentIndex: Number(row.segment_index),
  targetLanguage: row.target_language,
  translatedText: row.translated_text,
  provider: row.provider,
  model: row.model,
  createdAt: iso(row.created_at)!,
  updatedAt: iso(row.updated_at)!
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
  const user = await client.query('SELECT 1 FROM users WHERE id = $1', [userId])
  if (user.rowCount === 0) throw new Error('authenticated user not found')
  await client.query(
    `INSERT INTO user_learning_profiles (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId]
  )
}

export type AuthenticatedUser = {
  id: string
  username: string
  displayName: string
  translationTargetLanguage: string
}

export type LoginResult = {
  accessToken: string
  expiresAt: string
  user: AuthenticatedUser
}

export const authenticateUser = async (username: string, password: string): Promise<LoginResult | undefined> => {
  const normalizedUsername = username.trim().toLowerCase()
  const result = await query(
    `SELECT id, username, display_name, preferences, password_hash
     FROM users
     WHERE LOWER(username) = $1
     LIMIT 1`,
    [normalizedUsername]
  )
  const row = result.rows[0]
  if (!row?.password_hash || !verifyPasswordHash(password, String(row.password_hash))) {
    return undefined
  }

  const accessToken = createAccessToken()
  const isPublicTestAccount = normalizedUsername === 'test'
  await withTransaction(async client => {
    await client.query(
      `DELETE FROM auth_sessions
       WHERE user_id = $1
         AND (expires_at <= NOW() OR ($2::boolean AND created_at < NOW() - INTERVAL '1 day'))`,
      [row.id, isPublicTestAccount]
    )
    await client.query(
      `INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN NOW() + INTERVAL '1 day' ELSE 'infinity'::timestamptz END)`,
      [newId(), row.id, hashAccessToken(accessToken), isPublicTestAccount]
    )
  })

  return {
    accessToken,
    expiresAt: isPublicTestAccount
      ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
      : PERMANENT_SESSION_EXPIRES_AT,
    user: {
      id: String(row.id),
      username: String(row.username),
      displayName: String(row.display_name),
      translationTargetLanguage: normalizeTranslationTargetLanguage(row.preferences?.translationTargetLanguage, String(row.username)),
    }
  }
}

export const getAuthenticatedUser = async (accessToken: string): Promise<AuthenticatedUser | undefined> => {
  if (!accessToken) return undefined
  const result = await query(
    `SELECT users.id, users.username, users.display_name, users.preferences
     FROM auth_sessions
     JOIN users ON users.id = auth_sessions.user_id
     WHERE auth_sessions.token_hash = $1
       AND auth_sessions.expires_at > NOW()
     LIMIT 1`,
    [hashAccessToken(accessToken)]
  )
  const row = result.rows[0]
  if (!row?.id || !row.username || !row.display_name) return undefined
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    translationTargetLanguage: normalizeTranslationTargetLanguage(row.preferences?.translationTargetLanguage, String(row.username)),
  }
}

export const getUserCreatedAt = async (userId: string): Promise<string | undefined> => {
  const result = await query(
    'SELECT created_at FROM users WHERE id = $1 LIMIT 1',
    [userId]
  )
  return result.rows[0] ? iso(result.rows[0].created_at) : undefined
}

export const deleteAuthenticatedSession = async (accessToken: string) => {
  if (!accessToken) return
  await query('DELETE FROM auth_sessions WHERE token_hash = $1', [hashAccessToken(accessToken)])
}

const insertCharacterVersion = async (
  client: PoolClient,
  character: Character,
  version: number
) => {
  await client.query(
    `INSERT INTO character_versions (id, character_id, version, created_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (character_id, version) DO NOTHING`,
    [
      `${character.id}:v${version}`,
      character.id,
      version,
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

export const setUserAvatar = async (userId: string, avatar: string) => {
  return withTransaction(async client => {
    await ensureUser(client, userId)
    const result = await client.query(
      `UPDATE users SET
         preferences = jsonb_set(
           COALESCE(preferences, '{}'::jsonb),
           '{avatar}',
           to_jsonb($2::text),
           TRUE
         ),
         updated_at = NOW()
       WHERE id = $1
       RETURNING preferences`,
      [userId, avatar]
    )
    return typeof result.rows[0]?.preferences?.avatar === 'string'
      ? result.rows[0].preferences.avatar
      : undefined
  })
}

export const updateUserProfile = async (
  userId: string,
  input: { displayName: string; avatar?: string; translationTargetLanguage?: string }
) => {
  return withTransaction(async client => {
    await ensureUser(client, userId)
    const avatarValue = input.avatar === undefined ? null : (input.avatar || null)
    const translationTargetLanguageValue = input.translationTargetLanguage === undefined
      ? null
      : (input.translationTargetLanguage.trim() || null)
    const result = await client.query(
      `UPDATE users SET
         display_name = $2,
         preferences = COALESCE(preferences, '{}'::jsonb)
           || jsonb_strip_nulls(jsonb_build_object(
             'avatar', $3::text,
             'translationTargetLanguage', $4::text
           )),
         updated_at = NOW()
       WHERE id = $1
       RETURNING display_name, preferences`,
      [userId, input.displayName, avatarValue, translationTargetLanguageValue]
    )
    const row = result.rows[0] || {}
    return {
      userName: typeof row.display_name === 'string' ? row.display_name : undefined,
      userAvatar: typeof row.preferences?.avatar === 'string' ? row.preferences.avatar : undefined,
      userTranslationTargetLanguage: normalizeTranslationTargetLanguage(row.preferences?.translationTargetLanguage, undefined),
    }
  })
}

export const listPinnedCharacterIds = async (userId: string): Promise<string[]> => {
  return withTransaction(async client => {
    await ensureUser(client, userId)
    const result = await client.query(
      `SELECT character_id
       FROM user_character_preferences
       WHERE user_id = $1 AND pinned_at IS NOT NULL
       ORDER BY pinned_at DESC, character_id`,
      [userId]
    )
    return result.rows.map(row => String(row.character_id))
  })
}

export const setCharacterPinned = async (
  userId: string,
  characterId: string,
  pinned: boolean
): Promise<boolean | undefined> => {
  return withTransaction(async client => {
    await ensureUser(client, userId)
    const characterResult = await client.query(
      'SELECT 1 FROM characters WHERE id = $1 AND (owner_user_id IS NULL OR owner_user_id = $2)',
      [characterId, userId]
    )
    if (!characterResult.rowCount) return undefined

    if (pinned) {
      await client.query(
        `INSERT INTO user_character_preferences (user_id, character_id, pinned_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (user_id, character_id)
         DO UPDATE SET pinned_at = EXCLUDED.pinned_at`,
        [userId, characterId]
      )
    } else {
      await client.query(
        `UPDATE user_character_preferences
         SET pinned_at = NULL
         WHERE user_id = $1 AND character_id = $2`,
        [userId, characterId]
      )
      await client.query(
        `DELETE FROM user_character_preferences
         WHERE user_id = $1
           AND character_id = $2
           AND pinned_at IS NULL
           AND avatar_override IS NULL`,
        [userId, characterId]
      )
    }

    return pinned
  })
}

export const listCharacters = async (userId?: string): Promise<Character[]> => {
  const result = userId
    ? await query(
      `SELECT characters.*, preferences.avatar_override
       FROM characters
       LEFT JOIN user_character_preferences preferences
         ON preferences.character_id = characters.id
         AND preferences.user_id = $1
       WHERE characters.owner_user_id IS NULL OR characters.owner_user_id = $1
       ORDER BY characters.created_at, characters.name`,
      [userId]
    )
    : await query('SELECT * FROM characters WHERE owner_user_id IS NULL ORDER BY created_at, name')
  return result.rows.map(mapCharacter)
}

export const setBuiltInCharacterAvatar = async (
  userId: string,
  characterId: string,
  avatar: string
): Promise<Character | undefined> => {
  return withTransaction(async client => {
    await ensureUser(client, userId)
    const characterResult = await client.query(
      `SELECT * FROM characters
       WHERE id = $1 AND owner_user_id IS NULL
       FOR UPDATE`,
      [characterId]
    )
    const character = characterResult.rows[0]
    if (!character) return undefined
    await client.query(
      `INSERT INTO user_character_preferences (
         user_id, character_id, pinned_at, avatar_override
       ) VALUES ($1, $2, NULL, $3)
       ON CONFLICT (user_id, character_id)
       DO UPDATE SET avatar_override = EXCLUDED.avatar_override`,
      [userId, characterId, avatar]
    )
    return { ...mapCharacter(character), avatar }
  })
}

export const getCharacter = async (id: string): Promise<Character | undefined> => {
  const result = await query('SELECT * FROM characters WHERE id = $1', [id])
  return result.rows[0] ? mapCharacter(result.rows[0]) : undefined
}

export const getCharacterForUser = async (userId: string, id: string): Promise<Character | undefined> => {
  const result = await query(
    `SELECT * FROM characters
     WHERE id = $1 AND (owner_user_id IS NULL OR owner_user_id = $2)`,
    [id, userId]
  )
  return result.rows[0] ? mapCharacter(result.rows[0]) : undefined
}

export const createCharacter = async (userId: string, character: Character): Promise<Character> => {
  return withTransaction(async client => {
    await ensureUser(client, userId)
    const result = await client.query(
      `INSERT INTO characters (
         id, name, avatar, role, personality, company, scenario, goal, language,
         background, system_prompt_template, default_settings, current_version,
         owner_user_id, created_at, updated_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, 1, $13, $14, $15
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
        JSON.stringify(character.runtimeConfig || {}),
        userId,
        character.createdAt,
        character.updatedAt
      ]
    )
    const created = mapCharacter(result.rows[0])
    await insertCharacterVersion(client, created, 1)
    return created
  })
}

export const updateCharacter = async (userId: string, character: Character): Promise<Character | undefined> => {
  return withTransaction(async client => {
    const currentResult = await client.query(
      'SELECT current_version FROM characters WHERE id = $1 AND owner_user_id = $2 FOR UPDATE',
      [character.id, userId]
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
         default_settings = $12::jsonb,
         current_version = $13,
         updated_at = $14
       WHERE id = $1 AND owner_user_id = $15
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
        JSON.stringify(character.runtimeConfig || {}),
        nextVersion,
        character.updatedAt,
        userId
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
      await client.query(
        `DELETE FROM character_versions
         WHERE character_id = $1 AND version <> $2`,
        [updated.id, nextVersion]
      )
      if (updated.runtimeConfig?.timezone) {
        await client.query(
          `UPDATE simulation_cursors
           SET local_timezone = $2, updated_at = NOW()
           WHERE instance_id IN (
             SELECT id FROM character_instances WHERE character_id = $1
           )`,
          [updated.id, updated.runtimeConfig.timezone]
        )
      }
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

export const getSyncSnapshot = async (userId: string): Promise<SyncSnapshot> => {
  return withTransaction(async client => {
    await ensureUser(client, userId)
    const characterResult = await client.query(
      `SELECT characters.*, preferences.avatar_override
       FROM characters
       LEFT JOIN user_character_preferences preferences
         ON preferences.character_id = characters.id
         AND preferences.user_id = $1
       WHERE characters.owner_user_id IS NULL OR characters.owner_user_id = $1
       ORDER BY characters.created_at, characters.name`,
      [userId]
    )
    const userResult = await client.query(
      'SELECT username, display_name, preferences FROM users WHERE id = $1',
      [userId]
    )
    const conversationResult = await client.query(
      `SELECT
         conversations.*,
         latest_message.id AS latest_message_id,
         latest_message.sender_role AS latest_message_sender_role,
         latest_message.content AS latest_message_content,
         latest_message.content_json AS latest_message_content_json,
         latest_message.created_at AS latest_message_created_at,
         unread_messages.unread_count
       FROM conversations
       LEFT JOIN LATERAL (
         SELECT id, sender_role, content, content_json, created_at
         FROM messages
         WHERE conversation_id = conversations.id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) latest_message ON TRUE
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(
           CASE
             WHEN jsonb_typeof(unread_message.content_json -> 'deliverySegments') = 'array'
               THEN GREATEST(jsonb_array_length(unread_message.content_json -> 'deliverySegments'), 1)
             ELSE 1
           END
         ), 0)::integer AS unread_count
         FROM messages unread_message
         WHERE unread_message.conversation_id = conversations.id
           AND unread_message.sender_role = 'assistant'
           AND (
             unread_message.created_at > conversations.last_read_message_at
             OR (
               unread_message.created_at = conversations.last_read_message_at
               AND unread_message.id > COALESCE(conversations.last_read_message_id, '')
             )
           )
       ) unread_messages ON TRUE
       WHERE conversations.user_id = $1
         AND conversations.status = 'active'
       ORDER BY conversations.last_message_at DESC NULLS LAST, conversations.created_at DESC`,
      [userId]
    )
    const pinResult = await client.query(
      `SELECT character_id
       FROM user_character_preferences
       WHERE user_id = $1 AND pinned_at IS NOT NULL
       ORDER BY pinned_at DESC, character_id`,
      [userId]
    )

    const conversations: ConversationSyncRecord[] = conversationResult.rows.map(row => {
      const conversation = mapConversation(row)
      return {
        ...conversation,
        unreadCount: Number(row.unread_count || 0),
        latestMessage: row.latest_message_id
          ? {
              id: String(row.latest_message_id),
              senderRole: row.latest_message_sender_role,
              content: String(row.latest_message_content || ''),
              contentJson: row.latest_message_content_json || undefined,
              createdAt: iso(row.latest_message_created_at)!
            }
          : undefined
      }
    })

    const streakRows = await client.query(
      `SELECT character_id, current_days, longest_days, last_qualified_day, rekindle_progress,
              EXISTS (
                SELECT 1 FROM character_streak_days
                WHERE user_id = character_streaks.user_id
                  AND character_id = character_streaks.character_id
                  AND day_key = ((NOW() AT TIME ZONE 'Asia/Shanghai')::date)
              ) AS interacted_today
       FROM character_streaks
       WHERE user_id = $1`,
      [userId]
    )
    const beijingDayResult = await client.query("SELECT ((NOW() AT TIME ZONE 'Asia/Shanghai')::date)::text AS today")
    const beijingToday = String(beijingDayResult.rows[0].today)
    const streaks: ChatStreak[] = streakRows.rows.map(row => {
      const lastDay = streakDateKey(row.last_qualified_day)
      const days = Number(row.current_days || 0)
      const rekindleProgress = Number(row.rekindle_progress || 0)
      const status = chatStreakStatusFor({
        current_days: days,
        last_qualified_day: lastDay,
        rekindle_progress: rekindleProgress,
      }, beijingToday)
      const difference = lastDay
        ? Math.round((Date.parse(`${beijingToday}T00:00:00Z`) - Date.parse(`${lastDay}T00:00:00Z`)) / 86_400_000)
        : undefined
      const daysLeft = (status === 'pending' || status === 'rekindling') && difference !== undefined
        ? Math.max(1, 4 - difference)
        : undefined
      const expiryDay = lastDay
        ? new Date(Date.parse(`${lastDay}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10)
        : undefined
      return {
        characterId: String(row.character_id),
        days,
        longestDays: Number(row.longest_days || 0),
        status,
        lastQualifiedDay: lastDay,
        rekindleExpiresAt: (status === 'pending' || status === 'rekindling') && expiryDay
          ? `${expiryDay}T23:59:59+08:00`
          : undefined,
        rekindleProgress: status === 'rekindling' ? rekindleProgress : undefined,
        daysLeft,
        interactedToday: Boolean(row.interacted_today),
      }
    })

    const userRow = userResult.rows[0]
    return {
      serverTime: new Date().toISOString(),
      userName: typeof userRow?.display_name === 'string'
        && userRow.display_name !== 'Local User'
        ? userRow.display_name
        : undefined,
      userAvatar: typeof userRow?.preferences?.avatar === 'string'
        ? userRow.preferences.avatar
        : undefined,
      userTranslationTargetLanguage: normalizeTranslationTargetLanguage(userRow?.preferences?.translationTargetLanguage, userRow?.username),
      characters: characterResult.rows.map(mapCharacter),
      conversations,
      pinnedCharacterIds: pinResult.rows.map(row => String(row.character_id)),
      streaks,
    }
  })
}

export const getConversation = async (id: string): Promise<Conversation | undefined> => {
  const result = await query('SELECT * FROM conversations WHERE id = $1', [id])
  return result.rows[0] ? mapConversation(result.rows[0]) : undefined
}

export const markConversationRead = async (
  userId: string,
  conversationId: string,
  messageId: string
): Promise<boolean> => {
  return withTransaction(async client => {
    const messageResult = await client.query(
      `SELECT messages.id, messages.created_at
       FROM messages
       JOIN conversations ON conversations.id = messages.conversation_id
       WHERE messages.id = $1
         AND messages.conversation_id = $2
         AND conversations.user_id = $3`,
      [messageId, conversationId, userId]
    )
    const message = messageResult.rows[0]
    if (!message) return false

    await client.query(
      `UPDATE conversations
       SET last_read_message_at = $3,
           last_read_message_id = $4
       WHERE id = $1
         AND user_id = $2
         AND (
           last_read_message_at IS NULL
           OR last_read_message_at < $3::timestamptz
           OR (
             last_read_message_at = $3::timestamptz
             AND COALESCE(last_read_message_id, '') < $4
           )
         )`,
      [conversationId, userId, message.created_at, message.id]
    )
    return true
  })
}

export type MessageHistoryCursor = {
  createdAt: string
  id: string
}

export type MessagePage = {
  messages: Message[]
  hasMore: boolean
  nextCursor?: MessageHistoryCursor
}

export const listMessagePage = async (
  conversationId: string,
  options: { limit: number; before?: MessageHistoryCursor }
): Promise<MessagePage> => {
  const limit = Math.max(1, Math.floor(options.limit))
  const result = await query(
    `SELECT
       messages.*,
       COALESCE((
         SELECT jsonb_object_agg(translation.segment_index::text, translation.translated_text)
         FROM message_translations translation
         WHERE translation.message_id = messages.id
           AND translation.target_language = 'en'
       ), '{}'::jsonb) AS english_translations
     FROM messages
     WHERE conversation_id = $1
       AND (
         $2::timestamptz IS NULL
         OR (messages.created_at, messages.id) < ($2::timestamptz, $3::text)
       )
     ORDER BY messages.created_at DESC, messages.id DESC
     LIMIT $4`,
    [
      conversationId,
      options.before?.createdAt ?? null,
      options.before?.id ?? null,
      limit + 1
    ]
  )
  const hasMore = result.rows.length > limit
  const messages = result.rows
    .slice(0, limit)
    .reverse()
    .map(mapMessage)
  const oldestMessage = messages[0]

  return {
    messages,
    hasMore,
    nextCursor: hasMore && oldestMessage
      ? { createdAt: oldestMessage.createdAt, id: oldestMessage.id }
      : undefined
  }
}

export const getOwnedMessage = async (
  userId: string,
  messageId: string
): Promise<Message | undefined> => {
  const result = await query(
    `SELECT messages.*
     FROM messages
     JOIN conversations ON conversations.id = messages.conversation_id
     WHERE messages.id = $1 AND conversations.user_id = $2`,
    [messageId, userId]
  )
  return result.rows[0] ? mapMessage(result.rows[0]) : undefined
}

export const updateAssistantMessageVoice = async (
  messageId: string,
  voice: Record<string, unknown>
): Promise<Message | undefined> => {
  return withTransaction(async client => {
    const result = await client.query(
      `UPDATE messages
       SET content_json = jsonb_set(
         COALESCE(content_json, '{}'::jsonb),
         '{voice}',
         $2::jsonb,
         TRUE
       )
       WHERE id = $1 AND sender_role = 'assistant'
       RETURNING *`,
      [messageId, JSON.stringify(voice)]
    )
    if (!result.rows[0]) return undefined
    await client.query(
      `UPDATE conversations
       SET updated_at = NOW()
       WHERE id = $1`,
      [result.rows[0].conversation_id]
    )
    return mapMessage(result.rows[0])
  })
}

export const updateUserVoiceMessageTranscript = async (
  messageId: string,
  transcript: string
): Promise<Message | undefined> => {
  return withTransaction(async client => {
    const result = await client.query(
      `UPDATE messages
       SET content = $2,
           content_json = jsonb_set(
             COALESCE(content_json, '{}'::jsonb),
             '{voice}',
             jsonb_set(
               COALESCE(content_json -> 'voice', '{}'::jsonb),
               '{transcriptStatus}',
               '"ready"'::jsonb,
               TRUE
             ),
             TRUE
           )
       WHERE id = $1 AND sender_role = 'user'
       RETURNING *`,
      [messageId, transcript]
    )
    if (!result.rows[0]) return undefined
    await client.query(
      `UPDATE conversations
       SET updated_at = NOW()
       WHERE id = $1`,
      [result.rows[0].conversation_id]
    )
    return mapMessage(result.rows[0])
  })
}

export const clearUserVoiceMessageTranscript = async (
  messageId: string
): Promise<Message | undefined> => {
  return withTransaction(async client => {
    const result = await client.query(
      `UPDATE messages
       SET content = '',
           content_json = jsonb_set(
             COALESCE(content_json, '{}'::jsonb),
             '{voice}',
             jsonb_set(
               COALESCE(content_json -> 'voice', '{}'::jsonb),
               '{transcriptStatus}',
               '"none"'::jsonb,
               TRUE
             ),
             TRUE
           )
       WHERE id = $1 AND sender_role = 'user'
       RETURNING *`,
      [messageId]
    )
    if (!result.rows[0]) return undefined
    await client.query(
      `UPDATE conversations
       SET updated_at = NOW()
       WHERE id = $1`,
      [result.rows[0].conversation_id]
    )
    return mapMessage(result.rows[0])
  })
}

export const upsertExpoPushDevice = async ({
  userId,
  expoPushToken,
  platform,
}: {
  userId: string
  expoPushToken: string
  platform: 'ios' | 'android'
}) => {
  return withTransaction(async client => {
    await ensureUser(client, userId)
    await client.query(
      `INSERT INTO expo_push_devices (
         expo_push_token, user_id, platform, enabled, last_seen_at, created_at, updated_at
       ) VALUES ($1, $2, $3, TRUE, NOW(), NOW(), NOW())
       ON CONFLICT (expo_push_token)
       DO UPDATE SET
         user_id = EXCLUDED.user_id,
         platform = EXCLUDED.platform,
         enabled = TRUE,
         last_seen_at = NOW(),
         updated_at = NOW()`,
      [expoPushToken, userId, platform]
    )
  })
}

export const listEnabledExpoPushTokens = async (userId: string): Promise<string[]> => {
  const result = await query(
    `SELECT expo_push_token
     FROM expo_push_devices
     WHERE user_id = $1 AND enabled = TRUE
     ORDER BY updated_at DESC`,
    [userId]
  )
  return result.rows.map(row => String(row.expo_push_token))
}

export const disableExpoPushDevice = async (expoPushToken: string | undefined) => {
  if (!expoPushToken) return
  await query(
    `UPDATE expo_push_devices
     SET enabled = FALSE, updated_at = NOW()
     WHERE expo_push_token = $1`,
    [expoPushToken]
  )
}

export const getMessageTranslation = async (
  messageId: string,
  segmentIndex: number,
  targetLanguage: string
): Promise<MessageTranslation | undefined> => {
  const result = await query(
    `SELECT * FROM message_translations
     WHERE message_id = $1 AND segment_index = $2 AND target_language = $3`,
    [messageId, segmentIndex, targetLanguage]
  )
  return result.rows[0] ? mapMessageTranslation(result.rows[0]) : undefined
}

export const upsertMessageTranslation = async (translation: MessageTranslation) => {
  const result = await query(
    `INSERT INTO message_translations (
       id, message_id, segment_index, target_language, translated_text,
       provider, model, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (message_id, segment_index, target_language)
     DO UPDATE SET
       translated_text = EXCLUDED.translated_text,
       provider = EXCLUDED.provider,
       model = EXCLUDED.model,
       updated_at = EXCLUDED.updated_at
     RETURNING *`,
    [
      translation.id,
      translation.messageId,
      translation.segmentIndex,
      translation.targetLanguage,
      translation.translatedText,
      translation.provider,
      translation.model,
      translation.createdAt,
      translation.updatedAt
    ]
  )
  return mapMessageTranslation(result.rows[0])
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

export const listMessagesAfterSummaryCoverage = async (
  conversationId: string,
  coverage?: ConversationSummary['coverage'],
  limit = 64
): Promise<Message[]> => {
  const end = coverage?.end
  const endMessageId = coverage?.endMessageId
  const result = await query(
    `SELECT * FROM messages
     WHERE conversation_id = $1
       AND (
         $2::timestamptz IS NULL
         OR created_at > $2::timestamptz
         OR (created_at = $2::timestamptz AND ($3::text IS NULL OR id > $3::text))
       )
     ORDER BY created_at, id
     LIMIT $4`,
    [conversationId, end || null, endMessageId || null, Math.max(1, Math.min(128, Math.floor(limit)))]
  )
  return result.rows.map(mapMessage)
}

export const replaceConversationSummary = async (input: {
  conversationId: string
  summaryText: string
  coverage: NonNullable<ConversationSummary['coverage']>
}): Promise<ConversationSummary> => {
  return withTransaction(async client => {
    await client.query(
      'DELETE FROM conversation_summaries WHERE conversation_id = $1',
      [input.conversationId]
    )
    const result = await client.query(
      `INSERT INTO conversation_summaries (
         id, conversation_id, summary_text, last_generated_at, coverage
       ) VALUES ($1, $2, $3, NOW(), $4::jsonb)
       RETURNING *`,
      [newId(), input.conversationId, input.summaryText, JSON.stringify(input.coverage)]
    )
    const row = result.rows[0]
    return {
      id: row.id,
      conversationId: row.conversation_id,
      summaryText: row.summary_text,
      lastGeneratedAt: iso(row.last_generated_at)!,
      coverage: row.coverage || undefined
    }
  })
}

export const getUserLearningContext = async (userId: string) => {
  const result = await query(
    `SELECT
      u.learning_goals,
       u.display_name,
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
    userName: row?.display_name && row.display_name !== 'Local User'
      ? row.display_name
      : undefined,
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
         id, user_id, character_id, title, status, last_message_at,
         last_read_message_at, last_read_message_id, metadata, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
       RETURNING *`,
      [
        conversation.id,
        conversation.userId,
        conversation.characterId,
        conversation.title ?? null,
        conversation.status || 'active',
        starterMessage.createdAt,
        starterMessage.createdAt,
        starterMessage.id,
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

export const getOrCreateConversationWithStarter = async (
  conversation: Conversation,
  starterMessage: Message
): Promise<{
  conversation: Conversation
  starterMessage?: Message
  created: boolean
}> => {
  return withTransaction(async client => {
    await ensureUser(client, conversation.userId)
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [conversation.userId, conversation.characterId]
    )
    const existingResult = await client.query(
      `SELECT * FROM conversations
       WHERE user_id = $1 AND character_id = $2 AND status = 'active'
       ORDER BY last_message_at DESC NULLS LAST, created_at DESC
       LIMIT 1`,
      [conversation.userId, conversation.characterId]
    )
    if (existingResult.rows[0]) {
      return {
        conversation: mapConversation(existingResult.rows[0]),
        created: false
      }
    }

    const conversationResult = await client.query(
      `INSERT INTO conversations (
         id, user_id, character_id, title, status, last_message_at,
         last_read_message_at, last_read_message_id, metadata, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
       RETURNING *`,
      [
        conversation.id,
        conversation.userId,
        conversation.characterId,
        conversation.title ?? null,
        conversation.status || 'active',
        starterMessage.createdAt,
        starterMessage.createdAt,
        starterMessage.id,
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
    return {
      conversation: mapConversation(conversationResult.rows[0]),
      starterMessage,
      created: true
    }
  })
}

export const normalizeConversationStarterCreatedAt = async (
  userId: string,
  characterId: string,
  starterTexts: string[],
  createdAt: string,
  starterTimestampPolicy: string
) => {
  return withTransaction(async client => {
    const result = await client.query(
      `WITH first_starters AS (
         SELECT DISTINCT ON (m.conversation_id)
           m.id,
           m.conversation_id,
           m.created_at AS previous_created_at
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.user_id = $1
           AND c.character_id = $2
           AND c.status = 'active'
           AND c.metadata->>'starterTimestampPolicy' IS DISTINCT FROM $5
           AND m.sender_role = 'assistant'
           AND m.content = ANY($3::text[])
         ORDER BY m.conversation_id, m.created_at ASC, m.id ASC
       ), updated_starters AS (
         UPDATE messages m
         SET created_at = $4
         FROM first_starters f
         WHERE m.id = f.id
         RETURNING f.conversation_id, f.previous_created_at
       )
       UPDATE conversations c
       SET
         last_message_at = CASE
           WHEN c.last_message_at = u.previous_created_at THEN $4::timestamptz
           ELSE c.last_message_at
         END,
         last_read_message_at = CASE
           WHEN c.last_read_message_at = u.previous_created_at THEN $4::timestamptz
           ELSE c.last_read_message_at
         END,
         metadata = jsonb_set(
           COALESCE(c.metadata, '{}'::jsonb),
           '{starterTimestampPolicy}',
           to_jsonb($5::text),
           TRUE
         )
       FROM updated_starters u
       WHERE c.id = u.conversation_id
       RETURNING c.id`,
      [userId, characterId, starterTexts, createdAt, starterTimestampPolicy]
    )
    return result.rowCount > 0
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

export const appendMessages = async (messages: Message[]): Promise<Message[]> => {
  if (messages.length === 0) return []
  const conversationId = messages[0].conversationId
  if (!messages.every(message => message.conversationId === conversationId)) {
    throw new Error('all messages must belong to the same conversation')
  }

  return withTransaction(async client => {
    // A forwarded bundle must remain consecutive even when another device sends at once.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [conversationId])
    const stored: Message[] = []

    for (const message of messages) {
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
          message.createdAt,
        ]
      )
      stored.push(mapMessage(result.rows[0]))
    }

    const latest = stored.at(-1)
    if (latest) {
      await client.query(
        `UPDATE conversations
         SET last_message_at = $2, updated_at = $2
         WHERE id = $1`,
        [conversationId, latest.createdAt]
      )
    }
    return stored
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
    // Coordinate with starter creation so a cleared chat remains empty.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
      [userId, characterId]
    )
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

    const now = new Date().toISOString()
    const emptyConversationResult = await client.query(
      `INSERT INTO conversations (
         id, user_id, character_id, status, metadata, created_at, updated_at
       ) VALUES ($1, $2, $3, 'active', '{}'::jsonb, $4, $4)
       RETURNING *`,
      [uuidv4(), userId, characterId, now]
    )

    return {
      deletedConversations: conversationDeleteResult.rowCount || 0,
      deletedMessages: Number(messageCountResult.rows[0].count),
      deletedMemories: memoryDeleteResult.rowCount || 0,
      conversation: mapConversation(emptyConversationResult.rows[0])
    }
  })
}

export const newId = () => uuidv4()
