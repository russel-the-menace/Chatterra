import assert from 'node:assert/strict'
import { closeDatabase } from './database'
import { chatStreakStatusFor } from './chat-streak'

assert.equal(chatStreakStatusFor({ current_days: 2, last_qualified_day: '2026-08-09' }, '2026-08-09'), 'locked')
assert.equal(chatStreakStatusFor({ current_days: 3, last_qualified_day: '2026-08-09' }, '2026-08-09'), 'active')
assert.equal(chatStreakStatusFor({ current_days: 8, last_qualified_day: '2026-08-08' }, '2026-08-09'), 'pending')
assert.equal(chatStreakStatusFor({ current_days: 8, last_qualified_day: '2026-08-07' }, '2026-08-09'), 'rekindling')
assert.equal(chatStreakStatusFor({ current_days: 8, last_qualified_day: '2026-08-06' }, '2026-08-09'), 'expired')

console.log('chat streak checks passed')
void closeDatabase()
