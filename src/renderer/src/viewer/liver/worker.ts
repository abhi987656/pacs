/// <reference lib="webworker" />
/**
 * Liver analysis worker: keeps the analysis grid's HU (raw and denoised) and runs the
 * segmentation, lesion, vessel, segment, measurement and surface jobs off the UI thread.
 */
import {
  classifyVessels,
  fillLiver,
  flood,
  median3,
  refineLiver,
  segmentLesion,
  segmentLiver,
  segmentVessels,
  type TissueModel,
  type Vol
} from './algo'
import { segmentsOf, type GridGeom, type Landmarks, type SegLevel } from './couinaud'
import { surfaceOf } from './mesh'

let vol: Vol | null = null
let g: Int16Array | null = null
let grid: GridGeom | null = null

type Msg = { id: number; op: string; args: Record<string, unknown> }

const need = (): { v: Vol; g: Int16Array; grid: GridGeom } => {
  if (!vol || !g || !grid) throw new Error('The liver analysis is not ready')
  return { v: vol, g, grid }
}

function run(op: string, a: Record<string, unknown>): { result: unknown; transfer: Transferable[] } {
  switch (op) {
    case 'init': {
      grid = a.grid as GridGeom
      vol = { dims: grid.dims, sp: grid.sp, data: a.hu as Int16Array }
      g = median3(vol.data, vol.dims)
      return { result: true, transfer: [] }
    }
    case 'liver': {
      const { v, g } = need()
      const r = segmentLiver(v, g, a.seeds as number[])
      return { result: r, transfer: [r.mask.buffer] }
    }
    case 'addLiver': {
      // Another part (a click where the liver is missing): its own HU band, joined to the liver.
      const { v, g } = need()
      const cur = a.current as Uint8Array
      const r = segmentLiver(v, g, [a.seed as number])
      for (let i = 0; i < cur.length; i++) if (cur[i]) r.mask[i] = 1
      const model = a.model as TissueModel
      fillLiver(r.mask, g, v.dims, v.sp, { ...model, lo: Math.min(model.lo, r.model.lo), hi: Math.max(model.hi, r.model.hi) })
      return { result: { mask: r.mask, model: r.model }, transfer: [r.mask.buffer] }
    }
    case 'refine': {
      const { v, g } = need()
      const mask = refineLiver(v, g, a.current as Uint8Array, a.model as TissueModel, a.liverSeeds as number[], a.otherSeeds as number[])
      return { result: { mask }, transfer: [mask.buffer] }
    }
    case 'keepConnected': {
      // After brush edits: only what is joined to the liver clicks.
      const { v } = need()
      const cur = a.current as Uint8Array
      const seeds = (a.seeds as number[]).filter((s) => cur[s])
      const mask = seeds.length ? flood(cur, v.dims, seeds) : cur
      return { result: { mask }, transfer: [mask.buffer] }
    }
    case 'lesion': {
      const { v, g } = need()
      const r = segmentLesion(v, g, (a.model as TissueModel) ?? null, a.center as number, a.radiusMm as number)
      return { result: r, transfer: r ? [r.mask.buffer] : [] }
    }
    case 'vessels': {
      const { v, g } = need()
      const model = { ...(a.model as TissueModel) }
      const r = segmentVessels(v, g, a.liver as Uint8Array, model, a.exclude as Uint8Array | undefined, a.threshold as number | undefined)
      return { result: r, transfer: r ? [r.mask.buffer] : [] }
    }
    case 'classify': {
      const { v } = need()
      const labels = classifyVessels(a.vessels as Uint8Array, v.dims, v.sp, a.portal as number[], a.hepatic as number[])
      return { result: { labels }, transfer: [labels.buffer] }
    }
    case 'segments': {
      const { grid } = need()
      const r = segmentsOf(a.liver as Uint8Array, grid, a.landmarks as Landmarks, a.level as SegLevel)
      return { result: r, transfer: r.labels ? [r.labels.buffer] : [] }
    }
    case 'measure': {
      // Voxels, mean and SD of HU per label value of each map.
      const { v } = need()
      const maps = a.maps as Record<string, Uint8Array | null>
      const out: Record<string, Record<number, { n: number; mean: number; sd: number }>> = {}
      const data = v.data
      for (const [name, m] of Object.entries(maps)) {
        if (!m) continue
        const n = new Float64Array(256)
        const s = new Float64Array(256)
        const s2 = new Float64Array(256)
        for (let i = 0; i < m.length; i++) {
          const l = m[i]
          if (!l) continue
          const x = data[i]
          n[l]++
          s[l] += x
          s2[l] += x * x
        }
        const res: Record<number, { n: number; mean: number; sd: number }> = {}
        for (let l = 1; l < 256; l++) {
          if (!n[l]) continue
          const mean = s[l] / n[l]
          res[l] = { n: n[l], mean, sd: Math.sqrt(Math.max(0, s2[l] / n[l] - mean * mean)) }
        }
        out[name] = res
      }
      return { result: out, transfer: [] }
    }
    case 'surfaces': {
      // Several surfaces of one label volume: one per group of label values.
      const { grid } = need()
      const labels = a.labels as Uint8Array
      const out = (a.groups as number[][]).map((vals) => {
        const set = new Set(vals)
        return surfaceOf(labels, grid, (x) => set.has(x), a.step as number)
      })
      const transfer: Transferable[] = []
      for (const s of out) if (s) transfer.push(s.points.buffer, s.normals.buffer, s.polys.buffer)
      return { result: out, transfer }
    }
    case 'surface': {
      const { grid } = need()
      const labels = a.labels as Uint8Array
      const values = new Set(a.values as number[])
      const s = surfaceOf(labels, grid, (x) => values.has(x), a.step as number)
      return { result: s, transfer: s ? [s.points.buffer, s.normals.buffer, s.polys.buffer] : [] }
    }
  }
  throw new Error(`Unknown liver job ${op}`)
}

self.onmessage = (e: MessageEvent<Msg>) => {
  const { id, op, args } = e.data
  try {
    const { result, transfer } = run(op, args)
    ;(self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, result }, transfer)
  } catch (err) {
    ;(self as unknown as DedicatedWorkerGlobalScope).postMessage({ id, error: (err as Error)?.message ?? String(err) })
  }
}
