import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Enums as CoreEnums, setVolumesForViewports, utilities as csUtils } from '@cornerstonejs/core'
import type { Types } from '@cornerstonejs/core'
import * as csTools from '@cornerstonejs/tools'
import {
  ArrowLeftRight,
  ArrowUpRight,
  Box,
  Camera,
  ChevronsUpDown,
  CircleHelp,
  Columns2,
  Contrast,
  Crosshair,
  Ellipse,
  Eraser,
  FileText,
  Hand,
  Info,
  Link2,
  Move,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Ruler,
  Search,
  Square,
  SunMoon,
  Trash,
  Triangle,
  ZoomIn
} from 'lucide-react'
import type { SeriesImages, SeriesRow, StudyRow } from '@shared/types'
import { formatDicomDate, formatDicomTime } from '@shared/format'
import { Modal, useEvent, useUi } from '../common/ui'
import {
  applyVoi,
  cache,
  CT_PRESETS,
  getEngine,
  initCornerstone,
  prefetchSeries,
  setPrimaryTool,
  setTextPrompt,
  volumeLoader
} from './cs'
import type { ToolName } from './cs'
import { Viewport } from './Viewport'
import type { SlotInfo } from './Viewport'

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

interface MprState {
  seriesId: number
  studyId: number
  prevLayout: { rows: number; cols: number }
  prevSlots: SlotInfo[]
}

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
  const [sync, setSync] = useState(false)
  const [overlay, setOverlay] = useState(true)
  const [cine, setCine] = useState(false)
  const [fps, setFps] = useState(10)
  const [mpr, setMpr] = useState<MprState | null>(null)
  const [mprLoading, setMprLoading] = useState<string | null>(null)
  const [slab, setSlab] = useState(0)
  const [help, setHelp] = useState(false)
  const gridRef = useRef<HTMLDivElement>(null)

  // Refs so event handlers always see the latest state.
  const slotsRef = useRef(slots)
  slotsRef.current = slots
  const imagesRef = useRef(imagesMap)
  imagesRef.current = imagesMap
  const syncRef = useRef(sync)
  syncRef.current = sync
  const expected = useRef(new Map<string, number>())

  // ------------------------------------------------------------ init
  useEffect(() => {
    setTextPrompt((label) => ui.prompt('Annotation', label))
  }, [ui])

  useEffect(() => {
    initCornerstone()
      .then(() => setReady(true))
      .catch((e: unknown) => setInitError(String((e as Error)?.message ?? e)))
  }, [])

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
  }, [ready, maximized, layout])

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

  const exitMpr = useCallback(() => {
    setMpr((m) => {
      if (m) {
        setLayout(m.prevLayout)
        setSlots(m.prevSlots)
        setActive(0)
      }
      return null
    })
    setSlab(0)
    setMprLoading(null)
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
      setSync(false)
      setSlots([{ id: 'vp-0', kind: 'stack', seriesId: best?.id ?? null, studyId }])
      setActive(0)
      document.title = `${detail.study.patientName} – ${detail.study.description} – Viewer`
    },
    [ready, ensureImages, exitMpr]
  )

  const pendingStudy = useRef<number | null>(null)
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
  useEvent(api.onStudiesChanged, () => {
    if (currentStudyId == null) return
    void api.getPriors(currentStudyId).then((pri) => setStudies((s) => (s.length ? [s[0], ...pri] : s)))
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
  const loadIntoSlot = useCallback(
    async (index: number, seriesId: number, studyId: number) => {
      if (mpr) exitMpr()
      await ensureImages(seriesId)
      setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, seriesId, studyId } : s)))
      setActive(index)
    },
    [ensureImages, mpr, exitMpr]
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
      if (prev && prev.kind === 'stack') next.push(prev)
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

  // ------------------------------------------------------------ linked scrolling
  const onImageChange = useCallback((slotId: string, oldIdx: number, newIdx: number) => {
    const exp = expected.current.get(slotId)
    if (exp !== undefined) {
      expected.current.delete(slotId)
      if (exp === newIdx) return // this change was caused by syncing
    }
    if (!syncRef.current) return
    const src = slotsRef.current.find((s) => s.id === slotId)
    if (!src?.seriesId) return
    const sImgs = imagesRef.current[src.seriesId]
    const engine = getEngine()
    for (const other of slotsRef.current) {
      if (other.id === slotId || other.kind !== 'stack' || !other.seriesId) continue
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
  }, [])

  // ------------------------------------------------------------ MPR
  const enterMpr = async () => {
    const slot = slots[active]
    if (!slot?.seriesId || slot.kind !== 'stack' || slot.studyId == null) {
      ui.toast('Select a viewport with a series first.', 'info')
      return
    }
    const imgs = await ensureImages(slot.seriesId)
    if (!imgs.reconstructable) {
      ui.toast('This series cannot be reconstructed (needs at least 3 parallel slices of the same size).', 'error')
      return
    }
    setMpr({ seriesId: slot.seriesId, studyId: slot.studyId, prevLayout: layout, prevSlots: slots })
    setLayout({ rows: 1, cols: 3 })
    setMaximized(null)
    setSlots(
      (['axial', 'sagittal', 'coronal'] as const).map((k) => ({ id: `mpr-${k}`, kind: k, seriesId: slot.seriesId, studyId: slot.studyId }))
    )
    setActive(0)
    setTool('Crosshairs')
  }

  useEffect(() => {
    if (!mpr) return
    let cancelled = false
    void (async () => {
      try {
        const imgs = imagesRef.current[mpr.seriesId]
        setMprLoading('Loading images…')
        await prefetchSeries(imgs.imageIds, (d, t) => !cancelled && setMprLoading(`Loading images ${Math.round((100 * d) / t)}%`))
        if (cancelled) return
        setMprLoading('Building volume…')
        const volumeId = `cornerstoneStreamingImageVolume:series-${mpr.seriesId}`
        let volume = cache.getVolume(volumeId)
        if (!volume) {
          volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds: imgs.imageIds })
          ;(volume as unknown as { load: () => void }).load()
        }
        if (cancelled) return
        await setVolumesForViewports(getEngine(), [{ volumeId }], MPR_IDS)
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
    if (!mpr || mprLoading) return
    const engine = getEngine()
    for (const id of MPR_IDS) {
      const vp = engine.getViewport(id) as Types.IVolumeViewport | undefined
      if (!vp) continue
      if (slab > 0) {
        vp.setBlendMode(CoreEnums.BlendModes.MAXIMUM_INTENSITY_BLEND)
        vp.setSlabThickness(slab)
      } else {
        vp.setBlendMode(CoreEnums.BlendModes.COMPOSITE)
        vp.resetSlabThickness()
      }
    }
    engine.renderViewports(MPR_IDS)
  }, [slab, mpr, mprLoading])

  // ------------------------------------------------------------ tools
  useEffect(() => {
    if (ready) setPrimaryTool(tool, !!mpr)
  }, [tool, mpr, ready])

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

  const transform = (kind: 'invert' | 'rotate' | 'flip' | 'reset') => {
    const vp = activeVp() as Types.IStackViewport | undefined
    if (!vp) return
    if (kind === 'invert') vp.setProperties({ invert: !vp.getProperties().invert })
    else if (kind === 'rotate') {
      const rot = vp.getViewPresentation().rotation ?? 0
      vp.setViewPresentation({ rotation: (rot + 90) % 360 })
    } else if (kind === 'flip') {
      vp.setViewPresentation({ flipHorizontal: !vp.getViewPresentation().flipHorizontal })
    } else {
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
    }
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
    if (!(await ui.confirm('Remove all measurements?', 'All measurements and annotations in the viewer will be removed.', 'Remove all', true))) return
    csTools.annotation.state.removeAllAnnotations()
    getEngine().render()
  }

  const keyImage = async () => {
    const slot = slotsRef.current[active]
    const vp = activeVp()
    if (!vp || !slot) return
    const src = vp.canvas
    const out = document.createElement('canvas')
    out.width = src.width
    out.height = src.height
    const ctx = out.getContext('2d')!
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, out.width, out.height)
    ctx.drawImage(src, 0, 0)
    // Burn in the measurements (drawn by Cornerstone as an SVG layer).
    const svg = (vp.element as HTMLElement).querySelector('svg')
    if (svg) {
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
    // Downscale very large captures to keep reports small.
    const maxW = 900
    let final = out
    if (out.width > maxW) {
      final = document.createElement('canvas')
      final.width = maxW
      final.height = Math.round((out.height * maxW) / out.width)
      final.getContext('2d')!.drawImage(out, 0, 0, final.width, final.height)
    }
    const series = slot.studyId != null ? (seriesMap[slot.studyId] ?? []).find((s) => s.id === slot.seriesId) : undefined
    let imageNo = ''
    if (vp.type === CoreEnums.ViewportType.STACK) imageNo = `, image ${(vp as Types.IStackViewport).getCurrentImageIdIndex() + 1}`
    const caption = `${series ? `Series ${series.number ?? ''} ${series.description}`.trim() : slot.kind.toUpperCase()}${imageNo}`
    await api.sendKeyImage({ dataUrl: final.toDataURL('image/jpeg', 0.9), caption })
    ui.toast('Key image sent to the report', 'success')
  }

  const compareWithPrior = async () => {
    const cur = studies[0]
    const prior = studies.find((s) => s.id !== cur?.id)
    if (!cur || !prior) {
      ui.toast('No previous study for this patient.', 'info')
      return
    }
    if (mpr) exitMpr()
    const curSeriesList = seriesMap[cur.id] ?? (await ensureSeries(cur.id))
    const priorSeries = await ensureSeries(prior.id)
    setShown((s) => (s.includes(prior.id) ? s : [...s, prior.id]))
    const curSlot = slotsRef.current[active]
    const curSeries = curSeriesList.find((s) => s.id === curSlot?.seriesId) ?? pickBestSeries(curSeriesList)
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
    setSync(true)
    ui.toast('Comparing with the previous study – scrolling is linked. Align both, then scroll.', 'info')
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
    }
  }

  // ------------------------------------------------------------ keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      if (document.querySelector('.modal-backdrop')) return
      const k = e.key
      const lower = k.toLowerCase()
      if (k === 'ArrowUp' || k === 'ArrowLeft') scrollActive(-1)
      else if (k === 'ArrowDown' || k === 'ArrowRight') scrollActive(1)
      else if (k === 'PageUp') scrollActive(-10)
      else if (k === 'PageDown') scrollActive(10)
      else if (k === 'Home') jumpActive('first')
      else if (k === 'End') jumpActive('last')
      else if (/^[1-9]$/.test(k)) {
        const p = CT_PRESETS.find((x) => x.key === k)
        if (p) applyPreset(p.ww, p.wc)
      } else if (k === '0') resetVoi()
      else if (k === ' ') toggleCine()
      else if (k === 'Delete' || k === 'Backspace') deleteSelectedAnnotations()
      else if (k === 'Escape') {
        if (mpr) exitMpr()
        else setTool('WindowLevel')
      } else if (k === 'Tab') {
        setActive((a) => (a + 1) % slotsRef.current.length)
      } else if (!e.ctrlKey && !e.altKey) {
        const map: Record<string, ToolName> = {
          w: 'WindowLevel',
          h: 'Pan',
          z: 'Zoom',
          s: 'StackScroll',
          l: 'Length',
          a: 'Angle',
          e: 'EllipticalROI',
          o: 'RectangleROI',
          p: 'Probe',
          t: 'ArrowAnnotate',
          b: 'Bidirectional',
          g: 'Magnify',
          x: 'Eraser'
        }
        if (map[lower]) setTool(map[lower])
        else if (lower === 'i') transform('invert')
        else if (lower === 'r') transform('reset')
        else if (lower === 'f') transform('flip')
        else if (lower === 'k') void keyImage()
        else if (lower === 'm') void (mpr ? exitMpr() : enterMpr())
        else if (lower === 'c') void compareWithPrior()
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
    return (
      <div className="v-welcome">
        <h3>Viewer could not start</h3>
        <p>{initError}</p>
      </div>
    )
  }

  const toolBtn = (t: ToolName, title: string, icon: ReactNode) => (
    <VBtn title={title} active={tool === t} onClick={() => setTool(t)}>
      {icon}
    </VBtn>
  )

  return (
    <div className="viewer">
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

      <div className="v-toolbar">
        {LAYOUTS.map(([r, c]) => (
          <VBtn key={`${r}x${c}`} title={`Layout ${r}×${c}`} active={!mpr && layout.rows === r && layout.cols === c} onClick={() => void applyLayout(r, c)}>
            <LayoutIcon r={r} c={c} />
          </VBtn>
        ))}
        <span className="v-sep" />
        {toolBtn('WindowLevel', 'Window/level (W) – drag', <SunMoon size={17} />)}
        {toolBtn('Pan', 'Pan (H) – also middle mouse button', <Hand size={17} />)}
        {toolBtn('Zoom', 'Zoom (Z) – also right mouse button', <ZoomIn size={17} />)}
        {toolBtn('StackScroll', 'Scroll by dragging (S) – mouse wheel always scrolls', <ChevronsUpDown size={17} />)}
        {toolBtn('Magnify', 'Magnifying glass (G)', <Search size={17} />)}
        <span className="v-sep" />
        {toolBtn('Length', 'Length (L)', <Ruler size={17} />)}
        {toolBtn('Angle', 'Angle (A)', <Triangle size={17} />)}
        {toolBtn('EllipticalROI', 'Elliptical ROI – mean/SD HU, area (E)', <Ellipse size={17} />)}
        {toolBtn('RectangleROI', 'Rectangle ROI (O)', <Square size={17} />)}
        {toolBtn('Probe', 'Probe – pixel value / HU (P)', <Crosshair size={17} />)}
        {toolBtn('Bidirectional', 'Bidirectional – long & short axis (B)', <Move size={17} />)}
        {toolBtn('ArrowAnnotate', 'Arrow with text (T)', <ArrowUpRight size={17} />)}
        {toolBtn('Eraser', 'Eraser – click a measurement to delete (X)', <Eraser size={17} />)}
        <VBtn title="Remove all measurements" onClick={() => void clearAnnotations()}>
          <Trash size={17} />
        </VBtn>
        <span className="v-sep" />
        <select
          className="v-select"
          title="Window presets (keys 1–9, 0 = default)"
          value=""
          onChange={(e) => {
            const v = e.target.value
            if (v === 'default') resetVoi()
            else {
              const p = CT_PRESETS.find((x) => x.key === v)
              if (p) applyPreset(p.ww, p.wc)
            }
          }}
        >
          <option value="">Window presets…</option>
          <option value="default">0 · Default (from DICOM)</option>
          {CT_PRESETS.map((p) => (
            <option key={p.key} value={p.key}>
              {p.key} · {p.name} ({p.ww}/{p.wc})
            </option>
          ))}
        </select>
        <VBtn title="Invert (I)" onClick={() => transform('invert')}>
          <Contrast size={17} />
        </VBtn>
        <VBtn title="Rotate 90°" onClick={() => transform('rotate')}>
          <RotateCw size={17} />
        </VBtn>
        <VBtn title="Flip horizontal (F)" onClick={() => transform('flip')}>
          <ArrowLeftRight size={17} />
        </VBtn>
        <VBtn title="Reset view (R)" onClick={() => transform('reset')}>
          <RotateCcw size={17} />
        </VBtn>
        <span className="v-sep" />
        <VBtn title="MPR – axial / sagittal / coronal (M)" on={!!mpr} onClick={() => void (mpr ? exitMpr() : enterMpr())}>
          <Box size={17} /> MPR
        </VBtn>
        {mpr && (
          <>
            {toolBtn('Crosshairs', 'Crosshairs', <Crosshair size={17} />)}
            <select className="v-select" title="MIP slab thickness" value={slab} onChange={(e) => setSlab(Number(e.target.value))}>
              <option value={0}>Thin (no MIP)</option>
              {[5, 10, 15, 20, 30, 50].map((t) => (
                <option key={t} value={t}>
                  MIP {t} mm
                </option>
              ))}
            </select>
          </>
        )}
        <VBtn title="Link scrolling between viewports" on={sync} onClick={() => setSync((s) => !s)}>
          <Link2 size={17} />
        </VBtn>
        <VBtn title="Compare with previous study (C)" onClick={() => void compareWithPrior()} disabled={studies.length < 2}>
          <Columns2 size={17} /> Compare
        </VBtn>
        <VBtn title="Cine play/pause (Space)" on={cine} onClick={toggleCine}>
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
        <VBtn title="Send key image to the report (K)" onClick={() => void keyImage()}>
          <Camera size={17} /> Key image
        </VBtn>
        <VBtn title="Show/hide text overlay" on={overlay} onClick={() => setOverlay((o) => !o)}>
          <Info size={17} />
        </VBtn>
        <VBtn title="Keyboard shortcuts" onClick={() => setHelp(true)}>
          <CircleHelp size={17} />
        </VBtn>
        <div className="spacer" />
        <VBtn title="Open the report for this study" onClick={() => currentStudyId != null && void api.openReportFor(currentStudyId)} disabled={currentStudyId == null}>
          <FileText size={17} /> Report
        </VBtn>
      </div>

      <div
        ref={gridRef}
        className="v-grid"
        style={{
          gridTemplateColumns: `repeat(${maximized != null ? 1 : layout.cols}, 1fr)`,
          gridTemplateRows: `repeat(${maximized != null ? 1 : layout.rows}, 1fr)`
        }}
      >
        {ready &&
          slots.map((slot, i) => {
            const se = slot.seriesId != null ? seriesById.get(slot.seriesId) : undefined
            return (
              <Viewport
                key={slot.id}
                slot={slot}
                active={i === active && slots.length > 1}
                hidden={maximized != null && maximized !== i}
                study={slot.studyId != null ? studyById.get(slot.studyId) ?? null : null}
                seriesLabel={se ? `${se.description} (Se ${se.number ?? '—'})` : ''}
                images={slot.seriesId != null ? imagesMap[slot.seriesId] ?? null : null}
                showOverlay={overlay}
                loadingText={slot.kind !== 'stack' ? mprLoading : null}
                onActivate={() => setActive(i)}
                onDoubleClick={() => setMaximized((m) => (m === i ? null : slots.length > 1 ? i : null))}
                onDropSeries={(seriesId, studyId) => void loadIntoSlot(i, seriesId, studyId)}
                onImageChange={onImageChange}
              />
            )
          })}
        {!ready && <div className="v-welcome">Starting viewer…</div>}
      </div>

      {help && (
        <Modal title="Viewer shortcuts" onClose={() => setHelp(false)}>
          <table className="help-table">
            <tbody>
              {[
                ['Mouse wheel / ↑ ↓', 'Next / previous image'],
                ['Left drag', 'Selected tool (default: window/level)'],
                ['Middle drag', 'Pan'],
                ['Right drag', 'Zoom'],
                ['PgUp / PgDn, Home / End', 'Jump 10 images / first / last'],
                ['1 – 9', 'CT window presets (1 abdomen, 2 lung, 3 bone, 4 brain …); 0 = default'],
                ['W H Z S G', 'Window/level, pan, zoom, scroll, magnify'],
                ['L A E O P B T X', 'Length, angle, ellipse, rectangle, probe, bidirectional, arrow, eraser'],
                ['Delete', 'Delete selected measurement'],
                ['I / F / R', 'Invert / flip / reset'],
                ['M', 'MPR on/off (Esc to exit)'],
                ['C', 'Compare with previous study'],
                ['Space', 'Cine play / pause'],
                ['K', 'Send key image to the report'],
                ['Tab', 'Next viewport'],
                ['Double-click', 'Maximise / restore a viewport']
              ].map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </div>
  )
}
