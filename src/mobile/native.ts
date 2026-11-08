// Everything that talks to Android goes through here. Each piece has a browser fallback so the
// screens can also run (and be tested) in an ordinary browser.

import { Capacitor, CapacitorHttp, registerPlugin, WebPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'
import { Device } from '@capacitor/device'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { toB64 } from '@shared/syncCrypto'

export const isNative = Capacitor.isNativePlatform()

// ------------------------------------------------------------------ HTTP

export interface HttpResult {
  status: number
  data: unknown
}

const parseJson = (t: string): unknown => {
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

/**
 * JSON request to the PC. On the phone this uses Android's own HTTP stack (no browser
 * mixed-content/CORS rules for local network addresses). Throws if the PC can't be reached.
 */
export async function httpJson(
  method: 'GET' | 'POST',
  url: string,
  body: unknown,
  headers: Record<string, string>,
  connectTimeoutMs: number
): Promise<HttpResult> {
  if (isNative) {
    const r = await CapacitorHttp.request({
      url,
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
      data: body,
      connectTimeout: connectTimeoutMs,
      readTimeout: 120_000,
      responseType: 'json'
    })
    return { status: r.status, data: typeof r.data === 'string' ? parseJson(r.data) : r.data }
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), connectTimeoutMs)
  let res: Response
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    })
  } finally {
    clearTimeout(timer)
  }
  return { status: res.status, data: parseJson(await res.text()) }
}

// ------------------------------------------------------------------ local network (custom Android plugin)

export interface LanInterface {
  name: string
  address: string
  prefix: number
  broadcast?: string
}

interface LanPlugin {
  interfaces(): Promise<{ interfaces: LanInterface[] }>
  discover(o: { message: string; port: number; timeoutMs: number }): Promise<{ replies: { address: string; message: string }[] }>
}

export const Lan = registerPlugin<LanPlugin>('Lan', {
  web: () =>
    Promise.resolve({
      interfaces: async () => ({ interfaces: [] as LanInterface[] }),
      discover: async () => ({ replies: [] as { address: string; message: string }[] })
    })
})

// ------------------------------------------------------------------ dictation (custom Android plugin)

export interface DictationPlugin {
  available(): Promise<{ available: boolean; onDevice: boolean }>
  start(o: { language: string; preferOffline: boolean }): Promise<void>
  stop(): Promise<void>
  addListener(eventName: 'partial' | 'final', cb: (e: { text: string }) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'state', cb: (e: { listening: boolean }) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'error', cb: (e: { message: string; fatal: boolean }) => void): Promise<PluginListenerHandle>
}

interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onend: (() => void) | null
  onerror: ((ev: { error: string }) => void) | null
  start(): void
  stop(): void
}

/** Browser fallback: Chrome's speech API, plus a hook automated tests use to "speak". */
class DictationWeb extends WebPlugin {
  private rec: SpeechRecognitionLike | null = null
  private active = false

  private ctor(): (new () => SpeechRecognitionLike) | null {
    const w = window as unknown as Record<string, unknown>
    return (w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null) as (new () => SpeechRecognitionLike) | null
  }

  async available() {
    return { available: !!this.ctor() || !!(window as unknown as { __ppacsTest?: boolean }).__ppacsTest, onDevice: false }
  }

  async start(o: { language: string }) {
    this.active = true
    const SR = this.ctor()
    if (SR && !(window as unknown as { __ppacsTest?: boolean }).__ppacsTest) {
      const rec = new SR()
      rec.lang = o.language
      rec.continuous = true
      rec.interimResults = true
      rec.onresult = (ev) => {
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i]
          this.notifyListeners(r.isFinal ? 'final' : 'partial', { text: r[0].transcript })
        }
      }
      rec.onend = () => {
        if (this.active) {
          try {
            rec.start()
          } catch {
            /* ignore */
          }
        }
      }
      rec.onerror = (e) => {
        if (e.error === 'not-allowed') {
          this.active = false
          this.notifyListeners('error', { message: 'Microphone access was blocked.', fatal: true })
          this.notifyListeners('state', { listening: false })
        }
      }
      rec.start()
      this.rec = rec
    }
    this.notifyListeners('state', { listening: true })
  }

  async stop() {
    this.active = false
    this.rec?.stop()
    this.rec = null
    this.notifyListeners('state', { listening: false })
  }

  /** Test hook: pretend the user said something. */
  feed(text: string, final = true) {
    if (this.active) this.notifyListeners(final ? 'final' : 'partial', { text })
  }
}

const dictationWeb = new DictationWeb()
export const Dictation = registerPlugin<DictationPlugin>('Dictation', {
  web: () => Promise.resolve(dictationWeb)
})
if (!isNative) {
  ;(window as unknown as Record<string, unknown>).__ppacsSay = (text: string, final = true) => dictationWeb.feed(text, final)
}

// ------------------------------------------------------------------ files

const MIME: Record<string, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  txt: 'text/plain'
}

function browserDownload(name: string, data: Uint8Array | string): void {
  const ext = name.split('.').pop() ?? ''
  const blob = new Blob([typeof data === 'string' ? data : (data.slice().buffer as ArrayBuffer)], { type: MIME[ext] ?? 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/** Opens Android's share sheet (WhatsApp, Gmail, Drive, Files …) with the file. */
export async function shareFile(name: string, data: Uint8Array | string): Promise<void> {
  if (!isNative) {
    browserDownload(name, data)
    return
  }
  const text = typeof data === 'string'
  const res = await Filesystem.writeFile({
    path: `exports/${name}`,
    data: text ? data : toB64(data),
    directory: Directory.Cache,
    recursive: true,
    ...(text ? { encoding: Encoding.UTF8 } : {})
  })
  await Share.share({ title: name, files: [res.uri], dialogTitle: 'Send or save the report' })
}

/** Saves into the phone's Documents/PersonalPACS folder. Returns where it went. */
export async function saveToDocuments(name: string, data: Uint8Array | string): Promise<string> {
  if (!isNative) {
    browserDownload(name, data)
    return `Downloads/${name}`
  }
  const text = typeof data === 'string'
  await Filesystem.writeFile({
    path: `PersonalPACS/${name}`,
    data: text ? data : toB64(data),
    directory: Directory.Documents,
    recursive: true,
    ...(text ? { encoding: Encoding.UTF8 } : {})
  })
  return `Documents/PersonalPACS/${name}`
}

// ------------------------------------------------------------------ device & app lifecycle

export async function deviceName(): Promise<string> {
  try {
    const info = await Device.getInfo()
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
    const name = (info.name ?? '').trim()
    if (name && !/^localhost$/i.test(name)) return name.slice(0, 60)
    const model = [cap(info.manufacturer ?? ''), info.model ?? ''].join(' ').trim()
    return (model || 'Android phone').slice(0, 60)
  } catch {
    return 'Android phone'
  }
}

export function onAppResume(cb: () => void): () => void {
  if (!isNative) {
    const h = () => {
      if (document.visibilityState === 'visible') cb()
    }
    document.addEventListener('visibilitychange', h)
    return () => document.removeEventListener('visibilitychange', h)
  }
  const p = CapApp.addListener('appStateChange', (s) => {
    if (s.isActive) cb()
  })
  return () => void p.then((h) => h.remove())
}

export function onAppPause(cb: () => void): () => void {
  if (!isNative) {
    const h = () => {
      if (document.visibilityState === 'hidden') cb()
    }
    document.addEventListener('visibilitychange', h)
    return () => document.removeEventListener('visibilitychange', h)
  }
  const p = CapApp.addListener('pause', cb)
  return () => void p.then((h) => h.remove())
}

/** Android back button. Return true from the handler when it was used (e.g. closed a screen). */
export function onBackButton(cb: () => boolean): () => void {
  if (!isNative) return () => {}
  const p = CapApp.addListener('backButton', () => {
    if (!cb()) void CapApp.minimizeApp()
  })
  return () => void p.then((h) => h.remove())
}
