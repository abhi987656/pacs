// What goes over the wire when a case is shared (both directions), and how share links look.
//
// Routes (same on the direct connection and through the relay; every request is signed with the
// share's HMAC key, every body is encrypted with its AES key):
//   POST /s/<id>/manifest   <- sealed Hello (receiver's name)  (aad "hello|<id>")
//                           -> sealed ShareManifest           (aad "manifest|<id>")
//   GET  /s/<id>/chunk/<n>  -> sealed bytes of chunk n        (aad "chunk|<id>|<n>")
//   POST /s/<id>/done       -> the receiver finished downloading
//   POST /s/<id>/reply      <- sealed ShareReply              (aad "reply|<id>")
//   GET  /                  -> small landing page for the https link (no case data)

import type { ReportStatus } from '@shared/types'
import { normalizeShareCode, SHARE_CODE_LENGTH } from './crypto'

export const SHARE_PROTOCOL_VERSION = 1
/** How long a share can be downloaded. */
export const SHARE_HOURS = 24
/** How long the receiver can still send their report back. */
export const REPLY_DAYS = 7
/** Header names for the relay (HTTP) requests. */
export const AUTH_HEADER = 'x-ppacs'
export const CLIENT_HEADER = 'x-ppacs-client'
export const LINK_SCHEME = 'personalpacs'

export const aad = {
  hello: (id: string) => `hello|${id}`,
  manifest: (id: string) => `manifest|${id}`,
  chunk: (id: string, n: number) => `chunk|${id}|${n}`,
  reply: (id: string) => `reply|${id}`,
  replyAck: (id: string) => `reply-ack|${id}`,
  relay: (id: string) => `relay|${id}`
}

export interface ShareManifest {
  v: number
  shareId: string
  createdAt: string
  expiresAt: string
  replyUntil: string
  sender: { name: string; designation: string }
  anonymized: boolean
  allowReply: boolean
  study: {
    studyUid: string
    patientName: string
    patientId: string
    accession: string
    age: string
    sex: string
    birthDate: string
    studyDate: string
    studyTime: string
    description: string
    modalities: string
    referring: string
    institution: string
    clinicalHistory: string
    visitType: string
    numImages: number
    numSeries: number
  }
  report: {
    status: ReportStatus
    html: string
    text: string
    procedure: string
    radiologist: string
    templateName: string
    updatedAt: string
    signedAt: string | null
  } | null
  files: { name: string; size: number }[]
  chunkSize: number
  totalBytes: number
}

export interface ShareReply {
  v: number
  id: string
  from: { name: string; designation: string }
  status: ReportStatus
  html: string
  text: string
  sentAt: string
}

/** Sent by the receiver with the manifest request, so the sender sees who is downloading. */
export interface Hello {
  name: string
  designation: string
}

/** The relay address, published (encrypted) in the peer-to-peer network under the share's key. */
export interface RelayRecord {
  url: string
  at: string
}

export interface ParsedShareInput {
  code: string
  relay: string | null
}

// Characters of the share code alphabet (no 0/O, 1/I), either case.
const C = '[2-9A-HJ-NP-Za-hj-np-z]'
const CODE_RE = new RegExp(`(?:^|[^0-9A-Za-z])(${C}{5})[- ]?(${C}{5})(?![0-9A-Za-z])`)
const CODE_AFTER_WORD_RE = new RegExp(`code\\W{0,3}(${C}{5})[- ]?(${C}{5})(?![0-9A-Za-z])`, 'i')

/** Only https relay addresses (or a local one, for tests) are used. */
export function cleanRelayUrl(u: string | null | undefined): string | null {
  if (!u) return null
  try {
    const url = new URL(u)
    const local = url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
    if (url.protocol !== 'https:' && !local) return null
    return url.origin
  } catch {
    return null
  }
}

/**
 * Accepts anything the receiver might paste: the code ("ABCDE-23456"), the https link
 * ("https://x.trycloudflare.com/#ABCDE-23456"), the personalpacs:// link, or the whole message.
 */
export function parseShareInput(input: string): ParsedShareInput | null {
  const text = String(input ?? '').trim()
  if (!text) return null
  const app = new RegExp(`${LINK_SCHEME}://share/([0-9A-Za-z-]+)(?:/?\\?([^\\s]*))?`, 'i').exec(text)
  if (app) {
    const code = normalizeShareCode(decodeURIComponent(app[1]))
    let relay: string | null = null
    if (app[2]) relay = cleanRelayUrl(new URLSearchParams(app[2]).get('r'))
    if (code.length === SHARE_CODE_LENGTH) return { code, relay }
  }
  const web = /(https?:\/\/[^\s#]+)#([0-9A-Za-z-]{10,12})/i.exec(text)
  if (web) {
    const code = normalizeShareCode(web[2])
    if (code.length === SHARE_CODE_LENGTH) return { code, relay: cleanRelayUrl(web[1]) }
  }
  // A bare code; prefer the one written after the word "code".
  const m = CODE_AFTER_WORD_RE.exec(text) ?? CODE_RE.exec(text)
  if (m) {
    const code = normalizeShareCode(m[1] + m[2])
    if (code.length === SHARE_CODE_LENGTH) return { code, relay: null }
  }
  return null
}

/** Link that opens Personal PACS directly (used by the landing page). */
export function appLink(code: string, relay: string | null): string {
  return `${LINK_SCHEME}://share/${normalizeShareCode(code)}${relay ? `?r=${encodeURIComponent(relay)}` : ''}`
}

/** Plain file names only (the manifest comes from another computer). */
export function safeFileName(name: string, index: number): string {
  const n = String(name ?? '').replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '')
  return n && n.length <= 64 ? n : `f${String(index).padStart(5, '0')}.dcm`
}

/** Checks the manifest received from the sender before anything is written to disk. */
export function checkManifest(m: ShareManifest, shareId: string): void {
  const bad = (what: string) => {
    throw new Error(`The shared case is damaged (${what})`)
  }
  if (!m || typeof m !== 'object') bad('manifest')
  if (m.v !== SHARE_PROTOCOL_VERSION) throw new Error('This case was shared from a different version of Personal PACS. Please update both apps.')
  if (m.shareId !== shareId) bad('id')
  if (!m.study || typeof m.study.studyUid !== 'string' || !m.study.studyUid) bad('study')
  if (!Array.isArray(m.files) || m.files.length > 200_000) bad('file list')
  let total = 0
  for (const f of m.files) {
    if (!f || !Number.isSafeInteger(f.size) || f.size < 0 || f.size > 4 * 1024 ** 3) bad('file size')
    total += f.size
  }
  if (total !== m.totalBytes) bad('total size')
  if (!Number.isSafeInteger(m.chunkSize) || m.chunkSize < 64 * 1024 || m.chunkSize > 16 * 1024 * 1024) bad('chunk size')
}
