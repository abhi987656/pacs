// Reformatting on the processor, the way RadiAnt and other workstations do it on modest PCs.
//
// The GPU path (Cornerstone volume viewports) uploads the whole series to the graphics card as
// one 3D texture. Windows' Direct3D 11 only guarantees one texture of up to 128 MB on built-in
// graphics (Intel UHD, AMD APUs: a quarter of their small "dedicated" memory), so a thin-slice
// CT of 500+ images (250 MB and more) fails there, while a gaming card takes up to 2 GB.
//
// Here the series is kept as a block of numbers in ordinary memory instead, and each axial /
// coronal / sagittal image is computed from it when it is shown (a few milliseconds), MIP slabs
// included. The images are ordinary 2D images with full geometry, so they go into normal stack
// viewports: the graphics card only ever holds one small image per tile, every image of the
// series is used (no thinning), and all stack tools work on them (measurements in HU, spine
// labels, reference lines, key images).

import { cache, Enums, imageLoader, metaData, utilities as csUtils } from '@cornerstonejs/core'
import type { Types } from '@cornerstonejs/core'
import type { SeriesImages } from '@shared/types'

export type Plane = 'axial' | 'coronal' | 'sagittal'
export type Vec3 = [number, number, number]

/** Thick slab: the brightest (MIP) or darkest (MinIP) value through `mm` millimetres. */
export type ProjectionMode = 'mip' | 'minip'
export interface Projection {
  mode: ProjectionMode
  mm: number
}
/** Slab thicknesses offered for MIP / MinIP. */
export const PROJECTION_MM = [5, 10, 15, 20, 30, 50]
export const projectionLabel = (p: Projection): string => `${p.mode === 'minip' ? 'MinIP' : 'MIP'} ${p.mm} mm`
/** Slab thicknesses (mm) that Ctrl+Shift+wheel steps through. */
export const SLAB_STEPS_MM = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 90, 100]

/**
 * One wheel step thicker (dir 1) or thinner (-1): Thin -> MIP 2 mm, … 100 mm; below 2 mm = Thin.
 * A MinIP slab stays MinIP.
 */
export function nextSlab(p: Projection | null | undefined, dir: 1 | -1): Projection | null {
  const mode: ProjectionMode = p?.mode ?? 'mip'
  const mm = p && p.mm > 0 ? p.mm : 0
  if (dir > 0) return { mode, mm: SLAB_STEPS_MM.find((t) => t > mm) ?? SLAB_STEPS_MM[SLAB_STEPS_MM.length - 1] }
  const thinner = SLAB_STEPS_MM.filter((t) => t < mm)
  return thinner.length ? { mode, mm: thinner[thinner.length - 1] } : null
}
type Scalars = Int16Array | Uint16Array | Uint8Array | Float32Array
type ScalarsCtor = Int16ArrayConstructor | Uint16ArrayConstructor | Uint8ArrayConstructor | Float32ArrayConstructor

export const REFORMAT_SCHEME = 'pacsmpr'

/**
 * How Cornerstone's MPR views look at the patient (screen right, screen down, and the way the
 * image number grows), so a reformatted tile looks and scrolls exactly like the GPU one.
 */
const VIEW: Record<Plane, { right: Vec3; down: Vec3; normal: Vec3 }> = {
  axial: { right: [1, 0, 0], down: [0, 1, 0], normal: [0, 0, -1] },
  sagittal: { right: [0, 1, 0], down: [0, 0, -1], normal: [1, 0, 0] },
  coronal: { right: [1, 0, 0], down: [0, 0, -1], normal: [0, -1, 0] }
}

/** Patient-coordinate attributes copied from the series to the reformatted images (overlays). */
const SKIP_ATTRIBUTES = new Set([
  'PixelData', 'FloatPixelData', 'DoubleFloatPixelData', 'SOPInstanceUID', 'InstanceNumber', 'SliceLocation',
  'ImagePositionPatient', 'ImageOrientationPatient', 'PixelSpacing', 'ImagerPixelSpacing', 'Rows', 'Columns',
  'RescaleSlope', 'RescaleIntercept', 'RescaleType', 'SmallestImagePixelValue', 'LargestImagePixelValue',
  'NumberOfFrames', 'BitsAllocated', 'BitsStored', 'HighBit', 'PixelRepresentation', 'SpacingBetweenSlices',
  'SliceThickness', 'ImageType', 'ContentTime', 'AcquisitionTime'
])

/** Largest series kept in memory (about 3,000 images of 512 × 512). */
const MAX_BYTES = 1.6 * 1024 ** 3

interface AxisTable {
  /** Offset into the data of each position along the axis. */
  off: Int32Array
  /** Slice axis only: offset to the next source slice and its weight (between two slices). */
  next: Int32Array
  w: Float32Array
}

interface PlaneGeometry {
  /** Volume axes (0 = columns, 1 = rows, 2 = slices) shown left→right, top→bottom, and stepped through. */
  ax: [number, number, number]
  /** +1 / -1: whether each runs with or against the volume axis. */
  sg: [number, number, number]
  cols: number
  rows: number
  count: number
  rowCos: Vec3
  colCos: Vec3
  /** The way the image number grows (patient coordinates). */
  dir: Vec3
  colSpacing: number
  rowSpacing: number
  /** mm between images. */
  step: number
  tables: [AxisTable, AxisTable, AxisTable]
}

interface CpuVolume {
  seriesId: number
  /** Columns, rows, and planes along the slice normal (evenly spaced). */
  dims: Vec3
  /** mm between columns, rows and planes. */
  spacing: Vec3
  /** Patient position of the centre of voxel (0, 0, 0). */
  origin: Vec3
  /** Unit directions of the column, row and plane axes. */
  axes: [Vec3, Vec3, Vec3]
  /** Modality values (HU for CT) of the source slices, sorted along the normal. */
  data: Scalars
  /** Even plane m -> offset of the source slice at or before it, offset to the next one, weight. */
  z0: Int32Array
  zNext: Int32Array
  zW: Float32Array
  forUid: string
  modality: string
  wc: number
  ww: number
  sourceImageId: string
  template: Record<string, unknown>
  geometry: Map<Plane, PlaneGeometry>
  /** Image ids made from this volume (removed from the image cache when it is released). */
  made: Set<string>
}

const volumes = new Map<number, CpuVolume>()
const building = new Map<number, Promise<CpuVolume>>()
const listeners = new Map<number, Set<(done: number, total: number) => void>>()
/** Series still wanted (set by releaseCpuVolumes); a build that finishes for another one is dropped. */
let wanted: Set<number> | null = null

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const unit = (a: readonly number[]): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

// ------------------------------------------------------------------ building the volume

interface ImagePlane {
  rowCosines?: number[]
  columnCosines?: number[]
  imagePositionPatient?: number[]
  rowPixelSpacing?: number | null
  columnPixelSpacing?: number | null
  frameOfReferenceUID?: string
}

/** Pixel values in modality units: pre-scaled by the loader, or with the rescale applied here. */
function valuesOf(img: Types.IImage): { px: ArrayLike<number> & { constructor: unknown }; slope: number; intercept: number } {
  const px = img.getPixelData() as unknown as ArrayLike<number> & { constructor: unknown }
  if (img.preScale?.scaled) return { px, slope: 1, intercept: 0 }
  return { px, slope: Number(img.slope) || 1, intercept: Number(img.intercept) || 0 }
}

/** The value type for the whole series, from its first slice (widened later if a slice needs it). */
function typeFor(img: Types.IImage): ScalarsCtor {
  const { px, slope, intercept } = valuesOf(img)
  if (px instanceof Float32Array || px instanceof Float64Array) return Float32Array
  if (slope === 1 && intercept === 0) {
    if (px instanceof Int16Array || px instanceof Int8Array) return Int16Array
    if (px instanceof Uint16Array) return Uint16Array
    if (px instanceof Uint8Array || px instanceof Uint8ClampedArray) return Uint8Array
    return Float32Array
  }
  return Number.isInteger(slope) && Number.isInteger(intercept) ? Int16Array : Float32Array
}

const RANGE = new Map<unknown, [number, number]>([
  [Int16Array, [-32768, 32767]],
  [Uint16Array, [0, 65535]],
  [Uint8Array, [0, 255]]
])

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

async function buildVolume(images: SeriesImages): Promise<CpuVolume> {
  const { seriesId, imageIds, positions, normal } = images
  if (!normal || imageIds.length < 3 || positions.some((p) => p == null)) {
    throw new Error('This series cannot be shown in other planes (it needs at least 3 parallel slices).')
  }
  const emit = (done: number, total: number) => listeners.get(seriesId)?.forEach((fn) => fn(done, total))
  const order = imageIds.map((_, i) => i).sort((a, b) => (positions[a] as number) - (positions[b] as number))
  const pos = order.map((i) => positions[i] as number)
  const n = order.length
  const load = (s: number) =>
    imageLoader.loadImage(imageIds[order[s]], { priority: 0, requestType: Enums.RequestType.Prefetch })

  // The first slice decides the size, the value type and the geometry.
  const first = await load(0)
  const rows = first.rows
  const cols = first.columns
  const sliceLen = rows * cols
  const plane = (metaData.get('imagePlaneModule', imageIds[order[0]]) ?? {}) as ImagePlane
  let Ctor = typeFor(first)
  if (sliceLen * n * Ctor.BYTES_PER_ELEMENT > MAX_BYTES) {
    throw new Error(`This series is too large to reformat (${n} images of ${cols} × ${rows}).`)
  }
  let data: Scalars = new Ctor(sliceLen * n)
  const failed: number[] = []

  const put = (s: number, img: Types.IImage): void => {
    if (img.rows !== rows || img.columns !== cols) throw new Error('The images of this series have different sizes.')
    const { px, slope, intercept } = valuesOf(img)
    const off = s * sliceLen
    if (slope === 1 && intercept === 0 && px.constructor === data.constructor) {
      data.set(px as unknown as ArrayLike<number>, off)
      return
    }
    const range = RANGE.get(data.constructor)
    if (range) {
      // Whole numbers that fit stay as they are; anything else widens the series to floats.
      for (let p = 0; p < sliceLen; p++) {
        const v = px[p] * slope + intercept
        if (v < range[0] || v > range[1] || v !== Math.round(v)) {
          const wider = new Float32Array(data.length)
          wider.set(data)
          data = wider
          Ctor = Float32Array
          break
        }
      }
    }
    for (let p = 0; p < sliceLen; p++) data[off + p] = px[p] * slope + intercept
  }

  put(0, first)
  let done = 1
  emit(done, n)
  let next = 1
  let fatal = false
  const worker = async () => {
    while (next < n && !fatal) {
      const s = next++
      try {
        put(s, await load(s))
      } catch (e) {
        if ((e as Error)?.message?.includes('different sizes')) {
          fatal = true
          throw e
        }
        console.warn('[reformat] slice could not be loaded', imageIds[order[s]], e)
        failed.push(s)
      }
      emit(++done, n)
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, n - 1) }, worker))
  if (failed.length > n / 10) throw new Error(`${failed.length} images of this series could not be read.`)
  if (failed.length) {
    // A missing slice shows as background (the lowest value) rather than as a bright band.
    let min = Infinity
    for (let p = 0; p < sliceLen; p++) min = Math.min(min, data[p])
    for (const s of failed) data.fill(Number.isFinite(min) ? min : 0, s * sliceLen, (s + 1) * sliceLen)
  }

  // Even spacing along the normal. Irregular series (gaps, mixed spacing) are interpolated
  // between their two nearest slices; regular ones use every slice exactly as it is.
  const gaps = pos.slice(1).map((p, i) => p - pos[i])
  const typical = median(gaps)
  const span = pos[n - 1] - pos[0]
  const regular = gaps.every((g) => Math.abs(g - typical) <= 0.02 * typical + 1e-4)
  let planes = regular ? n : Math.min(4 * n, 4096, Math.round(span / typical) + 1)
  planes = Math.max(2, planes)
  const dz = span / (planes - 1)
  const z0 = new Int32Array(planes)
  const zNext = new Int32Array(planes)
  const zW = new Float32Array(planes)
  for (let m = 0, k = 0; m < planes; m++) {
    if (regular) {
      z0[m] = m * sliceLen
      continue
    }
    const z = pos[0] + m * dz
    while (k < n - 2 && pos[k + 1] <= z) k++
    let w = (z - pos[k]) / (pos[k + 1] - pos[k])
    let at = k
    if (w >= 0.999) {
      at = k + 1
      w = 0
    } else if (w <= 0.001) w = 0
    z0[m] = at * sliceLen
    zNext[m] = w > 0 ? sliceLen : 0
    zW[m] = w
  }

  const rowCos = unit(plane.rowCosines ?? [1, 0, 0])
  const colCos = unit(plane.columnCosines ?? [0, 1, 0])
  const ipp = plane.imagePositionPatient ?? [0, 0, 0]
  const nat = (metaData.get('naturalized', imageIds[order[n >> 1]]) ?? {}) as Record<string, unknown>
  const template: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(nat)) if (!SKIP_ATTRIBUTES.has(k)) template[k] = v
  const series = (metaData.get('generalSeriesModule', imageIds[order[0]]) ?? {}) as { modality?: string }
  let wc = Number(Array.isArray(first.windowCenter) ? first.windowCenter[0] : first.windowCenter)
  let ww = Number(Array.isArray(first.windowWidth) ? first.windowWidth[0] : first.windowWidth)
  if (!Number.isFinite(wc) || !(ww > 0)) {
    // No window in the files (common for MR): the value range of the middle slice.
    let lo = Infinity
    let hi = -Infinity
    for (let p = (n >> 1) * sliceLen, end = p + sliceLen; p < end; p++) {
      const x = data[p]
      if (x < lo) lo = x
      if (x > hi) hi = x
    }
    wc = Number.isFinite(lo) ? (lo + hi) / 2 : 40
    ww = Number.isFinite(lo) && hi > lo ? hi - lo : 400
  }

  return {
    seriesId,
    dims: [cols, rows, planes],
    spacing: [Number(plane.columnPixelSpacing) || 1, Number(plane.rowPixelSpacing) || 1, dz],
    origin: [Number(ipp[0]) || 0, Number(ipp[1]) || 0, Number(ipp[2]) || 0],
    axes: [rowCos, colCos, unit(normal)],
    data,
    z0,
    zNext,
    zW,
    forUid: plane.frameOfReferenceUID || images.frameOfReferenceUid,
    modality: series.modality || String(nat.Modality ?? ''),
    wc,
    ww,
    sourceImageId: imageIds[order[n >> 1]],
    template,
    geometry: new Map(),
    made: new Set()
  }
}

/**
 * Loads (once) the series into memory for reformatting. Concurrent callers share one build;
 * `onProgress` reports the images read so far. Resolves to false when the series was let go
 * while it loaded (no tile shows it any more, see releaseCpuVolumes).
 */
export async function ensureCpuVolume(images: SeriesImages, onProgress?: (done: number, total: number) => void): Promise<boolean> {
  const id = images.seriesId
  if (volumes.has(id)) return true
  if (onProgress) {
    if (!listeners.has(id)) listeners.set(id, new Set())
    listeners.get(id)!.add(onProgress)
  }
  try {
    let job = building.get(id)
    if (!job) {
      job = buildVolume(images).finally(() => {
        building.delete(id)
        listeners.delete(id)
      })
      building.set(id, job)
    }
    const v = await job
    // Keep it unless every tile that wanted it has moved on while it loaded (it is big).
    if (wanted && !wanted.has(id)) return volumes.has(id)
    if (!volumes.has(id)) volumes.set(id, v)
    return true
  } finally {
    if (onProgress) listeners.get(id)?.delete(onProgress)
  }
}

export const hasCpuVolume = (seriesId: number): boolean => volumes.has(seriesId)

/** Frees the series no tile shows as a reformat any more (their images leave the image cache too). */
export function releaseCpuVolumes(keep: Set<number>): void {
  wanted = new Set(keep)
  for (const [id, v] of [...volumes]) {
    if (keep.has(id) || building.has(id)) continue
    volumes.delete(id)
    for (const imageId of v.made) {
      try {
        if (cache.getImageLoadObject(imageId)) cache.removeImageLoadObject(imageId)
      } catch {
        /* already gone */
      }
    }
  }
}

// ------------------------------------------------------------------ planes

function axisTable(v: CpuVolume, axis: number, len: number, sign: number): AxisTable {
  const off = new Int32Array(len)
  const next = new Int32Array(len)
  const w = new Float32Array(len)
  for (let t = 0; t < len; t++) {
    const i = sign > 0 ? t : len - 1 - t
    if (axis === 0) off[t] = i
    else if (axis === 1) off[t] = i * v.dims[0]
    else {
      off[t] = v.z0[i]
      next[t] = v.zNext[i]
      w[t] = v.zW[i]
    }
  }
  return { off, next, w }
}

function geometryOf(v: CpuVolume, plane: Plane): PlaneGeometry {
  const known = v.geometry.get(plane)
  if (known) return known
  const want = VIEW[plane]
  const along = (a: number, d: Vec3) => Math.abs(dot(v.axes[a], d))
  // The volume axis closest to the view's normal is stepped through; of the other two, the one
  // closest to the screen's right runs left→right.
  const axN = [0, 1, 2].sort((a, b) => along(b, want.normal) - along(a, want.normal))[0]
  const rest = [0, 1, 2].filter((a) => a !== axN)
  const axR = along(rest[0], want.right) >= along(rest[1], want.right) ? rest[0] : rest[1]
  const axD = rest[0] === axR ? rest[1] : rest[0]
  const sign = (a: number, d: Vec3) => (dot(v.axes[a], d) < 0 ? -1 : 1)
  const sR = sign(axR, want.right)
  const sD = sign(axD, want.down)
  const sN = sign(axN, want.normal)
  const g: PlaneGeometry = {
    ax: [axR, axD, axN],
    sg: [sR, sD, sN],
    cols: v.dims[axR],
    rows: v.dims[axD],
    count: v.dims[axN],
    rowCos: scale(v.axes[axR], sR),
    colCos: scale(v.axes[axD], sD),
    dir: scale(v.axes[axN], sN),
    colSpacing: v.spacing[axR],
    rowSpacing: v.spacing[axD],
    step: v.spacing[axN],
    tables: [axisTable(v, axR, v.dims[axR], sR), axisTable(v, axD, v.dims[axD], sD), axisTable(v, axN, v.dims[axN], sN)]
  }
  v.geometry.set(plane, g)
  return g
}

/** Patient position of the centre of a voxel (column, row, even plane). */
function worldOf(v: CpuVolume, idx: Vec3): Vec3 {
  const out: Vec3 = [...v.origin]
  for (let a = 0; a < 3; a++) {
    const d = idx[a] * v.spacing[a]
    out[0] += d * v.axes[a][0]
    out[1] += d * v.axes[a][1]
    out[2] += d * v.axes[a][2]
  }
  return out
}

/** Volume index along each axis of the top-left pixel of image `n` of a plane. */
function cornerIndex(g: PlaneGeometry, n: number): Vec3 {
  const idx: Vec3 = [0, 0, 0]
  idx[g.ax[0]] = g.sg[0] > 0 ? 0 : g.cols - 1
  idx[g.ax[1]] = g.sg[1] > 0 ? 0 : g.rows - 1
  idx[g.ax[2]] = g.sg[2] > 0 ? n : g.count - 1 - n
  return idx
}

/** Images a slab of `slabMm` covers: [before, after] the centre image. */
function slabSpan(g: PlaneGeometry, slabMm: number): [number, number] {
  const k = slabMm > 0 ? Math.max(1, Math.round(slabMm / g.step)) : 1
  const before = (k - 1) >> 1
  return [before, k - 1 - before]
}

/** Pixels of image `n` of a plane; with a slab, the brightest (MIP) or darkest (MinIP) value through it. */
function pixelsOf(v: CpuVolume, g: PlaneGeometry, n: number, slabMm: number, mode: ProjectionMode = 'mip'): { px: Scalars; min: number; max: number } {
  const [R, D, N] = g.tables
  const { cols, rows } = g
  const [before, after] = slabSpan(g, slabMm)
  const t0 = Math.max(0, n - before)
  const t1 = Math.min(g.count - 1, n + after)
  const data = v.data
  const Out = data.constructor as ScalarsCtor
  const out = new Out(rows * cols)
  const whole = !(out instanceof Float32Array)
  const darkest = mode === 'minip'
  let min = Infinity
  let max = -Infinity
  // Straight copy of an original slice (axial view of an axial series, regular spacing).
  if (t0 === t1 && g.ax[0] === 0 && g.sg[0] > 0 && g.ax[1] === 1 && g.sg[1] > 0 && N.w[t0] === 0) {
    out.set(data.subarray(N.off[t0], N.off[t0] + rows * cols) as never)
    for (let p = 0; p < out.length; p++) {
      const x = out[p]
      if (x < min) min = x
      if (x > max) max = x
    }
    return { px: out, min, max }
  }
  for (let r = 0; r < rows; r++) {
    const dOff = D.off[r]
    const dNext = D.next[r]
    const dW = D.w[r]
    const line = r * cols
    for (let c = 0; c < cols; c++) {
      const base = R.off[c] + dOff
      const rNext = R.next[c] + dNext
      const rW = R.w[c] + dW
      let best = darkest ? Infinity : -Infinity
      for (let t = t0; t <= t1; t++) {
        const o = base + N.off[t]
        // Only the slice axis has a second slice and a weight; the others add zero.
        const w = rW + N.w[t]
        const x = w === 0 ? data[o] : data[o] + (data[o + rNext + N.next[t]] - data[o]) * w
        if (darkest ? x < best : x > best) best = x
      }
      const x = whole ? Math.round(best) : best
      out[line + c] = x
      if (x < min) min = x
      if (x > max) max = x
    }
  }
  return { px: out, min, max }
}

interface Ref {
  seriesId: number
  plane: Plane
  /** Slab thickness in tenths of a mm (0 = single image). */
  slab: number
  mode: ProjectionMode
  n: number
}

// pacsmpr:<series>/<plane>/<slab>/<image>; slab = 0 (single image), mip<tenths> or minip<tenths>
// (a bare number is a MIP, as written before MinIP existed).
const ID_RE = new RegExp(`^${REFORMAT_SCHEME}:(\\d+)/(axial|coronal|sagittal)/(mip|minip)?(\\d+)/(\\d+)$`)

function parseId(imageId: string): Ref | null {
  const m = ID_RE.exec(imageId)
  return m
    ? { seriesId: Number(m[1]), plane: m[2] as Plane, mode: (m[3] as ProjectionMode | undefined) ?? 'mip', slab: Number(m[4]), n: Number(m[5]) }
    : null
}

export const isReformatImageId = (imageId: string | undefined): boolean => !!imageId && imageId.startsWith(`${REFORMAT_SCHEME}:`)

/** The series a reformatted image was computed from (measurements on it belong to that study). */
export const reformatSeriesOf = (imageId: string): number | null => parseId(imageId)?.seriesId ?? null

export interface PlaneStack {
  imageIds: string[]
  /** The way the image number grows (patient coordinates), for the scroll bar. */
  dir: Vec3
  /** mm between images. */
  step: number
}

/** The images of one plane of a loaded series (computed only when shown); thin, or a MIP / MinIP slab. */
export function cpuPlaneStack(seriesId: number, plane: Plane, projection: Projection | null = null): PlaneStack {
  const v = volumes.get(seriesId)
  if (!v) throw new Error('The series is not loaded for reformatting')
  const g = geometryOf(v, plane)
  const tenths = projection ? Math.max(0, Math.round(projection.mm * 10)) : 0
  const slab = tenths > 0 && projection ? `${projection.mode}${tenths}` : '0'
  return {
    imageIds: Array.from({ length: g.count }, (_, n) => `${REFORMAT_SCHEME}:${seriesId}/${plane}/${slab}/${n}`),
    dir: g.dir,
    step: g.step
  }
}

/** The image of a plane nearest to a patient position (for the crosshair). */
export function cpuPlaneIndexAt(seriesId: number, plane: Plane, world: readonly number[]): number {
  const v = volumes.get(seriesId)
  if (!v) return 0
  const g = geometryOf(v, plane)
  const axis = g.ax[2]
  const rel: Vec3 = [world[0] - v.origin[0], world[1] - v.origin[1], world[2] - v.origin[2]]
  const i = Math.round(dot(rel, v.axes[axis]) / v.spacing[axis])
  const n = g.sg[2] > 0 ? i : g.count - 1 - i
  return Math.min(g.count - 1, Math.max(0, n))
}

/** A point on image `n` of a plane, and the plane's unit normal (the way the image number grows). */
export function cpuPlanePoint(seriesId: number, plane: Plane, n: number): { point: Vec3; normal: Vec3 } | null {
  const v = volumes.get(seriesId)
  if (!v) return null
  const g = geometryOf(v, plane)
  return { point: worldOf(v, cornerIndex(g, Math.min(g.count - 1, Math.max(0, n)))), normal: g.dir }
}

/** Patient position of the centre of the series (where the crosshair starts). */
export function cpuVolumeCenter(seriesId: number): Vec3 | null {
  const v = volumes.get(seriesId)
  return v ? worldOf(v, [(v.dims[0] - 1) / 2, (v.dims[1] - 1) / 2, (v.dims[2] - 1) / 2]) : null
}

/** The series held in memory, for analysis (liver volumetry): geometry and modality values. */
export interface CpuVolumeData {
  /** Columns, rows, evenly spaced planes. */
  dims: Vec3
  spacing: Vec3
  origin: Vec3
  axes: [Vec3, Vec3, Vec3]
  modality: string
  /** Source slices (columns fastest); even plane m reads slice offset z0[m], blended with the
   *  slice at z0[m] + zNext[m] by weight zW[m]. */
  data: ArrayLike<number>
  z0: Int32Array
  zNext: Int32Array
  zW: Float32Array
}

export function cpuVolumeData(seriesId: number): CpuVolumeData | null {
  const v = volumes.get(seriesId)
  if (!v) return null
  return {
    dims: [...v.dims],
    spacing: [...v.spacing],
    origin: [...v.origin],
    axes: [v.axes[0], v.axes[1], v.axes[2]],
    modality: v.modality,
    data: v.data,
    z0: v.z0,
    zNext: v.zNext,
    zW: v.zW
  }
}

// ------------------------------------------------------------------ Cornerstone image loader + metadata

function loadReformatImage(imageId: string): { promise: Promise<Types.IImage> } {
  return {
    promise: (async () => {
      const ref = parseId(imageId)
      const v = ref ? volumes.get(ref.seriesId) : undefined
      if (!ref || !v) throw new Error(`Reformatted image ${imageId} is not available`)
      const g = geometryOf(v, ref.plane)
      if (ref.n >= g.count) throw new Error(`Reformatted image ${imageId} is out of range`)
      const { px, min, max } = pixelsOf(v, g, ref.n, ref.slab / 10, ref.mode)
      const voxelManager = csUtils.VoxelManager.createImageVoxelManager({ width: g.cols, height: g.rows, numberOfComponents: 1, scalarData: px })
      v.made.add(imageId)
      const image = {
        imageId,
        rows: g.rows,
        columns: g.cols,
        height: g.rows,
        width: g.cols,
        color: false,
        rgba: false,
        numberOfComponents: 1,
        dataType: px.constructor.name,
        minPixelValue: Number.isFinite(min) ? min : 0,
        maxPixelValue: Number.isFinite(max) ? max : 0,
        slope: 1,
        intercept: 0,
        windowCenter: v.wc,
        windowWidth: v.ww,
        invert: false,
        columnPixelSpacing: g.colSpacing,
        rowPixelSpacing: g.rowSpacing,
        FrameOfReferenceUID: v.forUid,
        sizeInBytes: px.byteLength,
        preScale: { enabled: true, scaled: true, scalingParameters: { modality: v.modality, rescaleSlope: 1, rescaleIntercept: 0 } },
        getCanvas: undefined,
        getPixelData: () => voxelManager.getScalarData(),
        voxelManager
      }
      return image as unknown as Types.IImage
    })()
  }
}

function geometryFor(imageId: string): { v: CpuVolume; g: PlaneGeometry; ref: Ref } | null {
  const ref = parseId(imageId)
  const v = ref ? volumes.get(ref.seriesId) : undefined
  return ref && v ? { v, g: geometryOf(v, ref.plane), ref } : null
}

function reformatMetadata(type: string, imageId: unknown): unknown {
  if (typeof imageId !== 'string' || !imageId.startsWith(`${REFORMAT_SCHEME}:`)) return undefined
  const found = geometryFor(imageId)
  if (!found) return undefined
  const { v, g, ref } = found
  const ipp = worldOf(v, cornerIndex(g, ref.n))
  const thickness = ref.slab > 0 ? ref.slab / 10 : g.step
  const bits = v.data instanceof Float32Array ? 32 : v.data instanceof Uint8Array ? 8 : 16
  switch (type) {
    case 'imagePlaneModule':
      return {
        frameOfReferenceUID: v.forUid,
        rows: g.rows,
        columns: g.cols,
        imageOrientationPatient: [...g.rowCos, ...g.colCos],
        rowCosines: g.rowCos,
        columnCosines: g.colCos,
        imagePositionPatient: ipp,
        pixelSpacing: [g.rowSpacing, g.colSpacing],
        rowPixelSpacing: g.rowSpacing,
        columnPixelSpacing: g.colSpacing,
        sliceThickness: thickness,
        spacingBetweenSlices: g.step
      }
    case 'imagePixelModule':
      return {
        samplesPerPixel: 1,
        photometricInterpretation: 'MONOCHROME2',
        rows: g.rows,
        columns: g.cols,
        bitsAllocated: bits,
        bitsStored: bits,
        highBit: bits - 1,
        pixelRepresentation: v.data instanceof Int16Array || v.data instanceof Float32Array ? 1 : 0
      }
    case 'generalSeriesModule': {
      const s = (metaData.get('generalSeriesModule', v.sourceImageId) ?? {}) as Record<string, unknown>
      return { ...s, modality: v.modality }
    }
    case 'modalityLutModule':
      return { rescaleSlope: 1, rescaleIntercept: 0 }
    case 'voiLutModule':
      return { windowCenter: [v.wc], windowWidth: [v.ww] }
    case 'generalImageModule':
      return { instanceNumber: ref.n + 1 }
    case 'patientModule':
    case 'generalStudyModule':
    case 'patientStudyModule':
    case 'generalEquipmentModule':
      return metaData.get(type, v.sourceImageId)
    case 'naturalized':
      return {
        ...v.template,
        Rows: g.rows,
        Columns: g.cols,
        PixelSpacing: [g.rowSpacing, g.colSpacing],
        ImageOrientationPatient: [...g.rowCos, ...g.colCos],
        ImagePositionPatient: ipp,
        SliceThickness: thickness,
        SpacingBetweenSlices: g.step,
        InstanceNumber: ref.n + 1,
        RescaleSlope: 1,
        RescaleIntercept: 0
      }
    default:
      return undefined
  }
}

let registered = false

/** Registers the image loader and metadata of reformatted images (once). */
export function initReformat(): void {
  if (registered) return
  registered = true
  imageLoader.registerImageLoader(REFORMAT_SCHEME, loadReformatImage as unknown as Types.ImageLoaderFn)
  metaData.addProvider(reformatMetadata as never, 10_000)
}
