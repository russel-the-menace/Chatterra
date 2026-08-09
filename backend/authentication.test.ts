import assert from 'node:assert/strict'
import { closeDatabase } from './database'
import {
  hashAccessToken,
  PERMANENT_SESSION_EXPIRES_AT,
  verifyPasswordHash,
} from './authentication'

const passwordHash = 'scrypt$5ed8daf2756281b52e9c422914d0e664$4d2f31ffecb5724cac3975b97d0885b2674a53f439d4a010a6ddb3e3f239fb8eb1975db0c7af7e491c6cbb812f476bf3e2641368c5144d0bfea4feca7d220862'
const junlingPasswordHash = 'scrypt$bc90d86ea470461c141b4c92ef0b1a37$bbd98f393ff5b8723c87ffedba4020b406c52617eeff6038d68163cd9d3534922964622522dd9a08b5832f0107d603d880b541c67416f2396df37f2ede6e5cfd'

assert.equal(verifyPasswordHash('yeatom', passwordHash), true)
assert.equal(verifyPasswordHash('wrong-password', passwordHash), false)
assert.equal(verifyPasswordHash('junling', junlingPasswordHash), true)
assert.equal(verifyPasswordHash('wrong-password', junlingPasswordHash), false)
assert.equal(verifyPasswordHash('yeatom', 'not-a-valid-hash'), false)
assert.equal(hashAccessToken('a-session-token'), hashAccessToken('a-session-token'))
assert.notEqual(hashAccessToken('a-session-token'), hashAccessToken('another-session-token'))
assert.ok(Date.parse(PERMANENT_SESSION_EXPIRES_AT) > Date.now())

console.log('authentication checks passed')
void closeDatabase()
