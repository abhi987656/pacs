// Request/response over one encrypted peer-to-peer socket (the direct connection).
// Frame: [u32 length][u8 type][u32 id][payload]
//   request  (type 1) payload: [u16 header length][header JSON {m, p, a}][body]
//   response (type 2) payload: [u16 status][body]

import type { Duplex } from 'node:stream'

const MAX_FRAME = 48 * 1024 * 1024

export interface RpcRequest {
  method: string
  path: string
  auth: string | undefined
  client: string | undefined
  body: Buffer
}

export interface RpcResponse {
  status: number
  body: Buffer
}

class FrameReader {
  private parts: Buffer[] = []
  private size = 0

  constructor(private readonly onFrame: (type: number, id: number, payload: Buffer) => void) {}

  push(d: Buffer): void {
    this.parts.push(d)
    this.size += d.length
    for (;;) {
      if (this.size < 4) return
      const head = this.peek(4)
      const len = head.readUInt32BE(0)
      if (len < 5 || len > MAX_FRAME) throw new Error('Bad frame')
      if (this.size < 4 + len) return
      const frame = this.take(4 + len)
      this.onFrame(frame.readUInt8(4), frame.readUInt32BE(5), frame.subarray(9))
    }
  }

  private peek(n: number): Buffer {
    if (this.parts[0].length >= n) return this.parts[0]
    const b = Buffer.concat(this.parts)
    this.parts = [b]
    return b
  }

  private take(n: number): Buffer {
    const all = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts)
    const out = all.subarray(0, n)
    const rest = all.subarray(n)
    this.parts = rest.length ? [rest] : []
    this.size = rest.length
    return out
  }
}

function frame(type: number, id: number, payload: Buffer): Buffer {
  const h = Buffer.alloc(9)
  h.writeUInt32BE(5 + payload.length, 0)
  h.writeUInt8(type, 4)
  h.writeUInt32BE(id, 5)
  return Buffer.concat([h, payload])
}

/** Serves requests arriving on a socket. */
export function serveRpc(socket: Duplex, handler: (req: RpcRequest) => Promise<RpcResponse>): void {
  const reader = new FrameReader((type, id, payload) => {
    if (type !== 1) return
    const hl = payload.readUInt16BE(0)
    let req: RpcRequest
    try {
      const h = JSON.parse(payload.subarray(2, 2 + hl).toString('utf8')) as { m: string; p: string; a?: string; c?: string }
      req = { method: h.m, path: h.p, auth: h.a, client: h.c, body: payload.subarray(2 + hl) }
    } catch {
      return
    }
    handler(req)
      .catch((): RpcResponse => ({ status: 500, body: Buffer.alloc(0) }))
      .then((res) => {
        const p = Buffer.alloc(2 + res.body.length)
        p.writeUInt16BE(res.status, 0)
        res.body.copy(p, 2)
        if (!socket.destroyed) socket.write(frame(2, id, p))
      })
  })
  socket.on('data', (d: Buffer) => {
    try {
      reader.push(d)
    } catch {
      socket.destroy()
    }
  })
  socket.on('error', () => {})
}

/** Client side of the direct connection. Requests can run in parallel. */
export class RpcClient {
  private next = 1
  private closed = false
  private pending = new Map<number, { resolve: (r: RpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()

  constructor(private readonly socket: Duplex) {
    const reader = new FrameReader((type, id, payload) => {
      if (type !== 2) return
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      clearTimeout(p.timer)
      p.resolve({ status: payload.readUInt16BE(0), body: Buffer.from(payload.subarray(2)) })
    })
    socket.on('data', (d: Buffer) => {
      try {
        reader.push(d)
      } catch {
        socket.destroy()
      }
    })
    const fail = () => {
      this.closed = true
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('Connection closed'))
      }
      this.pending.clear()
    }
    socket.on('close', fail)
    socket.on('error', fail)
  }

  get isClosed(): boolean {
    return this.closed || this.socket.destroyed
  }

  request(method: string, path: string, auth: string, client: string, body: Buffer = Buffer.alloc(0), timeoutMs = 120_000): Promise<RpcResponse> {
    if (this.isClosed) return Promise.reject(new Error('Connection closed'))
    const id = this.next++
    const header = Buffer.from(JSON.stringify({ m: method, p: path, a: auth, c: client }))
    const payload = Buffer.alloc(2 + header.length + body.length)
    payload.writeUInt16BE(header.length, 0)
    header.copy(payload, 2)
    body.copy(payload, 2 + header.length)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Timed out'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(frame(1, id, payload))
    })
  }

  close(): void {
    this.socket.destroy()
  }
}
