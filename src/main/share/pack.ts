// The files of a shared case as one continuous byte stream, cut into fixed-size chunks.
// Fewer, larger requests than one per DICOM file – much faster through a relay.

import { open } from 'node:fs/promises'
import { applyPatches } from './anonymize'
import type { Patch } from './anonymize'

export const CHUNK_SIZE = 4 * 1024 * 1024

export interface PackFile {
  path: string
  size: number
  patches?: Patch[]
}

export class Pack {
  readonly total: number
  readonly chunks: number
  private readonly starts: number[] = []

  constructor(readonly files: PackFile[]) {
    let pos = 0
    for (const f of files) {
      this.starts.push(pos)
      pos += f.size
    }
    this.total = pos
    this.chunks = Math.ceil(pos / CHUNK_SIZE)
  }

  /** Bytes of chunk `n` (anonymization patches applied). */
  async chunk(n: number): Promise<Buffer> {
    if (!Number.isInteger(n) || n < 0 || n >= this.chunks) throw new Error('No such chunk')
    const start = n * CHUNK_SIZE
    const end = Math.min(this.total, start + CHUNK_SIZE)
    const out = Buffer.alloc(end - start)
    // First file that overlaps the chunk (binary search on the start offsets).
    let lo = 0
    let hi = this.files.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.starts[mid] <= start) lo = mid
      else hi = mid - 1
    }
    for (let i = lo; i < this.files.length && this.starts[i] < end; i++) {
      const f = this.files[i]
      const fStart = this.starts[i]
      const from = Math.max(start, fStart)
      const to = Math.min(end, fStart + f.size)
      if (to <= from) continue
      const fh = await open(f.path, 'r')
      try {
        const slice = out.subarray(from - start, to - start)
        const { bytesRead } = await fh.read(slice, 0, slice.length, from - fStart)
        if (bytesRead !== slice.length) throw new Error('A file of this case changed while sharing')
        applyPatches(slice, from - fStart, f.patches)
      } finally {
        await fh.close()
      }
    }
    return out
  }
}
