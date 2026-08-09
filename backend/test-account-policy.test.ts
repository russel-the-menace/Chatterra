import assert from 'node:assert/strict'
import { closeDatabase } from './database'
import { isRestrictedTestAccountOperation } from './test-account-policy'

assert.equal(isRestrictedTestAccountOperation('POST', '/characters'), true)
assert.equal(isRestrictedTestAccountOperation('PUT', '/characters/custom-1'), true)
assert.equal(isRestrictedTestAccountOperation('POST', '/voice/transcriptions'), true)
assert.equal(isRestrictedTestAccountOperation('POST', '/translations'), true)
assert.equal(isRestrictedTestAccountOperation('PUT', '/users/account-test/profile'), true)
assert.equal(isRestrictedTestAccountOperation('POST', '/chat'), false)
assert.equal(isRestrictedTestAccountOperation('GET', '/sync'), false)

console.log('test account policy checks passed')
void closeDatabase()
