import { useEffect, useRef, useState } from 'react'
import { Enums, utilities as csUtils } from '@cornerstonejs/core'
import type { Types } from '@cornerstonejs/core'
import * as csTools from '@cornerstonejs/tools'
import type { SeriesImages, StudyRow } from '@shared/types'
import { formatAge, formatDicomDate, formatDicomDateTime, formatSex } from '@shared/format'
import { getEngine, getNatural, getVoi, MPR_TOOLGROUP, num, orientationMarkers, RENDERING_ENGINE_ID, STACK_TOOLGROUP, str } from './cs'

export type SlotKind = 'stack' | 'axial' | 'sagittal' | 'coronal'

export interface SlotInfo {
  id: string
  kind: SlotKind
  seriesId: number | null
  studyId: number | null
}

interface OverlayState {
  index: number
  total: number
  ww: number | null
  wc: number | null
  zoom: number
  markers: { top: string; bottom: string; left: string; right: string } | null
  imageId: string | undefined
}

interface Props {
  slot: SlotInfo
  active: boolean
  hidden: boolean
  study: StudyRow | null
  seriesLabel: string
  images: SeriesImages | null
  showOverlay: boolean
  loadingText: string | null
  onActivate: () => void
  onDoubleClick: () => void
  onDropSeries: (seriesId: number, studyId: number) => void
  onImageChange: (slotId: string, oldIndex: number, newIndex: number) => void
}

const ORIENT: Record<Exclude<SlotKind, 'stack'>, Enums.OrientationAxis> = {
  axial: Enums.OrientationAxis.AXIAL,
  sagittal: Enums.OrientationAxis.SAGITTAL,
  coronal: Enums.OrientationAxis.CORONAL
}

export function Viewport(p: Props) {
  const elRef = useRef<HTMLDivElement>(null)
  const [ov, setOv] = useState<OverlayState>({ index: 0, total: 0, ww: null, wc: null, zoom: 1, markers: null, imageId: undefined })
  const [dropping, setDropping] = useState(false)
  const lastIndex = useRef(0)
  const raf = useRef(0)
  const onImageChange = useRef(p.onImageChange)
  onImageChange.current = p.onImageChange
  const { id, kind } = p.slot

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
    const group = csTools.ToolGroupManager.getToolGroup(isStack ? STACK_TOOLGROUP : MPR_TOOLGROUP)
    group?.addViewport(id, RENDERING_ENGINE_ID)

    const refresh = () => {
      cancelAnimationFrame(raf.current)
      raf.current = requestAnimationFrame(() => {
        const vp = engine.getViewport(id)
        if (!vp) return
        let index = 0
        let total = 0
        let imageId: string | undefined
        if (isStack) {
          const sv = vp as Types.IStackViewport
          index = sv.getCurrentImageIdIndex()
          total = sv.getImageIds().length
          imageId = sv.getCurrentImageId()
        } else {
          const vv = vp as Types.IVolumeViewport
          index = vv.getSliceIndex?.() ?? 0
          total = vv.getNumberOfSlices?.() ?? 0
        }
        const voi = getVoi(vp)
        let zoom = 1
        try {
          zoom = vp.getZoom()
        } catch {
          /* not ready */
        }
        setOv({ index, total, ww: voi?.ww ?? null, wc: voi?.wc ?? null, zoom, markers: orientationMarkers(vp), imageId })
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

  // Scrollbar drag.
  const scrollTo = (clientY: number, track: HTMLDivElement) => {
    const r = track.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (clientY - r.top) / r.height))
    const vp = getEngine().getViewport(id)
    if (!vp || ov.total < 2) return
    const target = Math.round(frac * (ov.total - 1))
    if (kind === 'stack') void (vp as Types.IStackViewport).setImageIdIndex(target)
    else void csUtils.jumpToSlice(vp.element as HTMLDivElement, { imageIndex: target })
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
      className={`v-slot ${p.active ? 'active' : ''} ${dropping ? 'drop' : ''} ${p.hidden ? 'hidden' : ''}`}
      onMouseDownCapture={p.onActivate}
      onDoubleClick={p.onDoubleClick}
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
      {p.loadingText && <div className="v-loading">{p.loadingText}</div>}
      {kind !== 'stack' && <div className="mpr-label">{kind.toUpperCase()}</div>}
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
      {hasImages && ov.total > 1 && (
        <div
          className="scrollbar"
          title="Drag to scroll through images"
          onMouseDown={(e) => {
            e.stopPropagation()
            const track = e.currentTarget
            scrollTo(e.clientY, track)
            const move = (ev: MouseEvent) => scrollTo(ev.clientY, track)
            const up = () => {
              window.removeEventListener('mousemove', move)
              window.removeEventListener('mouseup', up)
            }
            window.addEventListener('mousemove', move)
            window.addEventListener('mouseup', up)
          }}
        >
          <div
            className="scrollbar-thumb"
            style={{
              top: `${(ov.index / Math.max(1, ov.total)) * 100}%`,
              height: `${Math.max(100 / ov.total, 2)}%`
            }}
          />
        </div>
      )}
    </div>
  )
}
