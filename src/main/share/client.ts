// Receiving side of case sharing: finds the sender's PC from the share code (or link), downloads
// the case (direct peer-to-peer connection first, the encrypted relay as a fallback), imports it
// and keeps the sender's report. Also sends this user's report back as a second opinion.

import { randomUUID } from 'node:crypto'
import { mkdir, open as openFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ReceivePhase, ReceiveProgress } from '@shared/types'
import type { Db } from '../db'
import type { Importer } from '../importer'
import { sanitizeReportHtml } from '../validate'
import { deriveShareKeys, open, openJson, sealJson, signRequest } from './crypto'
import type { ShareKeys } from './crypto'
import { dhtKeyPair, dhtOnline, directDisabled, holdDht } from './dht'
import type { DhtHold } from './dht'
import {
  AUTH_HEADER,
  CLIENT_HEADER,
  SHARE_PROTOCOL_VERSION,
  aad,
  checkManifest,
  cleanRelayUrl,
  parseShareInput,
  safeFileName
} from './protocol'
import type { Hello, RelayRecord, ShareManifest, ShareReply } from './protocol'
import { RpcClient } from './rpc'

/* eslint-disable @typescript-eslint/no-explicit-any */

type Fetch = typeof fetch

/** How long the direct connection gets before the relay is used instead (it may still take over later). */
const DIRECT_HEAD_START_MS = Number(process.env.PACS_SHARE_DIRECT_WAIT_MS) || 8_000
const DIRECT_TIMEOUT_MS = 25_000
const WORKERS = 6
const MAX_TRIES = 8

class Cancelled extends Error {
  constructor() {
    super('Cancelled')
  }
}

/** Errors that retrying won't fix (wrong code, share stopped …). */
class Final extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, reject) => {
      t = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    })
  ])
}

// ------------------------------------------------------------------ connection to the sender

/** One connection to a sender's PC: direct if possible, otherwise through the relay. */
class Peer {
  via: 'direct' | 'relay' | null = null
  relayUrl: string | null
  private rpc: RpcClient | null = null
  private dht: DhtHold | null = null
  private relayOk = false
  private connecting: Promise<void> | null = null
  private directPending: Promise<boolean> | null = null
  private closed = false

  constructor(
    private readonly keys: ShareKeys,
    relayHint: string | null,
    private readonly fetchImpl: Fetch,
    private readonly clientId: string
  ) {
    this.relayUrl = relayHint
  }

  /** Connects: direct first; the relay if the direct way isn't up within a few seconds. */
  connect(): Promise<void> {
    if (!this.connecting) this.connecting = this.doConnect().finally(() => (this.connecting = null))
    return this.connecting
  }

  private async doConnect(): Promise<void> {
    if (this.closed) throw new Cancelled()
    const direct = this.directPending ?? (this.directPending = this.tryDirect().finally(() => (this.directPending = null)))
    const quick = await Promise.race([direct, sleep(DIRECT_HEAD_START_MS).then(() => false)])
    if (quick) return
    if (await this.findRelay()) return
    if (await direct) return
    throw new Final(
      "Could not reach the sender's computer. It must be switched on, with Personal PACS open and connected to the internet. " +
        'If you only typed the code, ask for the link as well.'
    )
  }

  private dhtPromise: Promise<DhtHold> | null = null

  /** The peer-to-peer node (shared by the direct attempt and the relay lookup). */
  private getDht(): Promise<DhtHold> {
    if (!this.dhtPromise) {
      this.dhtPromise = withTimeout(holdDht(), 30_000, 'Peer-to-peer start').then((h) => {
        if (this.closed) h.release()
        else this.dht = h
        return h
      })
      this.dhtPromise.catch(() => (this.dhtPromise = null))
    }
    return this.dhtPromise
  }

  private async tryDirect(): Promise<boolean> {
    // PACS_SHARE_DIRECT=relay-only (tests): find the relay through the DHT but never connect directly.
    if (directDisabled() || process.env.PACS_SHARE_DIRECT === 'relay-only' || this.closed) return false
    try {
      const { node } = await this.getDht()
      if (!dhtOnline(node)) return false // UDP blocked here: only the relay can work
      const kp = await dhtKeyPair(this.keys.seed)
      const socket = node.connect(kp.publicKey)
      socket.on('error', () => {})
      await withTimeout(
        new Promise<void>((resolve, reject) => {
          socket.once('open', () => resolve())
          socket.once('close', () => reject(new Error('closed')))
        }),
        DIRECT_TIMEOUT_MS,
        'Direct connection'
      ).catch((e) => {
        socket.destroy()
        throw e
      })
      if (this.closed) {
        socket.destroy()
        return false
      }
      if (this.rpc) this.oldRpcBytes += this.rpc.bytesIn
      this.rpc = new RpcClient(socket)
      return true
    } catch {
      return false
    }
  }

  /** The relay address from the link if it works, else the one the sender published in the DHT. */
  private async findRelay(): Promise<boolean> {
    if (this.relayUrl && (await this.relayAlive(this.relayUrl))) return (this.relayOk = true)
    const published = await this.lookupRelay()
    if (published && published !== this.relayUrl && (await this.relayAlive(published))) {
      this.relayUrl = published
      return (this.relayOk = true)
    }
    this.relayOk = false
    return false
  }

  private async lookupRelay(): Promise<string | null> {
    if (directDisabled()) return null
    try {
      const { node } = await this.getDht()
      if (!dhtOnline(node)) return null
      const kp = await dhtKeyPair(this.keys.seed)
      const res = await withTimeout<any>(node.mutableGet(kp.publicKey, { latest: true }), 20_000, 'Lookup')
      if (!res?.value) return null
      const rec = openJson<RelayRecord>(this.keys.key, aad.relay(this.keys.id), Buffer.from(res.value))
      return cleanRelayUrl(rec.url)
    } catch {
      return null
    }
  }

  private async relayAlive(url: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${url}/`, { signal: AbortSignal.timeout(15_000) })
      await res.arrayBuffer().catch(() => null)
      return res.ok
    } catch {
      return false
    }
  }

  /** One signed request; switches between direct and relay (and reconnects) when one fails. */
  async request(method: 'GET' | 'POST', path: string, body?: Buffer): Promise<{ status: number; body: Buffer }> {
    let lastErr: Error | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.closed) throw new Cancelled()
      if (this.rpc && !this.rpc.isClosed) {
        try {
          const r = await this.rpc.request(method, path, signRequest(this.keys.mac, method, path), this.clientId, body)
          this.via = 'direct'
          return r
        } catch (e) {
          lastErr = e as Error
          if (!this.rpc.isClosed) this.rpc.close() // a stuck connection: use the relay
          this.oldRpcBytes += this.rpc.bytesIn
          this.rpc = null
          void this.retryDirectLater()
        }
      }
      if (this.relayUrl && this.relayOk) {
        try {
          const { status, type, buf } = await this.relayRequest(method, path, body)
          // Cloudflare's own errors (tunnel down, 502/530 …) mean the relay is gone, not the share.
          if (status >= 500 || (status !== 200 && !type.includes('octet-stream'))) throw new Error(`Relay error ${status}`)
          this.via = 'relay'
          return { status, body: buf }
        } catch (e) {
          lastErr = e as Error
          this.relayOk = false
        }
      }
      // Neither way works right now: connect again (the relay address may have changed).
      try {
        await this.connect()
      } catch (e) {
        lastErr = e as Error
        if (e instanceof Final || e instanceof Cancelled) throw e
      }
    }
    throw lastErr ?? new Error('Connection lost')
  }

  /** Bytes received over the relay so far (with `rpc.bytesIn`: progress while big responses arrive). */
  private relayBytesIn = 0

  get bytesIn(): number {
    return this.relayBytesIn + (this.rpc?.bytesIn ?? 0) + this.oldRpcBytes
  }

  private oldRpcBytes = 0

  /**
   * One HTTP request through the relay. It fails only when nothing arrives for a minute (big
   * responses on slow connections simply take longer); sending a body gets time by its size.
   */
  private async relayRequest(method: string, path: string, body?: Buffer): Promise<{ status: number; type: string; buf: Buffer }> {
    const ctrl = new AbortController()
    let timer: NodeJS.Timeout | null = null
    const quiet = (ms: number) => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => ctrl.abort(new Error('Timed out')), ms)
    }
    quiet(60_000 + (body ? body.length / 20 : 0)) // at least 20 KB/s for the upload
    try {
      const res = await this.fetchImpl(this.relayUrl + path, {
        method,
        headers: {
          [AUTH_HEADER]: signRequest(this.keys.mac, method, path),
          [CLIENT_HEADER]: this.clientId,
          'Content-Type': 'application/octet-stream'
        },
        body: body ? new Uint8Array(body) : undefined,
        signal: ctrl.signal
      })
      const parts: Buffer[] = []
      if (res.body) {
        const reader = res.body.getReader()
        for (;;) {
          quiet(60_000)
          const { done, value } = await reader.read()
          if (done) break
          parts.push(Buffer.from(value))
          this.relayBytesIn += value.length
        }
      }
      return { status: res.status, type: res.headers.get('content-type') ?? '', buf: Buffer.concat(parts) }
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async retryDirectLater(): Promise<void> {
    if (this.directPending || this.closed) return
    await sleep(5_000)
    if (this.closed || this.rpc || this.directPending) return
    this.directPending = this.tryDirect().finally(() => (this.directPending = null))
  }

  close(): void {
    this.closed = true
    this.rpc?.close()
    this.rpc = null
    this.dht?.release()
    this.dht = null
  }
}

// ------------------------------------------------------------------ receive jobs

interface Job {
  id: string
  code: string
  relay: string | null
  progress: ReceiveProgress
  cancelled: boolean
  finished: boolean
  peer: Peer | null
  dir: string | null
  lastEmit: number
  samples: { t: number; bytes: number }[]
}

export class ShareReceiver {
  private jobs = new Map<string, Job>()
  private importChain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly db: Db,
    private readonly importer: Importer,
    private readonly tmpDir: string,
    private readonly emit: (p: ReceiveProgress) => void,
    /** Called after a received case was added (refresh windows). */
    private readonly onReceived: (studyId: number) => void,
    private readonly fetchImpl: Fetch = fetch
  ) {}

  /** Removes half-finished downloads left over from a crash. */
  async cleanup(): Promise<void> {
    try {
      for (const name of await readdir(this.tmpDir)) {
        if (name.startsWith('receive-')) await rm(join(this.tmpDir, name), { recursive: true, force: true })
      }
    } catch {
      /* nothing to clean */
    }
  }

  start(input: string): string {
    const parsed = parseShareInput(input)
    if (!parsed) throw new Error('That is not a share code or link. A code looks like ABCDE-23456.')
    for (const j of this.jobs.values()) {
      if (j.code === parsed.code && !j.cancelled && !j.finished) return j.id // already receiving this one
    }
    const id = randomUUID()
    const job: Job = {
      id,
      code: parsed.code,
      relay: parsed.relay,
      cancelled: false,
      finished: false,
      peer: null,
      dir: null,
      lastEmit: 0,
      samples: [],
      progress: {
        jobId: id,
        phase: 'connecting',
        via: null,
        title: '',
        sender: '',
        bytes: 0,
        total: 0,
        rate: 0,
        message: "Looking for the sender's computer…",
        studyId: null
      }
    }
    this.jobs.set(id, job)
    void this.run(job).finally(() => this.jobs.delete(id))
    return id
  }

  cancel(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (!job) return
    job.cancelled = true
    job.peer?.close()
  }

  get busy(): boolean {
    return this.jobs.size > 0
  }

  private update(job: Job, patch: Partial<ReceiveProgress>, force = false): void {
    Object.assign(job.progress, patch)
    if (job.peer?.via) job.progress.via = job.peer.via
    const t = Date.now()
    if (force || t - job.lastEmit > 250) {
      job.lastEmit = t
      this.emit({ ...job.progress })
    }
  }

  private phase(job: Job, phase: ReceivePhase, message: string, patch: Partial<ReceiveProgress> = {}): void {
    if (phase === 'done' || phase === 'error' || phase === 'cancelled') job.finished = true
    this.update(job, { ...patch, phase, message }, true)
  }

  private async run(job: Job): Promise<void> {
    this.phase(job, 'connecting', "Looking for the sender's computer…")
    try {
      const keys = await deriveShareKeys(job.code)
      if (job.cancelled) throw new Cancelled()
      const peer = new Peer(keys, job.relay, this.fetchImpl, randomUUID())
      job.peer = peer
      await peer.connect()
      if (job.cancelled) throw new Cancelled()
      const s = this.db.getSettings()
      const hello: Hello = { name: s.radiologistName, designation: s.radiologistDesignation }
      const r = await peer.request('POST', `/s/${keys.id}/manifest`, sealJson(keys.key, aad.hello(keys.id), hello))
      if (r.status === 404) throw new Final("No case was found for this code. Check the code, and that the sender's Personal PACS is open.")
      if (r.status === 410) throw new Final('The sender stopped sharing this case, or the code has expired (codes work for 24 hours).')
      if (r.status !== 200) throw new Final(`The sender's computer answered with an error (${r.status}).`)
      const m = openJson<ShareManifest>(keys.key, aad.manifest(keys.id), r.body)
      checkManifest(m, keys.id)
      const title = [m.study.patientName, m.study.description || m.study.modalities].filter(Boolean).join(' – ')
      const sender = m.sender.name.trim() || 'A colleague'
      this.phase(job, 'downloading', m.totalBytes ? 'Downloading…' : 'Receiving…', { title, sender, total: m.totalBytes, bytes: 0 })

      job.dir = join(this.tmpDir, `receive-${job.id}`)
      if (m.files.length) await this.download(job, keys, m, job.dir)
      if (job.cancelled) throw new Cancelled()
      void peer.request('POST', `/s/${keys.id}/done`).catch(() => {})

      this.phase(job, 'importing', 'Adding the case to your worklist…')
      const studyId = await this.importCase(job, keys, m)
      this.db.saveReceivedShare({
        id: keys.id,
        studyId,
        code: keys.code,
        relayUrl: peer.relayUrl ?? '',
        senderName: sender,
        allowReply: m.allowReply,
        anonymized: m.anonymized,
        replyUntil: m.replyUntil
      })
      this.onReceived(studyId)
      this.phase(job, 'done', `Case received from ${sender}`, { studyId, bytes: m.totalBytes })
    } catch (e) {
      if (job.cancelled || e instanceof Cancelled) this.phase(job, 'cancelled', 'Cancelled')
      else this.phase(job, 'error', friendly(e as Error))
    } finally {
      job.peer?.close()
      if (job.dir) await rm(job.dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private async download(job: Job, keys: ShareKeys, m: ShareManifest, dir: string): Promise<void> {
    await mkdir(dir, { recursive: true })
    const used = new Set<string>()
    const paths = m.files.map((f, i) => {
      let name = safeFileName(f.name, i)
      if (used.has(name.toLowerCase())) name = `f${String(i).padStart(5, '0')}-${i}.dcm`
      used.add(name.toLowerCase())
      return join(dir, name)
    })
    const starts: number[] = []
    let pos = 0
    for (let i = 0; i < m.files.length; i++) {
      starts.push(pos)
      pos += m.files[i].size
      await writeFile(paths[i], Buffer.alloc(0))
    }
    const chunks = Math.ceil(m.totalBytes / m.chunkSize)
    const queue = Array.from({ length: chunks }, (_, i) => i)
    const tries = new Uint8Array(chunks)
    let fatal: Error | null = null
    let bytes = 0

    const write = async (offset: number, data: Buffer) => {
      // First file overlapping the range (binary search), then every file it spans.
      let lo = 0
      let hi = m.files.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (starts[mid] <= offset) lo = mid
        else hi = mid - 1
      }
      const end = offset + data.length
      for (let i = lo; i < m.files.length && starts[i] < end; i++) {
        const from = Math.max(offset, starts[i])
        const to = Math.min(end, starts[i] + m.files[i].size)
        if (to <= from) continue
        const fh = await openFile(paths[i], 'r+')
        try {
          await fh.write(data, from - offset, to - from, from - starts[i])
        } finally {
          await fh.close()
        }
      }
    }

    // Progress from the bytes actually arriving (a chunk is only complete at its end).
    const rawStart = job.peer!.bytesIn
    const shown = () => Math.min(m.totalBytes - 1, Math.max(bytes, job.peer!.bytesIn - rawStart))
    const ticker = setInterval(() => this.progress(job, shown()), 500)

    const worker = async () => {
      while (!fatal && !job.cancelled) {
        const n = queue.shift()
        if (n === undefined) return
        try {
          const r = await job.peer!.request('GET', `/s/${keys.id}/chunk/${n}`)
          if (r.status === 410) throw new Final('The sender stopped sharing this case before the download finished.')
          if (r.status === 404) throw new Final('The sender no longer has this case.')
          if (r.status !== 200) throw new Error(`Error ${r.status}`)
          const data = open(keys.key, aad.chunk(keys.id, n), r.body)
          if (data.length !== Math.min(m.chunkSize, m.totalBytes - n * m.chunkSize)) throw new Error('Wrong size')
          await write(n * m.chunkSize, data)
          bytes += data.length
          this.progress(job, shown())
        } catch (e) {
          if (e instanceof Final || e instanceof Cancelled) {
            fatal = e
            return
          }
          if (++tries[n] >= MAX_TRIES) {
            fatal = new Error(`The download kept failing (${(e as Error).message}).`)
            return
          }
          queue.push(n)
          await sleep(Math.min(15_000, 400 * 2 ** tries[n]))
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(WORKERS, Math.max(1, chunks)) }, worker))
    } finally {
      clearInterval(ticker)
    }
    if (job.cancelled) throw new Cancelled()
    if (fatal) throw fatal
    this.progress(job, bytes, true)
  }

  private progress(job: Job, bytes: number, force = false): void {
    const t = Date.now()
    job.samples.push({ t, bytes })
    while (job.samples.length > 2 && t - job.samples[0].t > 4000) job.samples.shift()
    const first = job.samples[0]
    const rate = t > first.t ? ((bytes - first.bytes) * 1000) / (t - first.t) : 0
    const pct = job.progress.total ? Math.floor((bytes / job.progress.total) * 100) : 0
    this.update(job, { bytes, rate, message: `Downloading… ${pct}%` }, force)
  }

  /** Imports the files (one import at a time) and stores the case details and the sender's report. */
  private async importCase(job: Job, keys: ShareKeys, m: ShareManifest): Promise<number> {
    const before = this.db.findStudyIdByUid(m.study.studyUid) ?? this.db.findReceivedShare(keys.id)?.studyId ?? null
    let studyId: number | null = before
    if (m.files.length) {
      const run = this.importChain.then(async () => {
        for (;;) {
          if (job.cancelled) throw new Cancelled()
          if (!this.importer.isRunning) {
            try {
              return await this.importer.run([job.dir!])
            } catch (e) {
              if (!/already running/i.test((e as Error).message)) throw e
            }
          }
          await sleep(500) // the user is importing something else: wait for it
        }
      })
      this.importChain = run.catch(() => {})
      const res = await run
      studyId = this.db.findStudyIdByUid(m.study.studyUid) ?? res.studyIds[0] ?? null
      if (!studyId) throw new Error(`The received images could not be imported (${res.errors} errors, ${res.skipped} skipped).`)
    }
    const st = m.study
    const details = {
      patientName: st.patientName,
      patientId: st.patientId,
      accession: st.accession,
      sex: st.sex,
      age: st.age,
      birthDate: st.birthDate,
      description: st.description,
      studyDate: st.studyDate,
      studyTime: st.studyTime,
      referring: st.referring,
      visitType: st.visitType,
      clinicalHistory: st.clinicalHistory
    }
    if (!studyId) {
      // A case without images.
      const sid = /^manual-([0-9a-f-]{36})$/i.exec(st.studyUid)?.[1]
      studyId = this.db.createManualStudy(
        { ...details, modality: st.modalities.split('\\')[0] ?? '' },
        sid && !this.db.findStudyIdByUid(`manual-${sid}`) ? { syncId: sid } : {}
      )
    } else if (before == null) {
      // New on this PC: show it exactly as the sender had it.
      this.db.updateStudyDetails(studyId, details)
    } else if (!this.db.getStudy(studyId)?.clinicalHistory && st.clinicalHistory) {
      this.db.updateStudy(studyId, { clinicalHistory: st.clinicalHistory })
    }
    const rep = m.report
    if (rep && rep.html.trim()) {
      const html = sanitizeReportHtml(rep.html)
      const sender = m.sender.name.trim() || 'a colleague'
      const label = rep.status === 'FINAL' ? 'final' : rep.status === 'PRELIMINARY' ? 'preliminary' : 'draft'
      const note = `Received from ${sender} (${label} report)`
      const mine = this.db.getReport(studyId)
      if (!mine || !mine.html.trim()) {
        // Their report becomes a draft here: read it, change it, and send your opinion back.
        this.db.saveReport({
          studyId,
          status: 'DRAFT',
          html,
          text: String(rep.text ?? ''),
          modality: st.modalities.split('\\')[0] ?? '',
          procedure: String(rep.procedure ?? ''),
          radiologist: '',
          templateName: String(rep.templateName ?? '')
        })
        this.db.noteLatestVersion(studyId, note)
      } else if (mine.html !== html) {
        this.db.addReportVersionNote(studyId, html, rep.status, note) // keep yours, store theirs in History
      }
    }
    return studyId
  }

  // ------------------------------------------------------------------ second opinion back to the sender

  async reply(studyId: number): Promise<string> {
    const rs = this.db.receivedForStudy(studyId)
    if (!rs) throw new Error('This case was not received from another Personal PACS user.')
    const who = rs.senderName || 'the sender'
    if (!rs.allowReply) throw new Error(`${who} did not ask for a report back.`)
    if (rs.replyUntil && Date.now() > Date.parse(rs.replyUntil)) throw new Error('Too late: a report can be sent back for 7 days after the case was shared.')
    const rep = this.db.getReport(studyId)
    if (!rep || !rep.html.trim()) throw new Error('Write your report first.')
    const keys = await deriveShareKeys(rs.code)
    const peer = new Peer(keys, rs.relayUrl || null, this.fetchImpl, randomUUID())
    try {
      await peer.connect().catch((e: Error) => {
        throw new Error(e instanceof Final ? `Could not reach ${who}'s computer. It must be switched on, with Personal PACS open.` : e.message)
      })
      const s = this.db.getSettings()
      const body: ShareReply = {
        v: SHARE_PROTOCOL_VERSION,
        id: randomUUID(),
        from: { name: s.radiologistName, designation: s.radiologistDesignation },
        status: rep.status,
        html: rep.html,
        text: rep.text,
        sentAt: new Date().toISOString()
      }
      const r = await peer.request('POST', `/s/${keys.id}/reply`, sealJson(keys.key, aad.reply(keys.id), body))
      if (r.status === 410) throw new Error(`${who} is no longer accepting reports for this case.`)
      if (r.status === 404) throw new Error(`${who}'s computer no longer has this case.`)
      if (r.status !== 200) throw new Error(`${who}'s computer answered with an error (${r.status}).`)
      openJson(keys.key, aad.replyAck(keys.id), r.body)
      this.db.markReplied(rs.id, peer.relayUrl ?? undefined)
      return `Your report was sent to ${who}.`
    } finally {
      peer.close()
    }
  }
}

function friendly(e: Error): string {
  const msg = e?.message || String(e)
  if (/unable to authenticate|Unsupported state/i.test(msg)) return 'The data could not be decrypted – the code may be wrong.'
  if (/fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|network/i.test(msg)) return "The connection to the sender's computer was lost. Try again."
  return msg
}
