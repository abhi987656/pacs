// The encrypted relay used when a direct connection isn't possible: Cloudflare's free
// "quick tunnel". This PC opens an outgoing connection to Cloudflare and gets a public
// https://….trycloudflare.com address that forwards to the local share server. Everything sent
// through it is already encrypted with the share key, so Cloudflare only sees scrambled data.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ShareLinkState } from '@shared/types'

function assetName(): string | null {
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe'
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64'
  return null
}

export class RelayTunnel {
  state: ShareLinkState = 'off'
  url: string | null = null
  error: string | null = null
  private proc: ChildProcess | null = null
  private wanted = false
  private port = 0
  private retryTimer: NodeJS.Timeout | null = null
  private failures = 0

  constructor(
    private readonly toolsDir: string,
    private readonly onChange: () => void,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private set(state: ShareLinkState, url: string | null, error: string | null = null): void {
    this.state = state
    this.url = url
    this.error = error
    this.onChange()
  }

  /** Starts the tunnel to http://127.0.0.1:<port> (no-op if already running). */
  start(port: number): void {
    this.wanted = true
    if (this.port === port && (this.state === 'starting' || this.state === 'ready')) return
    this.port = port
    if (process.env.PACS_SHARE_RELAY === 'off') {
      this.set('unavailable', null, 'Relay turned off')
      return
    }
    // Tests: the local server itself stands in for the relay.
    if (process.env.PACS_SHARE_FAKE_RELAY === '1') {
      this.set('ready', `http://127.0.0.1:${port}`)
      return
    }
    void this.launch()
  }

  stop(): void {
    this.wanted = false
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.proc?.kill()
    this.proc = null
    this.set('off', null)
  }

  private async binary(): Promise<string> {
    const name = assetName()
    if (!name) throw new Error('The relay is not available on this computer type')
    const file = join(this.toolsDir, name.endsWith('.exe') ? 'cloudflared.exe' : 'cloudflared')
    if (existsSync(file)) return file
    await mkdir(this.toolsDir, { recursive: true })
    const tmp = `${file}.download`
    // Cloudflare's official release on GitHub, over HTTPS.
    const res = await this.fetchImpl(`https://github.com/cloudflare/cloudflared/releases/latest/download/${name}`)
    if (!res.ok || !res.body) throw new Error(`Could not download the relay tool (HTTP ${res.status})`)
    await pipeline(Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream), createWriteStream(tmp))
    const { size } = await stat(tmp)
    const fh = await open(tmp, 'r')
    const head = Buffer.alloc(4)
    await fh.read(head, 0, 4, 0)
    await fh.close()
    const isExe = process.platform === 'win32' ? head.subarray(0, 2).toString() === 'MZ' : head[0] === 0x7f && head.subarray(1, 4).toString() === 'ELF'
    if (size < 5 * 1024 * 1024 || !isExe) {
      await rm(tmp, { force: true })
      throw new Error('The downloaded relay tool looks damaged')
    }
    if (process.platform !== 'win32') await chmod(tmp, 0o755)
    await rename(tmp, file)
    return file
  }

  private async launch(): Promise<void> {
    this.set('starting', null)
    let bin: string
    try {
      bin = await this.binary()
    } catch (e) {
      this.set('unavailable', null, (e as Error).message)
      this.scheduleRetry()
      return
    }
    if (!this.wanted) return
    const p = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.proc = p
    const timeout = setTimeout(() => {
      if (this.state === 'starting' && this.proc === p) {
        p.kill()
        this.set('unavailable', null, 'The relay did not start (no internet, or Cloudflare blocked on this network)')
      }
    }, 60_000)
    const scan = (d: Buffer) => {
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(d.toString())
      if (m && this.proc === p && this.state !== 'ready') {
        clearTimeout(timeout)
        this.failures = 0
        this.set('ready', m[0])
      }
    }
    p.stdout?.on('data', scan)
    p.stderr?.on('data', scan)
    p.on('error', (e) => {
      clearTimeout(timeout)
      if (this.proc === p) this.set('unavailable', null, e.message)
    })
    p.on('exit', () => {
      clearTimeout(timeout)
      if (this.proc !== p) return
      this.proc = null
      if (this.wanted) {
        this.set('unavailable', null, 'The relay stopped')
        this.scheduleRetry()
      }
    })
  }

  private scheduleRetry(): void {
    if (!this.wanted || this.retryTimer) return
    this.failures++
    const delay = Math.min(300_000, 15_000 * this.failures)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.wanted) void this.launch()
    }, delay)
  }
}
