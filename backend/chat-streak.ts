import { PoolClient } from 'pg'
import { withTransaction } from './database'

export type ChatStreakStatus = 'locked' | 'active' | 'pending' | 'rekindling' | 'expired'

export type ChatStreak = {
  characterId: string
  days: number
  longestDays: number
  status: ChatStreakStatus
  lastQualifiedDay?: string
  rekindleExpiresAt?: string
}

const beijingDaySql = "((NOW() AT TIME ZONE 'Asia/Shanghai')::date)"

const dateDifference = (from: string | undefined, to: string) => {
  if (!from) return undefined
  const fromMs = Date.parse(`${from}T00:00:00Z`)
  const toMs = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return undefined
  return Math.round((toMs - fromMs) / 86_400_000)
}

export const chatStreakStatusFor = (row: {
  current_days: number
  last_qualified_day?: string
}, today: string): ChatStreakStatus => {
  if (!row.last_qualified_day || Number(row.current_days) < 3) return 'locked'
  const difference = dateDifference(row.last_qualified_day, today)
  if (difference === 0) return 'active'
  if (difference === 1) return 'pending'
  if (difference === 2) return 'rekindling'
  return 'expired'
}

const mapStreak = (row: any, today: string): ChatStreak => {
  const lastQualifiedDay = row.last_qualified_day
    ? String(row.last_qualified_day).slice(0, 10)
    : undefined
  const status = chatStreakStatusFor({ current_days: Number(row.current_days), last_qualified_day: lastQualifiedDay }, today)
  const rekindleExpiresAt = status === 'rekindling'
    ? `${today}T23:59:59+08:00`
    : undefined
  return {
    characterId: String(row.character_id),
    days: Number(row.current_days || 0),
    longestDays: Number(row.longest_days || 0),
    status,
    lastQualifiedDay,
    rekindleExpiresAt,
  }
}

const todayForClient = async (client: PoolClient) => {
  const result = await client.query(`SELECT ${beijingDaySql}::text AS today`)
  return String(result.rows[0].today)
}

export const listChatStreaks = async (userId: string): Promise<ChatStreak[]> => {
  return withTransaction(async client => {
    const today = await todayForClient(client)
    const result = await client.query(
      `SELECT character_id, current_days, longest_days, last_qualified_day
       FROM character_streaks
       WHERE user_id = $1`,
      [userId]
    )
    return result.rows.map(row => mapStreak(row, today))
  })
}

const getStreakForUpdate = async (client: PoolClient, userId: string, characterId: string) => {
  const result = await client.query(
    `SELECT character_id, current_days, longest_days, last_qualified_day, restore_count
     FROM character_streaks
     WHERE user_id = $1 AND character_id = $2
     FOR UPDATE`,
    [userId, characterId]
  )
  return result.rows[0]
}

export const recordChatStreakInteraction = async ({
  userId,
  characterId,
  sourceMessageId,
}: {
  userId: string
  characterId: string
  sourceMessageId?: string
}): Promise<ChatStreak> => {
  return withTransaction(async client => {
    const today = await todayForClient(client)
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [userId, characterId])
    const insertedDay = await client.query(
      `INSERT INTO character_streak_days (user_id, character_id, day_key, source_message_id)
       VALUES ($1, $2, ${beijingDaySql}, $3)
       ON CONFLICT (user_id, character_id, day_key) DO NOTHING
       RETURNING day_key`,
      [userId, characterId, sourceMessageId || null]
    )
    const existing = await getStreakForUpdate(client, userId, characterId)
    if (!existing) {
      const created = await client.query(
        `INSERT INTO character_streaks (
           user_id, character_id, current_days, longest_days, last_qualified_day
         ) VALUES ($1, $2, 1, 1, ${beijingDaySql})
         RETURNING character_id, current_days, longest_days, last_qualified_day`,
        [userId, characterId]
      )
      return mapStreak(created.rows[0], today)
    }

    const lastDay = existing.last_qualified_day ? String(existing.last_qualified_day).slice(0, 10) : undefined
    const difference = dateDifference(lastDay, today)
    const alreadyCounted = insertedDay.rowCount === 0
    if (alreadyCounted) return mapStreak(existing, today)

    const nextDays = difference === 1 ? Number(existing.current_days) + 1 : 1
    const nextLongest = Math.max(Number(existing.longest_days), nextDays)
    const updated = await client.query(
      `UPDATE character_streaks
       SET current_days = $3,
           longest_days = $4,
           last_qualified_day = ${beijingDaySql},
           updated_at = NOW()
       WHERE user_id = $1 AND character_id = $2
       RETURNING character_id, current_days, longest_days, last_qualified_day`,
      [userId, characterId, nextDays, nextLongest]
    )
    return mapStreak(updated.rows[0], today)
  })
}

export const restoreChatStreak = async (userId: string, characterId: string): Promise<ChatStreak | undefined> => {
  return withTransaction(async client => {
    const today = await todayForClient(client)
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [userId, characterId])
    const existing = await getStreakForUpdate(client, userId, characterId)
    if (!existing) return undefined
    const lastDay = existing.last_qualified_day ? String(existing.last_qualified_day).slice(0, 10) : undefined
    if (chatStreakStatusFor({ current_days: Number(existing.current_days), last_qualified_day: lastDay }, today) !== 'rekindling') {
      return undefined
    }
    const updated = await client.query(
      `UPDATE character_streaks
       SET last_qualified_day = ${beijingDaySql},
           restore_count = restore_count + 1,
           updated_at = NOW()
       WHERE user_id = $1 AND character_id = $2
       RETURNING character_id, current_days, longest_days, last_qualified_day`,
      [userId, characterId]
    )
    await client.query(
      `INSERT INTO character_streak_days (user_id, character_id, day_key)
       VALUES ($1, $2, ${beijingDaySql})
       ON CONFLICT (user_id, character_id, day_key) DO NOTHING`,
      [userId, characterId]
    )
    return mapStreak(updated.rows[0], today)
  })
}
