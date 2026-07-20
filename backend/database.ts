import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg'

let pool: Pool | null = null

export const getPool = () => {
  if (pool) return pool

  const connectionString = process.env.DATABASE_URL || (
    process.env.NODE_ENV === 'production'
      ? ''
      : 'postgresql://chatterra:chatterra@127.0.0.1:5432/chatterra'
  )
  if (!connectionString) {
    throw new Error('DATABASE_URL is required')
  }

  pool = new Pool({
    connectionString,
    ssl: process.env.DATABASE_SSL === 'true'
      ? { rejectUnauthorized: false }
      : undefined
  })

  return pool
}

export const query = <T extends QueryResultRow = any>(text: string, values: any[] = []): Promise<QueryResult<T>> => {
  return getPool().query<T>(text, values)
}

export const withTransaction = async <T>(callback: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

export const checkDatabase = async () => {
  await query('SELECT 1')
}

export const closeDatabase = async () => {
  if (!pool) return
  await pool.end()
  pool = null
}
