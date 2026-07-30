import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const PASSWORD_HASH_PREFIX = 'scrypt'
const PASSWORD_HASH_LENGTH = 64

export const AUTH_SESSION_DURATION_MS = 90 * 24 * 60 * 60 * 1000

export const hashAccessToken = (accessToken: string) => (
  createHash('sha256').update(accessToken).digest('hex')
)

export const createAccessToken = () => randomBytes(32).toString('base64url')

export const verifyPasswordHash = (password: string, storedHash: string) => {
  const [algorithm, saltHex, digestHex] = storedHash.split('$')
  if (algorithm !== PASSWORD_HASH_PREFIX || !saltHex || !digestHex) return false

  try {
    const expected = Buffer.from(digestHex, 'hex')
    if (expected.length !== PASSWORD_HASH_LENGTH) return false
    const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), PASSWORD_HASH_LENGTH)
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}
