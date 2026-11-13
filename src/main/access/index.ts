/**
 * Electron side of the access control: settings baked in at build time (edition, Supabase
 * project), the session and the remembered approval kept encrypted on this computer, and a
 * stable id for this computer (counts against the account's computer limit).
 */
import { app, net, safeStorage } from 'electron'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { Edition } from '@shared/types'
import { AccessService, type AccessStorage } from './core'

declare const __PACS_EDITION__: string
declare const __SUPABASE_URL__: string
declare const __SUPABASE_ANON_KEY__: string

/** Which software this build is: the user software, or the master software that approves users. */
export const EDITION: Edition = __PACS_EDITION__ === 'master' ? 'master' : 'user'
export const APP_TITLE = EDITION === 'master' ? 'Personal PACS Master' : 'Personal PACS'

/** Key → value, saved encrypted with Windows' own protection for this user (DPAPI) when available. */
class FileStorage implements AccessStorage {
  private data: Record<string, string> = {}
  constructor(private readonly file: string) {
    try {
      const raw = readFileSync(file)
      const text = safeStorage.isEncryptionAvailable() && raw[0] !== 0x7b ? safeStorage.decryptString(raw) : raw.toString('utf8')
      this.data = JSON.parse(text) as Record<string, string>
    } catch {
      this.data = {}
    }
  }
  get(key: string): string | null {
    return this.data[key] ?? null
  }
  set(key: string, value: string): void {
    this.data[key] = value
    this.save()
  }
  remove(key: string): void {
    delete this.data[key]
    this.save()
  }
  private save(): void {
    try {
      const text = JSON.stringify(this.data)
      writeFileSync(this.file, safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : text)
    } catch (e) {
      console.error('access: could not save', e)
    }
  }
}

/** Windows' id of this installation (survives reinstalling the app; differs on a copied profile). */
function machineGuid(): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve(null)
      const m = /MachineGuid\s+REG_SZ\s+([0-9a-f-]{20,})/i.exec(String(out))
      resolve(m ? m[1].toLowerCase() : null)
    })
  })
}

const netFetch = ((input: string | URL | Request, init?: RequestInit) => net.fetch(input instanceof URL ? input.href : input, init)) as typeof fetch

export async function createAccess(): Promise<AccessService> {
  const storage = new FileStorage(join(app.getPath('userData'), 'access.dat'))
  const guid = await machineGuid()
  let key = guid ? createHash('sha256').update(`personal-pacs:${guid}`).digest('hex').slice(0, 40) : storage.get('device-id')
  if (!key) {
    key = randomUUID().replace(/-/g, '')
    storage.set('device-id', key)
  }
  return new AccessService({
    url: __SUPABASE_URL__,
    anonKey: __SUPABASE_ANON_KEY__,
    edition: EDITION,
    fetch: netFetch,
    storage,
    device: { key, name: hostname().slice(0, 120), platform: `${process.platform} ${process.arch}`, version: app.getVersion() }
  })
}
