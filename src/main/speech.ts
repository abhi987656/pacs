import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpeechEvent, SpeechInstallState, SpeechModelId, SpeechStatus } from '@shared/types'
import { getSpeechModel, SPEECH_MODELS, VAD_URL } from './speechModels'

type WorkerMsg =
  | { type: 'hello' }
  | { type: 'installProgress'; progress: number }
  | { type: 'installDone'; id: SpeechModelId }
  | { type: 'installError'; id: SpeechModelId; message: string }
  | { type: 'installCancelled'; id: SpeechModelId }
  | { type: 'loaded'; id: SpeechModelId }
  | { type: 'loadError'; message: string }
  | { type: 'speaking'; speaking: boolean }
  | { type: 'pending'; count: number }
  | { type: 'text'; text: string }
  | { type: 'stopped' }
  | { type: 'error'; message: string }

/**
 * Main-process side of offline dictation: owns the speech utility process, model
 * installation state, and relays audio in / text out.
 */
export class SpeechService {
  private worker: UtilityProcess | null = null
  private install: SpeechInstallState | null = null
  private engine: SpeechStatus['engine'] = 'off'
  private loadedModel: SpeechModelId | null = null
  private error: string | null = null
  private loading: Promise<void> | null = null
  private loadWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null
  private installWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null

  constructor(
    private readonly root: string, // <data>/speech
    private readonly workerPath: string,
    private readonly emit: (e: SpeechEvent) => void
  ) {}

  private modelDir(id: SpeechModelId): string {
    return join(this.root, id)
  }

  private get vadPath(): string {
    return join(this.root, 'silero_vad.onnx')
  }

  isInstalled(id: SpeechModelId): boolean {
    const def = getSpeechModel(id)
    if (!def) return false
    const dir = this.modelDir(id)
    return existsSync(join(dir, 'installed.json')) && def.keep.every((f) => existsSync(join(dir, f))) && existsSync(this.vadPath)
  }

  status(): SpeechStatus {
    return {
      models: SPEECH_MODELS.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        downloadMB: m.downloadMB,
        installed: this.isInstalled(m.id)
      })),
      install: this.install,
      engine: this.engine,
      loadedModel: this.loadedModel,
      error: this.error
    }
  }

  private pushStatus(): void {
    this.emit({ type: 'status', status: this.status() })
  }

  private ensureWorker(): UtilityProcess {
    if (this.worker) return this.worker
    const w = utilityProcess.fork(this.workerPath, [], { serviceName: 'Personal PACS speech', stdio: 'inherit' })
    w.on('message', (m: WorkerMsg) => this.onMessage(m))
    w.on('exit', (code) => {
      this.worker = null
      const wasBusy = this.engine === 'listening' || this.engine === 'loading' || this.install != null
      this.loadedModel = null
      this.install = null
      if (wasBusy || code !== 0) {
        this.engine = 'error'
        this.error = 'The speech engine stopped unexpectedly. Try again; if it keeps happening, try the smaller Whisper model.'
      } else {
        this.engine = 'off'
      }
      this.loadWaiter?.reject(new Error(this.error ?? 'Speech engine stopped'))
      this.loadWaiter = null
      this.installWaiter?.reject(new Error(this.error ?? 'Speech engine stopped'))
      this.installWaiter = null
      this.pushStatus()
    })
    this.worker = w
    return w
  }

  private onMessage(m: WorkerMsg): void {
    switch (m.type) {
      case 'installProgress':
        if (this.install) {
          this.install = { ...this.install, progress: m.progress }
          this.pushStatus()
        }
        break
      case 'installDone':
      case 'installError':
      case 'installCancelled':
        this.install = null
        this.error = m.type === 'installError' ? `Download failed: ${m.message}` : null
        if (m.type === 'installDone') this.installWaiter?.resolve()
        else this.installWaiter?.reject(new Error(m.type === 'installError' ? m.message : 'Cancelled'))
        this.installWaiter = null
        this.pushStatus()
        break
      case 'loaded':
        this.loadedModel = m.id
        this.engine = 'ready'
        this.error = null
        this.loadWaiter?.resolve()
        this.loadWaiter = null
        this.pushStatus()
        break
      case 'loadError':
        this.loadedModel = null
        this.engine = 'error'
        this.error = `Could not load the speech model: ${m.message}`
        this.loadWaiter?.reject(new Error(this.error))
        this.loadWaiter = null
        this.pushStatus()
        break
      case 'speaking':
        this.emit({ type: 'speaking', speaking: m.speaking })
        break
      case 'pending':
        this.emit({ type: 'pending', count: m.count })
        break
      case 'text':
        this.emit({ type: 'text', text: m.text })
        break
      case 'error':
        this.error = m.message
        this.pushStatus()
        break
      case 'stopped':
      case 'hello':
        break
    }
  }

  async installModel(id: SpeechModelId): Promise<void> {
    if (!getSpeechModel(id)) throw new Error('Unknown speech model')
    if (this.install) throw new Error('A download is already in progress')
    await mkdir(this.root, { recursive: true })
    const w = this.ensureWorker()
    this.install = { modelId: id, phase: 'downloading', progress: 0 }
    this.error = null
    this.pushStatus()
    const done = new Promise<void>((resolve, reject) => (this.installWaiter = { resolve, reject }))
    w.postMessage({ type: 'install', id, destDir: this.modelDir(id), vadPath: this.vadPath, vadUrl: VAD_URL })
    return done
  }

  cancelInstall(): void {
    this.worker?.postMessage({ type: 'cancelInstall' })
  }

  async removeModel(id: SpeechModelId): Promise<void> {
    if (this.loadedModel === id) this.shutdown()
    await rm(this.modelDir(id), { recursive: true, force: true })
    this.pushStatus()
  }

  private async load(id: SpeechModelId, pauseMs: number): Promise<void> {
    if (this.loadedModel === id && this.worker) return
    if (this.loading) return this.loading
    const w = this.ensureWorker()
    this.engine = 'loading'
    this.error = null
    this.pushStatus()
    this.loading = new Promise<void>((resolve, reject) => {
      this.loadWaiter = { resolve, reject }
      w.postMessage({ type: 'load', id, dir: this.modelDir(id).replace(/\\/g, '/'), vadPath: this.vadPath, pauseMs })
    }).finally(() => {
      this.loading = null
    })
    return this.loading
  }

  async start(id: SpeechModelId, pauseMs: number): Promise<void> {
    if (!this.isInstalled(id)) throw new Error('The speech model is not installed yet. Download it in Settings › Dictation.')
    await this.load(id, pauseMs)
    this.worker?.postMessage({ type: 'start', pauseMs })
    this.engine = 'listening'
    this.pushStatus()
  }

  audio(samples: Float32Array): void {
    if (this.engine === 'listening') this.worker?.postMessage({ type: 'audio', samples })
  }

  stop(): void {
    if (this.engine !== 'listening') return
    this.worker?.postMessage({ type: 'stop' })
    this.engine = 'ready'
    this.pushStatus()
  }

  shutdown(): void {
    const w = this.worker
    this.worker = null
    this.loadedModel = null
    this.engine = 'off'
    w?.removeAllListeners('exit')
    w?.kill()
  }
}
