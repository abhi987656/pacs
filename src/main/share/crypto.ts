// Keys and encryption for case sharing. Everything is derived from the share code, so the code
// (or the link carrying it) is all the receiver needs.
//
// code --scrypt (slow on purpose: a guessed code costs real CPU time)--> 64-byte master
//   master[0..32]  -> seed of the sender's peer-to-peer (DHT) key pair
//   master[32..64] -> HKDF -> AES-256-GCM key (all data) + HMAC key (request signatures)
// The relay (Cloudflare) and the DHT only ever see encrypted bytes.

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { PAIR_CODE_ALPHABET, formatPairCode, normalizePairCode } from '@shared/syncCrypto'

export const SHARE_CODE_LENGTH = 10

export function newShareCode(): string {
  return Array.from(randomBytes(SHARE_CODE_LENGTH), (b) => PAIR_CODE_ALPHABET[b % 32]).join('')
}

export const formatShareCode = formatPairCode
export const normalizeShareCode = normalizePairCode

export interface ShareKeys {
  code: string
  /** Short public id of the share (used in relay URLs). */
  id: string
  seed: Buffer
  key: Buffer
  mac: Buffer
}

const cache = new Map<string, Promise<ShareKeys>>()

export function deriveShareKeys(codeInput: string): Promise<ShareKeys> {
  const code = normalizeShareCode(codeInput)
  let p = cache.get(code)
  if (!p) {
    p = new Promise<ShareKeys>((resolve, reject) => {
      scrypt(code, 'PersonalPACS case share v1', 64, { N: 1 << 15, r: 8, p: 1, maxmem: 96 * 1024 * 1024 }, (err, master) => {
        if (err) return reject(err)
        const seed = Buffer.from(master.subarray(0, 32))
        const ikm = master.subarray(32, 64)
        const key = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'ppacs share enc', 32))
        const mac = Buffer.from(hkdfSync('sha256', ikm, Buffer.alloc(0), 'ppacs share mac', 32))
        const id = createHash('sha256').update(key).digest('hex').slice(0, 16)
        resolve({ code, id, seed, key, mac })
      })
    })
    cache.set(code, p)
  }
  return p
}

/** nonce (12) | ciphertext | tag (16). `aad` binds the data to its purpose (e.g. "chunk 7"). */
export function seal(key: Buffer, aad: string, data: Buffer): Buffer {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(data), c.final()])
  return Buffer.concat([iv, ct, c.getAuthTag()])
}

export function open(key: Buffer, aad: string, buf: Buffer): Buffer {
  if (buf.length < 28) throw new Error('Damaged data')
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(buf.subarray(buf.length - 16))
  return Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()])
}

export const sealJson = (key: Buffer, aad: string, v: unknown): Buffer => seal(key, aad, Buffer.from(JSON.stringify(v)))
export const openJson = <T>(key: Buffer, aad: string, buf: Buffer): T => JSON.parse(open(key, aad, buf).toString('utf8')) as T

/** Request signature: proves the caller knows the share code (clock tolerance: 1 day). */
export function signRequest(mac: Buffer, method: string, path: string, ts = Date.now()): string {
  const sig = createHmac('sha256', mac).update(`${method} ${path} ${ts}`).digest('base64url')
  return `${ts}.${sig}`
}

export function checkRequest(mac: Buffer, method: string, path: string, header: string | undefined): boolean {
  if (!header) return false
  const dot = header.indexOf('.')
  const ts = Number(header.slice(0, dot))
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 86400000) return false
  const want = Buffer.from(signRequest(mac, method, path, ts))
  const got = Buffer.from(header)
  return want.length === got.length && timingSafeEqual(want, got)
}
