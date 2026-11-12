import type { SeriesImages } from '@shared/types'
import type { InstanceRow } from './db'

function parseVec(s: string): number[] | null {
  if (!s) return null
  const v = s.split('\\').map(Number)
  return v.every(Number.isFinite) ? v : null
}

function cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

/**
 * Display order for a series: by Instance Number (what the scanner intended), ties broken by the
 * position along the slice normal. Without instance numbers, fall back to spatial order
 * (head first for axial images).
 */
export function sortInstances(list: InstanceRow[]): InstanceRow[] {
  const withPos = list.map((inst) => {
    const ipp = parseVec(inst.ipp)
    const iop = parseVec(inst.iop)
    let proj: number | null = null
    if (ipp && ipp.length === 3 && iop && iop.length === 6) {
      const n = cross(iop.slice(0, 3), iop.slice(3, 6))
      proj = ipp[0] * n[0] + ipp[1] * n[1] + ipp[2] * n[2]
    } else if (inst.sliceLocation != null) {
      proj = inst.sliceLocation
    }
    return { inst, proj }
  })
  const allHaveNumbers = list.every((i) => i.instanceNumber != null)
  return withPos
    .sort((a, b) => {
      if (allHaveNumbers) {
        const d = (a.inst.instanceNumber as number) - (b.inst.instanceNumber as number)
        if (d !== 0) return d
      }
      if (a.proj != null && b.proj != null && a.proj !== b.proj) return b.proj - a.proj
      if (!allHaveNumbers) {
        const ai = a.inst.instanceNumber ?? Number.MAX_SAFE_INTEGER
        const bi = b.inst.instanceNumber ?? Number.MAX_SAFE_INTEGER
        if (ai !== bi) return ai - bi
      }
      return a.inst.relPath < b.inst.relPath ? -1 : a.inst.relPath > b.inst.relPath ? 1 : 0
    })
    .map((x) => x.inst)
}

/** Cornerstone image ids (one per frame) plus geometry used for linked scrolling and MPR. */
export function buildSeriesImages(seriesId: number, sorted: InstanceRow[], baseUrl: string): SeriesImages {
  const images = sorted.filter((i) => i.rows && i.cols) // skip non-image objects (SR, PR, KO...)
  const imageIds: string[] = []
  const positions: (number | null)[] = []

  // Common orientation?
  const first = images[0]
  const iop0 = first ? parseVec(first.iop) : null
  const sameOrientation =
    !!iop0 &&
    iop0.length === 6 &&
    images.every((i) => {
      const v = parseVec(i.iop)
      return !!v && v.length === 6 && v.every((x, k) => Math.abs(x - iop0[k]) < 1e-3)
    })
  let normal: [number, number, number] | null = null
  if (sameOrientation && iop0) {
    const n = cross(iop0.slice(0, 3), iop0.slice(3, 6))
    const len = Math.hypot(n[0], n[1], n[2]) || 1
    normal = [n[0] / len, n[1] / len, n[2] / len]
  }

  for (const inst of images) {
    const url = `${baseUrl}${inst.relPath}`
    const ipp = parseVec(inst.ipp)
    const pos = normal && ipp && ipp.length === 3 ? ipp[0] * normal[0] + ipp[1] * normal[1] + ipp[2] * normal[2] : null
    if (inst.frames > 1) {
      for (let f = 1; f <= inst.frames; f++) {
        imageIds.push(`wadouri:${url}?frame=${f}`)
        positions.push(null)
      }
    } else {
      imageIds.push(`wadouri:${url}`)
      positions.push(pos)
    }
  }

  const sameSize = images.every((i) => i.rows === first?.rows && i.cols === first?.cols)
  const distinctPositions = new Set(positions.filter((p) => p != null).map((p) => (p as number).toFixed(2))).size
  const reconstructable =
    !!normal && sameSize && images.length >= 3 && images.every((i) => i.frames <= 1) && distinctPositions === images.length

  return {
    seriesId,
    imageIds,
    positions,
    normal,
    frameOfReferenceUid: first?.forUid ?? '',
    reconstructable,
    rows: first?.rows ?? 0,
    cols: first?.cols ?? 0
  }
}
