import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Enums as CoreEnums, eventTarget, setVolumesForViewports, utilities as csUtils } from '@cornerstonejs/core'
import type { Types } from '@cornerstonejs/core'
import * as csTools from '@cornerstonejs/tools'
import {
  ArrowUpRight,
  Bone,
  Bookmark,
  Box,
  Captions,
  ChevronsUpDown,
  Circle,
  CircleHelp,
  Columns2,
  Contrast,
  Crosshair,
  Ellipse,
  Eraser,
  FileText,
  Hand,
  Heart,
  Info,
  Lasso,
  Layers,
  Link,
  Link2,
  Lock,
  LockOpen,
  Maximize,
  Mic,
  MicOff,
  Minimize,
  PanelTop,
  Pause,
  Play,
  RotateCcw,
  Ruler,
  Save,
  ScanLine,
  Search,
  StickyNote,
  SunMoon,
  Triangle,
  Type,
  X,
  ZoomIn
} from 'lucide-react'
import type { SeriesImages, SeriesRow, StudyRow } from '@shared/types'
import { formatAge, formatDicomDate, formatDicomDateTime, formatDicomTime, formatSex } from '@shared/format'
import { Modal, useEvent, useUi } from '../common/ui'
import {
  applyProjection,
  applyVoi,
  CT_PRESETS,
  DRAG_MODES,
  ensureVolume,
  getEngine,
  getNatural,
  getVoi,
  gpu,
  initCornerstone,
  isDragMode,
  lowerVolumeBudget,
  onAnnotationCompleted,
  ORIGINAL_PRESET_KEY,
  reformatOnCpu,
  releaseVolumes,
  setPresentationLink,
  setPrimaryTool,
  setReferenceLines,
  setTextPrompt,
  STICKY_TOOLS,
  str,
  TOOL_LABEL,
  zoomActualSize,
  zoomToFit
} from './cs'
import type { DragMode, ToolName } from './cs'
import { ContextMenu } from './ContextMenu'
import type { MenuItem } from './ContextMenu'
import {
  cpuPlaneIndexAt,
  cpuPlanePoint,
  cpuPlaneStack,
  cpuVolumeCenter,
  cpuVolumeData,
  ensureCpuVolume,
  nextSlab,
  PROJECTION_MM,
  projectionLabel,
  reformatSeriesOf,
  releaseCpuVolumes
} from './reformat'
import type { Plane, Projection, ProjectionMode, Vec3 } from './reformat'
import { clearSpineLabels, setSpineNotifier } from './spine'
import { SpinePanel } from './SpinePanel'
import { Viewport } from './Viewport'
import { LiverPanel } from './liver/LiverPanel'
import { captureLiver3D, Liver3D } from './liver/Liver3D'
import { liverStore } from './liver/store'
import { reportHtml } from './liver/report'
import type { CrossPlane, SlotInfo } from './Viewport'

const api = window.api
const MPR_IDS = ['mpr-axial', 'mpr-sagittal', 'mpr-coronal']
const LAYOUTS: [number, number][] = [
  [1, 1],
  [1, 2],
  [2, 1],
  [2, 2],
  [1, 3],
  [2, 3]
]

/** Annotations the viewer draws for itself (not measurements to save or delete). */
const SYSTEM_ANNOTATION_TOOLS = new Set(['ReferenceLines', 'Crosshairs'])
const isUserAnnotation = (a: csTools.Types.Annotation) => !!a.metadata?.toolName && !SYSTEM_ANNOTATION_TOOLS.has(a.metadata.toolName)

const SCOUT_RE = /(scout|topogram|locali[sz]er|surview|survey|tracker|bolus|dose|monitor|plan|\bloc\b|smartprep)/i

function pickBestSeries(series: SeriesRow[]): SeriesRow | null {
  const images = series.filter((s) => s.isImage && s.numImages > 0)
  if (!images.length) return null
  const nonScout = images.filter((s) => !SCOUT_RE.test(s.description) && s.numFrames > 3)
  const pool = nonScout.length ? nonScout : images
  return [...pool].sort((a, b) => b.numFrames - a.numFrames)[0]
}

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 1)
  )
}

function matchSeries(target: SeriesRow, candidates: SeriesRow[]): SeriesRow | null {
  const imgs = candidates.filter((s) => s.isImage && s.numImages > 0 && !SCOUT_RE.test(s.description))
  if (!imgs.length) return null
  const t = tokens(target.description)
  let best: SeriesRow | null = null
  let bestScore = -Infinity
  for (const c of imgs) {
    const ct = tokens(c.description)
    const inter = [...t].filter((x) => ct.has(x)).length
    const union = new Set([...t, ...ct]).size || 1
    const sizeRatio = Math.min(c.numFrames, target.numFrames) / Math.max(c.numFrames, target.numFrames, 1)
    const score = (inter / union) * 2 + sizeRatio + (c.modality === target.modality ? 0.5 : 0)
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return best
}

function nearestIndex(positions: (number | null)[], target: number): number {
  let best = 0
  let bestD = Infinity
  positions.forEach((p, i) => {
    if (p == null) return
    const d = Math.abs(p - target)
    if (d < bestD) {
      bestD = d
      best = i
    }
  })
  return best
}

function LayoutIcon({ r, c }: { r: number; c: number }) {
  return (
    <span className="layout-icon" style={{ gridTemplateColumns: `repeat(${c}, 1fr)`, gridTemplateRows: `repeat(${r}, 1fr)` }}>
      {Array.from({ length: r * c }, (_, i) => (
        <span key={i} />
      ))}
    </span>
  )
}

function VBtn(p: { title: string; onClick: () => void; active?: boolean; on?: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <button className={`v-btn ${p.active ? 'active' : ''} ${p.on ? 'on' : ''}`} title={p.title} disabled={p.disabled} onClick={p.onClick}>
      {p.children}
    </button>
  )
}

type ReopenView = { kind: 'mpr' | 'coronal' | 'sagittal'; seriesId: number }

interface MprState {
  seriesId: number
  studyId: number
  prevLayout: { rows: number; cols: number }
  prevSlots: SlotInfo[]
  /** The tile (of prevSlots) the MPR was started from. */
  fromIndex: number
  /** The planes are computed on the processor (series too big for the graphics card). */
  cpu: boolean
  /** The liver analysis: axial, 3-D, coronal and sagittal tiles with the liver panel. */
  liver?: boolean
}

/** Crosshair line colours of the MPR planes (as Cornerstone draws them on the graphics card). */
const CROSS_COLOR: Record<Plane, string> = { axial: 'rgb(200, 0, 0)', sagittal: 'rgb(200, 200, 0)', coronal: 'rgb(0, 200, 0)' }
const MPR_PLANES: Plane[] = ['axial', 'sagittal', 'coronal']

// Hot keys (Fujifilm Synapse layout). Measurement tools apply once, then drop back to
// window/level, unless locked with L (or chosen from the toolbar).
const HOTKEY_TOOLS: Record<string, ToolName> = {
  r: 'Length',
  t: 'Label',
  a: 'ArrowAnnotate',
  d: 'Probe',
  g: 'Angle',
  f: 'FreehandROI',
  e: 'EllipticalROI',
  h: 'CircleROI',
  o: 'Magnify',
  p: 'SpineLabel',
  w: 'WindowLevel',
  z: 'StackScroll',
  x: 'Eraser'
}

/** Shown once when a tool that needs several clicks in a set order is chosen. */
const TOOL_TIPS: Partial<Record<ToolName, string>> = {
  CTR4: 'Cardiothoracic ratio: click both heart borders (widest points), then both inner chest walls.',
  CTR6: 'Cardiothoracic ratio (6 points): click two points on the midline, then both heart borders, then both inner chest walls.',
  PolygonROI: 'Polygon ROI: click the corners; click the first corner again (or double-click) to close it.'
}

const HELP: [string, string][] = [
  ['Mouse wheel / middle-drag', 'Scroll through images'],
  ['Left-drag', 'Window/level (or the selected tool)'],
  ['Hold right + drag', 'Zoom: drag up = in, down = out (around the point pressed)'],
  ['Hold left + right click', 'Switch the drag between window/level → zoom → pan'],
  ['Right click', 'Image tools menu (presets, tools, layouts …)'],
  ['Ctrl + Shift + wheel', 'MIP slab: wheel up = thicker, down = thinner (2 – 100 mm, then thin); a MinIP slab stays MinIP'],
  ['Alt + drag', 'Window/level (left-right = width, up-down = level)'],
  ['Alt + Ctrl + drag / Alt + Shift + drag', 'Zoom / pan'],
  ['Shift + drag / Ctrl + drag', 'Move / copy a tile (series, axial / coronal / sagittal view) to another tile'],
  ['Double-click middle button', 'Link window/level + zoom between tiles (same as I)'],
  ['R  T  A  D', 'Ruler, text, arrow, density value (HU)'],
  ['G  F  E  H  O', 'Angle, freehand ROI, elliptical ROI, circle ROI, magnifying glass'],
  ['P', 'Spine labels: pick the first level, click it on the image, then click above / below for the next levels (they show in every plane)'],
  ['W / Z / Shift+Z / Shift+X', 'Window/level / dynamic scroll (left-drag through the images) / zoom / pan'],
  ['X / Delete', 'Eraser / delete the selected measurement'],
  ['V / Shift+Delete', 'Save the annotations with the study / delete all annotations'],
  ['L / Esc', 'Lock the current tool / back to window/level'],
  ['B', 'Bookmark – send the image to the report (key image)'],
  ['S  K  C  J', 'Linked scrolling on/off, add/remove tile, remove all, auto-link'],
  ['I', 'Link window/level + zoom/pan between tiles'],
  ['Q / U', 'Lock / unlock reference lines'],
  ['= / -', 'Zoom to fit / zoom 1:1'],
  ['N / M', 'Cine / MPR (axial, sagittal, coronal)'],
  ['Liver (toolbar) / right-click › Liver Analysis', 'Liver volume from one click, findings, vessels, Couinaud segments from landmarks, resection plan with the remaining liver, 3D (Esc drops the liver tool)'],
  ['Number pad 0 – 9', `Window presets: 0 = bone, 3 = liver, 1 = soft tissue, 2 = lung, 5 – 9 head / CTA, ${ORIGINAL_PRESET_KEY} = original (Num Lock on or off)`],
  ['3 / ?', 'Coronal / sagittal view of the tile; press again to go back (3 = axial, ? = coronal)'],
  ['Slab menu (toolbar) / right-click › MIP / MinIP', 'Thick slab: MIP (brightest) or MinIP (darkest) on the active tile or the MPR view'],
  ['Home / End, PgUp / PgDn, arrows', 'First / last image, ±10 images, ±1 image'],
  ['F5', 'Reset the image'],
  ['Shift+T / Shift+A / Shift+I', 'Text overlay / annotations / invert'],
  ['Alt+C / Alt+Shift+C / Alt+X', 'Compare with next / previous prior study, close comparison'],
  ['Alt+S / Alt+A', 'Next / previous series'],
  ['Alt+I / Alt+N / Alt+R / Alt+E', 'Study info / notes / report / series picker'],
  ['Ctrl+C', 'Copy the image to the clipboard'],
  ['F11', 'Full screen on/off (the series strip hides; Alt+E shows it)'],
  ['F4', 'Dictation on/off (types into the report)'],
  ['Tab / double-click', 'Next tile / maximise tile']
]

export function ViewerApp() {
  const ui = useUi()
  const [ready, setReady] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)
  const [currentStudyId, setCurrentStudyId] = useState<number | null>(null)
  const [studies, setStudies] = useState<StudyRow[]>([])
  const [shown, setShown] = useState<number[]>([])
  const [seriesMap, setSeriesMap] = useState<Record<number, SeriesRow[]>>({})
  const [imagesMap, setImagesMap] = useState<Record<number, SeriesImages>>({})
  const [thumbs, setThumbs] = useState<Record<number, string>>({})
  const [layout, setLayout] = useState({ rows: 1, cols: 1 })
  const [slots, setSlots] = useState<SlotInfo[]>([{ id: 'vp-0', kind: 'stack', seriesId: null, studyId: null }])
  const [active, setActive] = useState(0)
  const [maximized, setMaximized] = useState<number | null>(null)
  const [tool, setTool] = useState<ToolName>('WindowLevel')
  const [locked, setLocked] = useState(true)
  const [scrollLink, setScrollLink] = useState(false)
  const [linkMembers, setLinkMembers] = useState<string[] | null>(null) // null = all tiles
  const [presLink, setPresLink] = useState(false)
  const [refLines, setRefLines] = useState(true)
  const [refSource, setRefSource] = useState<string | null>(null) // locked source (Q)
  const [overlay, setOverlay] = useState(true)
  const [showAnn, setShowAnn] = useState(true)
  const [showTop, setShowTop] = useState(true)
  const [cine, setCine] = useState(false)
  const [fps, setFps] = useState(10)
  const [mpr, setMpr] = useState<MprState | null>(null)
  const [mprLoading, setMprLoading] = useState<string | null>(null)
  // MPR computed on the processor: the crosshair point, and per tile the other two planes' lines.
  const [cross, setCross] = useState<Vec3 | null>(null)
  const [crossPlanes, setCrossPlanes] = useState<Record<string, CrossPlane[]>>({})
  const crossRef = useRef(cross)
  crossRef.current = cross
  const [fullScreen, setFullScreen] = useState(false)
  const topBeforeFullScreen = useRef(true)
  /** Thin, or a MIP / MinIP slab, for the three tiles of the MPR view. */
  const [mprProj, setMprProj] = useState<Projection | null>(null)
  const [help, setHelp] = useState(false)
  const [info, setInfo] = useState(false)
  const [notes, setNotes] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [dictating, setDictating] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)
  const compareIdx = useRef(-1)

  // Refs so event handlers always see the latest state.
  const slotsRef = useRef(slots)
  slotsRef.current = slots
  const imagesRef = useRef(imagesMap)
  imagesRef.current = imagesMap
  const linkRef = useRef({ scrollLink, linkMembers })
  linkRef.current = { scrollLink, linkMembers }
  const toolRef = useRef({ tool, locked })
  toolRef.current = { tool, locked }
  const activeRef = useRef(active)
  activeRef.current = active
  /** When Ctrl+Shift+wheel last said that a series can't have a MIP slab. */
  const slabNoticeAt = useRef(-Infinity)
  const mprRef = useRef(mpr)
  mprRef.current = mpr
  /** Leaving the liver analysis: saves unsaved results with the study, then lets go of them. */
  const liverLeaveRef = useRef<() => void>(() => {})
  const expected = useRef(new Map<string, number>())

  const isLinked = (slotId: string, l = linkRef.current) => l.scrollLink && (l.linkMembers == null || l.linkMembers.includes(slotId))

  // ------------------------------------------------------------ init
  useEffect(() => {
    setTextPrompt((label) => ui.prompt('Annotation', label))
    setSpineNotifier((message) => ui.toast(message, 'info'))
  }, [ui])

  useEffect(() => {
    initCornerstone()
      .then(() => setReady(true))
      .catch((e: unknown) => setInitError(String((e as Error)?.message ?? e)))
  }, [])

  // One-shot measurement tools: back to window/level when the measurement is finished.
  useEffect(() => {
    if (!ready) return
    return onAnnotationCompleted(() => {
      const t = toolRef.current
      if (!t.locked && !isDragMode(t.tool)) setTool('WindowLevel')
    })
  }, [ready])

  useEffect(() => {
    const el = gridRef.current
    if (!el || !ready) return
    const ro = new ResizeObserver(() => {
      try {
        getEngine().resize(true, true)
      } catch {
        /* engine not ready */
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [ready])

  useEffect(() => {
    if (!ready) return
    const t = setTimeout(() => getEngine().resize(true, true), 30)
    return () => clearTimeout(t)
  }, [ready, maximized, layout, showTop])

  // ------------------------------------------------------------ data helpers
  const ensureImages = useCallback(async (seriesId: number): Promise<SeriesImages> => {
    const have = imagesRef.current[seriesId]
    if (have) return have
    const imgs = await api.getSeriesImages(seriesId)
    imagesRef.current = { ...imagesRef.current, [seriesId]: imgs }
    setImagesMap((m) => ({ ...m, [seriesId]: imgs }))
    return imgs
  }, [])

  const ensureSeries = useCallback(
    async (studyId: number): Promise<SeriesRow[]> => {
      if (seriesMap[studyId]) return seriesMap[studyId]
      const d = await api.getStudy(studyId)
      const list = d?.series ?? []
      setSeriesMap((m) => ({ ...m, [studyId]: list }))
      return list
    },
    [seriesMap]
  )

  /** Back to the tiles from before the MPR (callers may change them further right after). */
  const exitMpr = useCallback(() => {
    const m = mprRef.current
    if (m?.liver) liverLeaveRef.current()
    if (m) {
      setLayout(m.prevLayout)
      setSlots(m.prevSlots)
      setActive(m.fromIndex)
    }
    setMpr(null)
    setMprProj(null)
    setMprLoading(null)
    setCross(null)
    setCrossPlanes({})
    setTool((t) => (t === 'Crosshairs' ? 'WindowLevel' : t))
  }, [])

  const openStudy = useCallback(
    async (studyId: number) => {
      if (!ready) return
      exitMpr()
      const [detail, priors] = await Promise.all([api.getStudy(studyId), api.getPriors(studyId)])
      if (!detail) return
      setCurrentStudyId(studyId)
      setStudies([detail.study, ...priors])
      setShown([studyId])
      setSeriesMap({ [studyId]: detail.series })
      const t: Record<number, string> = {}
      for (const s of detail.series) if (s.thumb) t[s.id] = s.thumb
      setThumbs((x) => ({ ...x, ...t }))
      const best = pickBestSeries(detail.series)
      if (best) await ensureImages(best.id)
      setLayout({ rows: 1, cols: 1 })
      setMaximized(null)
      setScrollLink(false)
      setLinkMembers(null)
      setPresLink(false)
      setRefSource(null)
      compareIdx.current = -1
      setSlots([{ id: 'vp-0', kind: 'stack', seriesId: best?.id ?? null, studyId }])
      setActive(0)
      document.title = `${detail.study.patientName} – ${detail.study.description} – Viewer`
      void loadSavedRef.current(studyId)
    },
    [ready, ensureImages, exitMpr]
  )

  // If the graphics card resets (Windows does this when the card runs out of memory or is busy too
  // long), WebGL loses everything and the tiles stay black. Reload the viewer and reopen the same
  // study; if a volume (MPR / coronal / sagittal) was shown, it is rebuilt smaller this time.
  const lostHandled = useRef(false)
  useEffect(() => {
    const onLost = () => {
      // One reset loses every graphics context of the window at once (several events): act once.
      if (lostHandled.current) return
      lostHandled.current = true
      const lowered = lowerVolumeBudget()
      const m = mprRef.current
      const slot = slotsRef.current[activeRef.current]
      const view: ReopenView | null = m
        ? { kind: 'mpr', seriesId: m.seriesId }
        : slot && (slot.kind === 'coronal' || slot.kind === 'sagittal') && slot.seriesId != null
          ? { kind: slot.kind, seriesId: slot.seriesId }
          : null
      const now = Date.now()
      let resets = 1
      try {
        const last = Number(sessionStorage.getItem('pacs:glResetAt') || 0)
        resets = now - last < 120_000 ? Number(sessionStorage.getItem('pacs:glResets') || 0) + 1 : 1
        sessionStorage.setItem('pacs:glResets', String(resets))
        sessionStorage.setItem('pacs:glResetAt', String(now))
        if (currentStudyId != null) sessionStorage.setItem('pacs:reopen', String(currentStudyId))
        if (view && lowered && resets <= 2) sessionStorage.setItem('pacs:reopenView', JSON.stringify(view))
        else sessionStorage.removeItem('pacs:reopenView')
      } catch {
        /* storage blocked */
      }
      if (resets > 2) {
        setInitError(
          'The graphics card keeps resetting, even with smaller volumes. Click “Try again” to open the images ' +
            'without MPR. If it happens again, update the graphics driver; for MPR, a thicker series (2–5 mm) ' +
            'needs much less graphics memory.'
        )
        return
      }
      ui.toast(
        lowered && view
          ? 'The graphics card ran out of memory – reopening with a lighter volume…'
          : 'The graphics card was reset – reopening the images…',
        'error'
      )
      setTimeout(() => location.reload(), 1200)
    }
    eventTarget.addEventListener(CoreEnums.Events.WEBGL_CONTEXT_LOST, onLost)
    return () => eventTarget.removeEventListener(CoreEnums.Events.WEBGL_CONTEXT_LOST, onLost)
  }, [currentStudyId, ui])

  /** Saved annotations come back when a study is opened (or shown next to it). */
  const loadSavedRef = useRef<(studyId: number) => Promise<unknown>>(async () => 0)
  loadSavedRef.current = (studyId: number) => (annLoaded.current.has(studyId) ? Promise.resolve(0) : loadSavedAnnotations(studyId, false))

  const pendingStudy = useRef<number | null>(null)
  // After such a reload: open the study that was on screen, and its MPR / plane view.
  const [reopenView, setReopenView] = useState<ReopenView | null>(null)
  useEffect(() => {
    try {
      const id = Number(sessionStorage.getItem('pacs:reopen'))
      sessionStorage.removeItem('pacs:reopen')
      if (id > 0 && pendingStudy.current == null) pendingStudy.current = id
      const view = JSON.parse(sessionStorage.getItem('pacs:reopenView') || 'null') as ReopenView | null
      sessionStorage.removeItem('pacs:reopenView')
      if (id > 0 && view && typeof view.seriesId === 'number' && ['mpr', 'coronal', 'sagittal'].includes(view.kind)) setReopenView(view)
    } catch {
      /* storage blocked */
    }
  }, [])
  useEvent(api.onViewerLoadStudy, (studyId: number) => {
    if (!ready) pendingStudy.current = studyId
    else void openStudy(studyId)
  })
  useEffect(() => {
    if (ready && pendingStudy.current != null) {
      const id = pendingStudy.current
      pendingStudy.current = null
      void openStudy(id)
    }
  }, [ready, openStudy])
  useEvent(api.onDictationActive, (on: boolean) => setDictating(on))
  useEvent(api.onStudiesChanged, () => {
    if (currentStudyId == null) return
    void Promise.all([api.getStudy(currentStudyId), api.getPriors(currentStudyId)]).then(([d, pri]) => {
      if (d) setStudies([d.study, ...pri])
    })
  })

  // ------------------------------------------------------------ thumbnails (generated once, then stored)
  const thumbQueue = useRef<Set<number>>(new Set())
  useEffect(() => {
    if (!ready) return
    const todo: SeriesRow[] = []
    for (const id of shown) for (const s of seriesMap[id] ?? []) if (s.isImage && !s.thumb && !thumbs[s.id] && !thumbQueue.current.has(s.id)) todo.push(s)
    if (!todo.length) return
    for (const s of todo) thumbQueue.current.add(s.id)
    void (async () => {
      for (const s of todo) {
        try {
          const imgs = await ensureImages(s.id)
          const imageId = imgs.imageIds[Math.floor(imgs.imageIds.length / 2)]
          if (!imageId) continue
          const canvas = document.createElement('canvas')
          canvas.width = 128
          canvas.height = 128
          await csUtils.loadImageToCanvas({ canvas, imageId, thumbnail: true })
          const url = canvas.toDataURL('image/jpeg', 0.8)
          setThumbs((t) => ({ ...t, [s.id]: url }))
          void api.saveSeriesThumb(s.id, url)
        } catch (e) {
          console.warn('thumbnail failed', s.id, e)
        }
      }
    })()
  }, [ready, shown, seriesMap, thumbs, ensureImages])

  // ------------------------------------------------------------ slots / layout
  /**
   * Opens a series in a tile (thumbnail click or drop, Alt+S / Alt+A): always as its own (axial)
   * images, also in a tile that showed a coronal / sagittal view (3, ? and M show other planes).
   * On the MPR view: leaves the MPR and opens the series in the tile the MPR was started from.
   */
  const loadIntoSlot = useCallback(
    async (index: number, seriesId: number, studyId: number) => {
      await ensureImages(seriesId)
      const m = mprRef.current
      const at = m ? m.fromIndex : index
      if (m) exitMpr()
      setSlots((prev) => prev.map((s, i) => (i === at ? { ...s, kind: 'stack', cpu: false, slab: null, at: null, voi: null, seriesId, studyId } : s)))
      setActive(at)
    },
    [ensureImages, exitMpr]
  )

  const applyLayout = async (rows: number, cols: number) => {
    if (mpr) exitMpr()
    const n = rows * cols
    const used = new Set(slotsRef.current.map((s) => s.seriesId).filter(Boolean))
    const sid = currentStudyId
    const candidates = (sid != null ? seriesMap[sid] ?? [] : []).filter(
      (s) => s.isImage && s.numImages > 0 && !used.has(s.id) && !SCOUT_RE.test(s.description)
    )
    const next: SlotInfo[] = []
    for (let i = 0; i < n; i++) {
      const prev = slotsRef.current[i]
      if (prev && !prev.id.startsWith('mpr-')) next.push(prev)
      else {
        const c = candidates.shift()
        if (c) await ensureImages(c.id)
        next.push({ id: `vp-${i}`, kind: 'stack', seriesId: c?.id ?? null, studyId: c ? sid : null })
      }
    }
    setLayout({ rows, cols })
    setSlots(next)
    setMaximized(null)
    setActive((a) => Math.min(a, n - 1))
  }

  /**
   * Shift+drag = move (swap) what a tile shows to another tile, Ctrl+drag = copy: the series with
   * its view (axial, coronal or sagittal) and window. Not on the MPR view (its tiles are fixed).
   */
  const onSeriesDrag = (from: number, to: number, copy: boolean) => {
    const cur = slotsRef.current
    const a = cur[from]
    const b = cur[to]
    if (!a || !b || a.seriesId == null || a.id.startsWith('mpr-') || b.id.startsWith('mpr-')) return
    const viewOf = (s: SlotInfo): Partial<SlotInfo> => {
      const vp = getEngine().getViewport(s.id)
      const f = vp?.getCamera().focalPoint
      return {
        kind: s.kind,
        cpu: s.cpu,
        slab: s.slab ?? null,
        seriesId: s.seriesId,
        studyId: s.studyId,
        voi: (vp ? getVoi(vp) : null) ?? s.voi ?? null,
        at: f ? [f[0], f[1], f[2]] : null // the moved view opens at the same image / level
      }
    }
    const va = viewOf(a)
    const vb = viewOf(b)
    setSlots((prev) =>
      prev.map((s, i) => {
        if (i === to) return { ...s, ...va }
        if (i === from && !copy) return { ...s, ...vb }
        return s
      })
    )
    setActive(to)
  }

  // ------------------------------------------------------------ linked scrolling
  const onImageChange = useCallback((slotId: string, oldIdx: number, newIdx: number) => {
    // Processor-computed MPR: the crosshair follows the plane this tile moved to.
    const m = mprRef.current
    if (m?.cpu && slotId.startsWith('mpr-')) {
      const c = crossRef.current
      const at = cpuPlanePoint(m.seriesId, slotId.slice(4) as Plane, newIdx)
      if (c && at) {
        const d = (at.point[0] - c[0]) * at.normal[0] + (at.point[1] - c[1]) * at.normal[1] + (at.point[2] - c[2]) * at.normal[2]
        if (Math.abs(d) > 1e-6) setCross([c[0] + d * at.normal[0], c[1] + d * at.normal[1], c[2] + d * at.normal[2]])
      }
      return
    }
    const exp = expected.current.get(slotId)
    if (exp !== undefined) {
      expected.current.delete(slotId)
      if (exp === newIdx) return // this change was caused by syncing
    }
    if (!isLinked(slotId)) return
    const src = slotsRef.current.find((s) => s.id === slotId)
    // Reformatted planes number their images differently from the series: not linked by position.
    if (!src?.seriesId || src.kind !== 'stack') return
    const sImgs = imagesRef.current[src.seriesId]
    const engine = getEngine()
    for (const other of slotsRef.current) {
      if (other.id === slotId || other.kind !== 'stack' || !other.seriesId || !isLinked(other.id)) continue
      const vp = engine.getViewport(other.id) as Types.IStackViewport | undefined
      if (!vp) continue
      const oImgs = imagesRef.current[other.seriesId]
      const cur = vp.getCurrentImageIdIndex()
      const total = vp.getImageIds().length
      let target = cur
      const pOld = sImgs?.positions[oldIdx]
      const pNew = sImgs?.positions[newIdx]
      const parallel =
        sImgs?.normal && oImgs?.normal && sImgs.normal.reduce((acc, v, k) => acc + v * (oImgs.normal as number[])[k], 0) > 0.99
      if (pOld != null && pNew != null && parallel && oImgs.positions.some((p) => p != null)) {
        const sameFor = !!sImgs.frameOfReferenceUid && sImgs.frameOfReferenceUid === oImgs.frameOfReferenceUid
        const targetPos = sameFor ? pNew : (oImgs.positions[cur] ?? 0) + (pNew - pOld)
        target = nearestIndex(oImgs.positions, targetPos)
      } else {
        target = Math.min(total - 1, Math.max(0, cur + (newIdx - oldIdx)))
      }
      if (target !== cur) {
        expected.current.set(other.id, target)
        void vp.setImageIdIndex(target)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Linked window/level + zoom/pan between tiles ("I", or double-click the mouse wheel).
  useEffect(() => {
    if (!ready || mpr) return
    const ids = slots.filter((s) => s.kind === 'stack' && s.seriesId != null).map((s) => s.id)
    const t = setTimeout(() => setPresentationLink(presLink, ids), 50)
    return () => clearTimeout(t)
  }, [ready, presLink, slots, mpr])

  // Reference lines follow the active tile unless locked with Q.
  useEffect(() => {
    if (!ready) return
    const src = refSource ?? slots[active]?.id ?? ''
    const t = setTimeout(() => {
      try {
        setReferenceLines(refLines && !mpr && slots.length > 1, src)
        getEngine().render()
      } catch {
        /* viewports not ready */
      }
    }, 60)
    return () => clearTimeout(t)
  }, [ready, refLines, refSource, active, slots, mpr])

  // ------------------------------------------------------------ volumes (MPR, coronal, sagittal)
  // Free the memory of series no tile shows as a plane any more (on the graphics card, or the
  // series kept in memory for planes computed on the processor).
  useEffect(() => {
    if (!ready) return
    const onGpu = new Set<number>()
    const onCpu = new Set<number>()
    if (mpr) (mpr.cpu ? onCpu : onGpu).add(mpr.seriesId)
    for (const s of slots) if (s.kind !== 'stack' && s.seriesId != null) (s.cpu ? onCpu : onGpu).add(s.seriesId)
    releaseVolumes(onGpu)
    releaseCpuVolumes(onCpu)
  }, [ready, slots, mpr])

  // ------------------------------------------------------------ MPR
  const enterMpr = async () => {
    const slot = slots[active]
    if (!slot?.seriesId || slot.id.startsWith('mpr-') || slot.studyId == null) {
      ui.toast('Select a viewport with a series first.', 'info')
      return
    }
    const imgs = await ensureImages(slot.seriesId)
    if (!imgs.reconstructable) {
      ui.toast('This series cannot be reconstructed (needs at least 3 parallel slices of the same size).', 'error')
      return
    }
    // Series bigger than this graphics card holds in one piece: computed on the processor instead.
    const cpu = reformatOnCpu(imgs)
    setMpr({ seriesId: slot.seriesId, studyId: slot.studyId, prevLayout: layout, prevSlots: slots, fromIndex: active, cpu })
    setLayout({ rows: 1, cols: 3 })
    setMaximized(null)
    setSlots(MPR_PLANES.map((k) => ({ id: `mpr-${k}`, kind: k, seriesId: slot.seriesId, studyId: slot.studyId, cpu })))
    setActive(0)
    setTool('Crosshairs')
    setLocked(true)
  }

  // ------------------------------------------------------------ liver analysis
  const enterLiver = async () => {
    const from = mpr && !mpr.liver ? { seriesId: mpr.seriesId, studyId: mpr.studyId } : null
    if (mpr) exitMpr()
    const slot = from ? null : slotsRef.current[activeRef.current]
    const seriesId = from?.seriesId ?? slot?.seriesId
    const studyId = from?.studyId ?? slot?.studyId
    if (seriesId == null || studyId == null) {
      ui.toast('Select a tile with a CT series first.', 'info')
      return
    }
    const modality = seriesById.get(seriesId)?.modality ?? ''
    if (modality && modality !== 'CT') {
      ui.toast('The liver analysis works on CT series (it reads Hounsfield units).', 'info')
      return
    }
    const imgs = await ensureImages(seriesId)
    if (!imgs.reconstructable) {
      ui.toast('The liver analysis needs a CT series of parallel slices (a thin axial series works best).', 'error')
      return
    }
    // Always on the processor: the analysis needs the series in memory anyway.
    setMpr({ seriesId, studyId, prevLayout: layout, prevSlots: slotsRef.current, fromIndex: activeRef.current, cpu: true, liver: true })
    setLayout({ rows: 2, cols: 2 })
    setMaximized(null)
    setSlots((['axial', 'coronal', 'sagittal'] as Plane[]).map((k) => ({ id: `mpr-${k}`, kind: k, seriesId, studyId, cpu: true })))
    setActive(0)
    setTool('Crosshairs')
    setLocked(true)
  }

  // Once the series is in memory: the analysis grid, and any analysis saved with the study.
  useEffect(() => {
    if (!mpr?.liver || mprLoading) return
    const st = liverStore.state
    if (st.active && st.seriesId === mpr.seriesId) return
    const cv = cpuVolumeData(mpr.seriesId)
    if (!cv) return
    const uid = seriesById.get(mpr.seriesId)?.seriesUid || `series-${mpr.seriesId}`
    void (async () => {
      try {
        await liverStore.open(mpr.seriesId, mpr.studyId, uid, cv)
        const saved = await api.getLiverAnalysis(mpr.studyId, uid)
        if (saved && liverStore.state.seriesId === mpr.seriesId && (await liverStore.restore(saved))) ui.toast('The liver analysis saved with this study was loaded', 'info')
      } catch (e) {
        console.error(e)
        ui.toast(`Liver analysis: ${(e as Error).message}`, 'error')
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mpr, mprLoading])

  const saveLiver = async (quiet = false) => {
    const st = liverStore.state
    const json = liverStore.serialize()
    if (!json || st.studyId == null) return
    try {
      await api.saveLiverAnalysis(st.studyId, st.seriesUid, json)
      liverStore.markSaved()
      if (!quiet) ui.toast('Liver analysis saved with the study', 'success')
    } catch (e) {
      ui.toast(`Could not save the liver analysis: ${(e as Error).message}`, 'error')
    }
  }
  liverLeaveRef.current = () => {
    const st = liverStore.state
    if (st.liver && !st.saved) {
      void saveLiver(true).then(() => ui.toast('Liver analysis saved with the study', 'success'))
      // serialize() ran before close(): the save above already has the data
    }
    setTimeout(() => liverStore.close(), 0)
  }

  const liverToReport = async () => {
    const st = liverStore.state
    const se = st.seriesId != null ? seriesById.get(st.seriesId) : undefined
    const html = reportHtml(st, se ? `${se.number ?? ''} ${se.description}`.trim() : '')
    if (!html) return
    await api.sendReportHtml(html)
    const shot = await captureLiver3D()
    if (shot) await api.sendKeyImage({ dataUrl: shot, caption: 'Liver analysis – 3D' })
    const axial = await captureSlot('mpr-axial', 900, 'image/jpeg')
    if (axial) await api.sendKeyImage({ dataUrl: axial.dataUrl, caption: 'Liver analysis – axial' })
    ui.toast('Liver volumetry sent to the report', 'success')
  }

  /** Processor-computed MPR: the other tiles show the planes through `world` (crosshair click / drag). */
  const moveCross = (fromId: string, world: Vec3) => {
    const m = mprRef.current
    if (!m?.cpu) return
    setCross(world)
    for (const k of MPR_PLANES) {
      const id = `mpr-${k}`
      if (id === fromId) continue
      const vp = getEngine().getViewport(id) as Types.IStackViewport | undefined
      if (!vp || vp.type !== CoreEnums.ViewportType.STACK || !vp.getImageIds().length) continue
      const target = cpuPlaneIndexAt(m.seriesId, k, world)
      if (target !== vp.getCurrentImageIdIndex()) void vp.setImageIdIndex(target)
    }
  }

  useEffect(() => {
    if (!mpr) return
    let cancelled = false
    void (async () => {
      try {
        const imgs = imagesRef.current[mpr.seriesId]
        setMprLoading('Loading images…')
        if (mpr.cpu) {
          // Each tile shows its own plane (Viewport); here the crosshair starts in the middle.
          const loaded = await ensureCpuVolume(imgs, (done, total) => {
            if (!cancelled) setMprLoading(`Loading images… ${Math.floor((done / total) * 100)}%`)
          })
          if (cancelled || !loaded) return
          const normal = Object.fromEntries(MPR_PLANES.map((k) => [k, cpuPlaneStack(mpr.seriesId, k).dir])) as Record<Plane, Vec3>
          const lines: Record<string, CrossPlane[]> = {}
          for (const k of MPR_PLANES) {
            lines[`mpr-${k}`] = MPR_PLANES.filter((o) => o !== k).map((o) => ({ normal: normal[o], color: CROSS_COLOR[o] }))
          }
          setCrossPlanes(lines)
          const center = cpuVolumeCenter(mpr.seriesId)
          if (center) moveCross('', center)
          setMprLoading(null)
          return
        }
        const plan = await ensureVolume(mpr.seriesId, imgs.imageIds)
        if (cancelled) return
        setMprLoading('Building volume…')
        await setVolumesForViewports(getEngine(), [{ volumeId: plan.volumeId }], MPR_IDS)
        getEngine().renderViewports(MPR_IDS)
        setMprLoading(null)
      } catch (e) {
        console.error(e)
        if (!cancelled) {
          ui.toast(`MPR failed: ${(e as Error).message}`, 'error')
          exitMpr()
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mpr?.seriesId])

  useEffect(() => {
    // Processor-computed MPR tiles make their MIP / MinIP images themselves (projection prop).
    if (!mpr || mpr.cpu || mprLoading) return
    const engine = getEngine()
    for (const id of MPR_IDS) {
      const vp = engine.getViewport(id) as Types.IVolumeViewport | undefined
      if (vp) applyProjection(vp, mprProj)
    }
    engine.renderViewports(MPR_IDS)
  }, [mprProj, mpr, mprLoading])

  /**
   * Thin / MIP / MinIP: for the three tiles of the MPR view, or for the active tile (or tile `idx`).
   * Original axial images become a thick-slab axial reformat at the same level (Thin returns to the
   * images there).
   */
  const setProjection = async (proj: Projection | null, idx = active) => {
    if (mpr) {
      setMprProj(proj)
      return
    }
    const slot = slotsRef.current[idx]
    if (!slot?.seriesId || slot.studyId == null) {
      ui.toast('Select a tile with a series first.', 'info')
      return
    }
    if (slot.kind === 'stack' && !proj) return
    const vp = getEngine().getViewport(slot.id)
    const f = vp?.getCamera().focalPoint
    const at: Vec3 | null = f ? [f[0], f[1], f[2]] : null
    const voi = (vp ? getVoi(vp) : null) ?? slot.voi ?? null
    if (slot.kind === 'stack') {
      const imgs = await ensureImages(slot.seriesId)
      if (!imgs.reconstructable) {
        ui.toast('MIP / MinIP needs a series of at least 3 parallel slices of the same size.', 'error')
        return
      }
      if (cine) setCine(false)
      setSlots((prev) => prev.map((s, i) => (i === idx ? { ...s, kind: 'axial', cpu: reformatOnCpu(imgs), slab: proj, at, voi } : s)))
      return
    }
    if (slot.kind === 'axial' && !proj) {
      setSlots((prev) => prev.map((s, i) => (i === idx ? { ...s, kind: 'stack', cpu: false, slab: null, at, voi } : s)))
      return
    }
    setSlots((prev) => prev.map((s, i) => (i === idx ? { ...s, slab: proj } : s)))
  }

  /**
   * Ctrl+Shift+wheel over tile `idx`: one step thicker (1) or thinner (-1). Thin becomes MIP; the
   * MPR view changes all three planes. Uses the latest state, so fast wheel turns all count.
   */
  const stepSlab = (idx: number, dir: 1 | -1) => {
    const slot = slotsRef.current[idx]
    if (!slot) return
    setActive(idx)
    if (mprRef.current && slot.id.startsWith('mpr-')) {
      setMprProj((p) => nextSlab(p, dir))
      return
    }
    if (slot.seriesId == null) return
    const next = nextSlab(slot.slab, dir)
    // Original images <-> thick-slab axial reformat: rebuilt at the same level.
    if (slot.kind === 'stack') {
      if (!next) return
      if (imagesRef.current[slot.seriesId]?.reconstructable === false) {
        // e.g. an X-ray: one notice per turn of the wheel, not one per step
        if (performance.now() - slabNoticeAt.current > 3000) ui.toast('MIP / MinIP needs a series of at least 3 parallel slices of the same size.', 'info')
        slabNoticeAt.current = performance.now()
        return
      }
      void setProjection(next, idx)
      return
    }
    if (slot.kind === 'axial' && !next) {
      void setProjection(null, idx)
      return
    }
    setSlots((prev) => prev.map((s, i) => (i === idx && s.kind !== 'stack' ? { ...s, slab: nextSlab(s.slab, dir) } : s)))
  }

  /** The active tile's (or the MPR view's) thick slab, for the menus. */
  const currentProj = (): Projection | null => (mpr ? mprProj : slots[active]?.slab ?? null)
  /** The slab menus' thicknesses, plus the current one when the wheel chose another. */
  const slabChoices = (mode: ProjectionMode): number[] => {
    const cur = currentProj()
    return cur?.mode === mode && !PROJECTION_MM.includes(cur.mm) ? [...PROJECTION_MM, cur.mm].sort((a, b) => a - b) : PROJECTION_MM
  }
  const projValue = (p: Projection | null) => (p && p.mm > 0 ? `${p.mode}:${p.mm}` : '')
  const parseProj = (v: string): Projection | null => {
    const [mode, mm] = v.split(':')
    return (mode === 'mip' || mode === 'minip') && Number(mm) > 0 ? { mode, mm: Number(mm) } : null
  }

  useEffect(() => {
    const want = reopenView
    if (!want || !ready || currentStudyId == null || mpr) return
    const list = seriesMap[currentStudyId]
    const slot = slots[0]
    if (!list || !slot || slot.studyId !== currentStudyId) return // still opening
    if (!list.some((s) => s.id === want.seriesId)) {
      setReopenView(null)
      return
    }
    if (slot.seriesId !== want.seriesId) {
      void loadIntoSlot(0, want.seriesId, currentStudyId)
      return
    }
    setReopenView(null)
    if (want.kind === 'mpr') void enterMpr()
    else void reformatActive(want.kind)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reopenView, ready, currentStudyId, seriesMap, slots, mpr])

  // ------------------------------------------------------------ tools
  useEffect(() => {
    if (!ready) return
    // A measurement half placed (e.g. 2 of the 4 CTR points) is dropped when the tool changes.
    for (const s of slotsRef.current) {
      const el = getEngine().getViewport(s.id)?.element as HTMLDivElement | undefined
      if (!el) continue
      try {
        csTools.cancelActiveManipulations(el)
      } catch {
        /* nothing in progress */
      }
    }
    // Processor-computed MPR tiles are normal stacks (their crosshair is handled by the Viewport).
    setPrimaryTool(tool, !!mpr && !mpr.cpu)
  }, [tool, mpr, ready])

  const chooseTool = (t: ToolName, lock: boolean) => {
    const tip = TOOL_TIPS[t]
    if (tip && toolRef.current.tool !== t) ui.toast(tip, 'info')
    // A viewer tool chosen during the liver analysis takes the left button back from the liver tool.
    if (mprRef.current?.liver && liverStore.state.tool) liverStore.ui({ tool: null, pendingCut: null })
    setTool(t)
    setLocked(lock || isDragMode(t) || STICKY_TOOLS.includes(t))
  }

  const cycleDragMode = (): DragMode => {
    const cur = toolRef.current.tool
    const next = isDragMode(cur) ? DRAG_MODES[(DRAG_MODES.indexOf(cur) + 1) % DRAG_MODES.length] : 'WindowLevel'
    setTool(next)
    setLocked(true)
    return next
  }

  const activeVp = (): Types.IViewport | undefined => {
    const slot = slotsRef.current[active]
    return slot ? getEngine().getViewport(slot.id) : undefined
  }

  const applyPreset = (ww: number, wc: number) => {
    const ids = mpr ? MPR_IDS : [slotsRef.current[active]?.id]
    for (const id of ids) {
      const vp = id ? getEngine().getViewport(id) : undefined
      if (vp) applyVoi(vp, ww, wc)
    }
  }

  const resetVoi = () => {
    const vp = activeVp() as Types.IStackViewport | undefined
    vp?.resetProperties()
    vp?.render()
  }

  const transform = (kind: 'invert' | 'rotateR' | 'rotateL' | 'flipH' | 'flipV' | 'reset' | 'fit' | 'actual') => {
    const vp = activeVp() as Types.IStackViewport | undefined
    if (!vp) return
    if (kind === 'invert') vp.setProperties({ invert: !vp.getProperties().invert })
    else if (kind === 'rotateR' || kind === 'rotateL') {
      const rot = vp.getViewPresentation().rotation ?? 0
      vp.setViewPresentation({ rotation: (rot + (kind === 'rotateR' ? 90 : 270)) % 360 })
    } else if (kind === 'flipH') vp.setViewPresentation({ flipHorizontal: !vp.getViewPresentation().flipHorizontal })
    else if (kind === 'flipV') vp.setViewPresentation({ flipVertical: !vp.getViewPresentation().flipVertical })
    else if (kind === 'fit') zoomToFit(vp)
    else if (kind === 'actual') zoomActualSize(vp)
    else {
      vp.resetCamera()
      vp.resetProperties()
    }
    vp.render()
  }

  const scrollActive = (delta: number) => {
    const vp = activeVp()
    if (!vp) return
    csUtils.scroll(vp, { delta })
  }

  const jumpActive = (where: 'first' | 'last') => {
    const vp = activeVp()
    if (!vp) return
    if (vp.type === CoreEnums.ViewportType.STACK) {
      const sv = vp as Types.IStackViewport
      void sv.setImageIdIndex(where === 'first' ? 0 : sv.getImageIds().length - 1)
    } else {
      const n = (vp as Types.IVolumeViewport).getNumberOfSlices?.() ?? 0
      if (n > 0) void csUtils.jumpToSlice(vp.element as HTMLDivElement, { imageIndex: where === 'first' ? 0 : n - 1 })
    }
  }

  /**
   * Key 3: the active tile's series as a coronal reformat (3 again = back to the original axial images).
   * Key ?: sagittal (? again = back to coronal). Window/level is kept.
   */
  const reformatActive = async (target: 'coronal' | 'sagittal' | 'stack') => {
    if (mpr) {
      ui.toast('Leave the MPR view first (M).', 'info')
      return
    }
    const idx = active
    const slot = slotsRef.current[idx]
    if (!slot?.seriesId || slot.studyId == null) {
      ui.toast('Select a tile with a series first.', 'info')
      return
    }
    let next: SlotInfo['kind'] = target
    if (target === 'coronal' && slot.kind === 'coronal') next = 'stack'
    else if (target === 'sagittal' && slot.kind === 'sagittal') next = 'coronal'
    if (next === slot.kind) return
    // Series bigger than this graphics card holds in one piece: the plane is computed on the processor.
    let cpu = false
    if (next !== 'stack') {
      const imgs = await ensureImages(slot.seriesId)
      if (!imgs.reconstructable) {
        ui.toast('This series cannot be shown in other planes (it needs at least 3 parallel slices of the same size).', 'error')
        return
      }
      cpu = reformatOnCpu(imgs)
    }
    const vp = getEngine().getViewport(slot.id)
    const voi = vp ? getVoi(vp) : null
    // From a thick-slab axial view back to the original images: at the same level.
    const f = slot.kind === 'axial' && next === 'stack' ? vp?.getCamera().focalPoint : undefined
    const at: Vec3 | null = f ? [f[0], f[1], f[2]] : null
    if (cine) setCine(false)
    // A MIP / MinIP slab stays with the tile in the other planes; the original images have none.
    setSlots((prev) =>
      prev.map((s, i) => (i === idx ? { ...s, kind: next, voi: voi ?? s.voi ?? null, cpu, slab: next === 'stack' ? null : s.slab ?? null, at } : s))
    )
  }

  const toggleCine = () => {
    const vp = activeVp()
    if (!vp) return
    const el = vp.element as HTMLDivElement
    if (cine) {
      csTools.utilities.cine.stopClip(el)
      setCine(false)
    } else {
      csTools.utilities.cine.playClip(el, { framesPerSecond: fps, loop: true })
      setCine(true)
    }
  }
  useEffect(() => {
    if (!cine) return
    const vp = activeVp()
    if (!vp) return
    csTools.utilities.cine.playClip(vp.element as HTMLDivElement, { framesPerSecond: fps, loop: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fps])

  const deleteSelectedAnnotations = () => {
    const sel = csTools.annotation.selection.getAnnotationsSelected()
    for (const uid of sel) csTools.annotation.state.removeAnnotation(uid)
    getEngine().render()
  }

  const clearAnnotations = async () => {
    if (
      !(await ui.confirm(
        'Delete all annotations?',
        'All measurements, labels and arrows in the viewer will be removed. Annotations saved with V stay saved until you save again.',
        'Delete all',
        true
      ))
    )
      return
    for (const a of csTools.annotation.state.getAllAnnotations()) {
      if (a.annotationUID && isUserAnnotation(a)) csTools.annotation.state.removeAnnotation(a.annotationUID)
    }
    getEngine().render()
  }

  const clearSpine = async () => {
    const vp = activeVp()
    if (!vp) return
    if (!(await ui.confirm('Clear the spine labels?', 'All spine labels of this scan will be removed.', 'Clear', true))) return
    clearSpineLabels(vp)
    getEngine().render()
  }

  // ------------------------------------------------------------ saved annotations (V)
  /** Studies whose saved annotations were read (saving them again may then remove some). */
  const annLoaded = useRef(new Set<number>())

  /** The annotations drawn on a study's images (any of its series, any plane). */
  const annotationsOfStudy = (studyId: number): csTools.Types.Annotation[] => {
    const images = new Set<string>()
    const frames = new Set<string>()
    const seriesIds = new Set<number>()
    for (const se of seriesMap[studyId] ?? []) {
      seriesIds.add(se.id)
      const imgs = imagesRef.current[se.id]
      if (!imgs) continue
      for (const id of imgs.imageIds) images.add(id)
      if (imgs.frameOfReferenceUid) frames.add(imgs.frameOfReferenceUid)
    }
    return csTools.annotation.state.getAllAnnotations().filter((a) => {
      if (!isUserAnnotation(a)) return false
      const ref = a.metadata?.referencedImageId
      // Measurements on planes computed on the processor belong to the series they came from.
      const reformatOf = ref ? reformatSeriesOf(ref) : null
      if (reformatOf != null) return seriesIds.has(reformatOf)
      if (ref) return images.has(ref)
      return !!a.metadata?.FrameOfReferenceUID && frames.has(a.metadata.FrameOfReferenceUID)
    })
  }

  const serializeAnnotations = (list: csTools.Types.Annotation[]) =>
    JSON.stringify(
      list.map((a) => ({
        annotationUID: a.annotationUID,
        metadata: a.metadata,
        data: a.data,
        isLocked: !!a.isLocked,
        isVisible: true
      })),
      (key, value: unknown) => {
        if (key === 'cachedStats') return {} // recalculated when shown
        if (key === 'roi' || key === 'enabledElement' || key === 'instance' || key === 'pointsInShape') return undefined
        if (ArrayBuffer.isView(value)) return Array.from(value as unknown as ArrayLike<number>)
        return value
      }
    )

  /** Puts the saved annotations of a study back on its images. `replace` drops the unsaved ones first. */
  const loadSavedAnnotations = async (studyId: number, replace: boolean): Promise<number> => {
    const json = await api.getSavedAnnotations(studyId)
    annLoaded.current.add(studyId)
    const state = csTools.annotation.state
    if (replace) for (const a of annotationsOfStudy(studyId)) if (a.annotationUID) state.removeAnnotation(a.annotationUID)
    let list: csTools.Types.Annotation[] = []
    try {
      list = json ? (JSON.parse(json) as csTools.Types.Annotation[]) : []
    } catch {
      list = []
    }
    let n = 0
    for (const a of list) {
      if (!a?.annotationUID || !a.data || !isUserAnnotation(a) || state.getAnnotation(a.annotationUID)) continue
      a.invalidated = true
      a.highlighted = false
      a.isSelected = false
      a.data.cachedStats = {}
      state.addAnnotation(a, a.metadata?.FrameOfReferenceUID ?? 'undefined')
      n++
    }
    if (n || replace) {
      try {
        getEngine().render()
      } catch {
        /* not ready */
      }
    }
    return n
  }

  const saveAnnotations = async () => {
    let total = 0
    let saved = 0
    for (const sid of shown) {
      const list = annotationsOfStudy(sid)
      if (!list.length && !annLoaded.current.has(sid)) continue
      await api.saveAnnotations(sid, serializeAnnotations(list))
      annLoaded.current.add(sid)
      total += list.length
      saved++
    }
    if (!saved) ui.toast('There are no annotations to save.', 'info')
    else if (!total) ui.toast('Saved: the study has no annotations now.', 'success')
    else ui.toast(`${total} annotation${total === 1 ? '' : 's'} saved – they show again when the study is opened.`, 'success')
  }

  const reloadSavedAnnotations = async () => {
    let n = 0
    for (const sid of shown) n += await loadSavedAnnotations(sid, true)
    ui.toast(n ? `${n} saved annotation${n === 1 ? '' : 's'} loaded` : 'No saved annotations for this study.', 'info')
  }

  /** The active tile as an image, with measurements burnt in. */
  const captureActive = (maxW = 0, type: 'image/jpeg' | 'image/png' = 'image/png') => captureSlot(slotsRef.current[active]?.id, maxW, type)

  const captureSlot = async (slotId: string | undefined, maxW = 0, type: 'image/jpeg' | 'image/png' = 'image/png') => {
    const slot = slotsRef.current.find((x) => x.id === slotId)
    const vp = slot ? getEngine().getViewport(slot.id) : undefined
    if (!vp || !slot) return null
    const src = vp.canvas
    const out = document.createElement('canvas')
    out.width = src.width
    out.height = src.height
    const ctx = out.getContext('2d')!
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.drawImage(src, 0, 0)
    // The liver analysis colours of the tile.
    const liverCanvas = (vp.element as HTMLElement).parentElement?.querySelector('canvas.v-liver') as HTMLCanvasElement | null
    if (liverCanvas && liverCanvas.width) ctx.drawImage(liverCanvas, 0, 0, out.width, out.height)
    const svg = (vp.element as HTMLElement).querySelector('svg')
    if (svg && showAnn) {
      const clone = svg.cloneNode(true) as SVGSVGElement
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
      clone.setAttribute('width', String(svg.clientWidth))
      clone.setAttribute('height', String(svg.clientHeight))
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }))
      await new Promise<void>((resolve) => {
        const img = new Image()
        img.onload = () => {
          ctx.drawImage(img, 0, 0, out.width, out.height)
          resolve()
        }
        img.onerror = () => resolve()
        img.src = url
      })
      URL.revokeObjectURL(url)
    }
    let final = out
    if (maxW && out.width > maxW) {
      final = document.createElement('canvas')
      final.width = maxW
      final.height = Math.round((out.height * maxW) / out.width)
      final.getContext('2d')!.drawImage(out, 0, 0, final.width, final.height)
    }
    const series = slot.studyId != null ? (seriesMap[slot.studyId] ?? []).find((s) => s.id === slot.seriesId) : undefined
    // Original images get their number; reformatted planes say which plane they are.
    let imageNo = ''
    if (slot.kind === 'stack' && vp.type === CoreEnums.ViewportType.STACK) imageNo = `, image ${(vp as Types.IStackViewport).getCurrentImageIdIndex() + 1}`
    const name = series ? `Series ${series.number ?? ''} ${series.description}`.trim() : ''
    const proj = slot.id.startsWith('mpr-') ? mprProj : slot.slab
    const plane = slot.kind !== 'stack' ? `${slot.kind}${proj && proj.mm > 0 ? ` ${projectionLabel(proj)}` : ''}` : ''
    const caption = `${[name, plane].filter(Boolean).join(' – ') || 'Image'}${imageNo}`
    return { dataUrl: final.toDataURL(type, 0.9), caption }
  }

  const keyImage = async () => {
    const shot = await captureActive(900, 'image/jpeg')
    if (!shot) return
    await api.sendKeyImage(shot)
    ui.toast('Key image (bookmark) sent to the report', 'success')
  }

  const copyImage = async () => {
    const shot = await captureActive()
    if (!shot) return
    try {
      const blob = await (await fetch(shot.dataUrl)).blob()
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      ui.toast('Image copied to the clipboard', 'success')
    } catch (e) {
      ui.toast(`Could not copy: ${(e as Error).message}`, 'error')
    }
  }

  const saveImage = async () => {
    const shot = await captureActive()
    if (!shot) return
    const st = studies[0]
    const file = await api.saveImage(shot.dataUrl, `${st?.patientName ?? 'image'} ${shot.caption}`)
    if (file) ui.toast(`Saved ${file}`, 'success')
  }

  // ------------------------------------------------------------ comparisons (Alt+C / Alt+Shift+C / Alt+X)
  const compareWith = async (prior: StudyRow) => {
    const cur = studies[0]
    if (!cur) return
    if (mpr) exitMpr()
    const curSeriesList = seriesMap[cur.id] ?? (await ensureSeries(cur.id))
    const priorSeries = await ensureSeries(prior.id)
    setShown((s) => (s.includes(prior.id) ? s : [...s, prior.id]))
    void loadSavedRef.current(prior.id)
    const curSlot = slotsRef.current[active]
    const keepCurrent = curSlot?.studyId === cur.id ? curSlot : slotsRef.current.find((s) => s.studyId === cur.id)
    const curSeries = curSeriesList.find((s) => s.id === keepCurrent?.seriesId) ?? pickBestSeries(curSeriesList)
    if (!curSeries) return
    const match = matchSeries(curSeries, priorSeries)
    await ensureImages(curSeries.id)
    if (match) await ensureImages(match.id)
    setLayout({ rows: 1, cols: 2 })
    setMaximized(null)
    setSlots([
      { id: 'vp-0', kind: 'stack', seriesId: curSeries.id, studyId: cur.id },
      { id: 'vp-1', kind: 'stack', seriesId: match?.id ?? null, studyId: match ? prior.id : null }
    ])
    setActive(0)
    setScrollLink(true)
    setLinkMembers(null)
    ui.toast(`Comparing with ${prior.description || 'prior'} (${formatDicomDate(prior.studyDate)}) – scrolling linked`, 'info')
  }

  const compareStep = (dir: 1 | -1) => {
    const priors = studies.slice(1)
    if (!priors.length) {
      ui.toast('No previous study for this patient.', 'info')
      return
    }
    compareIdx.current = (compareIdx.current + dir + priors.length) % priors.length
    void compareWith(priors[compareIdx.current])
  }

  const closeComparison = async () => {
    const cur = studies[0]
    if (!cur) return
    if (mpr) exitMpr()
    setShown([cur.id])
    compareIdx.current = -1
    const curSlot = slotsRef.current.find((s) => s.studyId === cur.id && s.seriesId != null)
    const seriesId = curSlot?.seriesId ?? pickBestSeries(seriesMap[cur.id] ?? [])?.id ?? null
    if (seriesId != null) await ensureImages(seriesId)
    setLayout({ rows: 1, cols: 1 })
    setSlots([{ id: 'vp-0', kind: 'stack', seriesId, studyId: cur.id }])
    setActive(0)
    setScrollLink(false)
  }

  /** Alt+S / Alt+A: next / previous series of the same study in the active tile. */
  const stepSeries = (dir: 1 | -1) => {
    const slot = slotsRef.current[active]
    if (!slot || slot.id.startsWith('mpr-') || slot.studyId == null) return
    const list = (seriesMap[slot.studyId] ?? []).filter((s) => s.isImage && s.numImages > 0)
    if (!list.length) return
    const i = list.findIndex((s) => s.id === slot.seriesId)
    const next = list[(i + dir + list.length) % list.length]
    void loadIntoSlot(active, next.id, slot.studyId)
  }

  const toggleShown = async (studyId: number) => {
    if (studyId === currentStudyId) return
    if (shown.includes(studyId)) setShown(shown.filter((x) => x !== studyId))
    else {
      const list = await ensureSeries(studyId)
      const t: Record<number, string> = {}
      for (const s of list) if (s.thumb) t[s.id] = s.thumb
      setThumbs((x) => ({ ...x, ...t }))
      setShown([...shown, studyId])
      void loadSavedRef.current(studyId)
    }
  }

  // ------------------------------------------------------------ linking helpers (S K C J I Q U)
  const toggleScrollLink = () => {
    setScrollLink((on) => {
      ui.toast(on ? 'Linked scrolling off' : 'Linked scrolling on', 'info')
      return !on
    })
    setLinkMembers(null)
  }
  const toggleLinkMember = () => {
    const id = slotsRef.current[active]?.id
    if (!id) return
    if (!scrollLink) {
      setScrollLink(true)
      setLinkMembers([id])
      ui.toast('Tile added to linked scrolling', 'info')
      return
    }
    const all = slotsRef.current.map((s) => s.id)
    const cur = linkMembers ?? all
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    setLinkMembers(next)
    ui.toast(cur.includes(id) ? 'Tile removed from linked scrolling' : 'Tile added to linked scrolling', 'info')
  }
  const togglePresLink = () => {
    setPresLink((on) => {
      ui.toast(on ? 'Window/level + zoom link off' : 'Window/level + zoom linked between tiles', 'info')
      return !on
    })
  }

  const saveNotes = async () => {
    if (notes == null || currentStudyId == null) return
    await api.updateStudy(currentStudyId, { clinicalHistory: notes })
    setNotes(null)
    ui.toast('Notes saved (shown in the report’s Clinical Details)', 'success')
  }

  // ------------------------------------------------------------ full screen (F11)
  const toggleFullScreen = () => {
    const next = !fullScreen
    setFullScreen(next)
    void api.setFullScreen(next)
    if (next) {
      topBeforeFullScreen.current = showTop
      setShowTop(false) // all the room for the images; Alt+E brings the series strip back
    } else setShowTop(topBeforeFullScreen.current)
  }

  // ------------------------------------------------------------ keyboard (Synapse hot keys)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      if (document.querySelector('.modal-backdrop')) return
      if (menu) {
        if (e.key === 'Escape') setMenu(null)
        return
      }
      const k = e.key
      const lower = k.length === 1 ? k.toLowerCase() : k
      // Number pad 0-9 = window presets. Checked by physical key first, so they work with Num Lock
      // off too (then the keys would otherwise arrive as End / arrows / PgDn and scroll instead).
      const numpad = /^Numpad(\d)$/.exec(e.code)
      if (numpad && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault()
        if (numpad[1] === ORIGINAL_PRESET_KEY) resetVoi()
        else {
          const p = CT_PRESETS.find((x) => x.key === numpad[1])
          if (p) applyPreset(p.ww, p.wc)
        }
        return
      }

      if (k === 'F4') void api.toggleDictation()
      else if (k === 'F5') transform('reset')
      else if (k === 'F11') toggleFullScreen()
      else if (e.ctrlKey && !e.altKey && lower === 'c') void copyImage()
      else if (e.altKey && lower === 'c') compareStep(e.shiftKey ? -1 : 1)
      else if (e.altKey && lower === 'x') void closeComparison()
      else if (e.altKey && lower === 's') stepSeries(1)
      else if (e.altKey && lower === 'a') stepSeries(-1)
      else if (e.altKey && lower === 'r') {
        if (currentStudyId != null) void api.openReportFor(currentStudyId)
      }
      else if (e.altKey && lower === 'i') setInfo(true)
      else if (e.altKey && lower === 'n') setNotes(studies[0]?.clinicalHistory ?? '')
      else if (e.altKey && lower === 'e') setShowTop((v) => !v)
      else if (e.shiftKey && lower === 'z') chooseTool('Zoom', true)
      else if (e.shiftKey && lower === 'x') chooseTool('Pan', true)
      else if (e.shiftKey && lower === 't') setOverlay((v) => !v)
      else if (e.shiftKey && lower === 'a') setShowAnn((v) => !v)
      else if (e.shiftKey && lower === 'i') transform('invert')
      else if (k === 'ArrowUp' || k === 'ArrowLeft') scrollActive(-1)
      else if (k === 'ArrowDown' || k === 'ArrowRight') scrollActive(1)
      else if (k === 'PageUp') scrollActive(-10)
      else if (k === 'PageDown') scrollActive(10)
      else if (k === 'Home') jumpActive('first')
      else if (k === 'End') jumpActive('last')
      else if (e.code === 'Digit3' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) void reformatActive('coronal')
      else if ((k === '?' || e.code === 'Slash') && !e.ctrlKey && !e.altKey && !e.metaKey) void reformatActive('sagittal')
      else if (k === '=' || k === '+') transform('fit')
      else if (k === '-') transform('actual')
      else if (k === ' ') toggleCine()
      else if (k === 'Delete' && e.shiftKey) void clearAnnotations()
      else if (k === 'Delete' || k === 'Backspace') deleteSelectedAnnotations()
      else if (k === 'Escape' && mpr?.liver && (liverStore.state.tool || liverStore.state.pendingCut)) liverStore.ui({ tool: null, pendingCut: null })
      else if (k === 'Escape') {
        if (!isDragMode(tool) && tool !== 'Crosshairs') chooseTool('WindowLevel', true)
        else if (mpr) exitMpr()
        else chooseTool('WindowLevel', true)
      } else if (k === 'Tab') setActive((a) => (a + 1) % slotsRef.current.length)
      else if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        if (HOTKEY_TOOLS[lower]) chooseTool(HOTKEY_TOOLS[lower], isDragMode(HOTKEY_TOOLS[lower]))
        else if (lower === 'l') {
          setLocked(true)
          ui.toast(`${TOOL_LABEL[tool]} locked (Esc to release)`, 'info')
        } else if (lower === 'b') void keyImage()
        else if (lower === 'v') void saveAnnotations()
        else if (lower === 'i') togglePresLink()
        else if (lower === 's') toggleScrollLink()
        else if (lower === 'k') toggleLinkMember()
        else if (lower === 'c') {
          setScrollLink(false)
          setLinkMembers(null)
          ui.toast('Linked scrolling: all tiles removed', 'info')
        } else if (lower === 'j') {
          setScrollLink(true)
          setLinkMembers(null)
          ui.toast('Linked scrolling: all tiles linked', 'info')
        } else if (lower === 'q') {
          setRefLines(true)
          setRefSource(slotsRef.current[active]?.id ?? null)
          ui.toast('Reference lines locked to this tile', 'info')
        } else if (lower === 'u') {
          setRefSource(null)
          ui.toast('Reference lines unlocked', 'info')
        } else if (lower === 'n') toggleCine()
        else if (lower === 'm') void (mpr ? exitMpr() : enterMpr())
        else return
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ------------------------------------------------------------ render helpers
  const studyById = useMemo(() => new Map(studies.map((s) => [s.id, s])), [studies])
  const seriesById = useMemo(() => {
    const m = new Map<number, SeriesRow>()
    for (const list of Object.values(seriesMap)) for (const s of list) m.set(s.id, s)
    return m
  }, [seriesMap])
  const inView = new Set(slots.map((s) => s.seriesId))
  const activeSeriesId = slots[active]?.seriesId

  if (initError) {
    const g = gpu()
    return (
      <div className="v-welcome">
        <h3>Viewer could not start</h3>
        <p>{initError}</p>
        {g.renderer && <p className="v-gpu">Graphics: {g.renderer}</p>}
        <button
          className="btn"
          onClick={() => {
            try {
              sessionStorage.removeItem('pacs:glResets')
              sessionStorage.removeItem('pacs:glResetAt')
            } catch {
              /* storage blocked */
            }
            location.reload()
          }}
        >
          Try again
        </button>
      </div>
    )
  }

  const toolBtn = (t: ToolName, title: string, icon: ReactNode) => (
    <VBtn title={title} active={tool === t} onClick={() => chooseTool(t, true)}>
      {icon}
    </VBtn>
  )

  const presetItems: MenuItem[] = [
    { label: 'Original (from scanner)', hint: `Num ${ORIGINAL_PRESET_KEY}`, onClick: resetVoi },
    ...CT_PRESETS.map((p) => ({ label: `${p.name}  (${p.ww}/${p.wc})`, hint: p.key ? `Num ${p.key}` : '', onClick: () => applyPreset(p.ww, p.wc) }))
  ]
  const pick = (label: string, t: ToolName, hint?: string): MenuItem => ({
    label,
    hint,
    checked: tool === t,
    onClick: () => chooseTool(t, false)
  })
  const annotationItems: MenuItem[] = [
    pick('Ruler', 'Length', 'R'),
    pick('Angle', 'Angle', 'G'),
    pick('Cobb Angle', 'CobbAngle'),
    pick('Elliptical ROI', 'EllipticalROI', 'E'),
    pick('Circle ROI', 'CircleROI', 'H'),
    pick('Rectangular ROI', 'RectangleROI'),
    pick('Polygon ROI', 'PolygonROI'),
    pick('Freehand ROI', 'FreehandROI', 'F'),
    pick('Bidirectional (long/short axis)', 'Bidirectional'),
    'sep',
    pick('Text', 'Label', 'T'),
    pick('Arrow', 'ArrowAnnotate', 'A'),
    pick('Spine Labels', 'SpineLabel', 'P'),
    pick('Cardiothoracic Ratio (4 points)', 'CTR4'),
    pick('Cardiothoracic Ratio (6 points)', 'CTR6'),
    'sep',
    { label: 'Show Annotations', hint: 'Shift+A', checked: showAnn, onClick: () => setShowAnn((v) => !v) },
    { label: 'Save Annotations', hint: 'V', onClick: () => void saveAnnotations() },
    { label: 'Load Saved Annotations', onClick: () => void reloadSavedAnnotations() },
    { label: 'Delete All Annotations', hint: 'Shift+Del', onClick: () => void clearAnnotations() }
  ]
  const menuItems: MenuItem[] = [
    { label: 'Window Level', hint: 'W', checked: tool === 'WindowLevel', onClick: () => chooseTool('WindowLevel', true) },
    { label: 'Zoom', hint: 'Shift+Z', checked: tool === 'Zoom', onClick: () => chooseTool('Zoom', true) },
    { label: 'Pan', hint: 'Shift+X', checked: tool === 'Pan', onClick: () => chooseTool('Pan', true) },
    { label: 'Dynamic Scroll', hint: 'Z', checked: tool === 'StackScroll', onClick: () => chooseTool('StackScroll', true) },
    { label: 'Density Value', hint: 'D', checked: tool === 'Probe', onClick: () => chooseTool('Probe', false) },
    { label: 'Lock Tools', hint: 'L', checked: locked && !isDragMode(tool), onClick: () => setLocked(true) },
    'sep',
    { label: 'Image Presets', submenu: presetItems },
    { label: 'Annotations', submenu: annotationItems },
    {
      label: 'Scale, Rotate, Flip',
      submenu: [
        { label: 'Zoom to fit', hint: '=', onClick: () => transform('fit') },
        { label: 'Zoom 1:1', hint: '-', onClick: () => transform('actual') },
        'sep',
        { label: 'Rotate right 90°', onClick: () => transform('rotateR') },
        { label: 'Rotate left 90°', onClick: () => transform('rotateL') },
        { label: 'Flip horizontal', onClick: () => transform('flipH') },
        { label: 'Flip vertical', onClick: () => transform('flipV') },
        { label: 'Invert', hint: 'Shift+I', onClick: () => transform('invert') }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Show Text Overlay', hint: 'Shift+T', checked: overlay, onClick: () => setOverlay((v) => !v) },
        'sep',
        { label: 'Magnifying Glass', hint: 'O', checked: tool === 'Magnify', onClick: () => chooseTool('Magnify', false) },
        { label: 'Eraser', hint: 'X', checked: tool === 'Eraser', onClick: () => chooseTool('Eraser', true) },
        'sep',
        { label: 'Bookmark Image (key image to report)', hint: 'B', onClick: () => void keyImage() }
      ]
    },
    {
      label: 'Reference Lines',
      submenu: [
        { label: 'Show reference lines', checked: refLines, onClick: () => setRefLines((v) => !v) },
        { label: 'Lock to this tile', hint: 'Q', checked: refSource != null, onClick: () => setRefSource(slots[active]?.id ?? null) },
        { label: 'Unlock', hint: 'U', onClick: () => setRefSource(null) }
      ]
    },
    { label: 'Save Image…', onClick: () => void saveImage() },
    'sep',
    { label: 'Copy To Clipboard', hint: 'Ctrl+C', onClick: () => void copyImage() },
    'sep',
    {
      label: 'Clear View',
      disabled: !!mpr,
      onClick: () =>
        setSlots((prev) => prev.map((s, i) => (i === active ? { ...s, kind: 'stack', voi: null, seriesId: null, studyId: null } : s)))
    },
    {
      label: 'Tile Formats',
      submenu: LAYOUTS.map(([r, c]) => ({
        label: `${r} × ${c}`,
        checked: !mpr && layout.rows === r && layout.cols === c,
        onClick: () => void applyLayout(r, c)
      }))
    },
    {
      label: 'Link / Scroll',
      submenu: [
        { label: 'Linked scrolling', hint: 'S', checked: scrollLink, onClick: toggleScrollLink },
        { label: 'Add / remove this tile', hint: 'K', checked: isLinked(slots[active]?.id ?? ''), onClick: toggleLinkMember },
        { label: 'Remove all', hint: 'C', onClick: () => (setScrollLink(false), setLinkMembers(null)) },
        { label: 'Auto link all tiles', hint: 'J', onClick: () => (setScrollLink(true), setLinkMembers(null)) },
        'sep',
        { label: 'Link window/level + zoom', hint: 'I', checked: presLink, onClick: togglePresLink }
      ]
    },
    'sep',
    { label: 'Cine', hint: 'N', checked: cine, onClick: toggleCine },
    { label: 'Compare with prior', hint: 'Alt+C', disabled: studies.length < 2, onClick: () => compareStep(1) },
    { label: 'Reset image', hint: 'F5', onClick: () => transform('reset') },
    { label: 'Full screen', hint: 'F11', checked: fullScreen, onClick: toggleFullScreen },
    'sep',
    { label: mpr && !mpr.liver ? 'Exit MPR View' : 'MPR View…', hint: 'M', onClick: () => void (mpr && !mpr.liver ? exitMpr() : enterMpr()) },
    { label: mpr?.liver ? 'Exit Liver Analysis' : 'Liver Analysis (volumetry)…', onClick: () => void (mpr?.liver ? exitMpr() : enterLiver()) },
    {
      label: 'Plane',
      disabled: !!mpr,
      submenu: [
        { label: 'Original (axial)', hint: '3', checked: slots[active]?.kind === 'stack', onClick: () => void reformatActive('stack') },
        { label: 'Coronal', hint: '3', checked: slots[active]?.kind === 'coronal', onClick: () => void reformatActive('coronal') },
        { label: 'Sagittal', hint: '?', checked: slots[active]?.kind === 'sagittal', onClick: () => void reformatActive('sagittal') }
      ]
    },
    {
      label: 'MIP / MinIP',
      submenu: [
        { label: 'Thin', checked: !currentProj(), onClick: () => void setProjection(null) },
        'sep',
        ...(['mip', 'minip'] as const).flatMap((mode, k) => [
          ...(k ? (['sep'] as const) : []),
          ...slabChoices(mode).map((mm) => ({
            label: projectionLabel({ mode, mm }),
            checked: currentProj()?.mode === mode && currentProj()?.mm === mm,
            onClick: () => void setProjection({ mode, mm })
          }))
        ])
      ]
    }
  ]

  const cur = studies[0]
  let nat: ReturnType<typeof getNatural> = null
  if (info && ready && slots[active]) {
    try {
      const vp = getEngine().getViewport(slots[active].id) as Types.IStackViewport | undefined
      if (vp && vp.type === CoreEnums.ViewportType.STACK) nat = getNatural(vp.getCurrentImageId())
    } catch {
      nat = null
    }
  }

  return (
    <div className="viewer">
      {showTop && (
        <div className="v-top">
          <div className="v-studies">
            <div className="v-studies-table">
              <table>
                <thead>
                  <tr>
                    <th></th>
                    <th>Proc Description</th>
                    <th>Date</th>
                    <th>Accession</th>
                    <th>Img</th>
                  </tr>
                </thead>
                <tbody>
                  {studies.map((s) => (
                    <tr
                      key={s.id}
                      className={`${s.id === currentStudyId ? 'current' : ''} ${shown.includes(s.id) ? 'shown' : ''}`}
                      onClick={() => void toggleShown(s.id)}
                      title={s.id === currentStudyId ? 'Current study' : 'Click to show/hide this study’s series for comparison'}
                    >
                      <td>
                        <input type="checkbox" readOnly checked={shown.includes(s.id)} disabled={s.id === currentStudyId} />
                      </td>
                      <td>{s.description || s.modalities}</td>
                      <td>
                        {formatDicomDate(s.studyDate)} {formatDicomTime(s.studyTime)}
                      </td>
                      <td>{s.accession}</td>
                      <td>{s.numImages}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="v-strip">
            {studies.length === 0 && <div className="v-welcome">Open a study from the worklist (Report or Images button).</div>}
            {shown.map((sid) => {
              const st = studyById.get(sid)
              if (!st) return null
              return [
                <div key={`tab-${sid}`} className={`v-study-tab ${sid === currentStudyId ? 'current' : ''}`}>
                  <b>{st.modalities.split('\\')[0]}</b>
                  <span>{formatDicomDate(st.studyDate)}</span>
                  <span>[{st.numImages}]</span>
                </div>,
                ...(seriesMap[sid] ?? []).map((se) => (
                  <div
                    key={se.id}
                    className={`v-thumb ${se.isImage ? '' : 'disabled'} ${inView.has(se.id) ? 'in-view' : ''} ${activeSeriesId === se.id ? 'in-active' : ''}`}
                    title={`${se.description || '(no description)'} – ${se.numFrames} image(s)`}
                    draggable={se.isImage}
                    onDragStart={(e) => e.dataTransfer.setData('application/x-series', JSON.stringify({ seriesId: se.id, studyId: sid }))}
                    onClick={() => se.isImage && void loadIntoSlot(active, se.id, sid)}
                  >
                    <div className="v-thumb-img">
                      {thumbs[se.id] || se.thumb ? (
                        <img src={thumbs[se.id] || se.thumb || ''} alt="" draggable={false} />
                      ) : (
                        <span className="ph">{se.isImage ? '…' : se.modality || 'non-image'}</span>
                      )}
                    </div>
                    <span className="v-thumb-count">{se.numFrames}</span>
                    <div className="v-thumb-label">
                      {se.number ?? ''} {se.description || se.modality}
                    </div>
                  </div>
                ))
              ]
            })}
          </div>
        </div>
      )}

      <div className="v-toolbar">
        <VBtn title="Study information (Alt+I)" onClick={() => setInfo(true)} disabled={!cur}>
          <Info size={17} />
        </VBtn>
        <VBtn title="Report (Alt+R)" onClick={() => currentStudyId != null && void api.openReportFor(currentStudyId)} disabled={currentStudyId == null}>
          <FileText size={17} />
        </VBtn>
        <VBtn title="Notes / clinical history (Alt+N)" onClick={() => setNotes(cur?.clinicalHistory ?? '')} disabled={!cur}>
          <StickyNote size={17} />
        </VBtn>
        <VBtn title="Series picker on/off (Alt+E)" on={showTop} onClick={() => setShowTop((v) => !v)}>
          <PanelTop size={17} />
        </VBtn>
        <span className="v-sep" />
        {LAYOUTS.map(([r, c]) => (
          <VBtn key={`${r}x${c}`} title={`Tile format ${r}×${c}`} active={!mpr && layout.rows === r && layout.cols === c} onClick={() => void applyLayout(r, c)}>
            <LayoutIcon r={r} c={c} />
          </VBtn>
        ))}
        <span className="v-sep" />
        {toolBtn('WindowLevel', 'Window level (left-drag; Alt+drag)', <SunMoon size={17} />)}
        {toolBtn('Zoom', 'Zoom (Shift+Z; hold right + drag; Alt+Ctrl+drag; hold left + right-click to switch)', <ZoomIn size={17} />)}
        {toolBtn('Pan', 'Pan (Shift+X; Alt+Shift+drag)', <Hand size={17} />)}
        {toolBtn('StackScroll', 'Dynamic scroll – left-drag up/down through the images (Z)', <ChevronsUpDown size={17} />)}
        {toolBtn('Magnify', 'Magnifying glass (O)', <Search size={17} />)}
        <span className="v-sep" />
        {toolBtn('Length', 'Ruler (R)', <Ruler size={17} />)}
        {toolBtn('Angle', 'Angle (G)', <Triangle size={17} />)}
        {toolBtn('EllipticalROI', 'Elliptical ROI – mean/SD HU, area (E)', <Ellipse size={17} />)}
        {toolBtn('CircleROI', 'Circle ROI – mean/SD HU, area (H)', <Circle size={17} />)}
        {toolBtn('FreehandROI', 'Freehand ROI (F)', <Lasso size={17} />)}
        {toolBtn('Probe', 'Density value – HU (D)', <Crosshair size={17} />)}
        {toolBtn('ArrowAnnotate', 'Arrow (A)', <ArrowUpRight size={17} />)}
        {toolBtn('Label', 'Text (T)', <Type size={17} />)}
        {toolBtn('SpineLabel', 'Spine labels – pick the first level, then click above / below (P)', <Bone size={17} />)}
        {toolBtn('CTR4', 'Cardiothoracic ratio (4 points; 6-point version in the right-click menu)', <Heart size={17} />)}
        {toolBtn('Eraser', 'Eraser – click a measurement to delete (X)', <Eraser size={17} />)}
        <VBtn title={locked ? 'Tool locked (Esc releases)' : 'Lock the current tool (L)'} on={locked && !isDragMode(tool)} onClick={() => setLocked((v) => !v)}>
          {locked ? <Lock size={16} /> : <LockOpen size={16} />}
        </VBtn>
        <span className="v-sep" />
        <select
          className="v-select"
          title={`Image presets (number pad: 0 = bone, 3 = liver, ${ORIGINAL_PRESET_KEY} = original; the others as listed)`}
          value=""
          onChange={(e) => {
            const v = e.target.value
            if (v === 'default') resetVoi()
            else {
              const p = CT_PRESETS[Number(v)]
              if (p) applyPreset(p.ww, p.wc)
            }
          }}
        >
          <option value="">Image presets…</option>
          <option value="default">{ORIGINAL_PRESET_KEY} · Original (from scanner)</option>
          {CT_PRESETS.map((p, i) => (
            <option key={p.name} value={i}>
              {p.key ? `${p.key} · ` : ''}
              {p.name} ({p.ww}/{p.wc})
            </option>
          ))}
        </select>
        <VBtn title="Invert (Shift+I)" onClick={() => transform('invert')}>
          <Contrast size={17} />
        </VBtn>
        <VBtn title="Reset image (F5)" onClick={() => transform('reset')}>
          <RotateCcw size={17} />
        </VBtn>
        <span className="v-sep" />
        <VBtn
          title="Liver analysis – liver volume, findings, vessels, Couinaud segments, resection planning, 3D"
          on={!!mpr?.liver}
          onClick={() => void (mpr?.liver ? exitMpr() : enterLiver())}
        >
          <Layers size={17} /> Liver
        </VBtn>
        <VBtn title="MPR view – axial / sagittal / coronal (M)" on={!!mpr && !mpr.liver} onClick={() => void (mpr && !mpr.liver ? exitMpr() : enterMpr())}>
          <Box size={17} /> MPR
        </VBtn>
        {mpr && toolBtn('Crosshairs', 'Crosshairs', <Crosshair size={17} />)}
        <select
          className="v-select"
          title={`Thick slab: MIP (brightest) or MinIP (darkest) through the slab – ${mpr ? 'all three MPR planes' : 'the active tile'}. Ctrl+Shift+wheel over a tile: thicker / thinner`}
          value={projValue(currentProj())}
          onChange={(e) => void setProjection(parseProj(e.target.value))}
        >
          <option value="">Thin</option>
          <optgroup label="MIP">
            {slabChoices('mip').map((t) => (
              <option key={`mip${t}`} value={`mip:${t}`}>
                MIP {t} mm
              </option>
            ))}
          </optgroup>
          <optgroup label="MinIP">
            {slabChoices('minip').map((t) => (
              <option key={`minip${t}`} value={`minip:${t}`}>
                MinIP {t} mm
              </option>
            ))}
          </optgroup>
        </select>
        <VBtn title="Linked scrolling (S) – K adds/removes this tile" on={scrollLink} onClick={toggleScrollLink}>
          <Link2 size={17} />
        </VBtn>
        <VBtn title="Link window/level + zoom between tiles (I, or double-click the mouse wheel)" on={presLink} onClick={togglePresLink}>
          <Link size={16} />
        </VBtn>
        <VBtn title="Reference lines (Q locks, U unlocks)" on={refLines} onClick={() => setRefLines((v) => !v)}>
          <ScanLine size={17} />
        </VBtn>
        <VBtn title="Compare with previous study (Alt+C, Alt+Shift+C for older)" onClick={() => compareStep(1)} disabled={studies.length < 2}>
          <Columns2 size={17} />
        </VBtn>
        {shown.length > 1 && (
          <VBtn title="Close comparison (Alt+X)" onClick={() => void closeComparison()}>
            <X size={16} />
          </VBtn>
        )}
        <VBtn title="Cine play/pause (N)" on={cine} onClick={toggleCine}>
          {cine ? <Pause size={17} /> : <Play size={17} />}
        </VBtn>
        <select className="v-select" title="Cine speed" value={fps} onChange={(e) => setFps(Number(e.target.value))}>
          {[5, 10, 15, 20, 30].map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
        <span className="v-sep" />
        <VBtn title="Bookmark – send key image to the report (B)" onClick={() => void keyImage()}>
          <Bookmark size={17} />
        </VBtn>
        <VBtn title="Save the annotations with the study (V)" onClick={() => void saveAnnotations()} disabled={!cur}>
          <Save size={16} />
        </VBtn>
        <VBtn title="Text overlay on/off (Shift+T)" on={overlay} onClick={() => setOverlay((o) => !o)}>
          <Captions size={17} />
        </VBtn>
        <VBtn title="Mouse & keyboard shortcuts" onClick={() => setHelp(true)}>
          <CircleHelp size={17} />
        </VBtn>
        <div className="spacer" />
        <span className="tool-indicator" title="Current left-mouse tool">
          {TOOL_LABEL[tool]}
          {!isDragMode(tool) && (locked ? ' 🔒' : ' (once)')}
        </span>
        <VBtn title="Dictate into the report (F4)" on={dictating} onClick={() => void api.toggleDictation()}>
          {dictating ? <Mic size={17} /> : <MicOff size={17} />} {dictating ? 'Dictating…' : 'Dictate'}
        </VBtn>
        <VBtn title="Open the report for this study (Alt+R)" onClick={() => currentStudyId != null && void api.openReportFor(currentStudyId)} disabled={currentStudyId == null}>
          <FileText size={17} /> Report
        </VBtn>
        <VBtn title={fullScreen ? 'Leave full screen (F11)' : 'Full screen (F11)'} on={fullScreen} onClick={toggleFullScreen}>
          {fullScreen ? <Minimize size={17} /> : <Maximize size={17} />}
        </VBtn>
      </div>

      <div className="v-body">
      {mpr?.liver && <LiverPanel onClose={exitMpr} onReport={() => void liverToReport()} onSave={() => void saveLiver()} />}
      <div
        ref={gridRef}
        className="v-grid"
        style={{
          gridTemplateColumns: `repeat(${maximized != null ? 1 : layout.cols}, 1fr)`,
          gridTemplateRows: `repeat(${maximized != null ? 1 : layout.rows}, 1fr)`
        }}
      >
        {ready &&
          slots.flatMap((slot, i) => {
            const se = slot.seriesId != null ? seriesById.get(slot.seriesId) : undefined
            const tile = (
              <Viewport
                key={slot.id}
                liver={!!mpr?.liver && slot.id.startsWith('mpr-')}
                slot={slot}
                index={i}
                active={i === active && slots.length > 1}
                hidden={maximized != null && maximized !== i}
                study={slot.studyId != null ? studyById.get(slot.studyId) ?? null : null}
                seriesLabel={se ? `${se.description} (Se ${se.number ?? '—'})` : ''}
                images={slot.seriesId != null ? imagesMap[slot.seriesId] ?? null : null}
                showOverlay={overlay}
                showAnnotations={showAnn}
                scrollLinked={slots.length > 1 && isLinked(slot.id)}
                loading={slot.id.startsWith('mpr-') ? mprLoading : null}
                projection={slot.id.startsWith('mpr-') ? mprProj : slot.slab ?? null}
                cross={mpr?.cpu && slot.id.startsWith('mpr-') ? cross : null}
                crossPlanes={mpr?.cpu ? crossPlanes[slot.id] : undefined}
                crosshair={!!mpr?.cpu && slot.id.startsWith('mpr-') && tool === 'Crosshairs'}
                onCross={(w) => moveCross(slot.id, w)}
                dragMode={isDragMode(tool) ? tool : null}
                onCycleDragMode={cycleDragMode}
                onContextMenu={(x, y) => {
                  setActive(i)
                  setMenu({ x, y })
                }}
                onSlabStep={(dir) => stepSlab(i, dir)}
                onSeriesDrag={onSeriesDrag}
                onMiddleDoubleClick={togglePresLink}
                onActivate={() => setActive(i)}
                onDoubleClick={() => {
                  if (!isDragMode(tool) && tool !== 'StackScroll') return
                  setMaximized((m) => (m === i ? null : slots.length > 1 ? i : null))
                }}
                onDropSeries={(seriesId, studyId) => void loadIntoSlot(i, seriesId, studyId)}
                onImageChange={onImageChange}
              />
            )
            // Liver analysis: the 3-D view sits top right, next to the axial tile.
            return mpr?.liver && i === 0 ? [tile, <Liver3D key="liver-3d" />] : [tile]
          })}
        {!ready && <div className="v-welcome">Starting viewer…</div>}
        {ready && tool === 'SpineLabel' && (
          <SpinePanel
            getViewport={activeVp}
            activeKey={slots[active]?.id ?? ''}
            onClear={() => void clearSpine()}
            onClose={() => chooseTool('WindowLevel', true)}
          />
        )}
      </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}

      {help && (
        <Modal wide title="Viewer mouse & keyboard (Synapse-style)" onClose={() => setHelp(false)}>
          <table className="help-table">
            <tbody>
              {HELP.map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}

      {info && cur && (
        <Modal wide title="Study information" onClose={() => setInfo(false)}>
          <div className="info-grid">
            {[
              ['Patient', cur.patientName],
              ['Patient ID (CR No)', cur.patientId],
              ['Age / Sex', [formatAge(cur.age, cur.birthDate, cur.studyDate), formatSex(cur.sex)].filter(Boolean).join(' / ')],
              ['Birth date', formatDicomDate(cur.birthDate)],
              ['Study', cur.description],
              ['Accession (PG No)', cur.accession],
              ['Study date', formatDicomDateTime(cur.studyDate, cur.studyTime)],
              ['Referring', cur.referring],
              ['Institution', cur.institution],
              ['Modalities', cur.modalities.split('\\').join(', ')],
              ['Series / images', `${cur.numSeries} / ${cur.numImages}`],
              ['Clinical history', cur.clinicalHistory]
            ].map(([k, v]) => (
              <div key={k} className="info-row">
                <span>{k}</span>
                <b>{v || '—'}</b>
              </div>
            ))}
          </div>
          {nat && (
            <>
              <h4 className="info-h">Current image – DICOM attributes</h4>
              <div className="tag-table">
                {Object.entries(nat)
                  .filter(([key, v]) => !/PixelData|^_/.test(key) && v != null && (typeof v !== 'object' || Array.isArray(v)))
                  .slice(0, 400)
                  .map(([key, v]) => (
                    <div key={key} className="tag-row">
                      <span>{key}</span>
                      <span>{str(v).slice(0, 200)}</span>
                    </div>
                  ))}
              </div>
            </>
          )}
        </Modal>
      )}

      {notes != null && (
        <Modal
          title="Notes / clinical history"
          onClose={() => setNotes(null)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setNotes(null)}>
                Cancel
              </button>
              <button className="btn btn-green" onClick={() => void saveNotes()}>
                Save
              </button>
            </>
          }
        >
          <textarea className="notes-area" autoFocus value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Modal>
      )}
    </div>
  )
}
