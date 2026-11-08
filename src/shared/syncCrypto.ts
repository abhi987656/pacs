// Encryption between the PC and the phone app. The same code runs in Electron's main process
// (Node's WebCrypto) and in the Android app's WebView, so both sides always agree.
//
// Pairing: the PC shows a one-time code (in a QR code, or typed by hand). Both sides derive a
// temporary key from it, exchange fresh ECDH public keys under that key, and derive a permanent
// per-phone key from the ECDH secret. Someone who only listens on the Wi-Fi can't work out that
// key, even if they later guess the code. After pairing, every request and response is
// encrypted and authenticated with AES-256-GCM.

const te = new TextEncoder()
const td = new TextDecoder()

// Types that work both with Node's WebCrypto typings and the browser's DOM typings.
type Subtle = typeof globalThis.crypto.subtle
export type SyncKey = Awaited<ReturnType<Subtle['importKey']>>
export interface SyncKeyPair {
  publicKey: SyncKey
  privateKey: SyncKey
}
const subtle = (): Subtle => globalThis.crypto.subtle

/** Copies into a fresh ArrayBuffer-backed array (WebCrypto typings reject SharedArrayBuffer views). */
const bytes = (u: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(u.byteLength))
  out.set(u)
  return out
}

export function toB64(u: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromB64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(s.length))
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(n))
  globalThis.crypto.getRandomValues(out)
  return out
}

// ------------------------------------------------------------------ pairing code

/** No 0/O or 1/I, so the code can be read off the screen and typed without mistakes. */
export const PAIR_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
export const PAIR_CODE_LENGTH = 10

export function newPairCode(): string {
  // 32 symbols: one random byte modulo 32 is unbiased.
  return Array.from(randomBytes(PAIR_CODE_LENGTH), (b) => PAIR_CODE_ALPHABET[b % 32]).join('')
}

/** "abcde-fghjk" / "ABCDE FGHJK" -> "ABCDEFGHJK" */
export function normalizePairCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '')
}

export function formatPairCode(code: string): string {
  return code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : code
}

export async function pairKey(code: string, pcId: string): Promise<SyncKey> {
  const base = await subtle().importKey('raw', te.encode(normalizePairCode(code)), 'PBKDF2', false, ['deriveKey'])
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(`PersonalPACS pairing v1|${pcId}`), iterations: 150_000 },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  )
}

// ------------------------------------------------------------------ device key (ECDH)

export async function newEcdhKeyPair(): Promise<SyncKeyPair> {
  return (await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as unknown as SyncKeyPair
}

export async function exportPublicKey(key: SyncKey): Promise<string> {
  return toB64(new Uint8Array(await subtle().exportKey('raw', key)))
}

/** Both sides call this with their own private key and the other side's public key. */
export async function deriveDeviceKey(
  privateKey: SyncKey,
  peerPublicB64: string,
  pcId: string,
  deviceId: string
): Promise<Uint8Array> {
  const peer = await subtle().importKey('raw', fromB64(peerPublicB64), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = await subtle().deriveBits({ name: 'ECDH', public: peer }, privateKey, 256)
  const hk = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveBits'])
  const bits = await subtle().deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: te.encode(`${pcId}|${deviceId}`), info: te.encode('PersonalPACS device key v1') },
    hk,
    256
  )
  return new Uint8Array(bits)
}

export async function importDeviceKey(raw: Uint8Array): Promise<SyncKey> {
  return subtle().importKey('raw', bytes(raw), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

// ------------------------------------------------------------------ messages

/** What actually travels over the network: nonce + ciphertext (with the GCM tag), base64. */
export interface Envelope {
  n: string
  c: string
}

export function isEnvelope(x: unknown): x is Envelope {
  return !!x && typeof (x as Envelope).n === 'string' && typeof (x as Envelope).c === 'string'
}

/**
 * Encrypts a JSON payload. `aad` binds the message to its purpose (e.g. "pull|req|<device>") so a
 * response can't be replayed as a request or sent to another phone.
 */
export async function seal(key: SyncKey, aad: string, payload: unknown): Promise<Envelope> {
  const iv = randomBytes(12)
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(aad) },
    key,
    te.encode(JSON.stringify(payload))
  )
  return { n: toB64(iv), c: toB64(new Uint8Array(ct)) }
}

/** Decrypts and checks a message; throws if the key or purpose is wrong or it was tampered with. */
export async function unseal<T>(key: SyncKey, aad: string, env: Envelope): Promise<T> {
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: fromB64(env.n), additionalData: te.encode(aad) },
    key,
    fromB64(env.c)
  )
  return JSON.parse(td.decode(pt)) as T
}

// ------------------------------------------------------------------ pairing QR code

export interface PairingInfo {
  pcId: string
  pcName: string
  hosts: string[]
  port: number
  code: string
}

export function pairingUri(p: PairingInfo): string {
  const q = new URLSearchParams({
    v: '1',
    id: p.pcId,
    n: p.pcName,
    h: p.hosts.join(','),
    p: String(p.port),
    c: p.code
  })
  return `ppacs://pair?${q.toString()}`
}

export function parsePairingUri(uri: string): PairingInfo | null {
  const m = /^ppacs:\/\/pair\?(.*)$/i.exec(uri.trim())
  if (!m) return null
  const q = new URLSearchParams(m[1])
  const pcId = q.get('id') ?? ''
  const code = normalizePairCode(q.get('c') ?? '')
  const port = Number(q.get('p'))
  if (!pcId || code.length < 6 || !Number.isInteger(port) || port <= 0 || port > 65535) return null
  return {
    pcId,
    pcName: q.get('n') ?? 'PC',
    hosts: (q.get('h') ?? '').split(',').map((h) => h.trim()).filter(Boolean),
    port,
    code
  }
}

// Wire constants shared by both sides.
export const SYNC_HTTP_PORT = 47820
export const SYNC_DISCOVERY_PORT = 47821
export const DISCOVER_MESSAGE = 'PPACS-DISCOVER'
export const HERE_MESSAGE = 'PPACS-HERE'
