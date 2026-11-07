// Runs in an Electron utility process: downloads/unpacks speech models and does the
// speech recognition, so heavy work never blocks (or crashes) the main app.
import { net } from 'electron'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { cpus } from 'node:os'
import { basename, join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import * as sherpa from 'sherpa-onnx-node'
import bz2 from 'unbzip2-stream'
import * as tar from 'tar-stream'
import type { Headers } from 'tar-stream'
import { getSpeechModel, recognizerConfig } from './speechModels'

const SR = 16000
const VAD_WINDOW = 512
const PRE_ROLL = Math.round(0.3 * SR) // audio kept before the detected speech start
const POST_ROLL = Math.round(0.2 * SR)

type Msg =
  | { type: 'install'; id: string; destDir: string; vadPath: string; vadUrl: string }
  | { type: 'cancelInstall' }
  | { type: 'load'; id: string; dir: string; vadPath: string; pauseMs: number }
  | { type: 'start'; pauseMs: number }
  | { type: 'audio'; samples: Float32Array }
  | { type: 'stop' }

const port = process.parentPort
const post = (m: Record<string, unknown>) => port.postMessage(m)

// ------------------------------------------------------------------ installing models

let installAbort: AbortController | null = null

async function download(url: string, signal: AbortSignal): Promise<Response> {
  const res = await net.fetch(url, { signal })
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`)
  return res
}

async function install(m: Extract<Msg, { type: 'install' }>): Promise<void> {
  const def = getSpeechModel(m.id)
  if (!def) throw new Error(`Unknown model ${m.id}`)
  installAbort = new AbortController()
  const signal = installAbort.signal
  const tmpDir = `${m.destDir}.partial`
  await rm(tmpDir, { recursive: true, force: true })
  await mkdir(tmpDir, { recursive: true })
  try {
    // Voice activity detector (small, shared by all models).
    if (!existsSync(m.vadPath)) {
      const res = await download(m.vadUrl, signal)
      await writeFile(`${m.vadPath}.part`, Buffer.from(await res.arrayBuffer()))
      await rename(`${m.vadPath}.part`, m.vadPath)
    }

    // Stream: download -> bunzip2 -> untar, keeping only the files we need.
    const res = await download(def.url, signal)
    const total = Number(res.headers.get('content-length')) || def.downloadMB * 1024 * 1024
    let received = 0
    let lastPost = 0
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length
        const now = Date.now()
        if (now - lastPost > 250) {
          lastPost = now
          post({ type: 'installProgress', progress: Math.min(0.99, received / total) })
        }
        cb(null, chunk)
      }
    })
    const wanted = new Set(def.keep)
    const found = new Set<string>()
    await new Promise<void>((resolve, reject) => {
      const extract = tar.extract()
      extract.on('entry', (header: Headers, stream: Readable, next: (err?: unknown) => void) => {
        const name = basename(header.name)
        if (header.type === 'file' && wanted.has(name) && !name.startsWith('._')) {
          const out = createWriteStream(join(tmpDir, name))
          stream.pipe(out)
          out.on('finish', () => {
            found.add(name)
            next()
          })
          out.on('error', reject)
        } else {
          stream.on('end', () => next())
          stream.resume()
        }
      })
      extract.on('finish', () => resolve())
      extract.on('error', reject)
      const body = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream)
      body.on('error', reject)
      counter.on('error', reject)
      const unbz = bz2()
      unbz.on('error', reject)
      body.pipe(counter).pipe(unbz).pipe(extract)
    })
    const missing = def.keep.filter((f) => !found.has(f))
    if (missing.length) throw new Error(`Model archive is missing: ${missing.join(', ')}`)
    await writeFile(join(tmpDir, 'installed.json'), JSON.stringify({ id: def.id, installedAt: new Date().toISOString() }))
    await rm(m.destDir, { recursive: true, force: true })
    await rename(tmpDir, m.destDir)
    post({ type: 'installDone', id: def.id })
  } catch (e) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    if (signal.aborted) post({ type: 'installCancelled', id: m.id })
    else post({ type: 'installError', id: m.id, message: (e as Error).message ?? String(e) })
  } finally {
    installAbort = null
  }
}

// ------------------------------------------------------------------ recognition

/** Keeps the last couple of minutes of audio so segments can include a little pre-roll. */
class AudioRing {
  private buf = new Float32Array(SR * 120)
  written = 0
  push(x: Float32Array): void {
    const cap = this.buf.length
    for (let i = 0; i < x.length; i++) this.buf[(this.written + i) % cap] = x[i]
    this.written += x.length
  }
  slice(start: number, end: number): Float32Array {
    const cap = this.buf.length
    start = Math.max(start, this.written - cap, 0)
    end = Math.min(end, this.written)
    const out = new Float32Array(Math.max(0, end - start))
    for (let i = 0; i < out.length; i++) out[i] = this.buf[(start + i) % cap]
    return out
  }
  reset(): void {
    this.written = 0
  }
}

let recognizer: sherpa.OfflineRecognizer | null = null
let vad: sherpa.Vad | null = null
let vadPath = ''
let vadPauseMs = 600
const ring = new AudioRing()
let pendingSamples = new Float32Array(0)
let speaking = false
let pending = 0
let queue: Promise<void> = Promise.resolve()

function makeVad(pauseMs: number): sherpa.Vad {
  return new sherpa.Vad(
    {
      sileroVad: {
        model: vadPath,
        threshold: 0.5,
        minSilenceDuration: Math.min(2, Math.max(0.25, pauseMs / 1000)),
        minSpeechDuration: 0.2,
        maxSpeechDuration: 25,
        windowSize: VAD_WINDOW
      },
      sampleRate: SR,
      numThreads: 1,
      debug: false
    },
    60
  )
}

// Whisper sometimes "hears" these in silence/noise.
const JUNK = /^(\[.*\]|\(.*\)|thank you\.?|thanks for watching!?|you|\.+)$/i

function enqueue(samples: Float32Array): void {
  pending++
  post({ type: 'pending', count: pending })
  queue = queue.then(async () => {
    try {
      if (!recognizer) return
      const stream = recognizer.createStream()
      stream.acceptWaveform({ sampleRate: SR, samples })
      const r = await recognizer.decodeAsync(stream)
      const text = (r.text ?? '').trim()
      if (text && !JUNK.test(text)) post({ type: 'text', text })
    } catch (e) {
      post({ type: 'error', message: `Recognition failed: ${(e as Error).message}` })
    } finally {
      pending--
      post({ type: 'pending', count: pending })
    }
  })
}

function drainVad(): void {
  if (!vad) return
  const now = vad.isDetected()
  if (now !== speaking) {
    speaking = now
    post({ type: 'speaking', speaking })
  }
  while (!vad.isEmpty()) {
    const seg = vad.front(false) // Electron does not allow external buffers
    vad.pop()
    const padded = ring.slice(seg.start - PRE_ROLL, seg.start + seg.samples.length + POST_ROLL)
    enqueue(padded.length >= seg.samples.length ? padded : seg.samples)
  }
}

function acceptAudio(samples: Float32Array): void {
  if (!vad) return
  ring.push(samples)
  const all = new Float32Array(pendingSamples.length + samples.length)
  all.set(pendingSamples)
  all.set(samples, pendingSamples.length)
  let off = 0
  for (; off + VAD_WINDOW <= all.length; off += VAD_WINDOW) vad.acceptWaveform(all.subarray(off, off + VAD_WINDOW))
  pendingSamples = all.slice(off)
  drainVad()
}

async function load(m: Extract<Msg, { type: 'load' }>): Promise<void> {
  const def = getSpeechModel(m.id)
  if (!def) throw new Error(`Unknown model ${m.id}`)
  recognizer = null
  const threads = Math.max(1, Math.min(4, cpus().length - 1))
  recognizer = await sherpa.OfflineRecognizer.createAsync(recognizerConfig(def, m.dir, threads))
  vadPath = m.vadPath
  vadPauseMs = m.pauseMs
  vad = makeVad(vadPauseMs)
}

function start(pauseMs: number): void {
  if (pauseMs !== vadPauseMs || !vad) {
    vadPauseMs = pauseMs
    vad = makeVad(pauseMs)
  } else {
    vad.reset()
  }
  ring.reset()
  pendingSamples = new Float32Array(0)
  speaking = false
}

async function stop(): Promise<void> {
  if (vad) {
    vad.flush()
    drainVad()
  }
  if (speaking) {
    speaking = false
    post({ type: 'speaking', speaking: false })
  }
  await queue
  post({ type: 'stopped' })
}

port.on('message', (e: Electron.MessageEvent) => {
  const msg = e.data as Msg
  switch (msg.type) {
    case 'install':
      void install(msg)
      break
    case 'cancelInstall':
      installAbort?.abort()
      break
    case 'load':
      load(msg)
        .then(() => post({ type: 'loaded', id: msg.id }))
        .catch((err: unknown) => post({ type: 'loadError', message: (err as Error).message ?? String(err) }))
      break
    case 'start':
      start(msg.pauseMs)
      break
    case 'audio':
      acceptAudio(msg.samples instanceof Float32Array ? msg.samples : new Float32Array(msg.samples))
      break
    case 'stop':
      void stop()
      break
  }
})

post({ type: 'hello' })
