/**
 * Access control of the two editions (Supabase): the user software signs in, asks for access
 * and checks in at every start (this computer counts against the account's computer limit);
 * the master software signs in with a master account and manages the requests.
 *
 * An approval is remembered on the computer: without internet the software keeps working for
 * OFFLINE_DAYS after the last successful check. No Electron here (tested in Node).
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AccessAdminData, AccessDevice, AccessMember, AccessState, Edition, MemberStatus } from '@shared/types'

export const OFFLINE_DAYS = 7
const DAY = 24 * 3600 * 1000
/** Clock set back by more than this since the last check: the offline approval no longer counts. */
const CLOCK_SLACK = 10 * 60 * 1000

export interface AccessStorage {
  get(key: string): string | null
  set(key: string, value: string): void
  remove(key: string): void
}

export interface DeviceInfo {
  key: string
  name: string
  platform: string
  version: string
}

export interface AccessDeps {
  url: string
  anonKey: string
  edition: Edition
  fetch: typeof fetch
  storage: AccessStorage
  device: DeviceInfo
  now?: () => number
  /** Request timeout (ms). */
  timeoutMs?: number
}

/** What the last successful check said, kept for working offline. */
interface Remembered {
  edition: Edition
  userId: string
  name: string
  email: string
  checkedAt: number
}

const CACHE_KEY = 'access-approved'

class NetworkError extends Error {}

const isNetwork = (e: unknown): boolean => {
  if (!e) return false
  const err = e as { status?: number; name?: string; message?: string; code?: string }
  const msg = `${err.name ?? ''} ${err.message ?? ''} ${err.code ?? ''}`
  return (
    err instanceof NetworkError ||
    err.name === 'AuthRetryableFetchError' ||
    (err.status === 0 && !/invalid|credential/i.test(msg)) ||
    /fetch failed|failed to fetch|network|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|timed? ?out|abort/i.test(msg)
  )
}

/** Friendlier wording of Supabase's messages. */
function explain(e: unknown): string {
  const err = e as { message?: string; code?: string }
  const m = err?.message ?? String(e)
  if (/invalid login credentials/i.test(m)) return 'Wrong email or password.'
  if (/already registered|already been registered|user_already_exists/i.test(`${m} ${err?.code ?? ''}`)) return 'This email already has an account – sign in instead.'
  if (/password should be at least|weak_password/i.test(`${m} ${err?.code ?? ''}`)) return 'Choose a longer password (at least 6 characters).'
  if (/email.*invalid|invalid.*email|validate email/i.test(m)) return 'This email address does not look right.'
  if (/email not confirmed/i.test(m)) return 'This Supabase project still asks for email confirmation – turn off "Confirm email" (see the setup guide).'
  if (isNetwork(e)) return 'Cannot reach the server. Check the internet connection and try again.'
  return m
}

export class AccessService {
  state: AccessState
  private sb: SupabaseClient | null = null
  private listeners = new Set<(s: AccessState) => void>()
  private readonly now: () => number

  constructor(private readonly d: AccessDeps) {
    this.now = d.now ?? Date.now
    const configured = !!(d.url && d.anonKey)
    this.state = { edition: d.edition, status: configured ? 'checking' : 'off' }
    if (!configured) return
    const timeout = d.timeoutMs ?? 12000
    const timedFetch: typeof fetch = async (input, init) => {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), timeout)
      const outer = init?.signal
      if (outer) outer.addEventListener('abort', () => ctl.abort())
      try {
        return await d.fetch(input, { ...init, signal: ctl.signal })
      } catch (e) {
        throw new NetworkError((e as Error)?.message || 'network error')
      } finally {
        clearTimeout(timer)
      }
    }
    this.sb = createClient(d.url, d.anonKey, {
      auth: {
        storage: {
          getItem: (k) => d.storage.get(`sb:${k}`),
          setItem: (k, v) => d.storage.set(`sb:${k}`, v),
          removeItem: (k) => d.storage.remove(`sb:${k}`)
        },
        storageKey: 'pacs-auth',
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false
      },
      global: { fetch: timedFetch }
    })
  }

  /** Everything may be used (approved, possibly offline, or sign-in not set up in this build). */
  get unlocked(): boolean {
    return this.state.status === 'approved' || this.state.status === 'off'
  }

  onChange(fn: (s: AccessState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(next: Omit<AccessState, 'edition'>): AccessState {
    this.state = { edition: this.d.edition, ...next }
    for (const fn of this.listeners) fn(this.state)
    return this.state
  }

  private remembered(): Remembered | null {
    try {
      const raw = this.d.storage.get(CACHE_KEY)
      return raw ? (JSON.parse(raw) as Remembered) : null
    } catch {
      return null
    }
  }

  private remember(r: Remembered | null): void {
    if (r) this.d.storage.set(CACHE_KEY, JSON.stringify(r))
    else this.d.storage.remove(CACHE_KEY)
  }

  /** No answer from the server: a recent approval on this computer still counts. */
  private offline(reason: string): AccessState {
    const r = this.remembered()
    const now = this.now()
    if (r && r.edition === this.d.edition && now >= r.checkedAt - CLOCK_SLACK && now - r.checkedAt <= OFFLINE_DAYS * DAY) {
      return this.set({ status: 'approved', name: r.name, email: r.email, checkedAt: r.checkedAt, offlineUntil: r.checkedAt + OFFLINE_DAYS * DAY })
    }
    const behind = r && now < r.checkedAt - CLOCK_SLACK
    return this.set({
      status: 'offline',
      name: r?.name,
      email: r?.email,
      checkedAt: r?.checkedAt,
      message: !r
        ? `Cannot reach the server (${reason}). Connect to the internet to sign in.`
        : behind
          ? "This computer's clock is behind the last check with the server. Connect to the internet to continue."
          : `The last check with the server was more than ${OFFLINE_DAYS} days ago. Connect to the internet to continue.`
    })
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.sb!.rpc(fn, args)
    if (error) throw isNetwork(error) ? new NetworkError(error.message) : error
    return data as T
  }

  /** Asks the server whether this account may use the software here (every start; "Check again"). */
  async check(): Promise<AccessState> {
    if (!this.sb) return this.set({ status: 'off' })
    const prev = this.state
    if (prev.status !== 'approved') this.set({ status: 'checking', name: prev.name, email: prev.email })
    try {
      const { data, error } = await this.sb.auth.getSession()
      if (error) throw error
      const session = data.session
      if (!session) {
        this.remember(null)
        return this.set({ status: 'signed-out' })
      }
      const user = session.user
      const email = user.email ?? ''
      const metaName = String((user.user_metadata as { name?: string } | undefined)?.name ?? '')
      if (this.d.edition === 'master') {
        const admin = await this.rpc<boolean>('is_admin', {})
        if (!admin) {
          this.remember(null)
          return this.set({ status: 'not-admin', email, name: metaName })
        }
        const t = this.now()
        this.remember({ edition: 'master', userId: user.id, name: metaName || email, email, checkedAt: t })
        return this.set({ status: 'approved', email, name: metaName || email, checkedAt: t })
      }
      const dev = this.d.device
      const args = { p_device_key: dev.key, p_name: dev.name, p_platform: dev.platform, p_version: dev.version }
      type CheckIn = { status: MemberStatus | 'none'; name?: string; device?: 'ok' | 'limit'; max_devices?: number; devices?: number }
      let r = await this.rpc<CheckIn>('check_in', args)
      if (r.status === 'none') {
        // First start after signing up (or the master deleted the request): ask for access.
        await this.rpc('request_access', { p_name: metaName || email.split('@')[0] })
        r = await this.rpc<CheckIn>('check_in', args)
      }
      const name = r.name || metaName || email
      const base = { name, email, maxDevices: r.max_devices, devices: r.devices, checkedAt: this.now() }
      if (r.status === 'approved' && r.device === 'ok') {
        this.remember({ edition: 'user', userId: user.id, name, email, checkedAt: base.checkedAt })
        return this.set({ status: 'approved', ...base })
      }
      this.remember(null)
      if (r.status === 'approved') return this.set({ status: 'device-limit', ...base })
      if (r.status === 'denied' || r.status === 'revoked' || r.status === 'pending') return this.set({ status: r.status, ...base })
      return this.set({ status: 'error', ...base, message: `Unexpected answer from the server (${String(r.status)})` })
    } catch (e) {
      if (isNetwork(e)) return this.offline(explain(e))
      return this.set({ status: 'error', name: prev.name, email: prev.email, message: explain(e) })
    }
  }

  async signUp(name: string, email: string, password: string): Promise<AccessState> {
    if (!this.sb) return this.set({ status: 'off' })
    if (this.d.edition === 'master') return this.set({ status: 'signed-out', message: 'The master software signs in with an existing master account.' })
    const clean = name.trim().slice(0, 120)
    if (!clean) return this.set({ status: 'signed-out', message: 'Enter your name.' })
    try {
      const { data, error } = await this.sb.auth.signUp({ email: email.trim(), password, options: { data: { name: clean } } })
      if (error) throw error
      if (!data.session) {
        return this.set({
          status: 'signed-out',
          message: 'The account was made, but this Supabase project asks new users to confirm their email first. Turn off "Confirm email" in Supabase (Authentication › Sign In / Providers › Email), then sign in.'
        })
      }
      await this.rpc('request_access', { p_name: clean })
    } catch (e) {
      return this.set({ status: 'signed-out', message: explain(e) })
    }
    return this.check()
  }

  async signIn(email: string, password: string): Promise<AccessState> {
    if (!this.sb) return this.set({ status: 'off' })
    try {
      const { error } = await this.sb.auth.signInWithPassword({ email: email.trim(), password })
      if (error) throw error
    } catch (e) {
      return this.set({ status: 'signed-out', message: explain(e) })
    }
    return this.check()
  }

  async signOut(): Promise<AccessState> {
    if (!this.sb) return this.set({ status: 'off' })
    try {
      await this.sb.auth.signOut({ scope: 'local' })
    } catch {
      /* signed out locally anyway */
    }
    this.remember(null)
    return this.set({ status: 'signed-out' })
  }

  /** A declined or withdrawn account asks again. */
  async askAgain(): Promise<AccessState> {
    if (!this.sb) return this.set({ status: 'off' })
    try {
      await this.rpc('request_access', { p_name: this.state.name ?? '', p_again: true })
    } catch (e) {
      return this.set({ ...this.state, message: explain(e) })
    }
    return this.check()
  }

  // ---------------------------------------------------------------- master software

  private needAdmin(): SupabaseClient {
    if (!this.sb || this.d.edition !== 'master' || this.state.status !== 'approved') throw new Error('Only the master software, signed in, can do this.')
    return this.sb
  }

  async adminList(): Promise<AccessAdminData> {
    const sb = this.needAdmin()
    const [m, d] = await Promise.all([
      sb.from('members').select('user_id,name,email,status,max_devices,requested_at,decided_at').order('requested_at', { ascending: false }),
      sb.from('devices').select('id,user_id,name,platform,app_version,first_seen,last_seen').order('last_seen', { ascending: false })
    ])
    if (m.error) throw new Error(explain(m.error))
    if (d.error) throw new Error(explain(d.error))
    return { members: (m.data ?? []) as AccessMember[], devices: (d.data ?? []) as AccessDevice[] }
  }

  private async adminCall(fn: string, args: Record<string, unknown>): Promise<void> {
    this.needAdmin()
    try {
      await this.rpc(fn, args)
    } catch (e) {
      throw new Error(explain(e))
    }
  }

  adminDecide(userId: string, status: MemberStatus, maxDevices?: number): Promise<void> {
    return this.adminCall('admin_decide', { p_user: userId, p_status: status, p_max_devices: maxDevices ?? null })
  }

  adminSetDevices(userId: string, maxDevices: number): Promise<void> {
    return this.adminCall('admin_set_devices', { p_user: userId, p_max_devices: maxDevices })
  }

  adminRemoveDevice(deviceId: string): Promise<void> {
    return this.adminCall('admin_remove_device', { p_device: deviceId })
  }

  adminDeleteMember(userId: string): Promise<void> {
    return this.adminCall('admin_delete_member', { p_user: userId })
  }
}
