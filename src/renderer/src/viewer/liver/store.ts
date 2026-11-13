/**
 * State and actions of the liver analysis (one series at a time): the masks on the analysis
 * grid, the landmarks, findings and resection plan, and the measurements. Tiles and panels
 * subscribe; heavy work goes to the liver worker.
 */
import { dilate, paintBall, type TissueModel } from './algo'
import { LANDMARKS, LEVELS, SEGMENTS, type GridGeom, type LandmarkId, type Landmarks, type SegLevel, type Vec3 } from './couinaud'
import { buildGrid, voxelAt, worldAt } from './grid'
import type { CpuVolumeData } from '../reformat'

export type LiverStep = 'liver' | 'findings' | 'vessels' | 'segments' | 'resection'
export type LiverTool =
  | 'seed'
  | 'exclude'
  | 'paint'
  | 'erase'
  | 'lesion'
  | 'finding-paint'
  | 'finding-erase'
  | 'landmark'
  | 'cut'
  | 'resect-paint'
  | 'resect-erase'
  | null

export interface Finding {
  id: number
  name: string
  color: [number, number, number]
}

/** A virtual cut: removes the liver on the side the normal points to. */
export interface Cut {
  point: Vec3
  normal: Vec3
}

export interface PendingCut {
  a: Vec3
  b: Vec3
  /** Normal of the view the line was drawn on (the cut plane contains it). */
  view: Vec3
}

export interface Measure {
  n: number
  mean: number
  sd: number
}

export interface Stats {
  /** mL per voxel. */
  ml: number
  liver: Measure
  /** Liver minus vessels and findings (voxels). */
  functional: number
  findings: Record<number, Measure & { segments: number[] }>
  vessels: Record<number, Measure>
  segments: Record<number, Measure & { functional: number }>
  resection: null | {
    n: number
    functional: number
    bySegment: Record<number, number>
    atypical: number
    findings: Record<number, { resected: number; total: number }>
  }
}

export const LIVER_COLOR: [number, number, number] = [222, 140, 70]
export const VESSEL_COLORS: Record<number, [number, number, number]> = { 1: [60, 220, 230], 2: [150, 90, 230], 3: [60, 220, 230] }
export const VESSEL_NAMES: Record<number, string> = { 1: 'Vessels', 2: 'Portal veins', 3: 'Hepatic veins' }
const FINDING_COLORS: [number, number, number][] = [
  [230, 40, 40],
  [60, 200, 60],
  [250, 220, 40],
  [240, 120, 20],
  [200, 60, 220],
  [40, 140, 250]
]

export interface LiverState {
  active: boolean
  seriesId: number | null
  studyId: number | null
  seriesUid: string
  grid: GridGeom | null
  busy: string | null
  /** Last notice for the panel (e.g. why a finding could not be found). */
  message: string | null
  step: LiverStep
  tool: LiverTool
  brushMm: number
  opacity: number
  show: { liver: boolean; findings: boolean; vessels: boolean; segments: boolean; resection: boolean }
  liver: Uint8Array | null
  model: TissueModel | null
  seeds: number[]
  excludes: number[]
  findings: Uint8Array | null
  findingList: Finding[]
  activeFinding: number | null
  vessels: Uint8Array | null
  vesselThreshold: number | null
  level: SegLevel
  landmarks: Landmarks
  activeLandmark: LandmarkId | null
  segments: Uint8Array | null
  missing: LandmarkId[]
  resectSegments: number[]
  cuts: Cut[]
  pendingCut: PendingCut | null
  resectBrush: Uint8Array | null
  marginMm: number
  resected: Uint8Array | null
  stats: Stats | null
  saved: boolean
  /** Bumped on every change (tiles redraw). */
  version: number
  /** Bumped when the masks change (the 3-D view rebuilds its surfaces). */
  dataVersion: number
}

const initial = (): LiverState => ({
  active: false,
  seriesId: null,
  studyId: null,
  seriesUid: '',
  grid: null,
  busy: null,
  message: null,
  step: 'liver',
  tool: 'seed',
  brushMm: 8,
  opacity: 0.45,
  show: { liver: true, findings: true, vessels: true, segments: true, resection: true },
  liver: null,
  model: null,
  seeds: [],
  excludes: [],
  findings: null,
  findingList: [],
  activeFinding: null,
  vessels: null,
  vesselThreshold: null,
  level: 'couinaud',
  landmarks: {},
  activeLandmark: null,
  segments: null,
  missing: [],
  resectSegments: [],
  cuts: [],
  pendingCut: null,
  resectBrush: null,
  marginMm: 10,
  resected: null,
  stats: null,
  saved: true,
  version: 0,
  dataVersion: 0
})

// ------------------------------------------------------------------ worker

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

export function call<T>(op: string, args: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id)
      if (!p) return
      pending.delete(e.data.id)
      if (e.data.error) p.reject(new Error(e.data.error))
      else p.resolve(e.data.result)
    }
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'Liver worker failed'))
      pending.clear()
    }
  }
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    worker!.postMessage({ id, op, args }, transfer)
  })
}

// ------------------------------------------------------------------ store

class LiverStore {
  state: LiverState = initial()
  /** HU of the analysis grid (a copy also lives in the worker). */
  hu: Int16Array | null = null
  private listeners = new Set<() => void>()
  private undoStack: { liver: Uint8Array | null; findings: Uint8Array | null; findingList: Finding[]; vessels: Uint8Array | null; resectBrush: Uint8Array | null; seeds: number[] }[] = []

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(patch: Partial<LiverState>, dirty = true): void {
    this.state = {
      ...this.state,
      ...patch,
      version: this.state.version + 1,
      dataVersion: this.state.dataVersion + (dirty ? 1 : 0),
      saved: dirty ? false : patch.saved ?? this.state.saved
    }
    for (const fn of this.listeners) fn()
  }

  /** UI-only changes (tool, step, display): no "unsaved" mark. */
  ui(patch: Partial<LiverState>): void {
    this.set(patch, false)
  }

  /** Runs a job with a busy note; a failure becomes the panel's message (result null). */
  private async busy<T>(text: string, job: () => Promise<T>): Promise<T | null> {
    this.set({ busy: text, message: null }, false)
    try {
      return await job()
    } catch (e) {
      console.error(e)
      this.set({ message: (e as Error).message || String(e) }, false)
      return null
    } finally {
      if (this.state.busy === text) this.set({ busy: null }, false)
    }
  }

  // ---------------------------------------------------------------- open / close

  async open(seriesId: number, studyId: number, seriesUid: string, cv: CpuVolumeData): Promise<void> {
    this.state = { ...initial(), active: true, seriesId, studyId, seriesUid, busy: 'Preparing the liver analysis…', version: this.state.version + 1 }
    this.undoStack = []
    for (const fn of this.listeners) fn()
    const { grid, hu } = await buildGrid(cv, (f) => this.set({ busy: `Preparing the liver analysis… ${Math.round(f * 100)}%` }, false))
    if (this.state.seriesId !== seriesId || !this.state.active) return
    this.hu = hu
    await call('init', { grid, hu: hu.slice() })
    this.set({ grid, busy: null }, false)
  }

  close(): void {
    this.state = { ...initial(), version: this.state.version + 1 }
    this.hu = null
    this.undoStack = []
    for (const fn of this.listeners) fn()
  }

  // ---------------------------------------------------------------- helpers

  voxel(p: readonly number[]): number {
    return this.state.grid ? voxelAt(this.state.grid, p) : -1
  }

  private snapshot(): void {
    const s = this.state
    this.undoStack.push({
      liver: s.liver?.slice() ?? null,
      findings: s.findings?.slice() ?? null,
      findingList: s.findingList.map((f) => ({ ...f })),
      vessels: s.vessels?.slice() ?? null,
      resectBrush: s.resectBrush?.slice() ?? null,
      seeds: [...s.seeds]
    })
    if (this.undoStack.length > 6) this.undoStack.shift()
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  undo(): void {
    const u = this.undoStack.pop()
    if (!u) return
    this.set({ liver: u.liver, findings: u.findings, findingList: u.findingList, vessels: u.vessels, resectBrush: u.resectBrush, seeds: u.seeds })
    void this.afterLiverChange()
  }

  // ---------------------------------------------------------------- liver

  async clickLiver(p: Vec3): Promise<void> {
    const s = this.state
    const seed = this.voxel(p)
    if (seed < 0 || !s.grid) return
    this.snapshot()
    await this.busy('Segmenting the liver…', async () => {
      if (!s.liver || !s.model) {
        const r = await call<{ mask: Uint8Array; model: TissueModel }>('liver', { seeds: [seed] })
        this.set({ liver: r.mask, model: r.model, seeds: [seed], excludes: [] })
      } else {
        const r = await call<{ mask: Uint8Array; model: TissueModel }>('addLiver', { current: s.liver, seed, model: s.model })
        const m = s.model
        this.set({ liver: r.mask, seeds: [...s.seeds, seed], model: { ...m, lo: Math.min(m.lo, r.model.lo), hi: Math.max(m.hi, r.model.hi) } })
      }
    })
    await this.afterLiverChange()
  }

  /** A click on something that is not liver: the liver clicks and the "not liver" clicks compete. */
  async excludeAt(p: Vec3): Promise<void> {
    const s = this.state
    const seed = this.voxel(p)
    if (seed < 0 || !s.liver || !s.model) return
    this.snapshot()
    const excludes = [...s.excludes, seed]
    await this.busy('Separating…', async () => {
      const r = await call<{ mask: Uint8Array }>('refine', { current: s.liver, model: s.model, liverSeeds: s.seeds, otherSeeds: excludes })
      this.set({ liver: r.mask, excludes })
    })
    await this.afterLiverChange()
  }

  clearLiver(): void {
    this.snapshot()
    this.set({ liver: null, model: null, seeds: [], excludes: [], segments: null, vessels: null, resected: null, stats: null })
  }

  // ---------------------------------------------------------------- brush

  private brushTarget(): { mask: Uint8Array; value: number; limit?: Uint8Array; key: 'liver' | 'findings' | 'resectBrush' } | null {
    const s = this.state
    const g = s.grid
    if (!g) return null
    const N = g.dims[0] * g.dims[1] * g.dims[2]
    switch (s.tool) {
      case 'paint':
        return { mask: s.liver ?? new Uint8Array(N), value: 1, key: 'liver' }
      case 'erase':
        return s.liver ? { mask: s.liver, value: 0, key: 'liver' } : null
      case 'finding-paint':
        return s.activeFinding != null ? { mask: s.findings ?? new Uint8Array(N), value: s.activeFinding, key: 'findings' } : null
      case 'finding-erase':
        return s.findings && s.activeFinding != null ? { mask: s.findings, value: 0, limit: undefined, key: 'findings' } : null
      case 'resect-paint':
        return { mask: s.resectBrush ?? new Uint8Array(N), value: 1, limit: s.liver ?? undefined, key: 'resectBrush' }
      case 'resect-erase':
        return { mask: s.resectBrush ?? new Uint8Array(N), value: 2, limit: s.liver ?? undefined, key: 'resectBrush' }
    }
    return null
  }

  /** One dab of the 3-D brush at a patient position (phase 'start' saves an undo step). */
  paint(p: Vec3, phase: 'start' | 'move' | 'end'): void {
    const s = this.state
    if (phase === 'end') {
      if (s.tool === 'paint' || s.tool === 'erase' || s.tool === 'finding-paint' || s.tool === 'finding-erase') void this.afterLiverChange()
      else this.recomputeResection()
      return
    }
    const t = this.brushTarget()
    const c = this.voxel(p)
    if (!t || c < 0 || !s.grid) return
    if (phase === 'start') this.snapshot()
    const before = t.mask
    if (s.tool === 'finding-erase') {
      // only the selected finding
      const tmp = new Uint8Array(before.length)
      paintBall(tmp, s.grid.dims, s.grid.sp, c, s.brushMm, 1)
      for (let i = 0; i < tmp.length; i++) if (tmp[i] && before[i] === s.activeFinding) before[i] = 0
    } else paintBall(before, s.grid.dims, s.grid.sp, c, s.brushMm, t.value, t.limit)
    const patch: Partial<LiverState> = { [t.key]: before }
    // A painted finding is liver too.
    if (t.key === 'findings' && t.value && s.liver) paintBall(s.liver, s.grid.dims, s.grid.sp, c, s.brushMm, 1, before)
    if (t.key === 'liver' && !s.model) patch.model = { mean: 100, sd: 15, lo: 55, hi: 145 }
    this.set(patch)
  }

  // ---------------------------------------------------------------- findings

  async lesionAt(p: Vec3, radiusMm: number): Promise<void> {
    const s = this.state
    const c = this.voxel(p)
    if (c < 0 || !s.grid) return
    this.snapshot()
    const r = await this.busy('Segmenting the finding…', () =>
      call<{ mask: Uint8Array; mean: number; sd: number } | null>('lesion', { center: c, radiusMm, model: s.model })
    )
    if (!r) {
      if (!this.state.message) this.set({ message: 'This finding has about the same density as the liver here: draw it with the finding brush instead.' }, false)
      return
    }
    const N = r.mask.length
    const findings = s.findings ?? new Uint8Array(N)
    const id = (s.findingList.reduce((m, f) => Math.max(m, f.id), 0) % 250) + 1
    for (let i = 0; i < N; i++) if (r.mask[i]) findings[i] = id
    const liver = s.liver ?? new Uint8Array(N)
    for (let i = 0; i < N; i++) if (r.mask[i]) liver[i] = 1
    const f: Finding = { id, name: `Finding ${id}`, color: FINDING_COLORS[(id - 1) % FINDING_COLORS.length] }
    this.set({ findings, liver, findingList: [...s.findingList, f], activeFinding: id, model: s.model ?? { mean: 100, sd: 15, lo: 55, hi: 145 } })
    await this.afterLiverChange()
  }

  deleteFinding(id: number): void {
    const s = this.state
    if (!s.findings) return
    this.snapshot()
    const f = s.findings
    for (let i = 0; i < f.length; i++) if (f[i] === id) f[i] = 0
    this.set({ findings: f, findingList: s.findingList.filter((x) => x.id !== id), activeFinding: s.activeFinding === id ? null : s.activeFinding })
    void this.afterLiverChange()
  }

  renameFinding(id: number, name: string): void {
    this.set({ findingList: this.state.findingList.map((f) => (f.id === id ? { ...f, name } : f)) })
  }

  // ---------------------------------------------------------------- vessels

  async findVessels(threshold?: number): Promise<boolean> {
    const s = this.state
    if (!s.liver || !s.model) return false
    this.snapshot()
    const r = await this.busy('Finding the vessels…', () =>
      call<{ mask: Uint8Array; threshold: number } | null>('vessels', { liver: s.liver, model: s.model, exclude: s.findings ?? undefined, threshold })
    )
    if (!r) {
      this.set({ vessels: null, vesselThreshold: null })
      this.measure()
      return false
    }
    this.set({ vessels: r.mask, vesselThreshold: r.threshold })
    await this.classifyVessels()
    return true
  }

  /** Portal vs hepatic, when the landmarks on them are placed. */
  async classifyVessels(): Promise<void> {
    const s = this.state
    if (!s.vessels) return
    const lm = s.landmarks
    const portal = [...(lm.rpb ?? []), ...(lm.lpb ?? [])].map((p) => this.voxel(p)).filter((i) => i >= 0)
    const hepatic = [...(lm.ivc ?? []), ...(lm.rhv ?? []), ...(lm.mhv ?? [])].map((p) => this.voxel(p)).filter((i) => i >= 0)
    if (!portal.length || !hepatic.length) {
      const plain = s.vessels.map((v) => (v ? 1 : 0))
      this.set({ vessels: plain })
      this.measure()
      return
    }
    const flat = s.vessels.map((v) => (v ? 1 : 0))
    const r = await this.busy('Sorting portal and hepatic veins…', () => call<{ labels: Uint8Array }>('classify', { vessels: flat, portal, hepatic }))
    if (r) this.set({ vessels: r.labels })
    this.measure()
  }

  clearVessels(): void {
    this.set({ vessels: null, vesselThreshold: null })
    this.measure()
  }

  // ---------------------------------------------------------------- segments

  setLevel(level: SegLevel): void {
    this.set({ level })
    void this.computeSegments()
  }

  selectLandmark(id: LandmarkId | null): void {
    this.ui({ activeLandmark: id, tool: id ? 'landmark' : this.state.tool })
  }

  /** Places a point of the chosen landmark (a full landmark starts over), then goes to the next missing one. */
  placeLandmark(p: Vec3): void {
    const s = this.state
    const id = s.activeLandmark
    if (!id) return
    const def = LANDMARKS.find((l) => l.id === id)!
    const cur = s.landmarks[id] ?? []
    const pts = cur.length >= def.points ? [p] : [...cur, p]
    const landmarks = { ...s.landmarks, [id]: pts }
    let next: LandmarkId | null = id
    if (pts.length >= def.points) {
      const need = LEVELS.find((l) => l.id === s.level)?.needs ?? []
      next = need.find((n) => !(landmarks[n]?.length)) ?? null
    }
    this.set({ landmarks, activeLandmark: next, tool: next ? 'landmark' : null })
    void this.computeSegments()
    if (['rpb', 'lpb', 'ivc', 'rhv', 'mhv'].includes(id) && s.vessels) void this.classifyVessels()
  }

  clearLandmark(id: LandmarkId): void {
    const landmarks = { ...this.state.landmarks }
    delete landmarks[id]
    this.set({ landmarks, segments: null })
    void this.computeSegments()
  }

  async computeSegments(): Promise<void> {
    const s = this.state
    if (!s.liver) return
    const need = LEVELS.find((l) => l.id === s.level)?.needs ?? []
    const missing = need.filter((n) => !(s.landmarks[n]?.length))
    if (missing.length) {
      this.set({ segments: null, missing, resectSegments: [] })
      this.recomputeResection()
      return
    }
    const r = await this.busy('Computing the segments…', () =>
      call<{ labels: Uint8Array | null; missing: LandmarkId[] }>('segments', { liver: s.liver, landmarks: s.landmarks, level: s.level })
    )
    if (!r) return
    const valid = new Set(SEGMENTS.map((x) => x.code))
    this.set({ segments: r.labels, missing: r.missing, resectSegments: s.resectSegments.filter((c) => valid.has(c)) })
    this.recomputeResection()
  }

  // ---------------------------------------------------------------- resection

  toggleResectSegment(code: number): void {
    const cur = this.state.resectSegments
    this.set({ resectSegments: cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code] })
    this.recomputeResection()
  }

  setPendingCut(c: PendingCut | null): void {
    this.ui({ pendingCut: c })
  }

  /** The side of the pending cut line that holds `p` is removed. */
  chooseCutSide(p: Vec3): void {
    const c = this.state.pendingCut
    if (!c) return
    const dir: Vec3 = [c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]]
    let n: Vec3 = [dir[1] * c.view[2] - dir[2] * c.view[1], dir[2] * c.view[0] - dir[0] * c.view[2], dir[0] * c.view[1] - dir[1] * c.view[0]]
    const l = Math.hypot(...n) || 1
    n = [n[0] / l, n[1] / l, n[2] / l]
    const side = (p[0] - c.a[0]) * n[0] + (p[1] - c.a[1]) * n[1] + (p[2] - c.a[2]) * n[2]
    if (side < 0) n = [-n[0], -n[1], -n[2]]
    this.set({ cuts: [...this.state.cuts, { point: c.a, normal: n }], pendingCut: null })
    this.recomputeResection()
  }

  removeCut(i: number): void {
    this.set({ cuts: this.state.cuts.filter((_, k) => k !== i) })
    this.recomputeResection()
  }

  clearResection(): void {
    this.set({ resectSegments: [], cuts: [], resectBrush: null, pendingCut: null })
    this.recomputeResection()
  }

  setMargin(mm: number): void {
    this.set({ marginMm: mm })
    this.measure()
  }

  recomputeResection(): void {
    const s = this.state
    const g = s.grid
    if (!g || !s.liver || (!s.resectSegments.length && !s.cuts.length && !s.resectBrush)) {
      if (s.resected) this.set({ resected: null })
      this.measure()
      return
    }
    const [nx, ny, nz] = g.dims
    const out = new Uint8Array(s.liver.length)
    const segs = new Set(s.resectSegments)
    const cuts = s.cuts.map((c) => {
      const o = worldAt(g, 0, 0, 0)
      const d0 = (o[0] - c.point[0]) * c.normal[0] + (o[1] - c.point[1]) * c.normal[1] + (o[2] - c.point[2]) * c.normal[2]
      const st = [0, 1, 2].map((a) => (g.axes[a][0] * c.normal[0] + g.axes[a][1] * c.normal[1] + g.axes[a][2] * c.normal[2]) * g.sp[a])
      return { d0, dx: st[0], dy: st[1], dz: st[2] }
    })
    const brush = s.resectBrush
    let i = 0
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++, i++) {
          if (!s.liver[i]) continue
          if (brush && brush[i] === 2) continue
          let r = (brush && brush[i] === 1) || (s.segments != null && segs.has(s.segments[i]))
          if (!r) for (const c of cuts) if (c.d0 + x * c.dx + y * c.dy + z * c.dz > 0) (r = true)
          if (r) out[i] = 1
        }
    this.set({ resected: out })
    this.measure()
  }

  // ---------------------------------------------------------------- after changes

  private async afterLiverChange(): Promise<void> {
    const s = this.state
    if (s.segments) await this.computeSegments()
    else this.recomputeResection()
  }

  /** Volumes and HU of everything (on the UI thread: a few passes over the grid). */
  measure(): void {
    const s = this.state
    const g = s.grid
    const hu = this.hu
    if (!g || !hu || !s.liver) {
      if (s.stats) this.set({ stats: null }, false)
      return
    }
    const ml = (g.sp[0] * g.sp[1] * g.sp[2]) / 1000
    const acc = () => ({ n: 0, s: 0, s2: 0 })
    const fin = (a: { n: number; s: number; s2: number }): Measure => {
      const mean = a.n ? a.s / a.n : 0
      return { n: a.n, mean, sd: a.n > 1 ? Math.sqrt(Math.max(0, a.s2 / a.n - mean * mean)) : 0 }
    }
    const liver = acc()
    const segs = new Map<number, { n: number; s: number; s2: number; f: number }>()
    const finds = new Map<number, { n: number; s: number; s2: number; segs: Map<number, number> }>()
    const ves = new Map<number, { n: number; s: number; s2: number }>()
    let functional = 0
    const res = { n: 0, functional: 0, bySegment: {} as Record<number, number>, atypical: 0 }
    const { liver: L, findings: F, vessels: V, segments: S, resected: R } = s
    for (let i = 0; i < L.length; i++) {
      const v = V ? V[i] : 0
      const f = F ? F[i] : 0
      const h = hu[i]
      if (v) {
        const a = ves.get(v) ?? acc()
        a.n++
        a.s += h
        a.s2 += h * h
        ves.set(v, a)
      }
      if (f) {
        const a = finds.get(f) ?? { ...acc(), segs: new Map() }
        a.n++
        a.s += h
        a.s2 += h * h
        if (S && S[i]) a.segs.set(S[i], (a.segs.get(S[i]) ?? 0) + 1)
        finds.set(f, a)
      }
      if (!L[i]) continue
      liver.n++
      liver.s += h
      liver.s2 += h * h
      const isFunctional = !v && !f
      if (isFunctional) functional++
      const sc = S ? S[i] : 0
      if (sc) {
        const a = segs.get(sc) ?? { ...acc(), f: 0 }
        a.n++
        a.s += h
        a.s2 += h * h
        if (isFunctional) a.f++
        segs.set(sc, a)
      }
      if (R && R[i]) {
        res.n++
        if (isFunctional) res.functional++
        if (sc) res.bySegment[sc] = (res.bySegment[sc] ?? 0) + 1
        if (!sc || !s.resectSegments.includes(sc)) res.atypical++
      }
    }
    const stats: Stats = {
      ml,
      liver: fin(liver),
      functional,
      findings: {},
      vessels: {},
      segments: {},
      resection: null
    }
    for (const [id, a] of finds) {
      const total = a.n
      stats.findings[id] = { ...fin(a), segments: [...a.segs].filter(([, n]) => n >= Math.max(1, total * 0.05)).sort((x, y) => y[1] - x[1]).map(([c]) => c) }
    }
    for (const [id, a] of ves) stats.vessels[id] = fin(a)
    for (const [code, a] of segs) stats.segments[code] = { ...fin(a), functional: a.f }
    if (R) {
      const fr: Record<number, { resected: number; total: number }> = {}
      // Each finding with its safety margin: how much of it the plan removes.
      if (F && s.findingList.length) {
        for (const f of s.findingList) {
          const m = new Uint8Array(F.length)
          let any = false
          for (let i = 0; i < F.length; i++)
            if (F[i] === f.id) {
              m[i] = 1
              any = true
            }
          if (!any) continue
          const zone = s.marginMm > 0 ? dilate(m, g.dims, g.sp, s.marginMm) : m
          let total = 0
          let cut = 0
          for (let i = 0; i < zone.length; i++) {
            if (!zone[i] || !L[i]) continue
            total++
            if (R[i]) cut++
          }
          fr[f.id] = { resected: cut, total }
        }
      }
      stats.resection = { ...res, findings: fr }
    }
    this.set({ stats }, false)
  }

  // ---------------------------------------------------------------- save / load

  serialize(): string | null {
    const s = this.state
    if (!s.grid || !s.liver) return null
    return JSON.stringify({
      v: 1,
      seriesUid: s.seriesUid,
      grid: s.grid,
      model: s.model,
      seeds: s.seeds,
      excludes: s.excludes,
      liver: rle(s.liver),
      findings: s.findings ? rle(s.findings) : null,
      findingList: s.findingList,
      vessels: s.vessels ? rle(s.vessels) : null,
      vesselThreshold: s.vesselThreshold,
      level: s.level,
      landmarks: s.landmarks,
      resectSegments: s.resectSegments,
      cuts: s.cuts,
      resectBrush: s.resectBrush ? rle(s.resectBrush) : null,
      marginMm: s.marginMm
    })
  }

  /** Restores a saved analysis when it was made on the same grid. */
  async restore(json: string): Promise<boolean> {
    const s = this.state
    const g = s.grid
    if (!g) return false
    let d: Record<string, unknown>
    try {
      d = JSON.parse(json) as Record<string, unknown>
    } catch {
      return false
    }
    const sg = d.grid as GridGeom | undefined
    if (!sg || sg.dims.join() !== g.dims.join() || sg.sp.some((x, k) => Math.abs(x - g.sp[k]) > 1e-3)) return false
    const N = g.dims[0] * g.dims[1] * g.dims[2]
    const un = (x: unknown) => (typeof x === 'string' ? unrle(x, N) : null)
    this.set(
      {
        model: (d.model as TissueModel) ?? null,
        seeds: (d.seeds as number[]) ?? [],
        excludes: (d.excludes as number[]) ?? [],
        liver: un(d.liver),
        findings: un(d.findings),
        findingList: (d.findingList as Finding[]) ?? [],
        vessels: un(d.vessels),
        vesselThreshold: (d.vesselThreshold as number) ?? null,
        level: (d.level as SegLevel) ?? 'couinaud',
        landmarks: (d.landmarks as Landmarks) ?? {},
        resectSegments: (d.resectSegments as number[]) ?? [],
        cuts: (d.cuts as Cut[]) ?? [],
        resectBrush: un(d.resectBrush),
        marginMm: (d.marginMm as number) ?? 10,
        saved: true,
        step: 'liver',
        tool: null,
        dataVersion: this.state.dataVersion + 1
      },
      false
    )
    await this.computeSegments()
    if (!this.state.segments) this.recomputeResection()
    this.set({ saved: true }, false)
    return true
  }

  markSaved(): void {
    this.set({ saved: true }, false)
  }
}

/** Run-length code of a label volume as base64 (value, run length as varints). */
export function rle(m: Uint8Array): string {
  const out: number[] = []
  const push = (n: number) => {
    while (n >= 0x80) {
      out.push((n & 0x7f) | 0x80)
      n = Math.floor(n / 128)
    }
    out.push(n)
  }
  let i = 0
  while (i < m.length) {
    const v = m[i]
    let j = i + 1
    while (j < m.length && m[j] === v) j++
    out.push(v)
    push(j - i)
    i = j
  }
  const bytes = Uint8Array.from(out)
  let bin = ''
  for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000))
  return btoa(bin)
}

export function unrle(b64: string, n: number): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(n)
  let p = 0
  let i = 0
  while (i < bin.length && p < n) {
    const v = bin.charCodeAt(i++)
    let len = 0
    let mul = 1
    for (;;) {
      const b = bin.charCodeAt(i++)
      len += (b & 0x7f) * mul
      if (b < 0x80) break
      mul *= 128
    }
    if (v) out.fill(v, p, Math.min(n, p + len))
    p += len
  }
  return out
}

export const liverStore = new LiverStore()
