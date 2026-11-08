import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createSocket } from 'node:dgram'
import type { Socket } from 'node:dgram'
import { randomUUID } from 'node:crypto'
import { hostname, networkInterfaces } from 'node:os'
import type {
  PhoneDevice,
  PhoneEvent,
  PhoneLinkStatus,
  PullRequest,
  PushMacro,
  PushReport,
  PushRequest,
  PushResponse,
  PushResult,
  PushStudy,
  PushTemplate
} from '@shared/types'
import {
  DISCOVER_MESSAGE,
  HERE_MESSAGE,
  SYNC_DISCOVERY_PORT,
  SYNC_HTTP_PORT,
  deriveDeviceKey,
  exportPublicKey,
  fromB64,
  importDeviceKey,
  isEnvelope,
  newEcdhKeyPair,
  newPairCode,
  pairKey,
  pairingUri,
  seal,
  toB64,
  unseal
} from '@shared/syncCrypto'
import type { Envelope, SyncKey } from '@shared/syncCrypto'
import type { Db } from './db'
import { cleanManualInput, sanitizeReportHtml } from './validate'

// The "phone link": a small server on the local network that the Android app syncs with.
// It only answers paired phones (each has its own key), and everything is encrypted.

interface PhoneConfig {
  enabled: boolean
  pcId: string
  pcName: string
  port: number
}

interface PairingSession {
  code: string
  key: SyncKey
  expiresAt: number
  attempts: number
  timer: NodeJS.Timeout
}

const PAIRING_MINUTES = 10
const MAX_BODY = 80 * 1024 * 1024

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code)
  }
}

export class PhoneLink {
  private server: Server | null = null
  private udp: Socket | null = null
  private port = 0
  private error: string | null = null
  private pairing: PairingSession | null = null
  private keys = new Map<string, SyncKey>()
  private lastSync: PhoneLinkStatus['lastSync'] = null

  constructor(
    private readonly db: Db,
    private readonly emit: (e: PhoneEvent) => void,
    /** Called after a phone changed cases/reports on the PC (to refresh open windows). */
    private readonly onChanged: (studyIds: number[]) => void,
    private readonly portOverride?: number
  ) {}

  // ------------------------------------------------------------------ configuration

  private config(): PhoneConfig {
    let c = this.db.getKv<PhoneConfig>('phone')
    if (!c || !c.pcId) {
      c = {
        enabled: false,
        pcId: randomUUID(),
        pcName: `Personal PACS (${hostname()})`,
        port: SYNC_HTTP_PORT
      }
      this.db.setKv('phone', c)
    }
    return c
  }

  private saveConfig(patch: Partial<PhoneConfig>): PhoneConfig {
    const c = { ...this.config(), ...patch }
    this.db.setKv('phone', c)
    return c
  }

  /** Starts the server at launch if the phone link was turned on before. */
  async init(): Promise<void> {
    if (this.config().enabled) await this.start()
  }

  addresses(): string[] {
    const out: string[] = []
    for (const [name, list] of Object.entries(networkInterfaces())) {
      for (const a of list ?? []) {
        if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue
        // Virtual adapters (VirtualBox, Hyper-V, VPNs …) go last; Wi-Fi/Ethernet are tried first.
        const virtual = /virtual|vmware|vbox|hyper-v|vethernet|docker|wsl|tailscale|zerotier|vpn|loopback/i.test(name)
        if (virtual) out.push(a.address)
        else out.unshift(a.address)
      }
    }
    return [...new Set(out)]
  }

  status(): PhoneLinkStatus {
    const c = this.config()
    return {
      enabled: c.enabled,
      running: !!this.server,
      port: this.port || c.port,
      addresses: this.addresses(),
      pcName: c.pcName,
      pcId: c.pcId,
      devices: this.db.listDevices().map(({ key: _key, ...d }) => d),
      pairing: this.pairing
        ? {
            code: this.pairing.code,
            uri: pairingUri({
              pcId: c.pcId,
              pcName: c.pcName,
              hosts: this.addresses(),
              port: this.port,
              code: this.pairing.code
            }),
            expiresAt: new Date(this.pairing.expiresAt).toISOString()
          }
        : null,
      error: this.error,
      lastSync: this.lastSync
    }
  }

  private emitStatus(): PhoneLinkStatus {
    const s = this.status()
    this.emit({ type: 'status', status: s })
    return s
  }

  async setEnabled(on: boolean): Promise<PhoneLinkStatus> {
    this.saveConfig({ enabled: on })
    if (on) await this.start()
    else {
      this.clearPairing()
      await this.stop()
    }
    return this.emitStatus()
  }

  async startPairing(): Promise<PhoneLinkStatus> {
    this.saveConfig({ enabled: true })
    await this.start()
    if (!this.server) return this.emitStatus()
    this.clearPairing()
    const code = newPairCode()
    const key = await pairKey(code, this.config().pcId)
    const timer = setTimeout(() => {
      this.pairing = null
      this.emitStatus()
    }, PAIRING_MINUTES * 60000)
    this.pairing = { code, key, expiresAt: Date.now() + PAIRING_MINUTES * 60000, attempts: 0, timer }
    return this.emitStatus()
  }

  cancelPairing(): PhoneLinkStatus {
    this.clearPairing()
    return this.emitStatus()
  }

  private clearPairing(): void {
    if (this.pairing) clearTimeout(this.pairing.timer)
    this.pairing = null
  }

  removeDevice(id: string): PhoneLinkStatus {
    this.db.removeDevice(id)
    this.keys.delete(id)
    return this.emitStatus()
  }

  // ------------------------------------------------------------------ server

  private async start(): Promise<void> {
    if (this.server) return
    this.error = null
    const preferred = this.portOverride ?? this.config().port ?? SYNC_HTTP_PORT
    let lastErr: unknown = null
    for (let i = 0; i < 10; i++) {
      const port = preferred + i
      try {
        this.server = await this.listen(port)
        this.port = port
        if (port !== this.config().port && this.portOverride == null) this.saveConfig({ port })
        break
      } catch (e) {
        lastErr = e
      }
    }
    if (!this.server) {
      this.error = `Could not start the phone link: ${(lastErr as Error)?.message ?? lastErr}`
      return
    }
    this.startDiscovery()
  }

  private listen(port: number): Promise<Server> {
    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => {
        void this.handle(req, res).catch((e: unknown) => {
          const status = e instanceof HttpError ? e.status : 500
          const code = e instanceof HttpError ? e.code : 'server-error'
          if (!(e instanceof HttpError)) console.error('phone link:', e)
          if (!res.headersSent) sendJson(res, status, { error: code })
          else res.end()
        })
      })
      srv.requestTimeout = 120_000
      srv.once('error', reject)
      srv.listen(port, '0.0.0.0', () => {
        srv.off('error', reject)
        srv.on('error', (e) => {
          this.error = String((e as Error).message ?? e)
        })
        resolve(srv)
      })
    })
  }

  /** Answers "where is PC <id>?" broadcasts from the phone, so a changed Wi-Fi address is no problem. */
  private startDiscovery(): void {
    try {
      const sock = createSocket({ type: 'udp4', reuseAddr: true })
      sock.on('message', (msg, rinfo) => {
        const text = msg.toString('utf8').trim()
        if (!text.startsWith(DISCOVER_MESSAGE)) return
        const wanted = text.slice(DISCOVER_MESSAGE.length).trim()
        const { pcId } = this.config()
        if (wanted && wanted !== pcId) return
        const reply = Buffer.from(`${HERE_MESSAGE} ${pcId} ${this.port}`)
        sock.send(reply, rinfo.port, rinfo.address)
      })
      sock.on('error', () => {
        /* discovery is optional (the phone also remembers addresses) */
      })
      sock.bind(SYNC_DISCOVERY_PORT, () => {
        try {
          sock.setBroadcast(true)
        } catch {
          /* ignore */
        }
      })
      this.udp = sock
    } catch {
      this.udp = null
    }
  }

  async stop(): Promise<void> {
    const srv = this.server
    this.server = null
    this.port = 0
    try {
      this.udp?.close()
    } catch {
      /* ignore */
    }
    this.udp = null
    if (srv) {
      srv.closeAllConnections?.()
      await new Promise<void>((r) => srv.close(() => r()))
    }
  }

  // ------------------------------------------------------------------ requests

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS lets the app's screens be tested in a normal browser; the Android app uses native HTTP.
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-ppacs-device')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    const c = this.config()
    if (req.method === 'GET' && url.pathname === '/ppacs') {
      sendJson(res, 200, { app: 'PersonalPACS', v: 1, id: c.pcId, name: c.pcName })
      return
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/v1/')) throw new HttpError(404, 'not-found')
    const method = url.pathname.slice('/api/v1/'.length)
    const body = await readJson(req)
    if (!isEnvelope(body)) throw new HttpError(400, 'bad-request')
    const ip = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')

    if (method === 'pair') {
      sendJson(res, 200, await this.pair(body))
      return
    }

    const deviceId = String(req.headers['x-ppacs-device'] ?? '')
    const dev = this.db.listDevices().find((d) => d.id === deviceId)
    if (!dev) throw new HttpError(401, 'unpaired')
    let key = this.keys.get(dev.id)
    if (!key) {
      key = await importDeviceKey(fromB64(dev.key))
      this.keys.set(dev.id, key)
    }
    let payload: unknown
    try {
      payload = await unseal(key, `${method}|req|${dev.id}`, body)
    } catch {
      throw new HttpError(401, 'bad-key')
    }
    this.db.touchDevice(dev.id, ip)

    let result: unknown
    if (method === 'hello') {
      result = { pcId: c.pcId, pcName: c.pcName, rev: this.db.syncRev(), port: this.port, addresses: this.addresses() }
    } else if (method === 'pull') {
      const p = (payload ?? {}) as Partial<PullRequest>
      result = {
        ...this.db.syncPull({ since: Number(p.since) || 0, have: Array.isArray(p.have) ? p.have : [] }),
        pcId: c.pcId,
        pcName: c.pcName
      }
      this.noteSync(dev, 'synced')
    } else if (method === 'push') {
      result = this.push((payload ?? {}) as Partial<PushRequest>, dev)
    } else {
      throw new HttpError(404, 'not-found')
    }
    sendJson(res, 200, await seal(key, `${method}|res|${dev.id}`, result))
  }

  private async pair(body: Envelope): Promise<Envelope> {
    const session = this.pairing
    if (!session || Date.now() > session.expiresAt) throw new HttpError(403, 'not-pairing')
    let msg: { deviceId?: unknown; deviceName?: unknown; pub?: unknown }
    try {
      msg = await unseal(session.key, 'pair|req', body)
    } catch {
      // Wrong code. A few attempts only, so the code can't be guessed.
      session.attempts++
      if (session.attempts >= 5) {
        this.clearPairing()
        this.emitStatus()
      }
      throw new HttpError(403, 'bad-code')
    }
    const deviceId = typeof msg.deviceId === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(msg.deviceId) ? msg.deviceId : ''
    const deviceName = typeof msg.deviceName === 'string' ? msg.deviceName.trim().slice(0, 60) : ''
    if (!deviceId || typeof msg.pub !== 'string') throw new HttpError(400, 'bad-request')
    const c = this.config()
    const kp = await newEcdhKeyPair()
    const deviceKey = await deriveDeviceKey(kp.privateKey, msg.pub, c.pcId, deviceId)
    this.db.addDevice({ id: deviceId, name: deviceName || 'Android phone', key: toB64(deviceKey) })
    this.keys.delete(deviceId)
    const reply = await seal(session.key, 'pair|res', {
      pcId: c.pcId,
      pcName: c.pcName,
      pub: await exportPublicKey(kp.publicKey),
      port: this.port,
      addresses: this.addresses()
    })
    this.clearPairing()
    const device = this.db.listDevices().find((d) => d.id === deviceId)
    if (device) {
      const { key: _key, ...pub } = device
      this.emit({ type: 'paired', device: pub as PhoneDevice })
    }
    this.emitStatus()
    return reply
  }

  /** Applies changes made on the phone. Each item is its own transaction, so one bad item can't block the rest. */
  private push(p: Partial<PushRequest>, dev: PhoneDevice): PushResponse {
    const results: PushResult[] = []
    const changed = new Set<number>()
    const each = <T>(list: T[] | undefined, fn: (x: T) => PushResult & { studyId?: number }, kind: PushResult['kind'], id: (x: T) => string) => {
      for (const item of Array.isArray(list) ? list : []) {
        try {
          const r = this.db.transaction(() => fn(item))
          const { studyId, ...result } = r
          if (studyId) changed.add(studyId)
          results.push(result)
        } catch (e) {
          results.push({ kind, id: String(id(item) ?? ''), outcome: 'rejected', message: (e as Error).message })
        }
      }
    }
    each<PushStudy>(
      p.studies,
      (s) => {
        if (typeof s.syncId !== 'string' || !s.syncId) throw new Error('Missing id')
        const r = this.db.applyPushStudy(
          { ...s, baseRev: Number(s.baseRev) || 0, modifiedAt: String(s.modifiedAt ?? '') },
          cleanManualInput(s.fields, true)
        )
        const studyId = this.db.studyIdForSync(s.syncId) ?? undefined
        return { ...r, studyId: r.outcome === 'applied' ? studyId : undefined }
      },
      'study',
      (s) => s.syncId
    )
    each<PushReport>(
      p.reports,
      (r) => {
        if (typeof r.studySyncId !== 'string') throw new Error('Missing id')
        const status = r.status === 'PRELIMINARY' ? 'PRELIMINARY' : 'DRAFT'
        const clean: PushReport = {
          studySyncId: r.studySyncId,
          status,
          html: '',
          text: String(r.text ?? '').slice(0, 2_000_000),
          modality: String(r.modality ?? '').slice(0, 20),
          procedure: String(r.procedure ?? '').slice(0, 200),
          radiologist: String(r.radiologist ?? '').slice(0, 200),
          templateName: String(r.templateName ?? '').slice(0, 200),
          updatedAt: String(r.updatedAt ?? ''),
          baseRev: Number(r.baseRev) || 0
        }
        return this.db.applyPushReport(clean, sanitizeReportHtml(String(r.html ?? '')), dev.name)
      },
      'report',
      (r) => r.studySyncId
    )
    each<PushTemplate>(
      p.templates,
      (t) => {
        if (typeof t.syncId !== 'string' || !t.syncId) throw new Error('Missing id')
        const name = String(t.name ?? '').trim().slice(0, 200)
        if (!t.deleted && !name) throw new Error('Template name is required')
        return this.db.applyPushTemplate({
          syncId: t.syncId,
          name,
          modality: String(t.modality ?? '').slice(0, 20),
          html: sanitizeReportHtml(String(t.html ?? '')),
          mine: t.mine !== false,
          updatedAt: String(t.updatedAt ?? ''),
          deleted: !!t.deleted,
          baseRev: Number(t.baseRev) || 0
        })
      },
      'template',
      (t) => t.syncId
    )
    each<PushMacro>(
      p.macros,
      (m) => {
        if (typeof m.syncId !== 'string' || !m.syncId) throw new Error('Missing id')
        const code = String(m.code ?? '').trim().replace(/^\./, '')
        if (!m.deleted && !/^[A-Za-z0-9_-]{1,20}$/.test(code)) throw new Error('Macro code must be 1–20 letters/numbers')
        return this.db.applyPushMacro({
          syncId: m.syncId,
          code,
          text: String(m.text ?? '').slice(0, 20000),
          updatedAt: String(m.updatedAt ?? ''),
          deleted: !!m.deleted,
          baseRev: Number(m.baseRev) || 0
        })
      },
      'macro',
      (m) => m.syncId
    )
    const applied = results.filter((r) => r.outcome === 'applied').length
    if (results.length) {
      this.onChanged([...changed])
      this.noteSync(dev, `${applied} change${applied === 1 ? '' : 's'} received`, [...changed])
    }
    return { results }
  }

  private noteSync(dev: PhoneDevice, summary: string, changedStudies: number[] = []): void {
    this.lastSync = { device: dev.name, at: new Date().toISOString(), summary }
    this.emit({ type: 'synced', device: dev.name, changedStudies, summary })
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': data.length, 'Cache-Control': 'no-store' })
  res.end(data)
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'too-large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new HttpError(400, 'bad-json'))
      }
    })
    req.on('error', reject)
  })
}
