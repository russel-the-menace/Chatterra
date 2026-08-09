import assert from 'node:assert/strict'
import { closeDatabase } from './database'
import { chatStreakStatusFor, streakDateKey } from './chat-streak'

assert.equal(chatStreakStatusFor({ current_days: 2, last_qualified_day: '2026-08-09' }, '2026-08-09'), 'locked')
assert.equal(chatStreakStatusFor({ current_days: 3, last_qualified_day: '2026-08-09' }, '2026-08-09'), 'active')
assert.equal(chatStreakStatusFor({ current_days: 8, last_qualified_day: '2026-08-08' }, '2026-08-09'), 'pending')
assert.equal(chatStreakStatusFor({ current_days: 8, last_qualified_day: '2026-08-07' }, '2026-08-09'), 'pending')
assert.equal(chatStreakStatusFor({ current_days: 8, last_qualified_day: '2026-08-06' }, '2026-08-09'), 'pending')
assert.equal(chatStreakStatusFor({ current_days: 8, last_qualified_day: '2026-08-08', rekindle_progress: 1 }, '2026-08-09'), 'rekindling')
assert.equal(chatStreakStatusFor({ current_days: 8, last_qualified_day: '2026-08-07', rekindle_progress: 2 }, '2026-08-09'), 'rekindling')
assert.equal(chatStreakStatusFor({ current_days: 8, last_qualified_day: '2026-08-05' }, '2026-08-09'), 'expired')
assert.equal(streakDateKey(new Date('2026-08-08T00:00:00.000Z')), '2026-08-08')

console.log('chat streak checks passed')
void closeDatabase()
