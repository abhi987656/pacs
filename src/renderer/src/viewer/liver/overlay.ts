/**
 * Draws the liver analysis on a tile: colour fill of the liver / segments / vessels / findings
 * on the tile's slice of the analysis grid, the resected part hatched, landmarks, cut lines and
 * the brush outline.
 */
import type { Types } from '@cornerstonejs/core'
import { LANDMARKS, segmentDef, type Vec3 } from './couinaud'
import { worldAt } from './grid'
import { LIVER_COLOR, VESSEL_COLORS, type LiverState } from './store'

export interface OverlayExtras {
  /** Mouse position (canvas pixels) for the brush / finding outline. */
  cursor?: { x: number; y: number } | null
  /** Radius in mm of a finding being dragged out (centre in patient coordinates). */
  lesion?: { center: Vec3; radiusMm: number } | null
  /** A cut line being drawn (patient coordinates). */
  line?: { a: Vec3; b: Vec3 } | null
}

const SHORT: Record<string, string> = { ivc: 'IVC', rhv: 'RHV', mhv: 'MHV', uf: 'UF', rpb: 'RPB', lpb: 'LPB', tll: 'Tip', slv: 'SLV', dlv: 'DLV' }

let scratch: HTMLCanvasElement | null = null

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

export function drawLiverOverlay(canvas: HTMLCanvasElement, vp: Types.IViewport, s: LiverState, x: OverlayExtras = {}): void {
  const el = vp.element as HTMLElement
  const w = el.clientWidth
  const h = el.clientHeight
  const dpr = window.devicePixelRatio || 1
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  const ctx = canvas.getContext('2d')!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const g = s.grid
  if (!s.active || !g) return
  let cam: Types.ICamera
  try {
    cam = vp.getCamera()
  } catch {
    return
  }
  const n = cam.viewPlaneNormal
  const f = cam.focalPoint
  if (!n || !f) return
  const toCanvas = (p: readonly number[]): [number, number] => {
    const c = vp.worldToCanvas(p as Types.Point3)
    return [c[0], c[1]]
  }

  // --- the slice of the grid this tile shows
  const along = [0, 1, 2].map((a) => Math.abs(dot(g.axes[a], n)))
  const k = along.indexOf(Math.max(...along))
  const sl = Math.round(dot([f[0] - g.origin[0], f[1] - g.origin[1], f[2] - g.origin[2]], g.axes[k]) / g.sp[k])
  const [nx, ny, nz] = g.dims
  const stride = [1, nx, nx * ny]
  const [ua, va] = [0, 1, 2].filter((a) => a !== k)
  const W = g.dims[ua]
  const H = g.dims[va]
  if (sl >= 0 && sl < g.dims[k] && (s.liver || s.findings)) {
    if (!scratch) scratch = document.createElement('canvas')
    if (scratch.width !== W || scratch.height !== H) {
      scratch.width = W
      scratch.height = H
    }
    const sctx = scratch.getContext('2d')!
    const img = sctx.createImageData(W, H)
    const px = img.data
    const A = Math.round(255 * s.opacity)
    const { liver: L, findings: F, vessels: V, segments: S, resected: R, show } = s
    const fc = new Map(s.findingList.map((q) => [q.id, q.color]))
    const base = sl * stride[k]
    let o = 0
    for (let v = 0; v < H; v++) {
      const row = base + v * stride[va]
      for (let u = 0; u < W; u++, o += 4) {
        const i = row + u * stride[ua]
        let c: readonly number[] | undefined
        let a = A
        const fi = F ? F[i] : 0
        if (fi && show.findings) {
          c = fc.get(fi)
          a = Math.min(255, A + 70)
        } else if (V && V[i] && show.vessels) {
          c = VESSEL_COLORS[V[i]]
          a = Math.min(255, A + 50)
        } else if (L && L[i]) {
          if (S && S[i] && show.segments) c = segmentDef(S[i])?.color
          else if (show.liver) c = LIVER_COLOR
        }
        if (!c) continue
        if (R && R[i] && show.resection) {
          // resected: darker, with diagonal stripes
          const stripe = (u + v) % 4 < 2
          px[o] = stripe ? 30 : c[0] * 0.5
          px[o + 1] = stripe ? 30 : c[1] * 0.5
          px[o + 2] = stripe ? 30 : c[2] * 0.5
          px[o + 3] = Math.min(255, a + 40)
          continue
        }
        px[o] = c[0]
        px[o + 1] = c[1]
        px[o + 2] = c[2]
        px[o + 3] = a
      }
    }
    sctx.putImageData(img, 0, 0)
    // Grid pixel (u, v) -> canvas: an affine map from three voxel centres.
    const idx = (u: number, v: number): [number, number, number] => {
      const c: [number, number, number] = [0, 0, 0]
      c[ua] = u
      c[va] = v
      c[k] = sl
      return c
    }
    const p0 = toCanvas(worldAt(g, ...idx(0, 0)))
    const pu = toCanvas(worldAt(g, ...idx(1, 0)))
    const pv = toCanvas(worldAt(g, ...idx(0, 1)))
    ctx.setTransform(dpr * (pu[0] - p0[0]), dpr * (pu[1] - p0[1]), dpr * (pv[0] - p0[0]), dpr * (pv[1] - p0[1]), dpr * p0[0], dpr * p0[1])
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(scratch, -0.5, -0.5)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  } else ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  void nz

  // --- cut planes: where they cross this slice
  const cross = (p: Vec3, normal: Vec3, color: string, dash: number[]) => {
    // the line through the slice: direction = normal × view normal
    const l1 = Math.hypot(normal[0], normal[1], normal[2]) || 1
    const n1: Vec3 = [normal[0] / l1, normal[1] / l1, normal[2] / l1]
    const d: Vec3 = [n1[1] * n[2] - n1[2] * n[1], n1[2] * n[0] - n1[0] * n[2], n1[0] * n[1] - n1[1] * n[0]]
    const len = Math.hypot(...d)
    if (len < 1e-3) return
    // a point on both planes (the cut and this slice)
    const h1 = dot(n1, p)
    const h2 = dot(n, f)
    const c = dot(n1, n)
    const den = 1 - c * c
    const q: Vec3 = [0, 1, 2].map((t) => ((h1 - h2 * c) * n1[t] + (h2 - h1 * c) * n[t]) / den) as Vec3
    const far = 2000 / len
    const a = toCanvas([q[0] + d[0] * far, q[1] + d[1] * far, q[2] + d[2] * far])
    const b = toCanvas([q[0] - d[0] * far, q[1] - d[1] * far, q[2] - d[2] * far])
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    ctx.setLineDash(dash)
    ctx.beginPath()
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(b[0], b[1])
    ctx.stroke()
    ctx.restore()
  }
  if (s.show.resection) for (const c of s.cuts) cross(c.point, c.normal, 'rgba(255,70,70,0.9)', [6, 4])
  const pc = s.pendingCut
  if (pc) {
    const dir: Vec3 = [pc.b[0] - pc.a[0], pc.b[1] - pc.a[1], pc.b[2] - pc.a[2]]
    const cn: Vec3 = [dir[1] * pc.view[2] - dir[2] * pc.view[1], dir[2] * pc.view[0] - dir[0] * pc.view[2], dir[0] * pc.view[1] - dir[1] * pc.view[0]]
    cross(pc.a, cn, 'rgba(255,220,0,0.95)', [3, 3])
  }
  if (x.line) {
    const a = toCanvas(x.line.a)
    const b = toCanvas(x.line.b)
    ctx.strokeStyle = 'rgba(255,220,0,0.95)'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(a[0], a[1])
    ctx.lineTo(b[0], b[1])
    ctx.stroke()
  }

  // --- landmarks near this slice
  const near = Math.max(g.sp[k] * 1.5, 3)
  ctx.font = '11px system-ui, sans-serif'
  for (const def of LANDMARKS) {
    const pts = s.landmarks[def.id]
    if (!pts) continue
    for (const p of pts) {
      const dist = Math.abs(dot([p[0] - f[0], p[1] - f[1], p[2] - f[2]], n))
      if (dist > near * 4) continue
      const [cx, cy] = toCanvas(p)
      const on = dist <= near
      const color = s.activeLandmark === def.id ? '255,170,0' : '255,255,255'
      ctx.strokeStyle = `rgba(${color},${on ? 1 : 0.35})`
      ctx.fillStyle = `rgba(${color},${on ? 1 : 0.35})`
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(cx - 5, cy - 5)
      ctx.lineTo(cx + 5, cy + 5)
      ctx.moveTo(cx + 5, cy - 5)
      ctx.lineTo(cx - 5, cy + 5)
      ctx.stroke()
      ctx.fillText(SHORT[def.id] ?? def.id, cx + 7, cy - 6)
    }
  }

  // --- brush / finding outline
  const mmToPx = () => {
    const right = cam.viewUp ? (() => {
      const u = cam.viewUp!
      return [u[1] * n[2] - u[2] * n[1], u[2] * n[0] - u[0] * n[2], u[0] * n[1] - u[1] * n[0]] as Vec3
    })() : ([1, 0, 0] as Vec3)
    const a = toCanvas(f)
    const b = toCanvas([f[0] + right[0] * 10, f[1] + right[1] * 10, f[2] + right[2] * 10])
    return Math.hypot(b[0] - a[0], b[1] - a[1]) / 10
  }
  if (x.lesion) {
    const [cx, cy] = toCanvas(x.lesion.center)
    ctx.strokeStyle = 'rgba(255,80,80,0.95)'
    ctx.setLineDash([4, 3])
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(cx, cy, Math.max(2, x.lesion.radiusMm * mmToPx()), 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
  } else if (x.cursor && s.tool && /paint|erase/.test(s.tool)) {
    ctx.strokeStyle = /erase/.test(s.tool) ? 'rgba(255,90,90,0.9)' : 'rgba(120,255,120,0.9)'
    ctx.lineWidth = 1.2
    ctx.beginPath()
    ctx.arc(x.cursor.x, x.cursor.y, Math.max(2, s.brushMm * mmToPx()), 0, Math.PI * 2)
    ctx.stroke()
  }
}
