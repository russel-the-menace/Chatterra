import assert from 'node:assert/strict'
import { closeDatabase } from './database'
import { hashAccessToken, verifyPasswordHash } from './authentication'

const passwordHash = 'scrypt$5ed8daf2756281b52e9c422914d0e664$4d2f31ffecb5724cac3975b97d0885b2674a53f439d4a010a6ddb3e3f239fb8eb1975db0c7af7e491c6cbb812f476bf3e2641368c5144d0bfea4feca7d220862'

assert.equal(verifyPasswordHash('yeatom', passwordHash), true)
assert.equal(verifyPasswordHash('wrong-password', passwordHash), false)
assert.equal(verifyPasswordHash('yeatom', 'not-a-valid-hash'), false)
assert.equal(hashAccessToken('a-session-token'), hashAccessToken('a-session-token'))
assert.notEqual(hashAccessToken('a-session-token'), hashAccessToken('another-session-token'))

console.log('authentication checks passed')
void closeDatabase()
