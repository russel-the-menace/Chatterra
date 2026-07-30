import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const PASSWORD_HASH_PREFIX = 'scrypt'
const PASSWORD_HASH_LENGTH = 64

// PostgreSQL stores the session expiry as `infinity`; clients receive this
// parseable sentinel for durable local storage.
export const PERMANENT_SESSION_EXPIRES_AT = '9999-12-31T23:59:59.999Z'

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
