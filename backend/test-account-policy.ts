import { withTransaction } from './database'
import { v4 as uuidv4 } from 'uuid'

export const TEST_ACCOUNT_USERNAME = 'test'
export const TEST_ACCOUNT_HOURLY_REPLY_LIMIT = 20
export const TEST_ACCOUNT_DAILY_REPLY_LIMIT = 100
export const TEST_ACCOUNT_MESSAGE_LIMIT_PER_CHARACTER = 50

export const isRestrictedTestAccountOperation = (method: string, mountedPath: string) => {
  const methodAndPath = `${method.toUpperCase()} ${mountedPath}`
  return [
    /^POST \/characters$/,
    /^PUT \/characters\/[^/]+$/,
    /^PUT \/users\/[^/]+\/(?:avatar|profile)$/,
    /^PUT \/users\/[^/]+\/characters\/[^/]+\/avatar$/,
    /^PUT \/push-devices\/expo$/,
    /^POST \/(?:translations|voice\/)/,
    /^DELETE \/voice\//,
  ].some(pattern => pattern.test(methodAndPath))
}

export type TestAccountReplyQuota = {
  allowed: boolean
  applies: boolean
  hourlyUsed: number
  dailyUsed: number
  resetAt?: string
}

export const reserveTestAccountReply = async (userId: string): Promise<TestAccountReplyQuota> => {
  return withTransaction(async client => {
    const userResult = await client.query(
      'SELECT username FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    )
    if (String(userResult.rows[0]?.username || '').toLowerCase() !== TEST_ACCOUNT_USERNAME) {
      return { allowed: true, applies: false, hourlyUsed: 0, dailyUsed: 0 }
    }

    await client.query(
      `DELETE FROM test_account_reply_usage
       WHERE user_id = $1 AND created_at < NOW() - INTERVAL '1 day'`,
      [userId]
    )
    const usageResult = await client.query(
      `SELECT
         COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '1 hour')::int AS hourly_used,
         COUNT(*)::int AS daily_used,
         MIN(created_at) FILTER (WHERE created_at >= NOW() - INTERVAL '1 hour') AS hourly_oldest,
         MIN(created_at) AS daily_oldest
       FROM test_account_reply_usage
       WHERE user_id = $1`,
      [userId]
    )
    const usage = usageResult.rows[0]
    const hourlyUsed = Number(usage?.hourly_used || 0)
    const dailyUsed = Number(usage?.daily_used || 0)
    if (hourlyUsed >= TEST_ACCOUNT_HOURLY_REPLY_LIMIT || dailyUsed >= TEST_ACCOUNT_DAILY_REPLY_LIMIT) {
      const hourlyReset = usage?.hourly_oldest
        ? new Date(new Date(usage.hourly_oldest).getTime() + 60 * 60 * 1000)
        : undefined
      const dailyReset = usage?.daily_oldest
        ? new Date(new Date(usage.daily_oldest).getTime() + 24 * 60 * 60 * 1000)
        : undefined
      const applicableResets = [
        ...(hourlyUsed >= TEST_ACCOUNT_HOURLY_REPLY_LIMIT && hourlyReset ? [hourlyReset] : []),
        ...(dailyUsed >= TEST_ACCOUNT_DAILY_REPLY_LIMIT && dailyReset ? [dailyReset] : []),
      ]
      const resetAt = applicableResets.length > 0
        ? new Date(Math.max(...applicableResets.map(value => value.getTime())))
        : undefined
      return {
        allowed: false,
        applies: true,
        hourlyUsed,
        dailyUsed,
        resetAt: resetAt?.toISOString(),
      }
    }

    await client.query(
      `INSERT INTO test_account_reply_usage (id, user_id)
       VALUES ($1, $2)`,
      [uuidv4(), userId]
    )
    return {
      allowed: true,
      applies: true,
      hourlyUsed: hourlyUsed + 1,
      dailyUsed: dailyUsed + 1,
    }
  })
}
