/**
 * Surfaces for the 3-D liver view: marching cubes (vtk.js) on a smoothed, optionally coarser copy
 * of a mask, with the points put in patient coordinates. Runs in the liver worker.
 */
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray'
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData'
import vtkImageMarchingCubes from '@kitware/vtk.js/Filters/General/ImageMarchingCubes'
import type { GridGeom } from './couinaud'

export interface Surface {
  points: Float32Array
  normals: Float32Array
  /** vtk cell array: 3, a, b, c, 3, … */
  polys: Uint32Array
}

/** Separable [1 2 1]/4 smoothing along each axis, twice (about a one-voxel Gaussian). */
function smooth(f: Float32Array, d: [number, number, number]): void {
  const [nx, ny, nz] = d
  const tmp = new Float32Array(f.length)
  const strides = [1, nx, nx * ny]
  const lens = [nx, ny, nz]
  for (let rep = 0; rep < 2; rep++)
    for (let a = 0; a < 3; a++) {
      const s = strides[a]
      const n = lens[a]
      if (n < 3) continue
      for (let i = 0; i < f.length; i++) {
        const p = Math.floor(i / s) % n
        const l = p > 0 ? f[i - s] : f[i]
        const r = p < n - 1 ? f[i + s] : f[i]
        tmp[i] = 0.25 * l + 0.5 * f[i] + 0.25 * r
      }
      f.set(tmp)
    }
}

/**
 * Surface of the voxels where `pick(label)` holds, computed on blocks of `step` voxels.
 * Returns null when nothing is picked.
 */
export function surfaceOf(labels: Uint8Array, grid: GridGeom, pick: (v: number) => boolean, step = 1): Surface | null {
  const [nx, ny, nz] = grid.dims
  // Bounding box of the picked voxels (+ margin) keeps the field small.
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
        if (!labels[i] || !pick(labels[i])) continue
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
        if (z < z0) z0 = z
        if (z > z1) z1 = z
      }
  if (x1 < 0) return null
  const m = 2 * step
  x0 = Math.max(0, x0 - m)
  y0 = Math.max(0, y0 - m)
  z0 = Math.max(0, z0 - m)
  x1 = Math.min(nx - 1, x1 + m)
  y1 = Math.min(ny - 1, y1 + m)
  z1 = Math.min(nz - 1, z1 + m)
  // A field one block wider on each side, so the surface closes at the box edge.
  const bx = Math.ceil((x1 - x0 + 1) / step) + 2
  const by = Math.ceil((y1 - y0 + 1) / step) + 2
  const bz = Math.ceil((z1 - z0 + 1) / step) + 2
  const f = new Float32Array(bx * by * bz)
  const inv = 1 / (step * step * step)
  for (let z = z0; z <= z1; z++) {
    const cz = Math.floor((z - z0) / step) + 1
    for (let y = y0; y <= y1; y++) {
      const cy = Math.floor((y - y0) / step) + 1
      const row = nx * (y + ny * z)
      for (let x = x0; x <= x1; x++) {
        const v = labels[row + x]
        if (v && pick(v)) f[Math.floor((x - x0) / step) + 1 + bx * (cy + by * cz)] += inv
      }
    }
  }
  smooth(f, [bx, by, bz])
  const img = vtkImageData.newInstance()
  img.setDimensions(bx, by, bz)
  img.setOrigin([0, 0, 0])
  img.setSpacing([1, 1, 1])
  img.getPointData().setScalars(vtkDataArray.newInstance({ name: 'f', numberOfComponents: 1, values: f }))
  const mc = vtkImageMarchingCubes.newInstance({ contourValue: 0.5, computeNormals: true, mergePoints: true })
  mc.setInputData(img)
  const out = mc.getOutputData()
  const pts = out.getPoints().getData() as Float32Array
  if (!pts.length) return null
  // Block coordinates -> voxel coordinates -> patient coordinates.
  const points = new Float32Array(pts.length)
  const { origin: o, axes: a, sp } = grid
  const half = (step - 1) / 2
  for (let p = 0; p < pts.length; p += 3) {
    const vx = (pts[p] - 1) * step + x0 + half
    const vy = (pts[p + 1] - 1) * step + y0 + half
    const vz = (pts[p + 2] - 1) * step + z0 + half
    for (let k = 0; k < 3; k++) points[p + k] = o[k] + a[0][k] * vx * sp[0] + a[1][k] * vy * sp[1] + a[2][k] * vz * sp[2]
  }
  // Normals: same rotation (spacing may stretch them a little; fine for shading).
  const nrm = out.getPointData().getNormals()?.getData() as Float32Array | undefined
  const normals = new Float32Array(points.length)
  if (nrm) {
    for (let p = 0; p < nrm.length; p += 3) {
      const gx = nrm[p] / sp[0]
      const gy = nrm[p + 1] / sp[1]
      const gz = nrm[p + 2] / sp[2]
      let nx2 = a[0][0] * gx + a[1][0] * gy + a[2][0] * gz
      let ny2 = a[0][1] * gx + a[1][1] * gy + a[2][1] * gz
      let nz2 = a[0][2] * gx + a[1][2] * gy + a[2][2] * gz
      const l = Math.hypot(nx2, ny2, nz2) || 1
      nx2 /= l
      ny2 /= l
      nz2 /= l
      normals[p] = nx2
      normals[p + 1] = ny2
      normals[p + 2] = nz2
    }
  }
  const polys = Uint32Array.from(out.getPolys().getData() as ArrayLike<number>)
  return { points, normals, polys }
}
