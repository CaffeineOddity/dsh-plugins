import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

export function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** 先哈希再比较，避免用长度或前缀提前返回。 */
export function hashEquals(value: string, expectedHex: string): boolean {
  const actual = createHash('sha256').update(value).digest()
  const expected = Buffer.from(expectedHex.padEnd(64, '0').slice(0, 64), 'hex')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(actual, expected) && expectedHex.length === 64
}

export function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 })
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export function verifyPassphrase(passphrase: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt' || parts[1] === undefined || parts[2] === undefined) return false
  const salt = Buffer.from(parts[1], 'base64url')
  const expected = Buffer.from(parts[2], 'base64url')
  const actual = scryptSync(passphrase, salt, expected.length, { N: 16384, r: 8, p: 1 })
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

export function newHubKey(): string {
  return randomBytes(32).toString('base64url')
}

export interface Sealed {
  cipher: string
  iv: string
  tag: string
}

export function seal(plain: string, keyB64: string): Sealed {
  const key = Buffer.from(keyB64, 'base64url')
  if (key.length !== 32) throw new Error('hub key 无效')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return { cipher: enc.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') }
}

export function open(sealed: Sealed, keyB64: string): string {
  const key = Buffer.from(keyB64, 'base64url')
  if (key.length !== 32) throw new Error('hub key 无效')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(sealed.cipher, 'base64url')), decipher.final()]).toString('utf8')
}
