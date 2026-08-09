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
  rekindleProgress?: number
  daysLeft?: number
  interactedToday?: boolean
}

const beijingDaySql = "((NOW() AT TIME ZONE 'Asia/Shanghai')::date)"

export const streakDateKey = (value: unknown): string | undefined => {
  if (!value) return undefined
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  const text = String(value)
  if (/^\d{4}-\d{2}-\d{2}$/.test(text.slice(0, 10))) return text.slice(0, 10)
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString().slice(0, 10)
}

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
  rekindle_progress?: number
}, today: string): ChatStreakStatus => {
  if (!row.last_qualified_day || Number(row.current_days) < 3) return 'locked'
  const difference = dateDifference(row.last_qualified_day, today)
  if (difference === 0) return 'active'
  if (difference !== undefined && difference >= 1 && difference <= 3) {
    return Number(row.rekindle_progress || 0) > 0 ? 'rekindling' : 'pending'
  }
  return 'expired'
}

const mapStreak = (row: any, today: string): ChatStreak => {
  const lastQualifiedDay = streakDateKey(row.last_qualified_day)
  const rekindleProgress = Number(row.rekindle_progress || 0)
  const normalSparkRepair = String(row.character_id) === 'c3'
    && Boolean(row.interacted_today)
    && rekindleProgress > 0
  const status = chatStreakStatusFor({
    current_days: normalSparkRepair ? Number(row.current_days) + 1 : Number(row.current_days),
    last_qualified_day: lastQualifiedDay,
    rekindle_progress: normalSparkRepair ? 0 : rekindleProgress,
  }, today)
  const effectiveDays = normalSparkRepair ? Number(row.current_days) + 1 : Number(row.current_days)
  const effectiveStatus = normalSparkRepair ? 'active' : status
  const difference = dateDifference(lastQualifiedDay, today)
  const daysLeft = (status === 'pending' || status === 'rekindling') && difference !== undefined
    ? Math.max(1, 4 - difference)
    : undefined
  const expiryDay = lastQualifiedDay
    ? new Date(Date.parse(`${lastQualifiedDay}T00:00:00Z`) + 3 * 86_400_000).toISOString().slice(0, 10)
    : undefined
  const rekindleExpiresAt = expiryDay ? `${expiryDay}T23:59:59+08:00` : undefined
  return {
    characterId: String(row.character_id),
    days: effectiveDays,
    longestDays: Number(row.longest_days || 0),
    status: effectiveStatus,
    lastQualifiedDay,
    rekindleExpiresAt: effectiveStatus === 'pending' || effectiveStatus === 'rekindling' ? rekindleExpiresAt : undefined,
    rekindleProgress: effectiveStatus === 'rekindling' ? rekindleProgress : undefined,
    daysLeft,
    interactedToday: Boolean(row.interacted_today),
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
      `SELECT character_id, current_days, longest_days, last_qualified_day, rekindle_progress,
              EXISTS (
                SELECT 1 FROM character_streak_days
                WHERE user_id = character_streaks.user_id
                  AND character_id = character_streaks.character_id
                  AND day_key = ${beijingDaySql}
              ) AS interacted_today
       FROM character_streaks
       WHERE user_id = $1`,
      [userId]
    )
    return result.rows.map(row => mapStreak(row, today))
  })
}

const getStreakForUpdate = async (client: PoolClient, userId: string, characterId: string) => {
  const result = await client.query(
    `SELECT character_id, current_days, longest_days, last_qualified_day, restore_count, rekindle_progress
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

    const lastDay = streakDateKey(existing.last_qualified_day)
    const difference = dateDifference(lastDay, today)
    const currentDays = Number(existing.current_days)
    const currentProgress = Number(existing.rekindle_progress || 0)
    const alreadyCounted = insertedDay.rowCount === 0
    if (alreadyCounted) {
      // Maya's normal spark was briefly handled by the old relight branch. If
      // that same day's interaction is retried, repair the persisted row once.
      if (characterId === 'c3' && currentProgress > 0 && difference !== undefined && difference >= 1 && difference <= 3) {
        const repaired = await client.query(
          `UPDATE character_streaks
           SET current_days = $3,
               longest_days = GREATEST(longest_days, $3),
               last_qualified_day = ${beijingDaySql},
               rekindle_progress = 0,
               updated_at = NOW()
           WHERE user_id = $1 AND character_id = $2
           RETURNING character_id, current_days, longest_days, last_qualified_day, rekindle_progress`,
          [userId, characterId, currentDays + 1]
        )
        return mapStreak(repaired.rows[0], today)
      }
      return mapStreak(existing, today)
    }
    if (difference === 0) return mapStreak(existing, today)

    if (currentDays >= 3 && difference !== undefined && difference >= 1 && difference <= 3) {
      // A normal streak resumes on the first mutual interaction. Relight
      // progress is only used after the streak has already entered recovery.
      if (currentProgress === 0) {
        const restoredDays = currentDays + 1
        const restored = await client.query(
          `UPDATE character_streaks
           SET current_days = $3,
               longest_days = GREATEST(longest_days, $3),
               last_qualified_day = ${beijingDaySql},
               rekindle_progress = 0,
               updated_at = NOW()
           WHERE user_id = $1 AND character_id = $2
           RETURNING character_id, current_days, longest_days, last_qualified_day, rekindle_progress`,
          [userId, characterId, restoredDays]
        )
        return mapStreak(restored.rows[0], today)
      }
      const nextProgress = currentProgress + 1
      if (nextProgress < 3) {
        const progressing = await client.query(
          `UPDATE character_streaks
           SET rekindle_progress = $3, updated_at = NOW()
           WHERE user_id = $1 AND character_id = $2
           RETURNING character_id, current_days, longest_days, last_qualified_day, rekindle_progress`,
          [userId, characterId, nextProgress]
        )
        return mapStreak(progressing.rows[0], today)
      }
      const restoredDays = currentDays + 1
      const restored = await client.query(
        `UPDATE character_streaks
         SET current_days = $3,
             longest_days = GREATEST(longest_days, $3),
             last_qualified_day = ${beijingDaySql},
             rekindle_progress = 0,
             updated_at = NOW()
         WHERE user_id = $1 AND character_id = $2
         RETURNING character_id, current_days, longest_days, last_qualified_day, rekindle_progress`,
        [userId, characterId, restoredDays]
      )
      return mapStreak(restored.rows[0], today)
    }

    const nextDays = currentDays < 3 && difference === 1 ? currentDays + 1 : 1
    const nextLongest = Math.max(Number(existing.longest_days), nextDays)
    const updated = await client.query(
      `UPDATE character_streaks
       SET current_days = $3,
           longest_days = $4,
           last_qualified_day = ${beijingDaySql},
           rekindle_progress = 0,
           updated_at = NOW()
       WHERE user_id = $1 AND character_id = $2
       RETURNING character_id, current_days, longest_days, last_qualified_day, rekindle_progress`,
      [userId, characterId, nextDays, nextLongest]
    )
    return mapStreak(updated.rows[0], today)
  })
}
