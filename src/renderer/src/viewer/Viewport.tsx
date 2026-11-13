import { useEffect, useMemo, useRef, useState } from 'react'
import { Enums, eventTarget, utilities as csUtils } from '@cornerstonejs/core'
import type { Types } from '@cornerstonejs/core'
import * as csTools from '@cornerstonejs/tools'
import type { SeriesImages, StudyRow } from '@shared/types'
import { formatAge, formatDicomDate, formatDicomDateTime, formatSex } from '@shared/format'
import type { MouseEvent as ReactMouseEvent } from 'react'
import {
  annotationNear,
  applyProjection,
  applyVoi,
  ensureVolume,
  getEngine,
  getNatural,
  getVoi,
  moveViewTo,
  MPR_TOOLGROUP,
  num,
  orientationMarkers,
  panBy,
  RENDERING_ENGINE_ID,
  sliceAxis,
  STACK_TOOLGROUP,
  str,
  voiMultiplier,
  zoomBy
} from './cs'
import type { DragMode, SliceAxis } from './cs'
import { cpuPlaneIndexAt, cpuPlaneStack, ensureCpuVolume, hasCpuVolume, projectionLabel, REFORMAT_SCHEME } from './reformat'
import type { Projection, Vec3 } from './reformat'
import { SpineLabelTool, spineLevelAt } from './spine'
import { liverStore } from './liver/store'
import { drawLiverOverlay, type OverlayExtras } from './liver/overlay'

export type SlotKind = 'stack' | 'axial' | 'sagittal' | 'coronal'

export interface SlotInfo {
  id: string
  /** 'stack' = the original images; a plane = reformatted from the series volume (keys 3 / ?, or MPR). */
  kind: SlotKind
  seriesId: number | null
  studyId: number | null
  /** Window/level to keep when the tile switches between original and reformatted views. */
  voi?: { ww: number; wc: number } | null
  /**
   * A plane computed on the processor (reformat.ts) and shown as a normal stack, for series too
   * big for the graphics card; otherwise planes are volume views on the graphics card.
   */
  cpu?: boolean
  /** Thick slab of this tile: MIP / MinIP (planes only; 'axial' = a thick-slab axial reformat). */
  slab?: Projection | null
  /** Where to start when the tile's view is (re)built: a point of the plane to show (patient coordinates). */
  at?: Vec3 | null
}

/** Another MPR plane, drawn as a crosshair line on this tile (processor-reformatted MPR). */
export interface CrossPlane {
  normal: Vec3
  color: string
}

interface OverlayState {
  index: number
  total: number
  ww: number | null
  wc: number | null
  zoom: number
  markers: { top: string; bottom: string; left: string; right: string } | null
  imageId: string | undefined
  /** Reformatted views: the direction in which the slice number increases (camera normal). */
  dir: [number, number, number] | null
  /** Axial images: the spine level, from labels placed on the sagittal / coronal images. */
  level: string | null
  /** Crosshair lines (canvas pixels) of processor-reformatted MPR tiles. */
  lines: { x1: number; y1: number; x2: number; y2: number; color: string }[]
}

interface Props {
  slot: SlotInfo
  index: number
  active: boolean
  hidden: boolean
  study: StudyRow | null
  seriesLabel: string
  images: SeriesImages | null
  showOverlay: boolean
  /** Shown while the tile is being prepared (e.g. the volume for the MPR view). */
  loading: string | null
  onActivate: () => void
  onDoubleClick: () => void
  onDropSeries: (seriesId: number, studyId: number) => void
  onImageChange: (slotId: string, oldIndex: number, newIndex: number) => void
  /** Left-drag mode (W/L, zoom, pan); null while a measurement tool is active. */
  dragMode: DragMode | null
  onCycleDragMode: () => DragMode
  onContextMenu: (x: number, y: number) => void
  onSeriesDrag: (fromIndex: number, toIndex: number, copy: boolean) => void
  onMiddleDoubleClick: () => void
  showAnnotations: boolean
  scrollLinked: boolean
  /** Thin, or a MIP / MinIP slab (planes: the tile's own, or the MPR view's). */
  projection?: Projection | null
  /** Processor-reformatted MPR: the crosshair point (patient coordinates) and the other planes. */
  cross?: Vec3 | null
  crossPlanes?: CrossPlane[]
  /** The crosshair tool is active on this tile: left click / drag moves the crosshair. */
  crosshair?: boolean
  onCross?: (world: Vec3) => void
  /** Ctrl+Shift+wheel over the tile: a thicker (1) or thinner (-1) MIP / MinIP slab. */
  onSlabStep?: (dir: 1 | -1) => void
  /** A tile of the liver analysis: shows its masks and takes its mouse tools. */
  liver?: boolean
}

/**
 * The right button: a click opens the image tools menu, holding it and dragging zooms. Kept for
 * all tiles, because the button can be released (and Windows then sends the contextmenu event)
 * over another tile.
 */
const rightButton = { down: false, moved: false, menu: false, upAt: 0 }
// The contextmenu event that follows a right-drag zoom opens no menu (Windows sends it on release).
window.addEventListener(
  'contextmenu',
  (e) => {
    if (rightButton.moved && (rightButton.down || performance.now() - rightButton.upAt < 1000)) {
      e.preventDefault()
      e.stopPropagation()
    }
  },
  true
)

/** Index of the image whose position along the slice normal is nearest to `target` (0 if none is known). */
function nearestPosition(positions: (number | null)[], target: number): number {
  let best = 0
  let bestD = Infinity
  positions.forEach((pos, i) => {
    if (pos == null) return
    const d = Math.abs(pos - target)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

const ORIENT: Record<Exclude<SlotKind, 'stack'>, Enums.OrientationAxis> = {
  axial: Enums.OrientationAxis.AXIAL,
  sagittal: Enums.OrientationAxis.SAGITTAL,
  coronal: Enums.OrientationAxis.CORONAL
}

export function Viewport(p: Props) {
  const elRef = useRef<HTMLDivElement>(null)
  const [ov, setOv] = useState<OverlayState>({
    index: 0,
    total: 0,
    ww: null,
    wc: null,
    zoom: 1,
    markers: null,
    imageId: undefined,
    dir: null,
    level: null,
    lines: []
  })
  const [dropping, setDropping] = useState(false)
  const lastIndex = useRef(0)
  const raf = useRef(0)
  const onImageChange = useRef(p.onImageChange)
  onImageChange.current = p.onImageChange
  const propsRef = useRef(p)
  propsRef.current = p
  const slotRef = useRef<HTMLDivElement>(null)
  const liverRef = useRef<HTMLCanvasElement>(null)
  /** Brush cursor, finding radius or cut line being drawn on this tile (liver analysis). */
  const liverExtras = useRef<OverlayExtras>({})
  /** Left drag in progress; `at` = where a zoom started (canvas pixels), the point that stays put. */
  const drag = useRef<{ mode: DragMode; x: number; y: number; moved: boolean; at: [number, number] | null } | null>(null)
  const suppressMenu = useRef(false)
  const lastMiddle = useRef(0)
  const { id, kind } = p.slot
  /** A plane computed on the processor: shown in a normal stack viewport. */
  const cpu = kind !== 'stack' && !!p.slot.cpu
  /** The thick slab as a value for effect dependencies ('' = thin). */
  const projKey = p.projection && p.projection.mm > 0 ? `${p.projection.mode}:${p.projection.mm}` : ''
  /** Which way the image number of a processor-reformatted plane grows (for the scroll bar). */
  const planeDir = useRef<Vec3 | null>(null)
  const refreshRef = useRef<() => void>(() => {})

  // ---------------------------------------------------------------- Synapse-style mouse
  // Left drag = window/level (or zoom/pan); while holding the left button, each right click
  // switches W/L -> Zoom -> Pan. Alt+drag = W/L, Alt+Ctrl = zoom, Alt+Shift = pan.
  // Shift+drag moves the series to another tile, Ctrl+drag copies it. Right click = menu;
  // holding the right button and dragging zooms.
  const startManipulation = (mode: DragMode, cx: number, cy: number) => {
    const vp = getEngine().getViewport(id)
    const el = elRef.current
    if (!vp || !el) return
    const rect = el.getBoundingClientRect()
    const voi = getVoi(vp)
    let ww = voi?.ww ?? 400
    let wc = voi?.wc ?? 40
    const mult = voiMultiplier(vp)
    drag.current = { mode, x: cx, y: cy, moved: false, at: null }
    const move = (ev: MouseEvent) => {
      const d = drag.current
      if (!d) return
      const dx = ev.clientX - d.x
      const dy = ev.clientY - d.y
      if (!d.moved && Math.abs(dx) + Math.abs(dy) < 2) return
      d.moved = true
      if (d.mode === 'WindowLevel') {
        const now = getVoi(vp)
        if (now) {
          ww = now.ww
          wc = now.wc
        }
        ww = Math.max(1, ww + dx * mult)
        wc = wc + dy * mult
        applyVoi(vp, ww, wc)
      } else if (d.mode === 'Zoom') {
        d.at ??= [d.x - rect.left, d.y - rect.top]
        zoomBy(vp, Math.exp(-dy * 0.01), d.at)
      } else {
        panBy(vp, [d.x - rect.left, d.y - rect.top], [ev.clientX - rect.left, ev.clientY - rect.top])
      }
      d.x = ev.clientX
      d.y = ev.clientY
    }
    const up = (ev: MouseEvent) => {
      if (ev.button !== 0) return
      drag.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up, true)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up, true)
  }

  /** Liver analysis tools (left button): click, brush, finding radius, landmark, cut line. */
  const startLiverTool = (cx: number, cy: number): boolean => {
    const st = liverStore.state
    const tool = st.tool
    const vp = getEngine().getViewport(id)
    const el = elRef.current
    if (!tool || !vp || !el || !st.grid || st.busy) return false
    const r = el.getBoundingClientRect()
    const world = (x: number, y: number): Vec3 => {
      const w = vp.canvasToWorld([x - r.left, y - r.top])
      return [w[0], w[1], w[2]]
    }
    const redraw = () => refreshRef.current()
    const p0 = world(cx, cy)
    const drag = (onMove: (q: Vec3, ev: MouseEvent) => void, onUp: (q: Vec3) => void) => {
      const move = (ev: MouseEvent) => onMove(world(ev.clientX, ev.clientY), ev)
      const up = (ev: MouseEvent) => {
        if (ev.button !== 0) return
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up, true)
        onUp(world(ev.clientX, ev.clientY))
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up, true)
    }
    const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
    switch (tool) {
      case 'seed':
        void liverStore.clickLiver(p0)
        return true
      case 'exclude':
        void liverStore.excludeAt(p0)
        return true
      case 'landmark':
        liverStore.placeLandmark(p0)
        return true
      case 'cut':
        if (st.pendingCut) {
          liverStore.chooseCutSide(p0)
          return true
        }
        drag(
          (q) => {
            liverExtras.current.line = { a: p0, b: q }
            redraw()
          },
          (q) => {
            liverExtras.current.line = null
            const n = vp.getCamera().viewPlaneNormal
            if (n && dist(p0, q) > 5) liverStore.setPendingCut({ a: p0, b: q, view: [n[0], n[1], n[2]] })
            redraw()
          }
        )
        return true
      case 'lesion': {
        let radius = 0
        drag(
          (q) => {
            radius = dist(p0, q)
            liverExtras.current.lesion = { center: p0, radiusMm: radius }
            redraw()
          },
          () => {
            liverExtras.current.lesion = null
            redraw()
            void liverStore.lesionAt(p0, radius > 3 ? radius : 20)
          }
        )
        return true
      }
      default: {
        // Brushes: dabs along the drag, at most half a brush apart.
        let last = p0
        liverStore.paint(p0, 'start')
        drag(
          (q, ev) => {
            const steps = Math.ceil(dist(last, q) / Math.max(1, liverStore.state.brushMm / 2))
            for (let k = 1; k <= steps; k++)
              liverStore.paint([last[0] + ((q[0] - last[0]) * k) / steps, last[1] + ((q[1] - last[1]) * k) / steps, last[2] + ((q[2] - last[2]) * k) / steps], 'move')
            last = q
            liverExtras.current.cursor = { x: ev.clientX - r.left, y: ev.clientY - r.top }
          },
          () => liverStore.paint(last, 'end')
        )
        return true
      }
    }
  }

  /**
   * Right button held: drag up = zoom in, down = zoom out, around the point pressed. Released
   * without dragging, it is a right click: the image tools menu.
   */
  const startRightDrag = (cx: number, cy: number) => {
    const el = elRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const at: [number, number] = [cx - r.left, cy - r.top]
    Object.assign(rightButton, { down: true, moved: false, menu: false })
    let lastY = cy
    const end = () => {
      rightButton.down = false
      rightButton.upAt = performance.now()
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up, true)
    }
    const move = (ev: MouseEvent) => {
      if (!(ev.buttons & 2)) return end() // released outside the window
      if (!rightButton.moved && Math.abs(ev.clientX - cx) + Math.abs(ev.clientY - cy) < 4) return
      rightButton.moved = true
      const vp = getEngine().getViewport(id)
      if (vp && ev.clientY !== lastY) zoomBy(vp, Math.exp(-(ev.clientY - lastY) * 0.01), at)
      lastY = ev.clientY
    }
    const up = (ev: MouseEvent) => {
      if (ev.button !== 2) return
      end()
      // Linux sends contextmenu while the button is down (noted in rightButton.menu); Windows sends
      // it after this release, and the tile's handler opens the menu then.
      if (rightButton.menu && !rightButton.moved) propsRef.current.onContextMenu(ev.clientX, ev.clientY)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up, true)
  }

  /** Crosshair tool on a processor-reformatted MPR tile: the point under the mouse becomes the crosshair. */
  const startCross = (cx: number, cy: number) => {
    const vp = getEngine().getViewport(id)
    const el = elRef.current
    if (!vp || !el) return
    const at = (x: number, y: number) => {
      const r = el.getBoundingClientRect()
      const w = vp.canvasToWorld([x - r.left, y - r.top])
      propsRef.current.onCross?.([w[0], w[1], w[2]])
    }
    at(cx, cy)
    const move = (ev: MouseEvent) => at(ev.clientX, ev.clientY)
    const up = (ev: MouseEvent) => {
      if (ev.button !== 0) return
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up, true)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up, true)
  }

  const startSeriesDrag = (copy: boolean) => {
    document.body.classList.add(copy ? 'dragging-copy' : 'dragging-move')
    const up = (ev: MouseEvent) => {
      document.body.classList.remove('dragging-copy', 'dragging-move')
      window.removeEventListener('mouseup', up, true)
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-slot-index]') as HTMLElement | null
      const to = target ? Number(target.dataset.slotIndex) : -1
      if (to >= 0 && to !== propsRef.current.index) propsRef.current.onSeriesDrag(propsRef.current.index, to, copy)
    }
    window.addEventListener('mouseup', up, true)
  }

  const onMouseDownCapture = (e: ReactMouseEvent) => {
    p.onActivate()
    const el = elRef.current
    if (!el) return
    if ((e.target as HTMLElement).closest?.('.slicebar')) return // the scroll bar handles its own mouse
    if (e.button === 1) {
      const t = Date.now()
      if (t - lastMiddle.current < 350) {
        e.preventDefault()
        p.onMiddleDoubleClick()
      }
      lastMiddle.current = t
      return // middle drag = scroll (handled by Cornerstone)
    }
    if (e.button === 2) {
      e.preventDefault()
      e.stopPropagation()
      if (drag.current) {
        // Holding the left button: switch W/L -> zoom -> pan.
        drag.current.mode = p.onCycleDragMode()
        drag.current.at = null
        suppressMenu.current = true
      } else startRightDrag(e.clientX, e.clientY)
      return
    }
    if (e.button !== 0) return
    if (p.liver && liverStore.state.tool && !e.altKey && !e.shiftKey && !e.ctrlKey) {
      if (startLiverTool(e.clientX, e.clientY)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
    }
    if (p.crosshair && !e.altKey && !e.shiftKey && !e.ctrlKey) {
      e.preventDefault()
      e.stopPropagation()
      startCross(e.clientX, e.clientY)
      return
    }
    if ((e.shiftKey || e.ctrlKey) && !e.altKey) {
      // Move / copy the tile's view (axial, coronal or sagittal) to another tile; not the MPR tiles.
      if (p.slot.seriesId != null && !id.startsWith('mpr-')) {
        e.preventDefault()
        e.stopPropagation()
        startSeriesDrag(e.ctrlKey)
      }
      return
    }
    const rect = el.getBoundingClientRect()
    let mode: DragMode | null = null
    if (e.altKey) mode = e.ctrlKey ? 'Zoom' : e.shiftKey ? 'Pan' : 'WindowLevel'
    else if (p.dragMode && !annotationNear(el, e.clientX - rect.left, e.clientY - rect.top)) mode = p.dragMode
    if (!mode) return // a measurement tool is active, or an existing measurement is being edited
    e.preventDefault()
    e.stopPropagation()
    startManipulation(mode, e.clientX, e.clientY)
  }

  // Ctrl+Shift+wheel: a thicker / thinner MIP slab instead of the next image. Caught before
  // Cornerstone sees the wheel, and not passive, so the window does not zoom either.
  useEffect(() => {
    const root = slotRef.current
    if (!root) return
    let sum = 0
    let last = 0
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      // With Shift held, Windows turns the wheel sideways: the turn arrives as deltaX.
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      const px = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? d * 40 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? d * 400 : d
      if (e.timeStamp - last > 500) sum = 0
      last = e.timeStamp
      sum += px
      if (Math.abs(sum) < 40) return // a touchpad sends many small steps
      const dir = sum < 0 ? 1 : -1 // wheel turned away from you = thicker
      sum = 0
      propsRef.current.onSlabStep?.(dir)
    }
    root.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => root.removeEventListener('wheel', onWheel, { capture: true })
  }, [])

  // Liver analysis: redraw this tile's overlay when the masks, landmarks or display change.
  useEffect(() => {
    if (!p.liver) return
    const off = liverStore.subscribe(() => refreshRef.current())
    refreshRef.current()
    return () => {
      off()
      const c = liverRef.current
      c?.getContext('2d')?.clearRect(0, 0, c.width, c.height)
    }
  }, [p.liver])

  // Enable / disable the Cornerstone element for this slot.
  useEffect(() => {
    const element = elRef.current
    if (!element) return
    const engine = getEngine()
    // Original images, and planes computed on the processor, are stacks; other planes are volume views.
    const isStack = kind === 'stack' || cpu
    engine.enableElement({
      viewportId: id,
      type: isStack ? Enums.ViewportType.STACK : Enums.ViewportType.ORTHOGRAPHIC,
      element,
      defaultOptions: kind === 'stack' || cpu ? { background: [0, 0, 0] } : { background: [0, 0, 0], orientation: ORIENT[kind] }
    })
    // Tiles of the 3-plane MPR view on the graphics card use the crosshair tools; every other tile
    // (a single coronal/sagittal tile, processor-reformatted MPR tiles) keeps the normal ones.
    const group = csTools.ToolGroupManager.getToolGroup(isStack || !id.startsWith('mpr-') ? STACK_TOOLGROUP : MPR_TOOLGROUP)
    group?.addViewport(id, RENDERING_ENGINE_ID)

    const refresh = () => {
      cancelAnimationFrame(raf.current)
      raf.current = requestAnimationFrame(() => {
        const vp = engine.getViewport(id)
        if (!vp) return
        let index = 0
        let total = 0
        let imageId: string | undefined
        let dir: [number, number, number] | null = null
        if (isStack) {
          const sv = vp as Types.IStackViewport
          index = sv.getCurrentImageIdIndex()
          total = sv.getImageIds().length
          imageId = sv.getCurrentImageId()
          if (cpu) dir = planeDir.current
        } else {
          const vv = vp as Types.IVolumeViewport
          index = vv.getSliceIndex?.() ?? 0
          total = vv.getNumberOfSlices?.() ?? 0
          // The slice number of a volume view grows along the camera's view-plane normal.
          const n = vv.getCamera?.().viewPlaneNormal
          if (n) dir = [n[0], n[1], n[2]]
        }
        const voi = getVoi(vp)
        let zoom = 1
        try {
          zoom = vp.getZoom()
        } catch {
          /* not ready */
        }
        setOv({
          index,
          total,
          ww: voi?.ww ?? null,
          wc: voi?.wc ?? null,
          zoom,
          markers: orientationMarkers(vp),
          imageId,
          dir,
          level: spineLevelAt(vp),
          lines: crossLines(vp)
        })
        if (propsRef.current.liver && liverRef.current) drawLiverOverlay(liverRef.current, vp, liverStore.state, liverExtras.current)
      })
    }
    refreshRef.current = refresh
    const onNewImage = (e: Event) => {
      const detail = (e as CustomEvent<{ imageIdIndex: number }>).detail
      const old = lastIndex.current
      lastIndex.current = detail.imageIdIndex
      if (old !== detail.imageIdIndex) onImageChange.current(id, old, detail.imageIdIndex)
      refresh()
    }
    const events = [Enums.Events.VOI_MODIFIED, Enums.Events.CAMERA_MODIFIED, Enums.Events.IMAGE_RENDERED, Enums.Events.VOLUME_NEW_IMAGE]
    for (const ev of events) element.addEventListener(ev, refresh)
    element.addEventListener(Enums.Events.STACK_NEW_IMAGE, onNewImage)
    const prevent = (e: Event) => e.preventDefault()
    element.addEventListener('contextmenu', prevent)
    // Spine labels placed, moved or deleted in another tile show here too (in every plane) and
    // change the level shown on axial images.
    const onAnnotation = (e: Event) => {
      const a = (e as CustomEvent<{ annotation?: csTools.Types.Annotation }>).detail?.annotation
      if (a && a.metadata?.toolName !== SpineLabelTool.toolName) return
      refresh()
      try {
        csTools.utilities.triggerAnnotationRenderForViewportIds([id])
      } catch {
        /* not rendered yet */
      }
    }
    const annotationEvents = [
      csTools.Enums.Events.ANNOTATION_ADDED,
      csTools.Enums.Events.ANNOTATION_COMPLETED,
      csTools.Enums.Events.ANNOTATION_MODIFIED,
      csTools.Enums.Events.ANNOTATION_REMOVED
    ]
    for (const ev of annotationEvents) eventTarget.addEventListener(ev, onAnnotation)

    return () => {
      for (const ev of events) element.removeEventListener(ev, refresh)
      element.removeEventListener(Enums.Events.STACK_NEW_IMAGE, onNewImage)
      element.removeEventListener('contextmenu', prevent)
      for (const ev of annotationEvents) eventTarget.removeEventListener(ev, onAnnotation)
      cancelAnimationFrame(raf.current)
      try {
        csTools.utilities.cine.stopClip(element)
      } catch {
        /* not playing */
      }
      try {
        if (isStack) csTools.utilities.stackPrefetch.disable(element)
      } catch {
        /* ignore */
      }
      group?.removeViewports(RENDERING_ENGINE_ID, id)
      engine.disableElement(id)
      refreshRef.current = () => {}
    }
  }, [id, kind, cpu])

  /**
   * Crosshair of processor-reformatted MPR: where each other plane cuts this one, through the
   * crosshair point (canvas pixels).
   */
  const crossLines = (vp: Types.IViewport): OverlayState['lines'] => {
    const { cross, crossPlanes } = propsRef.current
    if (!cross || !crossPlanes?.length) return []
    try {
      const n = vp.getCamera().viewPlaneNormal
      if (!n) return []
      const out: OverlayState['lines'] = []
      for (const pl of crossPlanes) {
        const m = pl.normal
        // The line runs along both planes: perpendicular to both normals.
        const u = [n[1] * m[2] - n[2] * m[1], n[2] * m[0] - n[0] * m[2], n[0] * m[1] - n[1] * m[0]]
        const len = Math.hypot(u[0], u[1], u[2])
        if (len < 1e-3) continue
        const far = 2000 / len
        const a = vp.worldToCanvas([cross[0] + u[0] * far, cross[1] + u[1] * far, cross[2] + u[2] * far])
        const b = vp.worldToCanvas([cross[0] - u[0] * far, cross[1] - u[1] * far, cross[2] - u[2] * far])
        out.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1], color: pl.color })
      }
      return out
    } catch {
      return []
    }
  }

  // The crosshair moved (another tile was clicked or scrolled): redraw its lines here.
  useEffect(() => {
    refreshRef.current()
  }, [p.cross, p.crossPlanes])

  // Load the series into a stack viewport.
  useEffect(() => {
    if (kind !== 'stack') return
    const element = elRef.current
    const engine = getEngine()
    const vp = engine.getViewport(id) as Types.IStackViewport | undefined
    if (!vp || !element) return
    if (!p.images || p.images.imageIds.length === 0) return
    let cancelled = false
    // Coming back from a thick-slab axial view (or moved from another tile): the image at that level.
    const at = p.slot.at
    const n = p.images.normal
    const start = at && n ? nearestPosition(p.images.positions, at[0] * n[0] + at[1] * n[1] + at[2] * n[2]) : 0
    lastIndex.current = start
    void vp
      .setStack(p.images.imageIds, start)
      .then(() => {
        if (cancelled) return
        if (p.slot.voi) applyVoi(vp, p.slot.voi.ww, p.slot.voi.wc)
        vp.render()
        try {
          csTools.utilities.stackPrefetch.enable(element)
        } catch {
          /* optional */
        }
      })
      .catch((e: unknown) => console.error('setStack failed', e))
    return () => {
      cancelled = true
    }
  }, [id, kind, p.images])

  // Coronal / sagittal view of the series in this tile (keys 3 and ?) on the graphics card: load the series volume.
  const [volLoading, setVolLoading] = useState<string | null>(null)
  useEffect(() => {
    if (kind === 'stack' || cpu || id.startsWith('mpr-')) return
    const seriesId = p.slot.seriesId
    const imgs = p.images
    if (seriesId == null || !imgs || imgs.imageIds.length === 0) return
    let cancelled = false
    void (async () => {
      try {
        setVolLoading('Loading images…')
        const plan = await ensureVolume(seriesId, imgs.imageIds)
        if (cancelled) return
        setVolLoading(`Building ${kind} view…`)
        const vp = getEngine().getViewport(id) as Types.IVolumeViewport | undefined
        if (!vp) return
        await vp.setVolumes([{ volumeId: plan.volumeId }])
        if (cancelled) return
        if (p.slot.at) moveViewTo(vp, p.slot.at) // e.g. axial images -> thick-slab axial at the same level
        applyProjection(vp, propsRef.current.projection)
        if (p.slot.voi) applyVoi(vp as unknown as Types.IViewport, p.slot.voi.ww, p.slot.voi.wc)
        vp.render()
        setVolLoading(null)
      } catch (e) {
        console.error(e)
        if (!cancelled) setVolLoading(`Could not build the ${kind} view: ${(e as Error).message}`)
      }
    })()
    return () => {
      cancelled = true
      setVolLoading(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, kind, cpu, p.images, p.slot.seriesId])

  // MIP / MinIP chosen for a plane on the graphics card (the MPR view sets its own tiles).
  useEffect(() => {
    if (kind === 'stack' || cpu || id.startsWith('mpr-')) return
    const vp = getEngine().getViewport(id) as Types.IVolumeViewport | undefined
    if (!vp || !vp.getActors().length) return // still loading: applied when the volume is set
    applyProjection(vp, propsRef.current.projection)
    vp.render()
  }, [id, kind, cpu, projKey])

  // A plane computed on the processor (series too big for the graphics card, MPR tiles too): load
  // the series into memory once, then show the plane's images as a normal stack. A new slab
  // thickness swaps in the MIP images of the same position, keeping zoom, pan and window.
  useEffect(() => {
    if (!cpu) return // (cpu implies a plane, not 'stack')
    const seriesId = p.slot.seriesId
    const imgs = p.images
    if (seriesId == null || !imgs || imgs.imageIds.length === 0) return
    const plane = kind
    let cancelled = false
    void (async () => {
      try {
        if (!hasCpuVolume(seriesId)) setVolLoading('Loading images…')
        const loaded = await ensureCpuVolume(imgs, (done, total) => {
          if (!cancelled) setVolLoading(`Loading images… ${Math.floor((done / total) * 100)}%`)
        })
        if (cancelled || !loaded) return
        const vp = getEngine().getViewport(id) as Types.IStackViewport | undefined
        if (!vp) return
        const stack = cpuPlaneStack(seriesId, plane, propsRef.current.projection ?? null)
        planeDir.current = stack.dir
        const shown = vp.getImageIds()
        const prefix = `${REFORMAT_SCHEME}:${seriesId}/${plane}/`
        const sameImages = shown.length === stack.imageIds.length && !!shown[0]?.startsWith(prefix)
        // Same plane, other slab: keep the position and how the image is shown.
        const keep = sameImages
          ? { index: vp.getCurrentImageIdIndex(), voi: getVoi(vp), invert: vp.getProperties().invert, view: vp.getViewPresentation() }
          : null
        // Otherwise: the level asked for (e.g. axial images -> thick-slab axial), the MPR crosshair, or the middle.
        const at = p.slot.at ?? propsRef.current.cross
        const start = keep ? keep.index : at ? cpuPlaneIndexAt(seriesId, plane, at) : stack.imageIds.length >> 1
        await vp.setStack(stack.imageIds, start)
        if (cancelled) return
        if (keep) {
          vp.setViewPresentation(keep.view)
          if (keep.invert) vp.setProperties({ invert: true })
          if (keep.voi) applyVoi(vp, keep.voi.ww, keep.voi.wc)
        } else if (p.slot.voi) applyVoi(vp, p.slot.voi.ww, p.slot.voi.wc)
        vp.render()
        setVolLoading(null)
        refreshRef.current()
      } catch (e) {
        console.error(e)
        if (!cancelled) setVolLoading(`Could not build the ${plane} view: ${(e as Error).message}`)
      }
    })()
    return () => {
      cancelled = true
      setVolLoading(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, kind, cpu, p.images, p.slot.seriesId, projKey])

  // Scroll bar: which way the slices run (H/F, A/P or R/L at its ends).
  const stackDir = useMemo(() => {
    const imgs = p.images
    if (!imgs?.normal) return null
    const pos = imgs.positions.filter((x): x is number => x != null)
    if (pos.length < 2 || pos[0] === pos[pos.length - 1]) return null
    const sign = Math.sign(pos[pos.length - 1] - pos[0])
    return [imgs.normal[0] * sign, imgs.normal[1] * sign, imgs.normal[2] * sign]
  }, [p.images])
  const axis = sliceAxis(kind === 'stack' ? stackDir : ov.dir)

  const seek = (target: number) => {
    const vp = getEngine().getViewport(id)
    if (!vp || ov.total < 2) return
    const i = Math.min(ov.total - 1, Math.max(0, target))
    if (vp.type === Enums.ViewportType.STACK) void (vp as Types.IStackViewport).setImageIdIndex(i)
    else void csUtils.jumpToSlice(vp.element as HTMLDivElement, { imageIndex: i })
  }
  const step = (delta: number) => {
    const vp = getEngine().getViewport(id)
    if (vp && delta) csUtils.scroll(vp as Types.IStackViewport, { delta })
  }

  const nat = getNatural(ov.imageId)
  const s = p.study
  const isCT = str(nat?.Modality) === 'CT' || (p.study?.modalities ?? '').startsWith('CT')
  const ps = nat?.PixelSpacing as number[] | undefined
  const cols = Number(nat?.Columns ?? 0)
  const rows = Number(nat?.Rows ?? 0)
  const fov = ps && cols && rows ? `${((cols * ps[1]) / 10).toFixed(1)}x${((rows * ps[0]) / 10).toFixed(1)}cm` : ''
  const hasImages = kind !== 'stack' || (p.images?.imageIds.length ?? 0) > 0

  return (
    <div
      className={`v-slot ${p.active ? 'active' : ''} ${dropping ? 'drop' : ''} ${p.hidden ? 'hidden' : ''} ${p.showAnnotations ? '' : 'hide-annotations'}`}
      data-slot-index={p.index}
      onMouseDownCapture={onMouseDownCapture}
      ref={slotRef}
      onMouseMove={(e) => {
        if (!p.liver || !liverStore.state.tool || !/paint|erase/.test(liverStore.state.tool)) return
        const r = elRef.current?.getBoundingClientRect()
        if (!r) return
        liverExtras.current.cursor = { x: e.clientX - r.left, y: e.clientY - r.top }
        refreshRef.current()
      }}
      onMouseLeave={() => {
        if (!p.liver || !liverExtras.current.cursor) return
        liverExtras.current.cursor = null
        refreshRef.current()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        if (suppressMenu.current) {
          suppressMenu.current = false
          return
        }
        // Button still down (Linux sends the event on press): the menu opens on release, unless
        // the mouse was dragged to zoom.
        if (rightButton.down) {
          rightButton.menu = true
          return
        }
        p.onContextMenu(e.clientX, e.clientY)
      }}
      onDoubleClick={(e) => e.button === 0 && !e.altKey && p.onDoubleClick()}
      onDragOver={(e) => {
        // A series from the strip can be dropped on any tile: axial, coronal / sagittal or MPR.
        if (!e.dataTransfer.types.includes('application/x-series')) return
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        setDropping(false)
        const data = e.dataTransfer.getData('application/x-series')
        if (!data) return
        e.preventDefault()
        const { seriesId, studyId } = JSON.parse(data) as { seriesId: number; studyId: number }
        p.onDropSeries(seriesId, studyId)
      }}
    >
      <div ref={elRef} className="v-element" />
      {p.liver && <canvas ref={liverRef} className="v-liver" />}
      {!hasImages && <div className="v-empty">Drag a series here, or click a thumbnail above</div>}
      {(p.loading || volLoading) && <div className="v-loading">{p.loading || volLoading}</div>}
      {kind !== 'stack' && (
        <div
          className="mpr-label"
          title={
            cpu
              ? 'Reformatted on the processor from every image of the series (the series is larger than this graphics card holds in one piece)'
              : undefined
          }
        >
          {kind.toUpperCase()}
          {p.projection && p.projection.mm > 0 ? ` · ${projectionLabel(p.projection)}` : ''}
        </div>
      )}
      {ov.lines.length > 0 && (
        <svg className="v-cross">
          {ov.lines.map((l, k) => (
            <line key={k} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={l.color} strokeWidth={1} />
          ))}
        </svg>
      )}
      {p.scrollLinked && hasImages && <div className="link-badge" title="Linked scrolling (S)">LINK</div>}
      {p.showOverlay && hasImages && s && (
        <>
          <div className="ov tl">
            <div className="name">{s.patientName}</div>
            <div>{s.patientId}</div>
            <div>{formatDicomDate(s.birthDate)}</div>
            <div>{[formatAge(s.age, s.birthDate, s.studyDate), formatSex(s.sex)].filter(Boolean).join(' ')}</div>
          </div>
          <div className="ov tr">
            <div>{s.institution}</div>
            <div>{s.description}</div>
            <div>{p.seriesLabel}</div>
            <div>{formatDicomDateTime(s.studyDate, s.studyTime)}</div>
            <div>{s.accession}</div>
            {nat?.SliceLocation != null && <div>LOC: {num(nat.SliceLocation, 2)}</div>}
            {nat?.SliceThickness != null && (
              <div>
                THK: {num(nat.SliceThickness, 2)}
                {nat?.SpacingBetweenSlices != null ? ` SP: ${num(nat.SpacingBetweenSlices, 2)}` : ''}
              </div>
            )}
            {nat?.PatientPosition != null && <div>{str(nat.PatientPosition)}</div>}
          </div>
          <div className="ov bl">
            {ov.level && (
              <div className="spine-level" title="Estimated from the spine labels on the sagittal / coronal images">
                Level ≈ {ov.level}
              </div>
            )}
            {isCT ? (
              <>
                {nat?.GantryDetectorTilt != null && <div>Tilt: {num(nat.GantryDetectorTilt)}</div>}
                {nat?.XRayTubeCurrent != null && <div>mA: {num(nat.XRayTubeCurrent)}</div>}
                {nat?.KVP != null && <div>kVp: {num(nat.KVP)}</div>}
              </>
            ) : (
              <>
                {nat?.RepetitionTime != null && <div>TR: {num(nat.RepetitionTime)}</div>}
                {nat?.EchoTime != null && <div>TE: {num(nat.EchoTime)}</div>}
                {nat?.MagneticFieldStrength != null && <div>{num(nat.MagneticFieldStrength)}T</div>}
              </>
            )}
            {nat?.AcquisitionNumber != null && <div>Acq no: {num(nat.AcquisitionNumber)}</div>}
            <div>
              Image: {ov.total ? ov.index + 1 : 0} of {ov.total}
            </div>
          </div>
          <div className="ov br">
            <div>Z: {ov.zoom.toFixed(2)}</div>
            {ov.ww != null && ov.wc != null && (
              <div>
                C: {Math.round(ov.wc)} W: {Math.round(ov.ww)}
              </div>
            )}
            {fov && <div>DFOV: {fov}</div>}
            <div>
              IM: {num(nat?.InstanceNumber) || ov.index + 1} SE: {num(nat?.SeriesNumber) || '—'}
            </div>
          </div>
        </>
      )}
      {p.showOverlay && hasImages && ov.markers && (
        <>
          <div className="orient top">{ov.markers.top}</div>
          <div className="orient bottom">{ov.markers.bottom}</div>
          <div className="orient left">{ov.markers.left}</div>
          <div className="orient right">{ov.markers.right}</div>
        </>
      )}
      {hasImages && ov.total > 1 && !p.loading && !volLoading && (
        <SliceBar index={ov.index} total={ov.total} axis={axis} onSeek={seek} onStep={step} />
      )}
    </div>
  )
}

/**
 * Slice scroll bar at the side of the tile (GE/Synapse style): the ends say where the slices
 * go (H/F, A/P or R/L); click or drag the handle to move through the images, wheel = ±1 image.
 */
function SliceBar(p: { index: number; total: number; axis: SliceAxis | null; onSeek: (i: number) => void; onStep: (d: number) => void }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const last = p.total - 1
  const frac = last > 0 ? p.index / last : 0
  const t = p.axis?.reversed ? 1 - frac : frac
  const indexAt = (clientY: number) => {
    const r = trackRef.current?.getBoundingClientRect()
    if (!r || r.height <= 0) return p.index
    const f = Math.min(1, Math.max(0, (clientY - r.top) / r.height))
    return Math.round((p.axis?.reversed ? 1 - f : f) * last)
  }
  const names: Record<string, string> = { H: 'head', F: 'feet', A: 'front', P: 'back', R: 'right', L: 'left' }
  const title = p.axis
    ? `Drag to scroll through the images (${p.axis.top} = ${names[p.axis.top]}, ${p.axis.bottom} = ${names[p.axis.bottom]})`
    : 'Drag to scroll through the images'
  return (
    <div
      className={`slicebar ${dragging ? 'dragging' : ''}`}
      title={title}
      onMouseDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        p.onSeek(indexAt(e.clientY))
        setDragging(true)
        const move = (ev: MouseEvent) => p.onSeek(indexAt(ev.clientY))
        const up = () => {
          setDragging(false)
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }}
      onWheel={(e) => {
        e.stopPropagation()
        p.onStep(Math.sign(e.deltaY)) // same as the wheel over the image
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {p.axis && <div className="slicebar-end">{p.axis.top}</div>}
      <div className="slicebar-track" ref={trackRef}>
        <div className="slicebar-line" />
        <div className="slicebar-thumb" style={{ top: `${t * 100}%` }}>
          {dragging && (
            <span className="slicebar-pos">
              {p.index + 1}/{p.total}
            </span>
          )}
        </div>
      </div>
      {p.axis && <div className="slicebar-end">{p.axis.bottom}</div>}
    </div>
  )
}
