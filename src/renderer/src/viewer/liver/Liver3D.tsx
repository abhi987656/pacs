/**
 * 3-D view of the liver analysis (top-right tile, as in the Philips application): surfaces of
 * the liver or its segments, the findings and the vessels; the resected part faint. Surfaces
 * are made in the liver worker; drawing them needs no 3-D textures (fine on built-in graphics).
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import '@kitware/vtk.js/Rendering/Profiles/Geometry'
import vtkGenericRenderWindow from '@kitware/vtk.js/Rendering/Misc/GenericRenderWindow'
import vtkActor from '@kitware/vtk.js/Rendering/Core/Actor'
import vtkMapper from '@kitware/vtk.js/Rendering/Core/Mapper'
import vtkPolyData from '@kitware/vtk.js/Common/DataModel/PolyData'
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray'
import { SEGMENTS } from './couinaud'
import type { Surface } from './mesh'
import { call, LIVER_COLOR, liverStore, VESSEL_COLORS, type LiverState } from './store'
import { tablesOf } from './report'

type GRW = ReturnType<typeof vtkGenericRenderWindow.newInstance>
let current: GRW | null = null

/** The 3-D view as a PNG data URL (for the report), or null when it is not shown. */
export async function captureLiver3D(): Promise<string | null> {
  if (!current) return null
  try {
    current.getRenderWindow().render()
    const shots = current.getRenderWindow().captureImages('image/png') as Promise<string>[]
    return shots.length ? await shots[0] : null
  } catch {
    return null
  }
}

const PLAIN = 100
const RESECTED = 200

interface Part {
  values: number[]
  color: readonly number[]
  opacity: number
}

export function Liver3D() {
  const box = useRef<HTMLDivElement>(null)
  const grw = useRef<GRW | null>(null)
  const actors = useRef<ReturnType<typeof vtkActor.newInstance>[]>([])
  const placed = useRef(false)
  /** The newest rebuild; surfaces of an older one are dropped. */
  const gen = useRef(0)
  const [busy, setBusy] = useState(false)
  const s = useSyncExternalStore((fn) => liverStore.subscribe(fn), () => liverStore.state)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const w = vtkGenericRenderWindow.newInstance({ background: [0.11, 0.11, 0.13], listenWindowResize: false })
    w.setContainer(el)
    w.resize()
    grw.current = w
    current = w
    const ro = new ResizeObserver(() => w.resize())
    ro.observe(el)
    return () => {
      ro.disconnect()
      if (current === w) current = null
      grw.current = null
      actors.current = []
      placed.current = false
      w.delete()
    }
  }, [])

  // Rebuild the surfaces a moment after the masks stop changing.
  useEffect(() => {
    const st = liverStore.state
    const timer = setTimeout(() => void rebuild(st), 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.dataVersion, s.segments, s.resected, s.grid])

  const rebuild = async (st: LiverState) => {
    const w = grw.current
    if (!w || !st.grid) return
    const my = ++gen.current
    const ren = w.getRenderer()
    for (const a of actors.current) ren.removeActor(a)
    actors.current = []
    if (!st.liver) {
      w.getRenderWindow().render()
      return
    }
    setBusy(true)
    try {
      const N = st.liver.length
      // Liver (or its segments) and the resected part, in one label volume.
      const parts = new Uint8Array(N)
      const L = st.liver
      const S = st.segments
      const R = st.resected
      for (let i = 0; i < N; i++) if (L[i]) parts[i] = R && R[i] ? RESECTED : S && S[i] ? S[i] : PLAIN
      const inside = (st.findings && st.findingList.length) || st.vessels
      const liverOpacity = inside ? 0.38 : 0.95
      const groups: Part[] = []
      if (S) for (const seg of SEGMENTS) groups.push({ values: [seg.code], color: seg.color, opacity: liverOpacity })
      groups.push({ values: [PLAIN], color: LIVER_COLOR, opacity: liverOpacity })
      groups.push({ values: [RESECTED], color: [150, 150, 150], opacity: 0.12 })
      const jobs: Promise<void>[] = []
      const add = (labels: Uint8Array, gs: Part[], step: number) =>
        jobs.push(
          call<(Surface | null)[]>('surfaces', { labels, groups: gs.map((g) => g.values), step }).then((list) =>
            list.forEach((surf, k) => surf && my === gen.current && addActor(surf, gs[k]))
          )
        )
      add(parts, groups, 2)
      if (st.findings && st.findingList.length) add(st.findings, st.findingList.map((f) => ({ values: [f.id], color: f.color, opacity: 1 })), 1)
      if (st.vessels)
        add(
          st.vessels,
          [1, 2, 3].map((v) => ({ values: [v], color: VESSEL_COLORS[v], opacity: 1 })),
          1
        )
      await Promise.all(jobs)
      if (my !== gen.current) return
      if (!placed.current && actors.current.length) {
        // Seen from the front, head up (the patient's right on the left, as on the images).
        const cam = ren.getActiveCamera()
        const b = ren.computeVisiblePropBounds()
        const c = [(b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2]
        cam.setFocalPoint(c[0], c[1], c[2])
        cam.setPosition(c[0], c[1] - 1000, c[2])
        cam.setViewUp(0, 0, 1)
        ren.resetCamera()
        placed.current = true
      }
      w.getRenderWindow().render()
    } catch (e) {
      console.error('3-D liver view', e)
    } finally {
      setBusy(false)
    }
  }

  const addActor = (surf: Surface, part: Part) => {
    const w = grw.current
    if (!w) return
    const pd = vtkPolyData.newInstance()
    pd.getPoints().setData(surf.points, 3)
    pd.getPolys().setData(surf.polys)
    pd.getPointData().setNormals(vtkDataArray.newInstance({ name: 'Normals', numberOfComponents: 3, values: surf.normals }))
    const mapper = vtkMapper.newInstance()
    mapper.setInputData(pd)
    const actor = vtkActor.newInstance()
    actor.setMapper(mapper)
    const p = actor.getProperty()
    p.setColor(part.color[0] / 255, part.color[1] / 255, part.color[2] / 255)
    p.setOpacity(part.opacity)
    p.setSpecular(0.2)
    p.setSpecularPower(20)
    w.getRenderer().addActor(actor)
    actors.current.push(actor)
  }

  const reset = () => {
    placed.current = false
    void rebuild(liverStore.state)
  }

  const t = tablesOf(s)
  return (
    <div className="liver-3d" onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => (e.preventDefault(), e.stopPropagation())} onWheel={(e) => e.stopPropagation()}>
      <div ref={box} className="liver-3d-view" />
      <div className="liver-3d-label">3D</div>
      {t && (
        <div className="liver-3d-info">
          Liver volume {Math.round(t.total)} mL
          {t.functional !== t.total ? ` · functional ${Math.round(t.functional)} mL` : ''}
          {t.remnant ? ` · remnant ${Math.round(t.remnant.ml)} mL (${Math.round(t.remnant.pctFn)} %)` : ''}
        </div>
      )}
      {!s.liver && <div className="liver-3d-empty">The liver appears here once segmented</div>}
      {busy && <div className="liver-3d-busy">Updating…</div>}
      <button className="liver-3d-reset" title="Front view" onClick={reset}>
        Reset view
      </button>
    </div>
  )
}
