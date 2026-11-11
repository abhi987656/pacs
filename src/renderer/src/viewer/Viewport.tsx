import { useEffect, useMemo, useRef, useState } from 'react'
import { Enums, utilities as csUtils } from '@cornerstonejs/core'
import type { Types } from '@cornerstonejs/core'
import * as csTools from '@cornerstonejs/tools'
import type { SeriesImages, StudyRow } from '@shared/types'
import { formatAge, formatDicomDate, formatDicomDateTime, formatSex } from '@shared/format'
import type { MouseEvent as ReactMouseEvent } from 'react'
import {
  annotationNear,
  applyVoi,
  ensureVolume,
  getEngine,
  getNatural,
  getVoi,
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

export type SlotKind = 'stack' | 'axial' | 'sagittal' | 'coronal'

/** A tile that is still being prepared (e.g. the volume for a coronal view): text and 0–100 %. */
export interface TileLoading {
  text: string
  pct: number | null
}

export interface SlotInfo {
  id: string
  /** 'stack' = the original images; a plane = reformatted from the series volume (keys 3 / ?, or MPR). */
  kind: SlotKind
  seriesId: number | null
  studyId: number | null
  /** Window/level to keep when the tile switches between original and reformatted views. */
  voi?: { ww: number; wc: number } | null
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
  loading: TileLoading | null
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
}

const ORIENT: Record<Exclude<SlotKind, 'stack'>, Enums.OrientationAxis> = {
  axial: Enums.OrientationAxis.AXIAL,
  sagittal: Enums.OrientationAxis.SAGITTAL,
  coronal: Enums.OrientationAxis.CORONAL
}

export function Viewport(p: Props) {
  const elRef = useRef<HTMLDivElement>(null)
  const [ov, setOv] = useState<OverlayState>({ index: 0, total: 0, ww: null, wc: null, zoom: 1, markers: null, imageId: undefined, dir: null })
  const [dropping, setDropping] = useState(false)
  const lastIndex = useRef(0)
  const raf = useRef(0)
  const onImageChange = useRef(p.onImageChange)
  onImageChange.current = p.onImageChange
  const propsRef = useRef(p)
  propsRef.current = p
  const drag = useRef<{ mode: DragMode; x: number; y: number; moved: boolean } | null>(null)
  const suppressMenu = useRef(false)
  const lastMiddle = useRef(0)
  const { id, kind } = p.slot

  // ---------------------------------------------------------------- Synapse-style mouse
  // Left drag = window/level (or zoom/pan); while holding the left button, each right click
  // switches W/L -> Zoom -> Pan. Alt+drag = W/L, Alt+Ctrl = zoom, Alt+Shift = pan.
  // Shift+drag moves the series to another tile, Ctrl+drag copies it. Right click = menu.
  const startManipulation = (mode: DragMode, cx: number, cy: number) => {
    const vp = getEngine().getViewport(id)
    const el = elRef.current
    if (!vp || !el) return
    const rect = el.getBoundingClientRect()
    const voi = getVoi(vp)
    let ww = voi?.ww ?? 400
    let wc = voi?.wc ?? 40
    const mult = voiMultiplier(vp)
    drag.current = { mode, x: cx, y: cy, moved: false }
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
        zoomBy(vp, Math.exp(-dy * 0.01))
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
      if (drag.current) {
        drag.current.mode = p.onCycleDragMode()
        suppressMenu.current = true
        e.preventDefault()
        e.stopPropagation()
      }
      return
    }
    if (e.button !== 0) return
    if ((e.shiftKey || e.ctrlKey) && !e.altKey) {
      if (kind === 'stack' && p.slot.seriesId != null) {
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

  // Enable / disable the Cornerstone element for this slot.
  useEffect(() => {
    const element = elRef.current
    if (!element) return
    const engine = getEngine()
    const isStack = kind === 'stack'
    engine.enableElement({
      viewportId: id,
      type: isStack ? Enums.ViewportType.STACK : Enums.ViewportType.ORTHOGRAPHIC,
      element,
      defaultOptions: isStack ? { background: [0, 0, 0] } : { background: [0, 0, 0], orientation: ORIENT[kind] }
    })
    // Tiles of the 3-plane MPR view use the crosshair tools; a single coronal/sagittal tile keeps the normal ones.
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
        setOv({ index, total, ww: voi?.ww ?? null, wc: voi?.wc ?? null, zoom, markers: orientationMarkers(vp), imageId, dir })
      })
    }
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

    return () => {
      for (const ev of events) element.removeEventListener(ev, refresh)
      element.removeEventListener(Enums.Events.STACK_NEW_IMAGE, onNewImage)
      element.removeEventListener('contextmenu', prevent)
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
    }
  }, [id, kind])

  // Load the series into a stack viewport.
  useEffect(() => {
    if (kind !== 'stack') return
    const element = elRef.current
    const engine = getEngine()
    const vp = engine.getViewport(id) as Types.IStackViewport | undefined
    if (!vp || !element) return
    if (!p.images || p.images.imageIds.length === 0) return
    let cancelled = false
    lastIndex.current = 0
    void vp
      .setStack(p.images.imageIds, 0)
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

  // Coronal / sagittal view of the series in this tile (keys 3 and ?): build the series volume
  // (shown as one percentage); the view appears when it is complete.
  const [volLoading, setVolLoading] = useState<TileLoading | null>(null)
  useEffect(() => {
    if (kind === 'stack' || id.startsWith('mpr-')) return
    const seriesId = p.slot.seriesId
    const imgs = p.images
    if (seriesId == null || !imgs || imgs.imageIds.length === 0) return
    let cancelled = false
    const label = `Building ${kind} view`
    void (async () => {
      try {
        setVolLoading({ text: label, pct: 0 })
        const volumeId = await ensureVolume(seriesId, imgs.imageIds, (pct) => {
          if (!cancelled) setVolLoading({ text: label, pct })
        })
        if (cancelled) return
        const vp = getEngine().getViewport(id) as Types.IVolumeViewport | undefined
        if (!vp) return
        await vp.setVolumes([{ volumeId }])
        if (cancelled) return
        if (p.slot.voi) applyVoi(vp as unknown as Types.IViewport, p.slot.voi.ww, p.slot.voi.wc)
        vp.render()
        setVolLoading(null)
      } catch (e) {
        console.error(e)
        if (!cancelled) setVolLoading({ text: `Could not build the ${kind} view: ${(e as Error).message}`, pct: null })
      }
    })()
    return () => {
      cancelled = true
      setVolLoading(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, kind, p.images, p.slot.seriesId])

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
    if (kind === 'stack') void (vp as Types.IStackViewport).setImageIdIndex(i)
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
      onContextMenu={(e) => {
        e.preventDefault()
        if (suppressMenu.current) {
          suppressMenu.current = false
          return
        }
        p.onContextMenu(e.clientX, e.clientY)
      }}
      onDoubleClick={(e) => e.button === 0 && !e.altKey && p.onDoubleClick()}
      onDragOver={(e) => {
        if (kind !== 'stack') return
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
      {!hasImages && <div className="v-empty">Drag a series here, or click a thumbnail above</div>}
      {(p.loading || volLoading) && <LoadingBox loading={(p.loading ?? volLoading)!} />}
      {kind !== 'stack' && <div className="mpr-label">{kind.toUpperCase()}</div>}
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

function LoadingBox({ loading }: { loading: TileLoading }) {
  return (
    <div className="v-loading">
      <div className="v-loading-text">
        {loading.text}
        {loading.pct != null && <b> {loading.pct}%</b>}
      </div>
      {loading.pct != null && (
        <div className="v-loading-bar">
          <div style={{ width: `${loading.pct}%` }} />
        </div>
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
