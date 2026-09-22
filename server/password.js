import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const KEYLEN = 32

// scrypt 口令哈希；存储格式 saltHex:hashHex
export function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, KEYLEN)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), KEYLEN)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
