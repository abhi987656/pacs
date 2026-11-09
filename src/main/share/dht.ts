// The peer-to-peer network used for direct connections (HyperDHT: public DHT for finding each
// other + UDP hole punching through home routers). Loaded only when sharing is used, so a problem
// with its native parts can never stop the app from starting.

/* eslint-disable @typescript-eslint/no-explicit-any */
export type DhtNode = any
export type DhtKeyPair = { publicKey: Buffer; secretKey: Buffer }

let mod: any = null
let node: DhtNode | null = null
let nodePromise: Promise<DhtNode> | null = null

async function load(): Promise<any> {
  if (!mod) {
    // CommonJS require where available (the packaged app): the well-trodden way to load modules
    // with native parts from Electron's app archive.
    const m: any = typeof require === 'function' ? require('hyperdht') : await import('hyperdht')
    mod = m.default ?? m
  }
  return mod
}

export async function dhtKeyPair(seed: Buffer): Promise<DhtKeyPair> {
  return (await load()).keyPair(seed)
}

/** One DHT node for the whole app (shared by sending and receiving). */
export function getDhtNode(): Promise<DhtNode> {
  if (node) return Promise.resolve(node)
  if (!nodePromise) {
    nodePromise = (async () => {
      const DHT = await load()
      const opts: Record<string, unknown> = {}
      // Tests: a local DHT, e.g. PACS_DHT_BOOTSTRAP=127.0.0.1:49737
      const boot = process.env.PACS_DHT_BOOTSTRAP
      if (boot) {
        opts.bootstrap = boot.split(',').map((s) => {
          const [host, port] = s.trim().split(':')
          return { host, port: Number(port) }
        })
        opts.host = '127.0.0.1'
      }
      const n = new DHT(opts)
      n.on?.('error', () => {})
      await n.ready()
      node = n
      return n
    })().catch((e) => {
      nodePromise = null
      throw e
    })
  }
  return nodePromise
}

let users = 0
let idleTimer: NodeJS.Timeout | null = null

export interface DhtHold {
  node: DhtNode
  release(): void
}

/** Uses the DHT node; it is shut down a minute after the last user releases it. */
export async function holdDht(): Promise<DhtHold> {
  users++
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  let released = false
  const release = () => {
    if (released) return
    released = true
    if (--users === 0) {
      idleTimer = setTimeout(() => {
        idleTimer = null
        if (users === 0) void destroyDht()
      }, 60_000)
      idleTimer.unref?.()
    }
  }
  try {
    return { node: await getDhtNode(), release }
  } catch (e) {
    release()
    throw e
  }
}

export async function destroyDht(): Promise<void> {
  const n = node
  node = null
  nodePromise = null
  if (n) await n.destroy().catch(() => {})
}

export const directDisabled = (): boolean => process.env.PACS_SHARE_DIRECT === 'off'

/**
 * Did the node reach the peer-to-peer network? On networks that block UDP the node still starts
 * (after ~12 s) but knows no other nodes; then nobody can find this PC directly.
 */
export function dhtOnline(node: DhtNode): boolean {
  try {
    return node.table.toArray().length > 0
  } catch {
    return true
  }
}
