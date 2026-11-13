/**
 * Liver segments from anatomical landmarks, after the landmark method of the Philips CT Liver
 * Analysis (Valette et al.): the user marks points on the hepatic veins, the portal bifurcations
 * and the fissures, and the segment borders are surfaces through them (here: planes).
 *
 * Patient coordinates are DICOM's (LPS): +x = patient left, +y = posterior, +z = head.
 */
import type { Dims, Spacing } from './algo'

export type Vec3 = [number, number, number]

/** Voxel grid of the analysis in patient coordinates. */
export interface GridGeom {
  dims: Dims
  sp: Spacing
  /** Patient position of the centre of voxel (0, 0, 0). */
  origin: Vec3
  /** Unit direction of the x, y and z voxel axes. */
  axes: [Vec3, Vec3, Vec3]
}

export type LandmarkId = 'ivc' | 'rhv' | 'mhv' | 'uf' | 'rpb' | 'lpb' | 'tll' | 'slv' | 'dlv'
export type SegLevel = 'lr-liver' | 'lr-lobe' | 'sectors' | 'seven' | 'couinaud' | 'bismuth'

export interface LandmarkDef {
  id: LandmarkId
  name: string
  /** Points to place (more help when the vein curves). */
  points: number
  hint: string
}

export const LANDMARKS: LandmarkDef[] = [
  { id: 'ivc', name: 'Inferior vena cava', points: 1, hint: 'Centre of the IVC where the hepatic veins join it (just below the heart).' },
  { id: 'rhv', name: 'Right hepatic vein', points: 2, hint: 'Along the right hepatic vein, away from the IVC: the border between the right anterior (5, 8) and right posterior (6, 7) segments.' },
  { id: 'mhv', name: 'Mid hepatic vein', points: 2, hint: 'Along the middle hepatic vein, or towards the gallbladder fossa: the border between the right liver (5, 8) and segment 4.' },
  { id: 'uf', name: 'Umbilical fissure', points: 1, hint: 'In the umbilical fissure (falciform ligament, ligamentum teres): the border between segment 4 and segments 2, 3.' },
  { id: 'rpb', name: 'Right portal bifurcation', points: 1, hint: 'Where the right portal vein divides: the level between the upper (7, 8) and lower (6, 5) segments.' },
  { id: 'lpb', name: 'Left portal bifurcation', points: 1, hint: 'The umbilical part of the left portal vein: the level between 4a and 4b, and between 2 and 3.' },
  { id: 'tll', name: 'Tip of the left liver', points: 1, hint: 'The outer tip of the left lobe: the slope of the border between segments 2 and 3.' },
  { id: 'slv', name: 'Superficial ligamentum venosum', points: 2, hint: 'At the back of the liver where the fissure of the ligamentum venosum separates segment 1 from segment 2.' },
  { id: 'dlv', name: 'Deep ligamentum venosum', points: 3, hint: 'Deeper along the fissure of the ligamentum venosum, towards the portal bifurcation: the front border of segment 1.' }
]

export const LEVELS: { id: SegLevel; name: string; needs: LandmarkId[] }[] = [
  { id: 'lr-liver', name: '2 segments: right / left liver', needs: ['ivc', 'mhv'] },
  { id: 'lr-lobe', name: '2 segments: right / left lobe', needs: ['ivc', 'uf'] },
  { id: 'sectors', name: '4 segments: right posterior, right anterior, left medial, left lateral', needs: ['ivc', 'rhv', 'mhv', 'uf'] },
  { id: 'seven', name: '7 segments (2 – 8)', needs: ['ivc', 'rhv', 'mhv', 'uf', 'rpb', 'lpb', 'tll'] },
  { id: 'couinaud', name: '8 segments (Couinaud)', needs: ['ivc', 'rhv', 'mhv', 'uf', 'rpb', 'lpb', 'tll', 'slv', 'dlv'] },
  { id: 'bismuth', name: '9 segments (Bismuth, 4a / 4b)', needs: ['ivc', 'rhv', 'mhv', 'uf', 'rpb', 'lpb', 'tll', 'slv', 'dlv'] }
]

export interface SegmentDef {
  code: number
  name: string
  color: [number, number, number]
}

/** Segment codes used in the segment label volume (0 = no segment). */
export const SEGMENTS: SegmentDef[] = [
  { code: 1, name: 'Segment 1', color: [240, 220, 90] },
  { code: 2, name: 'Segment 2', color: [150, 225, 140] },
  { code: 3, name: 'Segment 3', color: [150, 230, 240] },
  { code: 4, name: 'Segment 4', color: [240, 130, 190] },
  { code: 9, name: 'Segment 4b', color: [205, 90, 215] },
  { code: 5, name: 'Segment 5', color: [130, 235, 195] },
  { code: 6, name: 'Segment 6', color: [160, 200, 30] },
  { code: 7, name: 'Segment 7', color: [160, 205, 225] },
  { code: 8, name: 'Segment 8', color: [245, 185, 95] },
  { code: 11, name: 'Right liver', color: [80, 120, 210] },
  { code: 12, name: 'Left liver', color: [140, 70, 170] },
  { code: 13, name: 'Right lobe', color: [80, 120, 210] },
  { code: 14, name: 'Left lobe', color: [140, 70, 170] },
  { code: 15, name: 'Right posterior (6, 7)', color: [120, 190, 120] },
  { code: 16, name: 'Right anterior (5, 8)', color: [240, 190, 90] },
  { code: 17, name: 'Left medial (4)', color: [240, 130, 190] },
  { code: 18, name: 'Left lateral (2, 3)', color: [110, 120, 210] }
]
export const segmentDef = (code: number): SegmentDef | undefined => SEGMENTS.find((s) => s.code === code)
/** Name in the Bismuth scheme (segment 4 → 4a). */
export const segmentName = (code: number, level: SegLevel): string =>
  code === 4 && level === 'bismuth' ? 'Segment 4a' : segmentDef(code)?.name ?? `Segment ${code}`

export type Landmarks = Partial<Record<LandmarkId, Vec3[]>>

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: readonly number[], b: readonly number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
const mean = (ps: Vec3[]): Vec3 => {
  const s: Vec3 = [0, 0, 0]
  for (const p of ps) for (let k = 0; k < 3; k++) s[k] += p[k] / ps.length
  return s
}
const UP: Vec3 = [0, 0, 1]
const AP: Vec3 = [0, 1, 0]

export interface Plane {
  n: Vec3
  c: Vec3
}

/** Smallest-eigenvector normal of a point cloud (least-squares plane), by inverse iteration. */
function fitNormal(ps: Vec3[]): Vec3 {
  const c = mean(ps)
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (const p of ps) {
    const d = sub(p, c)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] += d[i] * d[j]
  }
  // Power iteration on (trace·I − M) finds the smallest eigenvector of M.
  const t = m[0] + m[4] + m[8] + 1e-6
  let v: Vec3 = [0.31, 0.53, 0.79]
  for (let it = 0; it < 60; it++) {
    const w: Vec3 = [
      t * v[0] - (m[0] * v[0] + m[1] * v[1] + m[2] * v[2]),
      t * v[1] - (m[3] * v[0] + m[4] * v[1] + m[5] * v[2]),
      t * v[2] - (m[6] * v[0] + m[7] * v[1] + m[8] * v[2])
    ]
    v = norm(w)
  }
  return v
}

/**
 * A "vertical" border (hepatic vein plane): through the points, upright unless 3+ points
 * clearly tilt it. `towards` orients the normal (positive side).
 */
export function veinPlane(points: Vec3[], towards: Vec3): Plane | null {
  if (points.length < 2) return null
  let n: Vec3
  if (points.length >= 3) {
    n = fitNormal(points)
    // A nearly flat fit is not a vein border: keep it upright.
    if (Math.abs(n[2]) > 0.6) n = norm(cross(sub(points[points.length - 1], points[0]), UP))
  } else n = norm(cross(sub(points[1], points[0]), UP))
  if (dot(n, towards) < 0) n = [-n[0], -n[1], -n[2]]
  return { n, c: mean(points) }
}

/** A "level" border through points, tilted along the left–right line between them, upright normal. */
export function levelPlane(points: Vec3[]): Plane | null {
  if (!points.length) return null
  let n: Vec3 = UP
  if (points.length >= 2) {
    const t = cross(sub(points[points.length - 1], points[0]), AP)
    if (Math.hypot(...t) > 1e-6) n = norm(t)
  }
  if (n[2] < 0) n = [-n[0], -n[1], -n[2]]
  return { n, c: mean(points) }
}

/** The landmark borders of a level (null entries: not needed or missing). */
export function bordersOf(lm: Landmarks, level: SegLevel): { planes: Record<string, Plane | null>; missing: LandmarkId[] } {
  const need = LEVELS.find((l) => l.id === level)?.needs ?? []
  const missing = need.filter((id) => !(lm[id]?.length))
  const ivc = lm.ivc?.[0]
  const pts = (id: LandmarkId): Vec3[] => lm[id] ?? []
  const planes: Record<string, Plane | null> = {}
  if (ivc) {
    planes.mhv = pts('mhv').length ? veinPlane([ivc, ...pts('mhv')], [1, 0, 0]) : null
    planes.rhv = pts('rhv').length ? veinPlane([ivc, ...pts('rhv')], [0, -1, 0]) : null
    planes.uf = pts('uf').length ? veinPlane([ivc, ...pts('uf')], [1, 0, 0]) : null
  }
  const portal = [...pts('rpb'), ...pts('lpb')]
  planes.portal = portal.length ? levelPlane(portal) : null
  planes.s23 = pts('lpb').length && pts('tll').length ? levelPlane([pts('lpb')[0], pts('tll')[0]]) : null
  const lv = [...pts('slv'), ...pts('dlv')]
  if (lv.length >= 2 && ivc) planes.lv = lv.length >= 3 ? orient({ n: fitNormal(lv), c: mean(lv) }, ivc) : veinPlane(lv, sub(ivc, mean(lv)))
  if (ivc && pts('rpb').length) planes.caudateRight = veinPlane([ivc, pts('rpb')[0]], [1, 0, 0])
  return { planes, missing }
}

function orient(p: Plane, towardsPoint: Vec3): Plane {
  return dot(p.n, sub(towardsPoint, p.c)) < 0 ? { n: [-p.n[0], -p.n[1], -p.n[2]], c: p.c } : p
}

/**
 * Segment label of every liver voxel (codes of SEGMENTS) for a level, or the landmarks that
 * are still missing.
 */
export function segmentsOf(liver: Uint8Array, grid: GridGeom, lm: Landmarks, level: SegLevel): { labels: Uint8Array | null; missing: LandmarkId[] } {
  const { planes, missing } = bordersOf(lm, level)
  if (missing.length) return { labels: null, missing }
  const [nx, ny, nz] = grid.dims
  const labels = new Uint8Array(liver.length)
  // Signed distance to a plane, stepped along the voxel axes.
  type Lin = { d0: number; dx: number; dy: number; dz: number } | null
  const lin = (p: Plane | null | undefined): Lin => {
    if (!p) return null
    return {
      d0: dot(p.n, sub(grid.origin, p.c)),
      dx: dot(p.n, grid.axes[0]) * grid.sp[0],
      dy: dot(p.n, grid.axes[1]) * grid.sp[1],
      dz: dot(p.n, grid.axes[2]) * grid.sp[2]
    }
  }
  const L = {
    mhv: lin(planes.mhv),
    rhv: lin(planes.rhv),
    uf: lin(planes.uf),
    portal: lin(planes.portal),
    s23: lin(planes.s23),
    lv: lin(planes.lv),
    cr: lin(planes.caudateRight)
  }
  const at = (l: Lin, x: number, y: number, z: number) => (l ? l.d0 + x * l.dx + y * l.dy + z * l.dz : 0)
  // Height range and front limit of segment 1 (patient coordinates).
  const zOf = (p: Vec3) => p[2]
  const ivc = lm.ivc?.[0]
  const portalPts = [...(lm.rpb ?? []), ...(lm.lpb ?? [])]
  const caudate = (level === 'couinaud' || level === 'bismuth') && L.lv && L.cr && ivc && portalPts.length
  const zTop = ivc ? zOf(ivc) + 15 : 0
  const zBottom = portalPts.length ? Math.min(...portalPts.map(zOf)) - 20 : 0
  const yFront = portalPts.length ? mean(portalPts)[1] - 5 : 0
  const wz = (x: number, y: number, z: number, k: 0 | 1 | 2) =>
    grid.origin[k] + x * grid.sp[0] * grid.axes[0][k] + y * grid.sp[1] * grid.axes[1][k] + z * grid.sp[2] * grid.axes[2][k]
  let i = 0
  for (let z = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++, i++) {
        if (!liver[i]) continue
        if (level === 'lr-liver') {
          labels[i] = at(L.mhv, x, y, z) > 0 ? 12 : 11
          continue
        }
        if (level === 'lr-lobe') {
          labels[i] = at(L.uf, x, y, z) > 0 ? 14 : 13
          continue
        }
        if (caudate) {
          const pz = wz(x, y, z, 2)
          if (at(L.lv, x, y, z) > 0 && at(L.cr, x, y, z) > 0 && pz <= zTop && pz >= zBottom && wz(x, y, z, 1) >= yFront) {
            labels[i] = 1
            continue
          }
        }
        const left = at(L.mhv, x, y, z) > 0
        if (!left) {
          const anterior = at(L.rhv, x, y, z) > 0
          if (level === 'sectors') {
            labels[i] = anterior ? 16 : 15
            continue
          }
          const upper = at(L.portal, x, y, z) > 0
          labels[i] = anterior ? (upper ? 8 : 5) : upper ? 7 : 6
          continue
        }
        const lateral = at(L.uf, x, y, z) > 0
        if (level === 'sectors') {
          labels[i] = lateral ? 18 : 17
          continue
        }
        if (lateral) labels[i] = at(L.s23, x, y, z) > 0 ? 2 : 3
        else labels[i] = level === 'bismuth' && at(L.portal, x, y, z) <= 0 ? 9 : 4
      }
  return { labels, missing: [] }
}
