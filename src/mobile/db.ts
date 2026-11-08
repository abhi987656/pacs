// The phone's own copy of cases, reports, templates and macros (IndexedDB, private to the app).
// Everything is also kept in memory: the data set is small and the screens stay instant.

import { useSyncExternalStore } from 'react'
import type { ManualStudyInput, SyncMacro, SyncReport, SyncSettings, SyncStudy, SyncTemplate } from '@shared/types'
import { DEFAULT_SETTINGS, SYNC_SETTING_KEYS } from '@shared/types'

export type DetailField = keyof ManualStudyInput

export interface LocalStudy extends SyncStudy {
  /** Created on the phone and not yet on the PC. */
  isNew: boolean
  /** Details changed on the phone, not yet sent (only these fields are sent). */
  dirtyFields: DetailField[]
  editedAt: string
  localVer: number
}

export interface LocalReport extends SyncReport {
  dirty: boolean
  localVer: number
}

export interface LocalTemplate extends SyncTemplate {
  dirty: boolean
  deleted: boolean
  localVer: number
}

export interface LocalMacro extends SyncMacro {
  dirty: boolean
  deleted: boolean
  localVer: number
}

export interface Pairing {
  pcId: string
  pcName: string
  deviceId: string
  deviceKey: string // base64, AES-256 key shared with the PC
  hosts: string[]
  port: number
  lastHost: string | null
  pairedAt: string
}

export interface Prefs {
  language: string // speech recognition language
  preferOffline: boolean
}

export interface LastSync {
  at: string
  ok: boolean
  message: string
}

export interface Meta {
  pairing: Pairing | null
  cursor: number
  settings: SyncSettings
  prefs: Prefs
  lastSync: LastSync | null
}

const DEFAULT_SYNC_SETTINGS = Object.fromEntries(SYNC_SETTING_KEYS.map((k) => [k, DEFAULT_SETTINGS[k]])) as unknown as SyncSettings

const DEFAULT_META: Meta = {
  pairing: null,
  cursor: 0,
  settings: DEFAULT_SYNC_SETTINGS,
  prefs: { language: 'en-IN', preferOffline: true },
  lastSync: null
}

type StoreName = 'studies' | 'reports' | 'templates' | 'macros' | 'meta'
const KEYS: Record<StoreName, string> = {
  studies: 'syncId',
  reports: 'studySyncId',
  templates: 'syncId',
  macros: 'syncId',
  meta: 'key'
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('personal-pacs', 1)
    r.onupgradeneeded = () => {
      const db = r.result
      for (const [name, keyPath] of Object.entries(KEYS)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath })
      }
    }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

/** Writes collected during one change, committed in a single IndexedDB transaction. */
export class Batch {
  readonly puts: [StoreName, unknown][] = []
  readonly dels: [StoreName, string][] = []
  put(store: StoreName, value: unknown) {
    this.puts.push([store, value])
  }
  del(store: StoreName, key: string) {
    this.dels.push([store, key])
  }
}

class Store {
  studies = new Map<string, LocalStudy>()
  reports = new Map<string, LocalReport>()
  templates = new Map<string, LocalTemplate>()
  macros = new Map<string, LocalMacro>()
  meta: Meta = { ...DEFAULT_META }
  version = 0
  private db: IDBDatabase | null = null
  private listeners = new Set<() => void>()
  private ver = 0

  async open(): Promise<void> {
    this.db = await openDb()
    const tx = this.db.transaction(['studies', 'reports', 'templates', 'macros', 'meta'], 'readonly')
    const [st, rp, tp, mc, mt] = await Promise.all([
      req(tx.objectStore('studies').getAll()),
      req(tx.objectStore('reports').getAll()),
      req(tx.objectStore('templates').getAll()),
      req(tx.objectStore('macros').getAll()),
      req(tx.objectStore('meta').getAll())
    ])
    this.studies = new Map((st as LocalStudy[]).map((x) => [x.syncId, x]))
    this.reports = new Map((rp as LocalReport[]).map((x) => [x.studySyncId, x]))
    this.templates = new Map((tp as LocalTemplate[]).map((x) => [x.syncId, x]))
    this.macros = new Map((mc as LocalMacro[]).map((x) => [x.syncId, x]))
    const meta = { ...DEFAULT_META }
    for (const row of mt as { key: keyof Meta; value: unknown }[]) (meta as Record<string, unknown>)[row.key] = row.value
    meta.settings = { ...DEFAULT_SYNC_SETTINGS, ...meta.settings }
    meta.prefs = { ...DEFAULT_META.prefs, ...meta.prefs }
    this.meta = meta
    this.ver = Math.max(0, ...[...this.studies.values(), ...this.reports.values()].map((x) => x.localVer || 0))
    this.emit()
  }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(): void {
    this.version++
    for (const cb of [...this.listeners]) cb()
  }

  /** A fresh local version number (marks "edited after the last sync started"). */
  nextVer(): number {
    return ++this.ver
  }

  async commit(b: Batch): Promise<void> {
    // Memory first (screens update at once), then disk.
    for (const [s, v] of b.puts) {
      if (s === 'studies') this.studies.set((v as LocalStudy).syncId, v as LocalStudy)
      else if (s === 'reports') this.reports.set((v as LocalReport).studySyncId, v as LocalReport)
      else if (s === 'templates') this.templates.set((v as LocalTemplate).syncId, v as LocalTemplate)
      else if (s === 'macros') this.macros.set((v as LocalMacro).syncId, v as LocalMacro)
      else if (s === 'meta') {
        const row = v as { key: keyof Meta; value: unknown }
        ;(this.meta as unknown as Record<string, unknown>)[row.key] = row.value
      }
    }
    for (const [s, k] of b.dels) {
      if (s === 'studies') this.studies.delete(k)
      else if (s === 'reports') this.reports.delete(k)
      else if (s === 'templates') this.templates.delete(k)
      else if (s === 'macros') this.macros.delete(k)
    }
    this.emit()
    if (!this.db) return
    const tx = this.db.transaction(['studies', 'reports', 'templates', 'macros', 'meta'], 'readwrite')
    for (const [s, v] of b.puts) tx.objectStore(s).put(v)
    for (const [s, k] of b.dels) tx.objectStore(s).delete(k)
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  }

  async setMeta<K extends keyof Meta>(key: K, value: Meta[K]): Promise<void> {
    const b = new Batch()
    b.put('meta', { key, value })
    await this.commit(b)
  }

  /** Removes all cases, reports, templates and macros (e.g. when pairing with another PC). */
  async wipe(keepPairing = false): Promise<void> {
    this.studies.clear()
    this.reports.clear()
    this.templates.clear()
    this.macros.clear()
    const pairing = keepPairing ? this.meta.pairing : null
    this.meta = { ...DEFAULT_META, prefs: this.meta.prefs, pairing }
    if (this.db) {
      const tx = this.db.transaction(['studies', 'reports', 'templates', 'macros', 'meta'], 'readwrite')
      for (const s of ['studies', 'reports', 'templates', 'macros', 'meta'] as StoreName[]) tx.objectStore(s).clear()
      tx.objectStore('meta').put({ key: 'prefs', value: this.meta.prefs })
      if (pairing) tx.objectStore('meta').put({ key: 'pairing', value: pairing })
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    }
    this.emit()
  }

  /** Changes made on the phone that the PC hasn't received yet. */
  pendingCount(): number {
    let n = 0
    for (const s of this.studies.values()) if (s.isNew || s.dirtyFields.length) n++
    for (const r of this.reports.values()) if (r.dirty) n++
    for (const t of this.templates.values()) if (t.dirty) n++
    for (const m of this.macros.values()) if (m.dirty) n++
    return n
  }

  liveTemplates(): LocalTemplate[] {
    return [...this.templates.values()].filter((t) => !t.deleted)
  }

  liveMacros(): LocalMacro[] {
    return [...this.macros.values()].filter((m) => !m.deleted)
  }
}

export const store = new Store()

/** Re-renders the component whenever the local data changes. */
export function useStore(): number {
  return useSyncExternalStore(store.subscribe, () => store.version)
}
