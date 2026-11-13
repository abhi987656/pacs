/**
 * The analysis grid of the liver tools: the series (already in memory for the reformats)
 * cropped to the body and averaged down to voxels of about 1.5 mm, as HU in an Int16Array.
 * Small enough to segment in a second or two on a laptop, fine enough for volumetry.
 */
import type { CpuVolumeData } from '../reformat'
import type { GridGeom, Vec3 } from './couinaud'

/** Largest grid (voxels) – about 13 MB of HU plus the masks. */
const MAX_VOXELS = 12_000_000
const TARGET_MM = 1.5

export async function buildGrid(cv: CpuVolumeData, onProgress?: (f: number) => void): Promise<{ grid: GridGeom; hu: Int16Array }> {
  const [cols, rows, planes] = cv.dims
  const [sx, sy, sz] = cv.spacing
  const { data, z0, zNext, zW } = cv
  const at = (i: number, j: number, m: number): number => {
    const o = z0[m] + j * cols + i
    const w = zW[m]
    return w > 0 ? data[o] * (1 - w) + data[o + zNext[m]] * w : data[o]
  }
  // In-plane extent of the body (more than air) on a few planes.
  let c0 = cols
  let c1 = -1
  let r0 = rows
  let r1 = -1
  const step = Math.max(1, Math.floor(planes / 12))
  for (let m = 0; m < planes; m += step)
    for (let j = 0; j < rows; j += 2)
      for (let i = 0; i < cols; i += 2) {
        if (at(i, j, m) < -500) continue
        if (i < c0) c0 = i
        if (i > c1) c1 = i
        if (j < r0) r0 = j
        if (j > r1) r1 = j
      }
  if (c1 < 0) {
    c0 = 0
    c1 = cols - 1
    r0 = 0
    r1 = rows - 1
  }
  const pad = 6
  c0 = Math.max(0, c0 - pad)
  r0 = Math.max(0, r0 - pad)
  c1 = Math.min(cols - 1, c1 + pad)
  r1 = Math.min(rows - 1, r1 + pad)
  const W = c1 - c0 + 1
  const H = r1 - r0 + 1
  // Block size: about 1.5 mm voxels, coarser if the grid would be too big.
  let target = TARGET_MM
  let f: Vec3 = [1, 1, 1]
  for (;;) {
    f = [Math.max(1, Math.round(target / sx)), Math.max(1, Math.round(target / sy)), Math.max(1, Math.round(target / sz))]
    const n = Math.floor(W / f[0]) * Math.floor(H / f[1]) * Math.floor(planes / f[2])
    if (n <= MAX_VOXELS) break
    target *= 1.15
  }
  const nx = Math.floor(W / f[0])
  const ny = Math.floor(H / f[1])
  const nz = Math.floor(planes / f[2])
  const hu = new Int16Array(nx * ny * nz)
  const inv = 1 / (f[0] * f[1] * f[2])
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        let s = 0
        for (let c = 0; c < f[2]; c++) {
          const m = z * f[2] + c
          for (let b = 0; b < f[1]; b++) {
            const j = r0 + y * f[1] + b
            for (let a = 0; a < f[0]; a++) s += at(c0 + x * f[0] + a, j, m)
          }
        }
        hu[x + nx * (y + ny * z)] = Math.max(-1024, Math.min(3071, Math.round(s * inv)))
      }
    if (z % 16 === 15) {
      onProgress?.(z / nz)
      await new Promise((r) => setTimeout(r, 0)) // keep the window responsive
    }
  }
  const off = (start: number, fk: number, spacing: number) => (start + (fk - 1) / 2) * spacing
  const ox = off(c0, f[0], sx)
  const oy = off(r0, f[1], sy)
  const oz = off(0, f[2], sz)
  const origin: Vec3 = [0, 1, 2].map((k) => cv.origin[k] + cv.axes[0][k] * ox + cv.axes[1][k] * oy + cv.axes[2][k] * oz) as Vec3
  return {
    grid: { dims: [nx, ny, nz], sp: [sx * f[0], sy * f[1], sz * f[2]], origin, axes: [cv.axes[0], cv.axes[1], cv.axes[2]] },
    hu
  }
}

/** Voxel index of a patient position (−1 outside the grid). */
export function voxelAt(grid: GridGeom, p: readonly number[]): number {
  const [nx, ny, nz] = grid.dims
  const q = [p[0] - grid.origin[0], p[1] - grid.origin[1], p[2] - grid.origin[2]]
  const c = [0, 1, 2].map((k) => Math.round((q[0] * grid.axes[k][0] + q[1] * grid.axes[k][1] + q[2] * grid.axes[k][2]) / grid.sp[k]))
  if (c[0] < 0 || c[1] < 0 || c[2] < 0 || c[0] >= nx || c[1] >= ny || c[2] >= nz) return -1
  return c[0] + nx * (c[1] + ny * c[2])
}

/** Patient position of a voxel's centre. */
export function worldAt(grid: GridGeom, x: number, y: number, z: number): Vec3 {
  const o = grid.origin
  const a = grid.axes
  const s = grid.sp
  return [0, 1, 2].map((k) => o[k] + a[0][k] * x * s[0] + a[1][k] * y * s[1] + a[2][k] * z * s[2]) as Vec3
}
