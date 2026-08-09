import assert from 'node:assert/strict'
import { closeDatabase } from './database'
import { looksLikeInjectionInput, looksLikeSuspiciousPath } from './security-audit'

assert.equal(looksLikeInjectionInput("test' OR 1=1 --"), true)
assert.equal(looksLikeInjectionInput('UNION SELECT password_hash FROM users'), true)
assert.equal(looksLikeInjectionInput('ExamplePass0831'), false)
assert.equal(looksLikeInjectionInput('normal-password!'), false)
assert.equal(looksLikeSuspiciousPath('/api/users/../../etc/passwd'), true)
assert.equal(looksLikeSuspiciousPath('/api/users?name=test%27%20OR%201%3D1%20--'), true)
assert.equal(looksLikeSuspiciousPath('/api/messages?beforeCreatedAt=2026-08-09T10%3A00%3A00Z'), false)

console.log('security audit checks passed')
void closeDatabase()
