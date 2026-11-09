// Sending side of case sharing: this PC serves a shared case to another Personal PACS user,
// anywhere on the internet, while it is switched on with the app open. Two ways in, both
// end-to-end encrypted with keys derived from the share code:
//   1. direct  – a peer-to-peer connection to this PC (HyperDHT: UDP hole punching through routers)
//   2. relay   – Cloudflare's free quick tunnel to a small server on 127.0.0.1 (when direct fails)
// The receiver tries the direct way first. The relay address is published, encrypted, in the
// peer-to-peer network under the share's key, so the code alone is enough to find this PC.

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReportStatus, ShareDownload, ShareEvent, ShareInfo, ShareLinkState, ShareStatus, StudyRow } from '@shared/types'
import { formatIsoDateTime } from '@shared/format'
import type { Db, ShareRow } from '../db'
import { sanitizeReportHtml } from '../validate'
import { ANON_NAME, anonymizePatches, scrubHtml, scrubText } from './anonymize'
import { checkRequest, deriveShareKeys, formatShareCode, newShareCode, openJson, seal, sealJson } from './crypto'
import type { ShareKeys } from './crypto'
import { dhtKeyPair, directDisabled, holdDht } from './dht'
import type { DhtHold, DhtKeyPair } from './dht'
import { CHUNK_SIZE, Pack } from './pack'
import type { PackFile } from './pack'
import { AUTH_HEADER, CLIENT_HEADER, REPLY_DAYS, SHARE_HOURS, SHARE_PROTOCOL_VERSION, aad } from './protocol'
import type { Hello, RelayRecord, ShareManifest, ShareReply } from './protocol'
import { serveRpc } from './rpc'
import type { RpcRequest, RpcResponse } from './rpc'
import { RelayTunnel } from './tunnel'

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAX_REPLY_BYTES = 40 * 1024 * 1024
const RELAY_REFRESH_MS = 30 * 60_000

interface Download extends ShareDownload {
  served: Set<number>
}

interface Live {
  row: ShareRow
  keys: ShareKeys
  kp: DhtKeyPair | null
  /** Shown on this PC only (includes the patient's name). */
  title: string
  /** Safe to put in the message (no patient details), e.g. "CT Chest". */
  label: string
  status: ShareStatus
  error: string | null
  pack: Pack | null
  preparing: Promise<void> | null
  files: number
  totalBytes: number
  /** Patient name / ID as written into the anonymized files (cut to the room each file has). */
  anonName: string
  anonId: string
  server: any | null
  direct: ShareLinkState
  directTriedAt: number
  relaySeq: number
  relayPublished: { url: string; at: number } | null
  downloads: Map<string, Download>
  replies: number
  emitTimer: NodeJS.Timeout | null
}

const empty = Buffer.alloc(0)
const reply = (status: number, body: Buffer = empty): RpcResponse => ({ status, body })

const LANDING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Personal PACS – shared case</title>
<style>
body{margin:0;background:#0b0d10;color:#e6e9ee;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:520px;margin:12vh auto;padding:0 20px}
h1{font-size:22px;margin:0 0 4px}h1 span{color:#19c8f5}
.card{background:#151a21;border:1px solid #26303b;border-radius:12px;padding:20px;margin-top:18px}
.btn{display:inline-block;background:#1677ff;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px}
.code{font:600 20px ui-monospace,Consolas,monospace;letter-spacing:2px;color:#fff}
.muted{color:#93a0b0;font-size:14px}
</style></head>
<body><main>
<h1>Personal <span>PACS</span></h1>
<div class="muted">A colleague shared a case with you.</div>
<div class="card">
<p><a id="open" class="btn" href="#">Open in Personal PACS</a></p>
<p class="muted">Nothing happened? Open Personal PACS on your computer, click <b>Receive case</b> and enter this code:</p>
<p class="code" id="code"></p>
</div>
<p class="muted">Cases can only be received in the Personal PACS app for Windows. The case is sent encrypted, straight from your colleague's computer.</p>
</main>
<script>
var code = decodeURIComponent(location.hash.slice(1)).toUpperCase().replace(/[^0-9A-Z-]/g, '').slice(0, 12);
document.getElementById('code').textContent = code || '(missing – ask for the code)';
document.getElementById('open').href = 'personalpacs://share/' + encodeURIComponent(code) + '?r=' + encodeURIComponent(location.origin);
</script>
</body></html>`

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    req.on('data', (d: Buffer) => {
      size += d.length
      if (size > max) {
        reject(new Error('Too large'))
        req.destroy()
        return
      }
      parts.push(d)
    })
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  return Array.isArray(v) ? v[0] : v
}

const cleanStr = (v: unknown, max: number): string => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max)

export class ShareHost {
  private live = new Map<string, Live>()
  private http: Server | null = null
  private httpPort: Promise<number> | null = null
  private dht: DhtHold | null = null
  private dhtPromise: Promise<DhtHold> | null = null
  private timer: NodeJS.Timeout | null = null
  readonly tunnel: RelayTunnel

  constructor(
    private readonly db: Db,
    private readonly archiveDir: string,
    toolsDir: string,
    private readonly emit: (e: ShareEvent) => void,
    fetchImpl: typeof fetch = fetch
  ) {
    this.tunnel = new RelayTunnel(toolsDir, () => this.onRelayChange(), fetchImpl)
  }

  // ------------------------------------------------------------------ lifecycle

  /** Brings back the shares that were running when the app was closed. */
  async init(): Promise<void> {
    this.timer = setInterval(() => this.tick(), 30_000)
    for (const row of this.db.listShareRows(REPLY_DAYS)) {
      const study = this.db.getStudy(row.studyId)
      const downloadable = !row.stoppedAt && Date.parse(row.expiresAt) > Date.now()
      if (!study || (!downloadable && !this.replyWindowOpen(row))) {
        this.db.closeShare(row.id)
        continue
      }
      try {
        const l = this.addLive(row, await deriveShareKeys(row.code), study)
        if (downloadable) this.activate(l)
        else {
          l.status = row.stoppedAt ? 'stopped' : 'expired'
          void this.startNetwork(l)
        }
      } catch {
        /* a broken row must not stop the app */
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.tunnel.stop()
    for (const l of this.live.values()) await l.server?.close().catch(() => {})
    this.live.clear()
    this.dht?.release()
    this.dht = null
    this.http?.close()
    this.http = null
  }

  // ------------------------------------------------------------------ public API

  async create(studyId: number, opts: { anonymize: boolean; allowReply: boolean }): Promise<ShareInfo> {
    const study = this.db.getStudy(studyId)
    if (!study) throw new Error('Case not found')
    const code = newShareCode()
    const keys = await deriveShareKeys(code)
    this.db.insertShare({
      id: keys.id,
      studyId,
      code,
      anonymize: !!opts.anonymize,
      allowReply: !!opts.allowReply,
      // 8 characters: fits the patient-ID field of almost every file, so nothing gets cut off.
      pseudoId: opts.anonymize ? `ANON${randomBytes(2).toString('hex').toUpperCase()}` : '',
      expiresAt: new Date(Date.now() + SHARE_HOURS * 3600_000).toISOString()
    })
    const row = this.db.listShareRows(REPLY_DAYS).find((r) => r.id === keys.id)
    if (!row) throw new Error('Could not save the share')
    const l = this.addLive(row, keys, study)
    this.activate(l)
    return this.info(l)
  }

  list(): ShareInfo[] {
    return [...this.live.values()].sort((a, b) => b.row.createdAt.localeCompare(a.row.createdAt)).map((l) => this.info(l))
  }

  /** Stops downloads. With `close` (or when no report can come back) the share ends completely. */
  stop(id: string, close = false): void {
    const l = this.live.get(id)
    if (!l) {
      this.db.closeShare(id)
      return
    }
    if (close || !this.replyWindowOpen(l.row)) {
      this.db.closeShare(id)
      void this.drop(l)
    } else {
      this.db.stopShare(id)
      l.row.stoppedAt = new Date().toISOString()
      l.status = 'stopped'
      l.pack = null
      this.emitShare(l)
    }
  }

  /** Is any share running (for the tray / quit warning)? */
  get activeCount(): number {
    return [...this.live.values()].filter((l) => l.status === 'active' || l.status === 'preparing').length
  }

  // ------------------------------------------------------------------ internals

  private replyWindowOpen(row: ShareRow): boolean {
    return row.allowReply && Date.now() < Date.parse(row.createdAt) + REPLY_DAYS * 86400_000
  }

  private replyUntil(row: ShareRow): string | null {
    return row.allowReply ? new Date(Date.parse(row.createdAt) + REPLY_DAYS * 86400_000).toISOString() : null
  }

  private addLive(row: ShareRow, keys: ShareKeys, study: StudyRow): Live {
    const modality = study.modalities.split('\\').filter((m) => m && m !== 'SR' && m !== 'PR')[0] ?? ''
    const desc = study.description.trim()
    const what = !desc ? modality : !modality || desc.toUpperCase().includes(modality.toUpperCase()) ? desc : `${modality} ${desc}`
    const l: Live = {
      row,
      keys,
      kp: null,
      title: [study.patientName || 'Unnamed', study.description || study.modalities].filter(Boolean).join(' – '),
      label: what,
      status: 'preparing',
      error: null,
      pack: null,
      preparing: null,
      files: 0,
      totalBytes: 0,
      anonName: ANON_NAME,
      anonId: row.pseudoId,
      server: null,
      direct: 'off',
      directTriedAt: 0,
      relaySeq: 0,
      relayPublished: null,
      downloads: new Map(),
      replies: this.db.countSecondOpinions(row.studyId),
      emitTimer: null
    }
    this.live.set(row.id, l)
    return l
  }

  private activate(l: Live): void {
    l.status = 'preparing'
    l.error = null
    l.preparing = this.prepare(l)
      .then(
        () => {
          if (l.status === 'preparing') l.status = 'active'
        },
        (e: Error) => {
          l.status = 'error'
          l.error = e.message
          l.pack = null
        }
      )
      .finally(() => {
        l.preparing = null
        this.emitShare(l)
      })
    this.emitShare(l)
    void this.startNetwork(l)
  }

  /** Lists the case's files (and, when anonymizing, works out which bytes to overwrite). */
  private async prepare(l: Live): Promise<void> {
    const study = this.db.getStudy(l.row.studyId)
    if (!study) throw new Error('The case was deleted')
    const rels = this.db.getInstancePathsForStudy(study.id)
    const files: (PackFile | null)[] = new Array(rels.length).fill(null)
    let nameLen = Infinity
    let idLen = Infinity
    let next = 0
    const worker = async () => {
      for (;;) {
        const i = next++
        if (i >= rels.length) return
        const path = join(this.archiveDir, ...rels[i].split('/'))
        let size: number
        try {
          size = (await stat(path)).size
        } catch {
          continue // file missing from the archive: send the rest
        }
        const f: PackFile = { path, size }
        if (l.row.anonymize) {
          try {
            const a = await anonymizePatches(path, l.row.pseudoId)
            f.patches = a.patches
            if (a.nameLength) nameLen = Math.min(nameLen, a.nameLength)
            if (a.idLength) idLen = Math.min(idLen, a.idLength)
          } catch (e) {
            throw new Error(`Patient details could not be removed from one of the images (${(e as Error).message}). Share it without removing them, or leave that image out.`)
          }
        }
        files[i] = f
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker))
    const list = files.filter((f): f is PackFile => f !== null)
    if (rels.length && !list.length) throw new Error('The image files of this case are missing from the archive')
    l.pack = new Pack(list)
    l.files = list.length
    l.totalBytes = l.pack.total
    if (Number.isFinite(nameLen)) l.anonName = ANON_NAME.slice(0, nameLen)
    if (Number.isFinite(idLen)) l.anonId = l.row.pseudoId.slice(0, idLen)
  }

  /** The case's details and report, read fresh for every receiver (so later edits are included). */
  private manifest(l: Live): ShareManifest {
    const s = this.db.getStudy(l.row.studyId)
    if (!s || !l.pack) throw new Error('gone')
    const settings = this.db.getSettings()
    const rep = this.db.getReport(s.id)
    const anon = l.row.anonymize
    const ids = anon ? [s.patientName, s.patientId, s.accession].filter((v) => v && v.trim().length >= 3) : []
    const text = (t: string) => (anon ? scrubText(t, ids) : t)
    const html = (h: string) => (anon ? scrubHtml(h, ids) : h)
    return {
      v: SHARE_PROTOCOL_VERSION,
      shareId: l.row.id,
      createdAt: l.row.createdAt,
      expiresAt: l.row.expiresAt,
      replyUntil: this.replyUntil(l.row) ?? l.row.expiresAt,
      sender: { name: settings.radiologistName, designation: settings.radiologistDesignation },
      anonymized: anon,
      allowReply: l.row.allowReply,
      study: {
        studyUid: s.studyUid,
        patientName: anon ? l.anonName : s.patientName,
        patientId: anon ? l.anonId : s.patientId,
        accession: anon ? '' : s.accession,
        age: s.age,
        sex: s.sex,
        birthDate: anon ? '' : s.birthDate,
        studyDate: s.studyDate,
        studyTime: s.studyTime,
        description: s.description,
        modalities: s.modalities,
        referring: anon ? '' : s.referring,
        institution: anon ? '' : s.institution,
        clinicalHistory: text(s.clinicalHistory),
        visitType: s.visitType,
        numImages: s.numImages,
        numSeries: s.numSeries
      },
      report:
        rep && rep.html.trim() && rep.status !== 'NEW'
          ? {
              status: rep.status,
              html: html(rep.html),
              text: text(rep.text),
              procedure: rep.procedure,
              radiologist: rep.radiologist || settings.radiologistName,
              templateName: rep.templateName,
              updatedAt: rep.updatedAt,
              signedAt: rep.signedAt
            }
          : null,
      files: l.pack.files.map((f, i) => ({ name: `f${String(i).padStart(5, '0')}.dcm`, size: f.size })),
      chunkSize: CHUNK_SIZE,
      totalBytes: l.pack.total
    }
  }

  // ------------------------------------------------------------------ network

  private async getDht(): Promise<DhtHold> {
    if (this.dht) return this.dht
    if (!this.dhtPromise) {
      this.dhtPromise = holdDht()
        .then((h) => {
          this.dht = h
          return h
        })
        .finally(() => {
          this.dhtPromise = null
        })
    }
    return this.dhtPromise
  }

  private async startNetwork(l: Live): Promise<void> {
    try {
      const port = await this.ensureHttp()
      this.tunnel.start(port)
    } catch (e) {
      l.error = `The relay could not start: ${(e as Error).message}`
    }
    await this.startDirect(l)
  }

  private async startDirect(l: Live): Promise<void> {
    if (l.server || l.direct === 'starting') return
    if (directDisabled()) {
      l.direct = 'unavailable'
      this.emitShare(l)
      return
    }
    l.direct = 'starting'
    l.directTriedAt = Date.now()
    this.emitShare(l)
    try {
      const { node } = await this.getDht()
      l.kp ??= await dhtKeyPair(l.keys.seed)
      const server = node.createServer((socket: any) => {
        socket.on('error', () => {})
        serveRpc(socket, (req) => this.handle(req, 'direct'))
      })
      server.on?.('error', () => {})
      await server.listen(l.kp)
      if (this.live.get(l.row.id) !== l) {
        await server.close().catch(() => {})
        return
      }
      l.server = server
      l.direct = 'ready'
      void this.publishRelay(l)
    } catch {
      l.direct = 'unavailable'
    }
    this.emitShare(l)
  }

  /** Puts the (encrypted) relay address into the peer-to-peer network under the share's key. */
  private async publishRelay(l: Live): Promise<void> {
    const url = this.tunnel.state === 'ready' ? this.tunnel.url : null
    if (!url || !l.kp || !l.server) return
    try {
      const { node } = await this.getDht()
      const rec: RelayRecord = { url, at: new Date().toISOString() }
      const seq = Math.max(Math.floor(Date.now() / 1000), l.relaySeq + 1)
      l.relaySeq = seq
      await node.mutablePut(l.kp, sealJson(l.keys.key, aad.relay(l.row.id), rec), { seq })
      l.relayPublished = { url, at: Date.now() }
    } catch {
      /* tried again by the timer */
    }
  }

  private onRelayChange(): void {
    for (const l of this.live.values()) {
      this.emitShare(l)
      if (this.tunnel.state === 'ready' && l.relayPublished?.url !== this.tunnel.url) void this.publishRelay(l)
    }
  }

  private relayState(): ShareLinkState {
    return this.tunnel.state
  }

  private ensureHttp(): Promise<number> {
    if (!this.httpPort) {
      this.httpPort = new Promise<number>((resolve, reject) => {
        const srv = createServer((req, res) => void this.onHttp(req, res))
        srv.on('error', (e) => {
          this.httpPort = null
          reject(e)
        })
        srv.listen(Number(process.env.PACS_SHARE_PORT) || 0, '127.0.0.1', () => {
          this.http = srv
          resolve((srv.address() as AddressInfo).port)
        })
      })
    }
    return this.httpPort
  }

  private async onHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: Buffer | string, type = 'application/octet-stream', extra: Record<string, string> = {}) => {
      const b = typeof body === 'string' ? Buffer.from(body) : body
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': b.length, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', ...extra })
      res.end(b)
    }
    try {
      const path = (req.url ?? '/').split('?')[0]
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        send(200, LANDING_PAGE, 'text/html; charset=utf-8', {
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
          'Referrer-Policy': 'no-referrer'
        })
        return
      }
      if (!path.startsWith('/s/')) {
        send(404, 'Not found', 'text/plain')
        return
      }
      const body = req.method === 'POST' ? await readBody(req, MAX_REPLY_BYTES) : empty
      const r = await this.handle(
        { method: req.method ?? 'GET', path, auth: header(req, AUTH_HEADER), client: header(req, CLIENT_HEADER), body },
        'relay'
      )
      send(r.status, r.body)
    } catch {
      if (!res.headersSent) send(500, '', 'text/plain')
      else res.destroy()
    }
  }

  // ------------------------------------------------------------------ requests

  private async handle(req: RpcRequest, via: 'direct' | 'relay'): Promise<RpcResponse> {
    const m = /^\/s\/([0-9a-f]{16})\/(manifest|chunk\/(\d{1,7})|done|reply)$/.exec(req.path)
    const l = m ? this.live.get(m[1]) : undefined
    // Wrong code / unknown share look the same: nothing to learn by guessing.
    if (!m || !l || !checkRequest(l.keys.mac, req.method, req.path, req.auth)) return reply(404)
    const what = m[2]
    const client = cleanStr(req.client, 64) || 'unknown'
    if (what === 'reply') {
      if (req.method !== 'POST') return reply(404)
      if (!this.replyWindowOpen(l.row) || !this.db.getStudy(l.row.studyId)) return reply(410)
      return this.onReply(l, req.body)
    }
    if (l.preparing) await l.preparing
    if (l.status !== 'active' || !l.pack) return reply(410)
    if (Date.now() >= Date.parse(l.row.expiresAt)) {
      this.tick()
      return reply(410)
    }
    if (what === 'manifest' && req.method === 'POST') {
      let hello: Hello | null = null
      try {
        hello = openJson<Hello>(l.keys.key, aad.hello(l.row.id), req.body)
      } catch {
        /* name is optional */
      }
      let manifest: ShareManifest
      try {
        manifest = this.manifest(l)
      } catch {
        return reply(410)
      }
      const d = this.track(l, client, via)
      if (hello) d.name = [cleanStr(hello.name, 80), cleanStr(hello.designation, 80)].filter(Boolean).join(', ')
      return reply(200, sealJson(l.keys.key, aad.manifest(l.row.id), manifest))
    }
    if (what === 'done' && req.method === 'POST') {
      const d = this.track(l, client, via)
      if (!d.done) {
        d.done = true
        d.bytes = d.total
        this.db.countShareDownload(l.row.id)
        l.row.downloads++
      }
      this.emitShare(l)
      return reply(200)
    }
    if (m[3] !== undefined && req.method === 'GET') {
      const n = Number(m[3])
      if (n >= l.pack.chunks) return reply(404)
      const data = await l.pack.chunk(n)
      const d = this.track(l, client, via)
      if (!d.served.has(n)) {
        d.served.add(n)
        d.bytes = Math.min(d.total, d.bytes + data.length)
      }
      return reply(200, seal(l.keys.key, aad.chunk(l.row.id, n), data))
    }
    return reply(404)
  }

  private track(l: Live, client: string, via: 'direct' | 'relay'): Download {
    let d = l.downloads.get(client)
    if (!d) {
      if (l.downloads.size >= 40) {
        const oldest = [...l.downloads.values()].sort((a, b) => a.lastSeen.localeCompare(b.lastSeen))[0]
        l.downloads.delete(oldest.id)
      }
      d = { id: client, name: '', via, bytes: 0, total: l.pack?.total ?? 0, done: false, lastSeen: '', served: new Set() }
      l.downloads.set(client, d)
    }
    d.via = via
    d.lastSeen = new Date().toISOString()
    this.emitShare(l)
    return d
  }

  private onReply(l: Live, body: Buffer): RpcResponse {
    let r: ShareReply
    try {
      r = openJson<ShareReply>(l.keys.key, aad.reply(l.row.id), body)
    } catch {
      return reply(400)
    }
    if (!r || typeof r.html !== 'string') return reply(400)
    const status: ReportStatus = r.status === 'PRELIMINARY' || r.status === 'FINAL' ? r.status : 'DRAFT'
    const fromName = cleanStr(r.from?.name, 120)
    const added = this.db.addSecondOpinion(l.row.studyId, {
      replyId: cleanStr(r.id, 64),
      fromName,
      fromDesignation: cleanStr(r.from?.designation, 120),
      status,
      html: sanitizeReportHtml(r.html.slice(0, 30_000_000)),
      text: String(r.text ?? '').slice(0, 2_000_000)
    })
    if (added) {
      l.replies++
      this.emit({ type: 'opinion', studyId: l.row.studyId, fromName: fromName || 'A colleague', title: l.title })
      this.emitShare(l)
    }
    return reply(200, sealJson(l.keys.key, aad.replyAck(l.row.id), { ok: true }))
  }

  // ------------------------------------------------------------------ housekeeping

  private tick(): void {
    const t = Date.now()
    for (const l of [...this.live.values()]) {
      if ((l.status === 'active' || l.status === 'preparing') && t >= Date.parse(l.row.expiresAt)) {
        l.status = 'expired'
        l.pack = null
        this.emitShare(l)
      }
      const downloadable = l.status === 'active' || l.status === 'preparing'
      if (!downloadable && !this.replyWindowOpen(l.row)) {
        this.db.closeShare(l.row.id)
        void this.drop(l)
        continue
      }
      if (l.server && this.tunnel.state === 'ready' && (!l.relayPublished || t - l.relayPublished.at > RELAY_REFRESH_MS)) void this.publishRelay(l)
      if (!l.server && l.direct === 'unavailable' && !directDisabled() && t - l.directTriedAt > 5 * 60_000) void this.startDirect(l) // try again now and then
    }
  }

  private async drop(l: Live): Promise<void> {
    if (this.live.get(l.row.id) === l) this.live.delete(l.row.id)
    if (l.emitTimer) clearTimeout(l.emitTimer)
    l.emitTimer = null
    l.status = 'closed'
    l.pack = null
    this.emit({ type: 'share', share: this.info(l) })
    const server = l.server
    l.server = null
    if (server) await server.close().catch(() => {})
    if (this.live.size === 0) {
      this.tunnel.stop()
      this.dht?.release()
      this.dht = null
    }
  }

  private emitShare(l: Live): void {
    if (l.emitTimer || l.status === 'closed') return
    l.emitTimer = setTimeout(() => {
      l.emitTimer = null
      if (l.status !== 'closed') this.emit({ type: 'share', share: this.info(l) })
    }, 150)
  }

  private info(l: Live): ShareInfo {
    const code = formatShareCode(l.row.code)
    const relayUrl = this.tunnel.state === 'ready' ? this.tunnel.url : null
    const link = relayUrl ? `${relayUrl}/#${code}` : null
    const downloadable = l.status === 'active' || l.status === 'preparing'
    return {
      id: l.row.id,
      studyId: l.row.studyId,
      title: l.title,
      code,
      link,
      message: this.message(l, code, link),
      createdAt: l.row.createdAt,
      expiresAt: l.row.expiresAt,
      replyUntil: this.replyUntil(l.row),
      anonymized: l.row.anonymize,
      allowReply: l.row.allowReply,
      status: l.status,
      direct: l.direct,
      relay: downloadable || this.replyWindowOpen(l.row) ? this.relayState() : 'off',
      error: l.error ?? (this.tunnel.state === 'unavailable' && l.direct !== 'ready' ? this.tunnel.error : null),
      files: l.files,
      totalBytes: l.totalBytes,
      downloads: [...l.downloads.values()]
        .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
        .map(({ served: _served, ...d }) => d), // eslint-disable-line @typescript-eslint/no-unused-vars
      replies: l.replies
    }
  }

  /** Ready-to-send text. Holds no patient details: it may travel through WhatsApp or e-mail. */
  private message(l: Live, code: string, link: string | null): string {
    const name = this.db.getSettings().radiologistName.trim()
    const lines = [
      `${name || 'A colleague'} shared a case with you on Personal PACS${l.label ? ` (${l.label})` : ''}.`,
      link ? `Open this link on your computer: ${link}` : '',
      `Or open Personal PACS, click "Receive case" and enter the code: ${code}`,
      `It works until ${formatIsoDateTime(l.row.expiresAt)}, while my computer is on.`
    ]
    return lines.filter(Boolean).join('\n')
  }
}
