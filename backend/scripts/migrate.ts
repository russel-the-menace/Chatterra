import dotenv from 'dotenv'
import fs from 'fs'
import path from 'path'
import { closeDatabase, query, withTransaction } from '../database'

dotenv.config()

const run = async () => {
  await query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  )

  const migrationsDir = path.join(__dirname, '..', 'migrations')
  const files = fs.readdirSync(migrationsDir).filter(file => file.endsWith('.sql')).sort()

  for (const file of files) {
    const existing = await query('SELECT 1 FROM schema_migrations WHERE name = $1', [file])
    if (existing.rowCount) continue

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    await withTransaction(async client => {
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file])
    })
    console.log(`Applied ${file}`)
  }
}

run()
  .catch(error => {
    console.error('Database migration failed', error)
    process.exitCode = 1
  })
  .finally(() => closeDatabase())
