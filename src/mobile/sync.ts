// Finds the PC on the local network and exchanges changes with it:
// first the phone's own changes are sent (push), then everything new on the PC is fetched (pull).

import type { PullResponse, PushRequest, PushResponse, PushResult } from '@shared/types'
import {
  DISCOVER_MESSAGE,
  HERE_MESSAGE,
  SYNC_DISCOVERY_PORT,
  deriveDeviceKey,
  exportPublicKey,
  fromB64,
  importDeviceKey,
  isEnvelope,
  newEcdhKeyPair,
  pairKey,
  seal,
  toB64,
  unseal,
  uuid
} from '@shared/syncCrypto'
import type { Envelope, PairingInfo, SyncKey } from '@shared/syncCrypto'
import { Batch, store } from './db'
import type { LocalMacro, LocalReport, LocalStudy, LocalTemplate, Pairing } from './db'
import { detailValue } from './repo'
import { Lan, httpJson, isNative } from './native'

export type SyncPhase = 'unpaired' | 'idle' | 'syncing' | 'offline' | 'error'

export interface SyncStatus {
  phase: SyncPhase
  message: string
  host: string | null
}

class SyncError extends Error {
  constructor(
    message: string,
    readonly kind: 'offline' | 'unpaired' | 'error'
  ) {
    super(message)
  }
}

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))]

// ------------------------------------------------------------------ talking to the PC

async function hostKey(): Promise<{ pairing: Pairing; key: SyncKey }> {
  const pairing = store.meta.pairing
  if (!pairing) throw new SyncError('Not paired with a PC yet.', 'unpaired')
  if (!cachedKey || cachedKey.id !== pairing.deviceId + pairing.deviceKey) {
    cachedKey = { id: pairing.deviceId + pairing.deviceKey, key: await importDeviceKey(fromB64(pairing.deviceKey)) }
  }
  return { pairing, key: cachedKey.key }
}
let cachedKey: { id: string; key: SyncKey } | null = null

/** One encrypted call. `host` is "address:port". */
async function call<T>(host: string, method: string, payload: unknown, connectTimeoutMs: number): Promise<T> {
  const { pairing, key } = await hostKey()
  const body = await seal(key, `${method}|req|${pairing.deviceId}`, payload)
  let res
  try {
    res = await httpJson('POST', `http://${host}/api/v1/${method}`, body, { 'X-PPACS-Device': pairing.deviceId }, connectTimeoutMs)
  } catch (e) {
    throw new SyncError(`Can't reach the PC at ${host}: ${(e as Error).message}`, 'offline')
  }
  if (res.status === 401) {
    throw new SyncError('This phone is no longer paired with the PC (it was removed there). Pair it again from Settings.', 'unpaired')
  }
  if (res.status !== 200 || !isEnvelope(res.data)) {
    const code = (res.data as { error?: string } | null)?.error
    throw new SyncError(`The PC answered with an error (${res.status}${code ? ` ${code}` : ''}).`, 'error')
  }
  try {
    return await unseal<T>(key, `${method}|res|${pairing.deviceId}`, res.data)
  } catch {
    throw new SyncError('Could not read the PC’s answer (wrong key). Pair the phone again.', 'unpaired')
  }
}

interface Hello {
  pcId: string
  pcName: string
  rev: number
  port: number
  addresses: string[]
}

/** Addresses to try for the PC: the one that worked last, the known ones, and then a search of the network. */
async function findPc(deep: boolean): Promise<{ host: string; hello: Hello }> {
  const { pairing } = await hostKey()
  const tryHost = async (host: string, timeout: number) => {
    const hello = await call<Hello>(host, 'hello', {}, timeout)
    if (hello.pcId !== pairing.pcId) throw new SyncError('A different PC answered.', 'error')
    return { host, hello }
  }
  const known = uniq([pairing.lastHost ?? '', ...pairing.hosts.map((h) => `${h}:${pairing.port}`)])
  if (pairing.lastHost) {
    try {
      return await tryHost(pairing.lastHost, 2500)
    } catch (e) {
      if (e instanceof SyncError && e.kind === 'unpaired') throw e
    }
  }
  const others = known.filter((h) => h !== pairing.lastHost)
  if (others.length) {
    try {
      return await Promise.any(others.map((h) => tryHost(h, 2500)))
    } catch (e) {
      const errs = (e as AggregateError).errors ?? []
      const unpaired = errs.find((x: unknown) => x instanceof SyncError && x.kind === 'unpaired')
      if (unpaired) throw unpaired
    }
  }
  // The PC's address changed (new Wi-Fi, new hotspot session …): ask the network.
  for (const host of await discover(pairing.pcId, deep)) {
    try {
      return await tryHost(host, 3000)
    } catch {
      /* try next */
    }
  }
  throw new SyncError(`${pairing.pcName} not found. Is Personal PACS open on the PC, and are both on the same Wi-Fi or hotspot?`, 'offline')
}

/** Broadcasts "where is PC <id>?" and, if nobody answers and `deep`, probes the local subnet. */
export async function discover(pcId: string | null, deep: boolean): Promise<string[]> {
  if (!isNative) return []
  const found: string[] = []
  try {
    const { replies } = await Lan.discover({ message: `${DISCOVER_MESSAGE} ${pcId ?? ''}`.trim(), port: SYNC_DISCOVERY_PORT, timeoutMs: 1500 })
    for (const r of replies) {
      const [tag, id, port] = r.message.trim().split(/\s+/)
      if (tag === HERE_MESSAGE && (!pcId || id === pcId) && Number(port) > 0) found.push(`${r.address}:${port}`)
    }
  } catch {
    /* ignore */
  }
  if (found.length || !deep) return uniq(found)
  // Some networks drop broadcasts: knock on every address of the phone's own /24 network(s).
  try {
    const { interfaces } = await Lan.interfaces()
    const port = store.meta.pairing?.port ?? 47820
    const candidates: string[] = []
    for (const i of interfaces) {
      const parts = i.address.split('.')
      if (parts.length !== 4 || i.prefix < 16) continue
      const base = parts.slice(0, 3).join('.')
      for (let n = 1; n < 255; n++) {
        const ip = `${base}.${n}`
        if (ip !== i.address) candidates.push(ip)
      }
    }
    for (let i = 0; i < candidates.length && !found.length; i += 48) {
      const batch = candidates.slice(i, i + 48)
      await Promise.all(
        batch.map(async (ip) => {
          try {
            const r = await httpJson('GET', `http://${ip}:${port}/ppacs`, undefined, {}, 700)
            const d = r.data as { app?: string; id?: string } | null
            if (r.status === 200 && d?.app === 'PersonalPACS' && (!pcId || d.id === pcId)) found.push(`${ip}:${port}`)
          } catch {
            /* nothing there */
          }
        })
      )
    }
  } catch {
    /* ignore */
  }
  return uniq(found)
}

// ------------------------------------------------------------------ pairing

export class PairError extends Error {}

/** Pairs with the PC shown in the QR code (or typed in). Throws PairError with a readable message. */
export async function pairWithPc(info: PairingInfo, name: string): Promise<void> {
  const pk = await pairKey(info.code, info.pcId)
  const kp = await newEcdhKeyPair()
  const deviceId = uuid()
  const body = await seal(pk, 'pair|req', { deviceId, deviceName: name, pub: await exportPublicKey(kp.publicKey) })
  let hosts = uniq(info.hosts.map((h) => (h.includes(':') ? h : `${h}:${info.port}`)))
  const attempt = async (host: string) => {
    const r = await httpJson('POST', `http://${host}/api/v1/pair`, body, {}, 4000)
    if (r.status === 403) {
      const code = (r.data as { error?: string } | null)?.error
      throw new PairError(
        code === 'bad-code'
          ? 'The code is not right. Check it, or start “Pair a phone” again on the PC.'
          : 'The PC is not waiting for a phone. On the PC open Settings › Phone app › Pair a phone, then try again.'
      )
    }
    if (r.status !== 200 || !isEnvelope(r.data)) throw new PairError(`The PC answered with an error (${r.status}).`)
    return { host, reply: await unseal<{ pcId: string; pcName: string; pub: string; port: number; addresses: string[] }>(pk, 'pair|res', r.data as Envelope) }
  }
  let result: Awaited<ReturnType<typeof attempt>> | null = null
  let lastErr: unknown = null
  for (let round = 0; round < 2 && !result; round++) {
    for (const host of hosts) {
      try {
        result = await attempt(host)
        break
      } catch (e) {
        if (e instanceof PairError) throw e
        lastErr = e
      }
    }
    if (!result && round === 0) {
      const more = (await discover(info.pcId, true)).filter((h) => !hosts.includes(h))
      if (!more.length) break
      hosts = more
    }
  }
  if (!result) {
    throw new PairError(
      `Could not reach the PC (${info.hosts.join(', ') || 'no address'}). Check that the phone and PC are on the same Wi-Fi or hotspot, and that Windows allowed Personal PACS through the firewall.` +
        (lastErr ? ` (${(lastErr as Error).message})` : '')
    )
  }
  const { host, reply } = result
  const key = await deriveDeviceKey(kp.privateKey, reply.pub, reply.pcId, deviceId)
  const prev = store.meta.pairing
  if (prev && prev.pcId !== reply.pcId) await store.wipe()
  const pairing: Pairing = {
    pcId: reply.pcId,
    pcName: reply.pcName,
    deviceId,
    deviceKey: toB64(key),
    hosts: uniq([host.split(':')[0], ...reply.addresses]),
    port: reply.port,
    lastHost: `${host.split(':')[0]}:${reply.port}`,
    pairedAt: new Date().toISOString()
  }
  const b = new Batch()
  b.put('meta', { key: 'pairing', value: pairing })
  b.put('meta', { key: 'cursor', value: 0 })
  await store.commit(b)
  cachedKey = null
}

/** Typed-in pairing: "192.168.1.5" or "192.168.1.5:47820" plus the code shown on the PC. */
export async function lookupPc(address: string): Promise<{ pcId: string; pcName: string; host: string; port: number }> {
  const m = /^\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3}|[a-z0-9.-]+)(?::(\d+))?\s*$/i.exec(address)
  if (!m) throw new PairError('Type the PC address shown on the PC, for example 192.168.1.5')
  const port = m[2] ? Number(m[2]) : 47820
  try {
    const r = await httpJson('GET', `http://${m[1]}:${port}/ppacs`, undefined, {}, 4000)
    const d = r.data as { app?: string; id?: string; name?: string } | null
    if (r.status === 200 && d?.app === 'PersonalPACS' && d.id) return { pcId: d.id, pcName: d.name ?? 'PC', host: m[1], port }
  } catch {
    /* fall through */
  }
  throw new PairError(`No Personal PACS found at ${m[1]}:${port}. Check the address, and that the phone and PC are on the same Wi-Fi or hotspot.`)
}

// ------------------------------------------------------------------ the sync itself

function buildPush(): { req: PushRequest; vers: Map<string, number> } {
  const vers = new Map<string, number>()
  const req: PushRequest = { studies: [], reports: [], templates: [], macros: [] }
  for (const s of store.studies.values()) {
    if (!s.isNew && !s.dirtyFields.length) continue
    const fields: Record<string, string> = {}
    for (const k of s.isNew ? (['patientName', 'patientId', 'accession', 'sex', 'age', 'birthDate', 'description', 'modality', 'studyDate', 'studyTime', 'referring', 'visitType', 'clinicalHistory'] as const) : s.dirtyFields) {
      fields[k] = detailValue(s, k)
    }
    req.studies.push({ syncId: s.syncId, isNew: s.isNew, fields, modifiedAt: s.editedAt, baseRev: s.rev })
    vers.set(`study:${s.syncId}`, s.localVer)
  }
  for (const r of store.reports.values()) {
    if (!r.dirty || r.status === 'FINAL') continue
    req.reports.push({
      studySyncId: r.studySyncId,
      status: r.status === 'PRELIMINARY' ? 'PRELIMINARY' : 'DRAFT',
      html: r.html,
      text: r.text,
      modality: r.modality,
      procedure: r.procedure,
      radiologist: r.radiologist,
      templateName: r.templateName,
      updatedAt: r.updatedAt,
      baseRev: r.rev
    })
    vers.set(`report:${r.studySyncId}`, r.localVer)
  }
  for (const t of store.templates.values()) {
    if (!t.dirty) continue
    req.templates.push({ syncId: t.syncId, name: t.name, modality: t.modality, html: t.html, mine: t.mine, updatedAt: t.updatedAt, deleted: t.deleted, baseRev: t.rev })
    vers.set(`template:${t.syncId}`, t.localVer)
  }
  for (const m of store.macros.values()) {
    if (!m.dirty) continue
    req.macros.push({ syncId: m.syncId, code: m.code, text: m.text, updatedAt: m.updatedAt, deleted: m.deleted, baseRev: m.rev })
    vers.set(`macro:${m.syncId}`, m.localVer)
  }
  return { req, vers }
}

/** Marks pushed items as sent (unless they were edited again meanwhile). Returns notices for the user. */
async function applyPushResults(results: PushResult[], vers: Map<string, number>): Promise<{ notices: string[]; again: boolean }> {
  const b = new Batch()
  const notices: string[] = []
  let again = false
  const unchanged = (kind: string, id: string, localVer: number) => vers.get(`${kind}:${id}`) === localVer
  const nameOf = (id: string) => store.studies.get(id)?.patientName || 'a case'
  for (const r of results) {
    if (r.kind === 'study') {
      const s = store.studies.get(r.id)
      if (!s) continue
      if (r.outcome === 'missing') {
        // Deleted on the PC while edited here: send it again as a new case, keeping the phone's data.
        b.put('studies', { ...s, isNew: true, rev: 0, localVer: store.nextVer() })
        notices.push(`${nameOf(r.id)} had been deleted on the PC – it was created there again.`)
        again = true
      } else if (unchanged('study', r.id, s.localVer)) {
        b.put('studies', { ...s, isNew: false, dirtyFields: [] })
      }
      if (r.outcome === 'rejected' && r.message) notices.push(`${nameOf(r.id)}: ${r.message}`)
    } else if (r.kind === 'report') {
      const rep = store.reports.get(r.id)
      if (!rep) continue
      if (r.outcome === 'missing') {
        const s = store.studies.get(r.id)
        if (s) b.put('studies', { ...s, isNew: true, rev: 0, localVer: store.nextVer() })
        b.put('reports', { ...rep, rev: 0 })
        again = true
        continue
      }
      if (unchanged('report', r.id, rep.localVer)) b.put('reports', { ...rep, dirty: false })
      if (r.outcome === 'rejected' || r.outcome === 'kept-pc') notices.push(`${nameOf(r.id)}: ${r.message ?? 'kept the PC version.'}`)
    } else if (r.kind === 'template') {
      const t = store.templates.get(r.id)
      if (!t || !unchanged('template', r.id, t.localVer)) continue
      if (t.deleted) b.del('templates', r.id)
      else b.put('templates', { ...t, dirty: false })
    } else if (r.kind === 'macro') {
      const m = store.macros.get(r.id)
      if (!m || !unchanged('macro', r.id, m.localVer)) continue
      if (m.deleted || r.replacedBy) b.del('macros', r.id)
      else b.put('macros', { ...m, dirty: false })
      if (r.replacedBy && r.message) notices.push(r.message)
    }
  }
  await store.commit(b)
  return { notices, again }
}

async function applyPull(res: PullResponse): Promise<void> {
  const b = new Batch()
  const studies = new Map(store.studies)
  for (const s of res.studies) {
    const local = studies.get(s.syncId)
    let next: LocalStudy
    if (!local) {
      next = { ...s, isNew: false, dirtyFields: [], editedAt: '', localVer: 0 }
    } else if (local.isNew || local.dirtyFields.length) {
      // Keep the phone's unsent edits on top of the PC's version.
      next = { ...s, isNew: local.isNew, dirtyFields: local.dirtyFields, editedAt: local.editedAt, localVer: local.localVer, rev: local.rev }
      for (const k of local.dirtyFields) {
        if (k === 'modality') next.modalities = local.modalities
        else (next as unknown as Record<string, unknown>)[k] = (local as unknown as Record<string, unknown>)[k]
      }
    } else {
      next = { ...s, isNew: false, dirtyFields: [], editedAt: local.editedAt, localVer: local.localVer }
    }
    const rep = store.reports.get(s.syncId)
    if (rep?.dirty && rep.status !== 'FINAL') next.reportStatus = rep.status
    studies.set(s.syncId, next)
    b.put('studies', next)
  }
  for (const r of res.reports) {
    const local = store.reports.get(r.studySyncId)
    if (local?.dirty && r.status !== 'FINAL') continue
    const next: LocalReport = { ...r, dirty: false, localVer: local?.localVer ?? 0 }
    b.put('reports', next)
  }
  for (const t of res.templates) {
    const local = store.templates.get(t.syncId)
    if (local?.dirty) continue
    const next: LocalTemplate = { ...t, dirty: false, deleted: false, localVer: local?.localVer ?? 0 }
    b.put('templates', next)
  }
  for (const m of res.macros) {
    const local = store.macros.get(m.syncId)
    if (local?.dirty) continue
    const next: LocalMacro = { ...m, dirty: false, deleted: false, localVer: local?.localVer ?? 0 }
    b.put('macros', next)
  }
  for (const id of res.deleted.templates) if (!store.templates.get(id)?.dirty) b.del('templates', id)
  for (const id of res.deleted.macros) if (!store.macros.get(id)?.dirty) b.del('macros', id)
  // Cases that left the phone's range (signed off and older than 30 days) or were deleted on the PC.
  const keep = new Set(res.scope)
  for (const s of studies.values()) {
    if (keep.has(s.syncId) || s.isNew || s.dirtyFields.length || store.reports.get(s.syncId)?.dirty) continue
    b.del('studies', s.syncId)
    b.del('reports', s.syncId)
  }
  if (res.settings) b.put('meta', { key: 'settings', value: res.settings })
  b.put('meta', { key: 'cursor', value: res.rev })
  await store.commit(b)
}

class SyncEngine {
  status: SyncStatus = { phase: 'unpaired', message: '', host: null }
  private listeners = new Set<() => void>()
  private running: Promise<void> | null = null
  private queuedRun: Promise<void> | null = null
  private queuedManual = false
  private lastDeep = 0

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  getStatus = (): SyncStatus => this.status

  private set(s: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...s }
    for (const cb of [...this.listeners]) cb()
  }

  init(): void {
    this.set({ phase: store.meta.pairing ? 'idle' : 'unpaired', message: '' })
  }

  /**
   * Syncs now. If a sync is already running, another one follows it, so the returned promise
   * always covers every change saved before the call. Never throws.
   */
  sync(opts: { manual?: boolean } = {}): Promise<void> {
    if (!store.meta.pairing) {
      this.set({ phase: 'unpaired', message: '' })
      return Promise.resolve()
    }
    if (this.running) {
      if (opts.manual) this.queuedManual = true
      if (!this.queuedRun) {
        this.queuedRun = this.running.then(() => {
          this.queuedRun = null
          const manual = this.queuedManual
          this.queuedManual = false
          return this.start(manual)
        })
      }
      return this.queuedRun
    }
    return this.start(!!opts.manual)
  }

  private start(manual: boolean): Promise<void> {
    this.running = this.run(manual).finally(() => {
      this.running = null
    })
    return this.running
  }

  private async run(manual: boolean): Promise<void> {
    this.set({ phase: 'syncing', message: 'Syncing…' })
    try {
      // A full network search is slow; do it when asked, or at most every 5 minutes.
      const deep = manual || Date.now() - this.lastDeep > 5 * 60000
      if (deep) this.lastDeep = Date.now()
      const { host, hello } = await findPc(deep)
      const pairing = store.meta.pairing!
      if (pairing.lastHost !== host || pairing.pcName !== hello.pcName || hello.port !== pairing.port) {
        await store.setMeta('pairing', {
          ...pairing,
          lastHost: host,
          pcName: hello.pcName,
          port: hello.port,
          hosts: uniq([host.split(':')[0], ...hello.addresses, ...pairing.hosts]).slice(0, 8)
        })
      }
      const notices: string[] = []
      for (let round = 0; round < 3; round++) {
        const { req, vers } = buildPush()
        if (!req.studies.length && !req.reports.length && !req.templates.length && !req.macros.length) break
        const res = await call<PushResponse>(host, 'push', req, 5000)
        const r = await applyPushResults(res.results, vers)
        notices.push(...r.notices)
        if (!r.again) break
      }
      const pull = await call<PullResponse>(host, 'pull', { since: store.meta.cursor, have: [...store.studies.keys()] }, 5000)
      await applyPull(pull)
      const message = notices.length ? notices.join(' ') : ''
      await store.setMeta('lastSync', { at: new Date().toISOString(), ok: true, message })
      this.set({ phase: 'idle', message, host })
    } catch (e) {
      const err = e instanceof SyncError ? e : new SyncError((e as Error).message ?? String(e), 'error')
      await store.setMeta('lastSync', { at: new Date().toISOString(), ok: false, message: err.message })
      this.set({ phase: err.kind === 'unpaired' ? 'error' : err.kind, message: err.message })
    }
  }
}

export const sync = new SyncEngine()
