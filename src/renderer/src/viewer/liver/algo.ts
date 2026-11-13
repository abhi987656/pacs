/**
 * Image processing for the liver analysis (CT liver volumetry in the manner of the Philips
 * IntelliSpace Portal "CT Liver Analysis"): one-click liver segmentation, lesions, vessels and
 * statistics. Pure functions on typed arrays, so they run in a Web Worker and in tests.
 *
 * Volumes are x-fastest: index = x + nx * (y + ny * z). Values are HU.
 */

export type Dims = [number, number, number]
export type Spacing = [number, number, number]
/** Half-open voxel box [x0, x1, y0, y1, z0, z1). */
export type Box = [number, number, number, number, number, number]

export interface Vol {
  dims: Dims
  /** mm between voxels along x, y and z. */
  sp: Spacing
  data: Int16Array
}

/** HU of a tissue: robust mean / spread and the band accepted as that tissue. */
export interface TissueModel {
  mean: number
  sd: number
  lo: number
  hi: number
}

const BIG = 1e20
const HU_MIN = -1024
const HU_BINS = 4096

export const fullBox = (d: Dims): Box => [0, d[0], 0, d[1], 0, d[2]]
export const voxelOf = (d: Dims, x: number, y: number, z: number): number => x + d[0] * (y + d[1] * z)
export function coordsOf(d: Dims, i: number): [number, number, number] {
  const nxy = d[0] * d[1]
  const z = Math.floor(i / nxy)
  const r = i - z * nxy
  const y = Math.floor(r / d[0])
  return [r - y * d[0], y, z]
}

/** Voxels set in `m`. */
export function countOf(m: Uint8Array, value = -1): number {
  let n = 0
  if (value < 0) {
    for (let i = 0; i < m.length; i++) if (m[i]) n++
  } else for (let i = 0; i < m.length; i++) if (m[i] === value) n++
  return n
}

/** Bounding box of the set voxels, grown by `margin` voxels per axis (null when empty). */
export function bboxOf(m: Uint8Array, d: Dims, margin: [number, number, number] = [0, 0, 0]): Box | null {
  const [nx, ny, nz] = d
  let x0 = nx
  let x1 = -1
  let y0 = ny
  let y1 = -1
  let z0 = nz
  let z1 = -1
  let i = 0
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++, i++) {
        if (!m[i]) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
        if (z < z0) z0 = z
        if (z > z1) z1 = z
      }
  if (x1 < 0) return null
  return [
    Math.max(0, x0 - margin[0]),
    Math.min(nx, x1 + 1 + margin[0]),
    Math.max(0, y0 - margin[1]),
    Math.min(ny, y1 + 1 + margin[1]),
    Math.max(0, z0 - margin[2]),
    Math.min(nz, z1 + 1 + margin[2])
  ]
}

/** Voxels of a radius in mm along each axis (at least 1). */
export const voxels = (sp: Spacing, mm: number): [number, number, number] => [
  Math.max(1, Math.ceil(mm / sp[0])),
  Math.max(1, Math.ceil(mm / sp[1])),
  Math.max(1, Math.ceil(mm / sp[2]))
]

// ------------------------------------------------------------------ filters

const med3 = (a: number, b: number, c: number): number => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))

/** Edge-keeping noise reduction: median of 3 along x, then y, then z. */
export function median3(src: Int16Array, d: Dims): Int16Array {
  const [nx, ny, nz] = d
  const nxy = nx * ny
  const a = new Int16Array(src.length)
  const b = new Int16Array(src.length)
  // x
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++) {
      const o = y * nx + z * nxy
      for (let x = 0; x < nx; x++) {
        const i = o + x
        a[i] = nx < 3 ? src[i] : med3(src[x > 0 ? i - 1 : i], src[i], src[x < nx - 1 ? i + 1 : i])
      }
    }
  // y
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++) {
      const o = y * nx + z * nxy
      for (let x = 0; x < nx; x++) {
        const i = o + x
        b[i] = ny < 3 ? a[i] : med3(a[y > 0 ? i - nx : i], a[i], a[y < ny - 1 ? i + nx : i])
      }
    }
  // z
  for (let z = 0; z < nz; z++) {
    const o = z * nxy
    for (let p = 0; p < nxy; p++) {
      const i = o + p
      a[i] = nz < 3 ? b[i] : med3(b[z > 0 ? i - nxy : i], b[i], b[z < nz - 1 ? i + nxy : i])
    }
  }
  return a
}

// ------------------------------------------------------------------ statistics

export class Histogram {
  bins = new Uint32Array(HU_BINS)
  n = 0
  sum = 0
  sum2 = 0
  add(v: number): void {
    const b = Math.min(HU_BINS - 1, Math.max(0, Math.round(v) - HU_MIN))
    this.bins[b]++
    this.n++
    this.sum += v
    this.sum2 += v * v
  }
  get mean(): number {
    return this.n ? this.sum / this.n : 0
  }
  get sd(): number {
    if (this.n < 2) return 0
    const m = this.sum / this.n
    return Math.sqrt(Math.max(0, this.sum2 / this.n - m * m))
  }
  /** Value below which a fraction `q` of the samples lie. */
  quantile(q: number): number {
    if (!this.n) return 0
    const want = q * this.n
    let acc = 0
    for (let b = 0; b < HU_BINS; b++) {
      acc += this.bins[b]
      if (acc >= want) return b + HU_MIN
    }
    return HU_BINS - 1 + HU_MIN
  }
  get median(): number {
    return this.quantile(0.5)
  }
  /** Robust spread: 1.4826 × the median absolute deviation (= SD for normal data). */
  get robustSd(): number {
    if (!this.n) return 0
    const med = this.median
    const dev = new Uint32Array(HU_BINS)
    for (let b = 0; b < HU_BINS; b++) if (this.bins[b]) dev[Math.min(HU_BINS - 1, Math.abs(b + HU_MIN - med))] += this.bins[b]
    let acc = 0
    for (let k = 0; k < HU_BINS; k++) {
      acc += dev[k]
      if (acc >= this.n / 2) return 1.4826 * k
    }
    return 0
  }
}

/** HU of the voxels in a mask (or with a given label). */
export function statsOf(data: Int16Array, m: Uint8Array, value = -1): { n: number; mean: number; sd: number } {
  let n = 0
  let s = 0
  let s2 = 0
  for (let i = 0; i < m.length; i++) {
    const hit = value < 0 ? m[i] !== 0 : m[i] === value
    if (!hit) continue
    const v = data[i]
    n++
    s += v
    s2 += v * v
  }
  const mean = n ? s / n : 0
  return { n, mean, sd: n > 1 ? Math.sqrt(Math.max(0, s2 / n - mean * mean)) : 0 }
}

/** Histogram of the voxels within `mm` of voxel `c` (optionally only where `within` is set). */
function ballHistogram(v: Vol, src: Int16Array, c: number, mm: number, within?: Uint8Array): Histogram {
  const [nx, ny, nz] = v.dims
  const [cx, cy, cz] = coordsOf(v.dims, c)
  const [rx, ry, rz] = voxels(v.sp, mm)
  const h = new Histogram()
  const r2 = mm * mm
  for (let z = Math.max(0, cz - rz); z <= Math.min(nz - 1, cz + rz); z++) {
    const dz = (z - cz) * v.sp[2]
    for (let y = Math.max(0, cy - ry); y <= Math.min(ny - 1, cy + ry); y++) {
      const dy = (y - cy) * v.sp[1]
      for (let x = Math.max(0, cx - rx); x <= Math.min(nx - 1, cx + rx); x++) {
        const dx = (x - cx) * v.sp[0]
        if (dx * dx + dy * dy + dz * dz > r2) continue
        const i = x + nx * (y + ny * z)
        if (within && !within[i]) continue
        h.add(src[i])
      }
    }
  }
  return h
}

// ------------------------------------------------------------------ distance transform

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher) of f with sample spacing² s2. */
function dt1(f: Float64Array, n: number, s2: number, out: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = -1
  for (let q = 0; q < n; q++) {
    const fq = f[q]
    if (fq >= BIG) continue
    if (k < 0) {
      k = 0
      v[0] = q
      z[0] = -Infinity
      z[1] = Infinity
      continue
    }
    let s = 0
    for (;;) {
      const p = v[k]
      s = (fq + s2 * q * q - (f[p] + s2 * p * p)) / (2 * s2 * (q - p))
      if (s <= z[k]) k--
      else break
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  if (k < 0) {
    for (let q = 0; q < n; q++) out[q] = BIG
    return
  }
  let j = 0
  for (let q = 0; q < n; q++) {
    while (z[j + 1] < q) j++
    const p = v[j]
    out[q] = s2 * (q - p) * (q - p) + f[p]
  }
}

/**
 * Squared distance in mm² from each voxel of `box` to the nearest set voxel of `feature` inside
 * the box (voxels outside the box are left at 0 and ignored).
 */
export function edt2(feature: Uint8Array, d: Dims, sp: Spacing, box: Box = fullBox(d)): Float32Array {
  const [nx, ny] = d
  const nxy = nx * ny
  const [x0, x1, y0, y1, z0, z1] = box
  const out = new Float32Array(feature.length)
  for (let z = z0; z < z1; z++)
    for (let y = y0; y < y1; y++) {
      const o = y * nx + z * nxy
      for (let x = x0; x < x1; x++) out[o + x] = feature[o + x] ? 0 : BIG
    }
  const len = Math.max(x1 - x0, y1 - y0, z1 - z0)
  const f = new Float64Array(len)
  const r = new Float64Array(len)
  const v = new Int32Array(len)
  const zz = new Float64Array(len + 1)
  const pass = (count: number, start: (k: number) => number, stride: number, n: number, s: number) => {
    const s2 = s * s
    for (let k = 0; k < count; k++) {
      const b = start(k)
      for (let t = 0; t < n; t++) f[t] = out[b + t * stride]
      dt1(f, n, s2, r, v, zz)
      for (let t = 0; t < n; t++) out[b + t * stride] = r[t] >= BIG ? BIG : r[t]
    }
  }
  const W = x1 - x0
  const H = y1 - y0
  const D = z1 - z0
  pass(H * D, (k) => x0 + (y0 + (k % H)) * nx + (z0 + Math.floor(k / H)) * nxy, 1, W, sp[0])
  pass(W * D, (k) => x0 + (k % W) + y0 * nx + (z0 + Math.floor(k / W)) * nxy, nx, H, sp[1])
  pass(W * H, (k) => x0 + (k % W) + (y0 + Math.floor(k / W)) * nx + z0 * nxy, nxy, D, sp[2])
  return out
}

/** Voxels within `mm` of the mask (dilation), inside `box`. */
export function dilate(m: Uint8Array, d: Dims, sp: Spacing, mm: number, box?: Box): Uint8Array {
  const b = box ?? bboxOf(m, d, voxels(sp, mm + 1)) ?? fullBox(d)
  const d2 = edt2(m, d, sp, b)
  const out = new Uint8Array(m.length)
  const r2 = mm * mm + 1e-6
  forBox(d, b, (i) => {
    if (d2[i] <= r2) out[i] = 1
  })
  return out
}

/** Mask voxels deeper than `mm` inside the mask (erosion). */
export function erode(m: Uint8Array, d: Dims, sp: Spacing, mm: number): Uint8Array {
  const b = bboxOf(m, d, [1, 1, 1])
  const out = new Uint8Array(m.length)
  if (!b) return out
  const inv = new Uint8Array(m.length)
  forBox(d, b, (i) => {
    inv[i] = m[i] ? 0 : 1
  })
  // The box edge counts as outside.
  const d2 = edt2(inv, d, sp, b)
  const r2 = mm * mm + 1e-6
  forBox(d, b, (i) => {
    if (m[i] && d2[i] > r2) out[i] = 1
  })
  return out
}

/** Morphological closing (fills gaps and dents narrower than 2 × mm). */
export function close(m: Uint8Array, d: Dims, sp: Spacing, mm: number): Uint8Array {
  const b = bboxOf(m, d, voxels(sp, mm * 2 + 2))
  if (!b) return new Uint8Array(m.length)
  return erode(dilate(m, d, sp, mm, b), d, sp, mm)
}

export function forBox(d: Dims, b: Box, fn: (i: number) => void): void {
  const [nx, ny] = d
  const nxy = nx * ny
  for (let z = b[4]; z < b[5]; z++)
    for (let y = b[2]; y < b[3]; y++) {
      const o = y * nx + z * nxy
      for (let x = b[0]; x < b[1]; x++) fn(o + x)
    }
}

// ------------------------------------------------------------------ connectivity

let queue = new Int32Array(1 << 16)
function q(size: number): Int32Array {
  if (queue.length < size) queue = new Int32Array(Math.max(size, queue.length * 2))
  return queue
}

/** 6-connected flood fill of `allowed` from the seeds (only seeds that are allowed start). */
export function flood(allowed: Uint8Array, d: Dims, seeds: ArrayLike<number>, out = new Uint8Array(allowed.length)): Uint8Array {
  const [nx, ny, nz] = d
  const nxy = nx * ny
  const Q = q(allowed.length)
  let head = 0
  let tail = 0
  for (let s = 0; s < seeds.length; s++) {
    const i = seeds[s]
    if (i >= 0 && i < allowed.length && allowed[i] && !out[i]) {
      out[i] = 1
      Q[tail++] = i
    }
  }
  while (head < tail) {
    const i = Q[head++]
    const z = (i / nxy) | 0
    const r = i - z * nxy
    const y = (r / nx) | 0
    const x = r - y * nx
    if (x > 0 && allowed[i - 1] && !out[i - 1]) (out[i - 1] = 1), (Q[tail++] = i - 1)
    if (x < nx - 1 && allowed[i + 1] && !out[i + 1]) (out[i + 1] = 1), (Q[tail++] = i + 1)
    if (y > 0 && allowed[i - nx] && !out[i - nx]) (out[i - nx] = 1), (Q[tail++] = i - nx)
    if (y < ny - 1 && allowed[i + nx] && !out[i + nx]) (out[i + nx] = 1), (Q[tail++] = i + nx)
    if (z > 0 && allowed[i - nxy] && !out[i - nxy]) (out[i - nxy] = 1), (Q[tail++] = i - nxy)
    if (z < nz - 1 && allowed[i + nxy] && !out[i + nxy]) (out[i + nxy] = 1), (Q[tail++] = i + nxy)
  }
  return out
}

/** The set voxel of `m` nearest (in steps through `through`) to voxel `from`, within `maxSteps` (−1: none). */
export function nearestSet(m: Uint8Array, through: Uint8Array, d: Dims, from: number, maxSteps: number): number {
  if (m[from]) return from
  const [nx, ny, nz] = d
  const nxy = nx * ny
  const seen = new Map<number, number>()
  let front = [from]
  seen.set(from, 0)
  for (let step = 1; step <= maxSteps && front.length; step++) {
    const next: number[] = []
    for (const i of front) {
      const z = (i / nxy) | 0
      const r = i - z * nxy
      const y = (r / nx) | 0
      const x = r - y * nx
      const nb = [x > 0 ? i - 1 : -1, x < nx - 1 ? i + 1 : -1, y > 0 ? i - nx : -1, y < ny - 1 ? i + nx : -1, z > 0 ? i - nxy : -1, z < nz - 1 ? i + nxy : -1]
      for (const j of nb) {
        if (j < 0 || seen.has(j)) continue
        seen.set(j, step)
        if (m[j]) return j
        if (through[j]) next.push(j)
      }
    }
    front = next
  }
  return -1
}

/** Fills holes (background not connected to the slice edge) in every slice across `axis`. */
export function fillHoles2D(m: Uint8Array, d: Dims, axis: 0 | 1 | 2, box: Box = fullBox(d)): void {
  const [nx, ny] = d
  const stride = [1, nx, nx * ny]
  const u = axis === 0 ? 1 : 0
  const w = axis === 2 ? 1 : 2
  const lo = [box[0], box[2], box[4]]
  const hi = [box[1], box[3], box[5]]
  const nu = hi[u] - lo[u]
  const nw = hi[w] - lo[w]
  if (nu < 3 || nw < 3) return
  const seen = new Uint8Array(nu * nw)
  const Q = new Int32Array(nu * nw)
  for (let s = lo[axis]; s < hi[axis]; s++) {
    const base = s * stride[axis] + lo[u] * stride[u] + lo[w] * stride[w]
    seen.fill(0)
    let tail = 0
    let any = false
    const push = (a: number, b: number) => {
      const k = a + b * nu
      if (seen[k]) return
      if (m[base + a * stride[u] + b * stride[w]]) {
        any = true
        return
      }
      seen[k] = 1
      Q[tail++] = k
    }
    for (let a = 0; a < nu; a++) {
      push(a, 0)
      push(a, nw - 1)
    }
    for (let b = 0; b < nw; b++) {
      push(0, b)
      push(nu - 1, b)
    }
    if (!any) {
      // quick check: does the slice hold any mask at all?
      let has = false
      for (let b = 0; b < nw && !has; b++) for (let a = 0; a < nu; a++) if (m[base + a * stride[u] + b * stride[w]]) (has = true)
      if (!has) continue
    }
    let head = 0
    while (head < tail) {
      const k = Q[head++]
      const a = k % nu
      const b = (k / nu) | 0
      if (a > 0) push(a - 1, b)
      if (a < nu - 1) push(a + 1, b)
      if (b > 0) push(a, b - 1)
      if (b < nw - 1) push(a, b + 1)
    }
    for (let b = 0; b < nw; b++)
      for (let a = 0; a < nu; a++) if (!seen[a + b * nu]) m[base + a * stride[u] + b * stride[w]] = 1
  }
}

/** Removes connected parts (6-connected) smaller than `minVoxels`. */
export function dropSmall(m: Uint8Array, d: Dims, minVoxels: number): void {
  const { labels, sizes } = components(m, d)
  for (let i = 0; i < m.length; i++) if (m[i] && sizes[labels[i]] < minVoxels) m[i] = 0
}

/** Labels of the 6-connected parts of `m` (0 = none, 1…n) and the size of each. */
export function components(m: Uint8Array, d: Dims): { labels: Int32Array; sizes: number[] } {
  const [nx, ny, nz] = d
  const nxy = nx * ny
  const labels = new Int32Array(m.length)
  const sizes: number[] = [0]
  const Q = q(m.length)
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || labels[s]) continue
    const id = sizes.length
    let head = 0
    let tail = 0
    labels[s] = id
    Q[tail++] = s
    while (head < tail) {
      const i = Q[head++]
      const z = (i / nxy) | 0
      const r = i - z * nxy
      const y = (r / nx) | 0
      const x = r - y * nx
      if (x > 0 && m[i - 1] && !labels[i - 1]) (labels[i - 1] = id), (Q[tail++] = i - 1)
      if (x < nx - 1 && m[i + 1] && !labels[i + 1]) (labels[i + 1] = id), (Q[tail++] = i + 1)
      if (y > 0 && m[i - nx] && !labels[i - nx]) (labels[i - nx] = id), (Q[tail++] = i - nx)
      if (y < ny - 1 && m[i + nx] && !labels[i + nx]) (labels[i + nx] = id), (Q[tail++] = i + nx)
      if (z > 0 && m[i - nxy] && !labels[i - nxy]) (labels[i - nxy] = id), (Q[tail++] = i - nxy)
      if (z < nz - 1 && m[i + nxy] && !labels[i + nxy]) (labels[i + nxy] = id), (Q[tail++] = i + nxy)
    }
    sizes.push(tail)
  }
  return { labels, sizes }
}

// ------------------------------------------------------------------ geodesic competition

/** Min-heap of voxel indices keyed by cost (stale entries are skipped by the caller). */
class Heap {
  idx = new Int32Array(1 << 16)
  key = new Float32Array(1 << 16)
  n = 0
  push(i: number, k: number): void {
    if (this.n === this.idx.length) {
      const ni = new Int32Array(this.n * 2)
      const nk = new Float32Array(this.n * 2)
      ni.set(this.idx)
      nk.set(this.key)
      this.idx = ni
      this.key = nk
    }
    let c = this.n++
    while (c > 0) {
      const p = (c - 1) >> 1
      if (this.key[p] <= k) break
      this.idx[c] = this.idx[p]
      this.key[c] = this.key[p]
      c = p
    }
    this.idx[c] = i
    this.key[c] = k
  }
  /** Removes the cheapest entry; its index is in `top`, its cost in `topKey`. */
  top = 0
  topKey = 0
  pop(): boolean {
    if (!this.n) return false
    this.top = this.idx[0]
    this.topKey = this.key[0]
    const li = this.idx[--this.n]
    const lk = this.key[this.n]
    let c = 0
    for (;;) {
      let ch = 2 * c + 1
      if (ch >= this.n) break
      if (ch + 1 < this.n && this.key[ch + 1] < this.key[ch]) ch++
      if (this.key[ch] >= lk) break
      this.idx[c] = this.idx[ch]
      this.key[c] = this.key[ch]
      c = ch
    }
    this.idx[c] = li
    this.key[c] = lk
    return true
  }
}

/**
 * Splits `allowed` between seed groups by the cheapest path, where crossing a change in HU
 * costs extra (so the border falls where the tissue changes, e.g. at the diaphragm). Returns
 * the group (1, 2, …) that won each voxel, 0 where none reached.
 */
export function compete(allowed: Uint8Array, g: Int16Array, d: Dims, sp: Spacing, groups: number[][], sd: number): Uint8Array {
  const [nx, ny, nz] = d
  const nxy = nx * ny
  const cost = new Float32Array(allowed.length).fill(Infinity)
  const label = new Uint8Array(allowed.length)
  const heap = new Heap()
  groups.forEach((seeds, gi) => {
    for (const s of seeds) {
      if (s < 0 || !allowed[s]) continue
      cost[s] = 0
      label[s] = gi + 1
      heap.push(s, 0)
    }
  })
  const k = 1 / Math.max(4, sd) ** 2
  const done = new Uint8Array(allowed.length)
  while (heap.pop()) {
    const i = heap.top
    if (done[i] || heap.topKey > cost[i]) continue
    done[i] = 1
    const ci = cost[i]
    const gi = g[i]
    const li = label[i]
    const z = (i / nxy) | 0
    const r = i - z * nxy
    const y = (r / nx) | 0
    const x = r - y * nx
    const visit = (j: number, step: number) => {
      if (!allowed[j] || done[j]) return
      const dv = g[j] - gi
      const c = ci + step * (1 + dv * dv * k)
      if (c < cost[j]) {
        cost[j] = c
        label[j] = li
        heap.push(j, c)
      }
    }
    if (x > 0) visit(i - 1, sp[0])
    if (x < nx - 1) visit(i + 1, sp[0])
    if (y > 0) visit(i - nx, sp[1])
    if (y < ny - 1) visit(i + nx, sp[1])
    if (z > 0) visit(i - nxy, sp[2])
    if (z < nz - 1) visit(i + nxy, sp[2])
  }
  return label
}

// ------------------------------------------------------------------ liver

export interface LiverOptions {
  /** Bridges to neighbouring organs thinner than 2 × neckMm are cut (default 4 mm). */
  neckMm?: number
  /** Width of the accepted HU band in robust SDs (default 3). */
  k?: number
}

/**
 * HU model of the liver around a click: the main soft-tissue peak of the voxels within 25 mm
 * (nearer voxels count more), so a click on a vessel or a small lesion still finds the
 * parenchyma. The spread comes from the width of that peak.
 */
export function liverModel(v: Vol, g: Int16Array, seed: number): TissueModel {
  const [nx, ny] = v.dims
  const R = 30
  const box = ballBox(v, seed, R)
  const [cx, cy, cz] = coordsOf(v.dims, seed)
  const OFF = 100
  const hist = new Float64Array(500) // -100 … 399 HU
  const inv = 1 / (2 * 15 * 15)
  for (let z = box[4]; z < box[5]; z++) {
    const dz = (z - cz) * v.sp[2]
    for (let y = box[2]; y < box[3]; y++) {
      const dy = (y - cy) * v.sp[1]
      for (let x = box[0]; x < box[1]; x++) {
        const dx = (x - cx) * v.sp[0]
        const r2 = dx * dx + dy * dy + dz * dz
        if (r2 > R * R) continue
        const h = g[x + nx * (y + ny * z)]
        if (h < -OFF || h >= 500 - OFF) continue
        hist[h + OFF] += Math.exp(-r2 * inv)
      }
    }
  }
  // Smooth (±4 HU) and take the highest peak above fat.
  const sm = new Float64Array(hist.length)
  for (let b = 0; b < hist.length; b++) {
    let s = 0
    for (let k = -4; k <= 4; k++) s += hist[Math.min(hist.length - 1, Math.max(0, b + k))]
    sm[b] = s
  }
  let peak = OFF - 20 + 1
  for (let b = OFF - 20; b < sm.length; b++) if (sm[b] > sm[peak]) peak = b
  const top = sm[peak]
  // The band runs out to where the peak has fallen to 12 % (covers livers of uneven density,
  // e.g. perfusion differences or fat), at least ±18 HU and at most ±60 HU around the peak.
  let l = peak
  let r = peak
  while (l > 0 && sm[l] > top * 0.12) l--
  while (r < sm.length - 1 && sm[r] > top * 0.12) r++
  const mean = peak - OFF
  const lo = Math.min(mean - 22, Math.max(mean - 60, l - OFF - 4))
  const hi = Math.max(mean + 22, Math.min(mean + 60, r - OFF + 4))
  const sd = Math.min(20, Math.max(6, (hi - lo) / 6))
  void ny
  return { mean, sd, lo, hi }
}

/** One model covering several (from several clicks). */
export function mergeModels(ms: TissueModel[]): TissueModel {
  if (ms.length === 1) return { ...ms[0] }
  return {
    mean: ms.reduce((s, m) => s + m.mean, 0) / ms.length,
    sd: Math.max(...ms.map((m) => m.sd)),
    lo: Math.min(...ms.map((m) => m.lo)),
    hi: Math.max(...ms.map((m) => m.hi))
  }
}

function ballBox(v: Vol, c: number, mm: number): Box {
  const [cx, cy, cz] = coordsOf(v.dims, c)
  const [rx, ry, rz] = voxels(v.sp, mm)
  const [nx, ny, nz] = v.dims
  return [Math.max(0, cx - rx), Math.min(nx, cx + rx + 1), Math.max(0, cy - ry), Math.min(ny, cy + ry + 1), Math.max(0, cz - rz), Math.min(nz, cz + rz + 1)]
}

/**
 * One-click liver: voxels in the liver's HU band connected to the click, with thin bridges to
 * other organs cut (opening by reconstruction), then vessels and lesions inside it filled in.
 */
export function segmentLiver(v: Vol, g: Int16Array, seeds: number[], opt: LiverOptions = {}): { mask: Uint8Array; model: TissueModel } {
  const { dims: d, sp } = v
  // Each click brings its own HU band (a liver of uneven density may take a click per part).
  const models = seeds.map((s) => liverModel(v, g, s))
  const neck = opt.neckMm ?? 8
  const N = g.length
  const grow = (ms: TissueModel[]) => {
    const reach = new Uint8Array(N)
    ms.forEach((m, k) => {
      const cand = new Uint8Array(N)
      for (let i = 0; i < N; i++) if (g[i] >= m.lo && g[i] <= m.hi) cand[i] = 1
      cand[seeds[k]] = 1
      flood(cand, d, [seeds[k]], reach)
    })
    return splitByNecks(reach, g, d, sp, seeds, neck, mergeModels(ms).sd)
  }
  let mask = grow(models)
  // Confidence-connected widening: the band follows the HU of the liver found so far, so slow
  // density changes across the liver (streaks from the arms, perfusion) are taken in.
  for (let it = 0; it < 3; it++) {
    const s = statsOf(g, mask)
    if (s.n < 50) break
    const k = opt.k ?? 2.8
    const wider = models.map((m) => ({
      ...m,
      lo: Math.round(Math.max(m.mean - 70, Math.min(m.lo, s.mean - k * s.sd))),
      hi: Math.round(Math.min(m.mean + 70, Math.max(m.hi, s.mean + k * s.sd)))
    }))
    if (wider.every((w, j) => w.lo >= models[j].lo - 1 && w.hi <= models[j].hi + 1)) break
    models.splice(0, models.length, ...wider)
    mask = grow(models)
  }
  // Still cut off by the band: tissue just past its edge that is surrounded by tissue (not a
  // partial-volume rim against fat, air or a bright vessel) is darker / brighter liver.
  const start = models.map((m) => ({ lo: m.lo, hi: m.hi }))
  for (let it = 0; it < 4; it++) {
    const lo = Math.min(...models.map((m) => m.lo))
    const hi = Math.max(...models.map((m) => m.hi))
    const e = cutOff(mask, g, d, lo, hi)
    // (measured on real CT: 9–21 % when the liver is complete, 23–31 % when the band cut it off)
    const wantLo = e.below > e.total * 0.22
    const wantHi = e.above > e.total * 0.22
    if (!wantLo && !wantHi) break
    const wider = models.map((m, j) => ({
      ...m,
      lo: wantLo ? Math.max(start[j].lo - 40, m.lo - 8) : m.lo,
      hi: wantHi ? Math.min(start[j].hi + 40, m.hi + 8) : m.hi
    }))
    if (wider.every((w, j) => w.lo === models[j].lo && w.hi === models[j].hi)) break
    models.splice(0, models.length, ...wider)
    mask = grow(models)
  }
  const model = mergeModels(models)
  const st = statsOf(g, mask)
  if (st.n > 50) {
    model.mean = st.mean
    model.sd = Math.max(6, st.sd)
  }
  fillLiver(mask, g, d, sp, model)
  return { mask, model }
}

/**
 * Separates the clicked organ from organs touching it through narrower contacts: erode by
 * `neck` mm, so touching organs fall apart into cores; the clicked cores and the others then
 * compete for the eroded rim (the border falls where the HU changes, else midway), and the
 * result keeps no more than `neck` (+ a voxel) around the clicked cores.
 */
export function splitByNecks(reach: Uint8Array, g: Int16Array, d: Dims, sp: Spacing, seeds: number[], neck: number, sd: number): Uint8Array {
  const N = reach.length
  const core = erode(reach, d, sp, neck)
  const starts = seeds.map((s) => nearestSet(core, reach, d, s, Math.ceil((neck * 3) / Math.min(...sp)))).filter((s) => s >= 0)
  if (!starts.length) return reach // a thin part: nothing to cut
  const { labels } = components(core, d)
  const mine = new Set(starts.map((s) => labels[s]))
  const box = bboxOf(reach, d, [1, 1, 1]) ?? fullBox(d)
  // Seeds of the competition: core voxels next to the rim (the inside of a core is settled).
  const [nx, ny] = d
  const nxy = nx * ny
  const groups: number[][] = [[], []]
  const settled = new Uint8Array(N)
  forBox(d, box, (i) => {
    const id = labels[i]
    if (!id) return
    settled[i] = mine.has(id) ? 1 : 2
    const rim = !core[i - 1] || !core[i + 1] || !core[i - nx] || !core[i + nx] || !core[i - nxy] || !core[i + nxy]
    if (rim) groups[mine.has(id) ? 0 : 1].push(i)
  })
  const allowed = new Uint8Array(N)
  forBox(d, box, (i) => {
    if (reach[i] && (!settled[i] || labels[i] === 0)) allowed[i] = 1
  })
  for (const gr of groups) for (const i of gr) allowed[i] = 1
  const won = compete(allowed, g, d, sp, groups, sd)
  // Liver = its cores + the rim it won, no further than neck (+ a voxel) from its cores.
  const own = new Uint8Array(N)
  forBox(d, box, (i) => {
    if (settled[i] === 1) own[i] = 1
  })
  const near = dilate(own, d, sp, neck + Math.max(...sp), box)
  const mask = new Uint8Array(N)
  forBox(d, box, (i) => {
    if (settled[i] === 1 || (reach[i] && !settled[i] && won[i] === 1 && near[i])) mask[i] = 1
  })
  return flood(mask, d, starts.concat(seeds.filter((s) => mask[s])))
}

/**
 * The voxels just outside a mask, and how many of them lie within 15 HU below / above the band
 * with all their neighbours tissue-like (within 30 HU of the band): parenchyma cut off by the band.
 */
function cutOff(m: Uint8Array, g: Int16Array, d: Dims, lo: number, hi: number): { total: number; below: number; above: number } {
  const [nx, ny, nz] = d
  const nxy = nx * ny
  const box = bboxOf(m, d, [1, 1, 1])
  let total = 0
  let below = 0
  let above = 0
  if (!box) return { total, below, above }
  for (let z = Math.max(1, box[4]); z < Math.min(nz - 1, box[5]); z++)
    for (let y = Math.max(1, box[2]); y < Math.min(ny - 1, box[3]); y++)
      for (let x = Math.max(1, box[0]); x < Math.min(nx - 1, box[1]); x++) {
        const i = x + nx * y + nxy * z
        if (m[i]) continue
        if (!m[i - 1] && !m[i + 1] && !m[i - nx] && !m[i + nx] && !m[i - nxy] && !m[i + nxy]) continue
        total++
        const v = g[i]
        if (v < lo && v >= lo - 15) {
          const f = lo - 30
          if (g[i - 1] >= f && g[i + 1] >= f && g[i - nx] >= f && g[i + nx] >= f && g[i - nxy] >= f && g[i + nxy] >= f) below++
        } else if (v > hi && v <= hi + 15) {
          const c = hi + 30
          if (g[i - 1] <= c && g[i + 1] <= c && g[i - nx] <= c && g[i + nx] <= c && g[i - nxy] <= c && g[i + nxy] <= c) above++
        }
      }
  return { total, below, above }
}

/** Vessels, lesions and the IVC groove inside the liver are part of the total liver. */
export function fillLiver(mask: Uint8Array, g: Int16Array, d: Dims, sp: Spacing, model: TissueModel): void {
  const box = bboxOf(mask, d, [2, 2, 2])
  if (!box) return
  fillHoles2D(mask, d, 2, box)
  fillHoles2D(mask, d, 1, box)
  fillHoles2D(mask, d, 0, box)
  // Small dents along vessels at the surface: closing, but not into fat or air.
  const closed = close(mask, d, sp, 3)
  const floor = Math.min(model.lo, -10)
  for (let i = 0; i < mask.length; i++) if (closed[i] && !mask[i] && g[i] >= floor && g[i] <= 1000) mask[i] = 1
  fillHoles2D(mask, d, 2, box)
}

/**
 * Corrects a leak: the liver clicks and the "not liver" clicks compete for the voxels in the
 * liver's HU band; the border falls where the HU changes most (diaphragm, kidney capsule …).
 */
export function refineLiver(v: Vol, g: Int16Array, current: Uint8Array, model: TissueModel, liverSeeds: number[], otherSeeds: number[]): Uint8Array {
  const { dims: d, sp } = v
  const N = g.length
  // The region in play: the current liver plus its HU band nearby.
  const box = bboxOf(current, d, voxels(sp, 20)) ?? fullBox(d)
  const allowed = new Uint8Array(N)
  forBox(d, box, (i) => {
    if (current[i] || (g[i] >= model.lo && g[i] <= model.hi)) allowed[i] = 1
  })
  for (const s of [...liverSeeds, ...otherSeeds]) if (s >= 0) allowed[s] = 1
  const lab = compete(allowed, g, d, sp, [liverSeeds, otherSeeds], model.sd)
  const mask = new Uint8Array(N)
  for (let i = 0; i < N; i++) if (lab[i] === 1 && current[i]) mask[i] = 1
  const kept = flood(mask, d, liverSeeds.filter((s) => mask[s]))
  fillLiver(kept, g, d, sp, model)
  return kept
}

// ------------------------------------------------------------------ lesions

/**
 * Lesion around a click (and a radius dragged out to its edge): the voxels on the lesion's
 * side of the HU midway between lesion and liver, connected to the click, holes filled.
 */
export function segmentLesion(
  v: Vol,
  g: Int16Array,
  model: TissueModel | null,
  center: number,
  radiusMm: number
): { mask: Uint8Array; mean: number; sd: number } | null {
  const { dims: d, sp } = v
  const R = Math.min(90, Math.max(6, radiusMm))
  const inner = ballHistogram(v, g, center, Math.max(Math.min(...sp), Math.min(4, R / 3)))
  const mL = inner.median
  const sL = Math.max(6, inner.robustSd)
  // The tissue around it: the liver model, else the shell just outside the radius.
  let mRef = model?.mean
  if (mRef == null) {
    const shell = ballHistogram(v, g, center, R * 1.3)
    mRef = shell.median
  }
  if (Math.abs(mL - mRef) < 10) return null // as dense as the liver: draw it with the brush
  const hypo = mL < mRef
  let t = (mL + mRef) / 2
  const box = ballBox(v, center, R * 1.3)
  const [cx, cy, cz] = coordsOf(d, center)
  const r2 = (R * 1.3) ** 2
  const inBall = (i: number) => {
    const [x, y, z] = coordsOf(d, i)
    const dx = (x - cx) * sp[0]
    const dy = (y - cy) * sp[1]
    const dz = (z - cz) * sp[2]
    return dx * dx + dy * dy + dz * dz <= r2
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const lo = hypo ? mL - Math.max(40, 3 * sL) : t
    const hi = hypo ? t : mL + Math.max(80, 3 * sL)
    const cand = new Uint8Array(g.length)
    let edge = 0
    forBox(d, box, (i) => {
      if (g[i] >= lo && g[i] <= hi && inBall(i)) cand[i] = 1
    })
    cand[center] = 1
    const m = flood(cand, d, [center])
    // Leaking out of the drawn radius: tighten towards the lesion and try again.
    const rr = (R * 1.15) ** 2
    let total = 0
    forBox(d, box, (i) => {
      if (!m[i]) return
      total++
      const [x, y, z] = coordsOf(d, i)
      const dx = (x - cx) * sp[0]
      const dy = (y - cy) * sp[1]
      const dz = (z - cz) * sp[2]
      if (dx * dx + dy * dy + dz * dz > rr) edge++
    })
    if (edge > total * 0.04 && attempt < 3) {
      t = t + (mL - t) * 0.35
      continue
    }
    const b = bboxOf(m, d, [2, 2, 2]) ?? box
    fillHoles2D(m, d, 2, b)
    fillHoles2D(m, d, 1, b)
    fillHoles2D(m, d, 0, b)
    const out = close(m, d, sp, Math.max(1.5, Math.min(...sp)))
    const s = statsOf(g, out)
    return { mask: out, mean: s.mean, sd: s.sd }
  }
  return null
}

// ------------------------------------------------------------------ vessels

/**
 * Contrast-filled vessels in and at the liver: brighter than the parenchyma by a margin. Returns
 * null when the scan shows no enhanced vessels (no contrast, or too early / late).
 */
export function segmentVessels(
  v: Vol,
  g: Int16Array,
  liver: Uint8Array,
  model: TissueModel,
  exclude?: Uint8Array,
  wanted?: number
): { mask: Uint8Array; threshold: number } | null {
  const { dims: d, sp } = v
  // Without contrast the liver is below ~75 HU and its veins are no brighter than it.
  if (wanted == null && model.mean < 75) return null
  const threshold = wanted ?? Math.round(model.mean + Math.max(25, 3 * model.sd))
  const near = dilate(liver, d, sp, 3)
  const mask = new Uint8Array(g.length)
  let n = 0
  let nl = 0
  for (let i = 0; i < g.length; i++) {
    if (liver[i]) nl++
    if (!near[i] || (exclude && exclude[i])) continue
    if (g[i] >= threshold && g[i] <= 600) {
      mask[i] = 1
      n++
    }
  }
  if (n < nl * 0.004) return null
  const vox = sp[0] * sp[1] * sp[2]
  const { labels, sizes } = components(mask, d)
  const minVox = Math.max(3, Math.round(40 / vox))
  for (let i = 0; i < mask.length; i++) if (mask[i] && sizes[labels[i]] < minVox) mask[i] = 0
  return { mask, threshold }
}

/**
 * Portal vs hepatic veins: each vessel voxel goes to the tree whose landmark it reaches first
 * along the vessels. 2 = portal, 3 = hepatic, 1 = not reached.
 */
export function classifyVessels(vessels: Uint8Array, d: Dims, sp: Spacing, portal: number[], hepatic: number[]): Uint8Array {
  const snap = (s: number) => nearestSet(vessels, new Uint8Array(vessels.length).fill(1), d, s, Math.ceil(12 / Math.min(...sp)))
  const ps = portal.map(snap).filter((s) => s >= 0)
  const hs = hepatic.map(snap).filter((s) => s >= 0)
  const out = new Uint8Array(vessels.length)
  for (let i = 0; i < vessels.length; i++) if (vessels[i]) out[i] = 1
  if (!ps.length && !hs.length) return out
  // Equal costs: a plain breadth-first race (stepping by mm).
  const flat = new Int16Array(vessels.length)
  const lab = compete(vessels, flat, d, sp, [ps, hs], 1e6)
  for (let i = 0; i < vessels.length; i++) if (vessels[i] && lab[i]) out[i] = lab[i] === 1 ? 2 : 3
  return out
}

// ------------------------------------------------------------------ brush

/** Sets (value 1) or clears (0) the voxels within `mm` of a voxel; optionally only where `limit` is set. */
export function paintBall(m: Uint8Array, d: Dims, sp: Spacing, c: number, mm: number, value: number, limit?: Uint8Array): void {
  const [nx, ny, nz] = d
  const [cx, cy, cz] = coordsOf(d, c)
  const [rx, ry, rz] = voxels(sp, mm)
  const r2 = mm * mm
  for (let z = Math.max(0, cz - rz); z <= Math.min(nz - 1, cz + rz); z++) {
    const dz = (z - cz) * sp[2]
    for (let y = Math.max(0, cy - ry); y <= Math.min(ny - 1, cy + ry); y++) {
      const dy = (y - cy) * sp[1]
      for (let x = Math.max(0, cx - rx); x <= Math.min(nx - 1, cx + rx); x++) {
        const dx = (x - cx) * sp[0]
        if (dx * dx + dy * dy + dz * dz > r2) continue
        const i = x + nx * (y + ny * z)
        if (limit && !limit[i]) continue
        m[i] = value
      }
    }
  }
}
