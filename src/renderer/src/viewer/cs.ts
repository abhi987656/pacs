import {
  cache,
  cornerstoneStreamingImageVolumeLoader,
  Enums,
  eventTarget,
  init as csInit,
  metaData,
  RenderingEngine,
  utilities as csUtilities,
  volumeLoader
} from '@cornerstonejs/core'
import type { Types } from '@cornerstonejs/core'
import { init as dicomLoaderInit, prefetchPart10Instance } from '@cornerstonejs/dicom-image-loader'
import * as csTools from '@cornerstonejs/tools'

export const RENDERING_ENGINE_ID = 'pacs-engine'
export const STACK_TOOLGROUP = 'stack-tools'
export const MPR_TOOLGROUP = 'mpr-tools'

const {
  WindowLevelTool,
  PanTool,
  ZoomTool,
  StackScrollTool,
  LengthTool,
  AngleTool,
  CobbAngleTool,
  EllipticalROITool,
  RectangleROITool,
  PlanarFreehandROITool,
  ProbeTool,
  ArrowAnnotateTool,
  LabelTool,
  BidirectionalTool,
  EraserTool,
  MagnifyTool,
  CrosshairsTool,
  ReferenceLinesTool,
  ToolGroupManager,
  Enums: ToolEnums
} = csTools

/**
 * Viewer tools. WindowLevel / Zoom / Pan are "drag modes" handled by our own mouse code
 * (so they can be switched mid-drag with a right click, like Synapse); everything else is
 * a Cornerstone tool bound to the left button while active.
 */
export type ToolName =
  | 'WindowLevel'
  | 'Pan'
  | 'Zoom'
  | 'StackScroll'
  | 'Length'
  | 'Angle'
  | 'CobbAngle'
  | 'EllipticalROI'
  | 'RectangleROI'
  | 'FreehandROI'
  | 'Probe'
  | 'ArrowAnnotate'
  | 'Label'
  | 'Bidirectional'
  | 'Eraser'
  | 'Magnify'
  | 'Crosshairs'

export type DragMode = 'WindowLevel' | 'Zoom' | 'Pan'
export const DRAG_MODES: DragMode[] = ['WindowLevel', 'Zoom', 'Pan']
export const isDragMode = (t: ToolName): t is DragMode => (DRAG_MODES as string[]).includes(t)

const TOOL_CLASS: Record<ToolName, { toolName: string }> = {
  WindowLevel: WindowLevelTool,
  Pan: PanTool,
  Zoom: ZoomTool,
  StackScroll: StackScrollTool,
  Length: LengthTool,
  Angle: AngleTool,
  CobbAngle: CobbAngleTool,
  EllipticalROI: EllipticalROITool,
  RectangleROI: RectangleROITool,
  FreehandROI: PlanarFreehandROITool,
  Probe: ProbeTool,
  ArrowAnnotate: ArrowAnnotateTool,
  Label: LabelTool,
  Bidirectional: BidirectionalTool,
  Eraser: EraserTool,
  Magnify: MagnifyTool,
  Crosshairs: CrosshairsTool
}

export const TOOL_LABEL: Record<ToolName, string> = {
  WindowLevel: 'Window level',
  Pan: 'Pan',
  Zoom: 'Zoom',
  StackScroll: 'Scroll',
  Length: 'Ruler',
  Angle: 'Angle',
  CobbAngle: 'Cobb angle',
  EllipticalROI: 'Elliptical ROI',
  RectangleROI: 'Rectangular ROI',
  FreehandROI: 'Freehand ROI',
  Probe: 'Density value',
  ArrowAnnotate: 'Arrow',
  Label: 'Text',
  Bidirectional: 'Bidirectional',
  Eraser: 'Eraser',
  Magnify: 'Magnifying glass',
  Crosshairs: 'Crosshairs'
}

const MPR_TOOLS: ToolName[] = ['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'Length', 'Angle', 'EllipticalROI', 'Probe', 'Crosshairs']

export const toolNameOf = (t: ToolName): string => TOOL_CLASS[t].toolName

let engine: RenderingEngine | null = null
let textPrompt: (label: string) => Promise<string | null> = async () => null

export function setTextPrompt(fn: (label: string) => Promise<string | null>): void {
  textPrompt = fn
}

export function getEngine(): RenderingEngine {
  if (!engine) throw new Error('Cornerstone not initialised')
  return engine
}

let initPromise: Promise<void> | null = null

/** Initialises Cornerstone once per window (safe to call repeatedly). */
export function initCornerstone(): Promise<void> {
  if (!initPromise) initPromise = doInit()
  return initPromise
}

const askText = (done: (text: string) => void) => void textPrompt('Annotation text').then((v) => done(v ?? ''))

async function doInit(): Promise<void> {
  csInit()
  dicomLoaderInit({
    maxWebWorkers: Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)),
    wasmBasePath: '/wasm'
  })
  csTools.init()
  volumeLoader.registerUnknownVolumeLoader(cornerstoneStreamingImageVolumeLoader as unknown as Types.VolumeLoaderFn)
  volumeLoader.registerVolumeLoader(
    'cornerstoneStreamingImageVolume',
    cornerstoneStreamingImageVolumeLoader as unknown as Types.VolumeLoaderFn
  )
  // Keep up to ~1.5 GB of decoded images in memory.
  cache.setMaxCacheSize(1.5 * 1024 * 1024 * 1024)

  for (const t of Object.values(TOOL_CLASS)) csTools.addTool(t as never)
  csTools.addTool(ReferenceLinesTool)

  // Stack tool group: used by all normal viewports.
  const stack = ToolGroupManager.createToolGroup(STACK_TOOLGROUP)!
  for (const t of Object.keys(TOOL_CLASS) as ToolName[]) {
    if (t === 'Crosshairs') continue
    if (t === 'ArrowAnnotate' || t === 'Label') {
      stack.addTool(toolNameOf(t), {
        getTextCallback: askText,
        changeTextCallback: (_data: unknown, _evt: unknown, done: (text: string) => void) => askText(done)
      })
    } else {
      stack.addTool(toolNameOf(t))
    }
  }
  stack.addTool(ReferenceLinesTool.toolName, { sourceViewportId: '' })
  setPrimaryTool('WindowLevel', false)

  // MPR tool group: crosshairs + navigation.
  const mpr = ToolGroupManager.createToolGroup(MPR_TOOLGROUP)!
  for (const t of MPR_TOOLS) mpr.addTool(toolNameOf(t))
  setPrimaryTool('WindowLevel', true)

  engine = new RenderingEngine(RENDERING_ENGINE_ID)
}

/**
 * Left button = the chosen annotation tool (drag modes are handled by our mouse code),
 * middle drag and wheel = scroll through images (Synapse style). Right button opens the menu.
 */
export function setPrimaryTool(primary: ToolName, mprMode: boolean): void {
  const g = ToolGroupManager.getToolGroup(mprMode ? MPR_TOOLGROUP : STACK_TOOLGROUP)
  if (!g) return
  const { MouseBindings } = ToolEnums
  const names = Object.keys(g.getToolInstances())
  for (const n of names) {
    if (n === ReferenceLinesTool.toolName) continue // enabled/disabled separately
    // "Passive" keeps existing measurements selectable and editable.
    g.setToolPassive(n)
  }
  if (mprMode && !MPR_TOOLS.includes(primary)) primary = 'WindowLevel'
  if (!isDragMode(primary)) g.setToolActive(toolNameOf(primary), { bindings: [{ mouseButton: MouseBindings.Primary }] })
  g.setToolActive(toolNameOf('StackScroll'), {
    bindings: [{ mouseButton: MouseBindings.Wheel }, { mouseButton: MouseBindings.Auxiliary }]
  })
}

/** Reference lines (the slice position of the active image drawn on other images, e.g. the scout). */
export function setReferenceLines(on: boolean, sourceViewportId: string): void {
  const g = ToolGroupManager.getToolGroup(STACK_TOOLGROUP)
  if (!g) return
  if (on && sourceViewportId) {
    g.setToolConfiguration(ReferenceLinesTool.toolName, { sourceViewportId })
    g.setToolEnabled(ReferenceLinesTool.toolName)
  } else {
    g.setToolDisabled(ReferenceLinesTool.toolName)
  }
}

// ------------------------------------------------------------------ linked W/L + zoom/pan ("I" key)

let voiSync: ReturnType<typeof csTools.synchronizers.createVOISynchronizer> | null = null
let zoomPanSync: ReturnType<typeof csTools.synchronizers.createZoomPanSynchronizer> | null = null

export function setPresentationLink(on: boolean, viewportIds: string[]): void {
  voiSync?.destroy()
  zoomPanSync?.destroy()
  voiSync = null
  zoomPanSync = null
  if (!on || viewportIds.length < 2) return
  voiSync = csTools.synchronizers.createVOISynchronizer('pacs-voi-link', { syncInvertState: true, syncColormap: false })
  zoomPanSync = csTools.synchronizers.createZoomPanSynchronizer('pacs-zoompan-link')
  for (const viewportId of viewportIds) {
    voiSync.add({ renderingEngineId: RENDERING_ENGINE_ID, viewportId })
    zoomPanSync.add({ renderingEngineId: RENDERING_ENGINE_ID, viewportId })
  }
}

/** Called when a measurement is finished (used to drop back to window/level after one use). */
export function onAnnotationCompleted(cb: () => void): () => void {
  const handler = () => cb()
  eventTarget.addEventListener(csTools.Enums.Events.ANNOTATION_COMPLETED, handler)
  return () => eventTarget.removeEventListener(csTools.Enums.Events.ANNOTATION_COMPLETED, handler)
}

export function annotationNear(element: HTMLDivElement, x: number, y: number): boolean {
  try {
    return !!csTools.utilities.getAnnotationNearPoint(element, [x, y], 8)
  } catch {
    return false
  }
}

// ------------------------------------------------------------------ window/level presets

export interface WlPreset {
  key: string
  name: string
  ww: number
  wc: number
}

// Same values as the Fujifilm Synapse defaults; keys 1-9 / number pad.
export const CT_PRESETS: WlPreset[] = [
  { key: '1', name: 'Body Soft Tissue', ww: 350, wc: 50 },
  { key: '2', name: 'Body Lung', ww: 1600, wc: -500 },
  { key: '3', name: 'Body Bone', ww: 1500, wc: 300 },
  { key: '4', name: 'Body Liver', ww: 200, wc: 60 },
  { key: '5', name: 'Head Mid Brain', ww: 80, wc: 40 },
  { key: '6', name: 'Head Post Fossa', ww: 200, wc: 40 },
  { key: '7', name: 'Head Blood', ww: 700, wc: 80 },
  { key: '8', name: 'Head Bone', ww: 4000, wc: 600 },
  { key: '9', name: 'CTA MIP', ww: 700, wc: 250 },
  { key: '', name: 'Head IAC', ww: 3200, wc: 250 },
  { key: '', name: 'Stroke', ww: 40, wc: 40 },
  { key: '', name: 'Subdural', ww: 200, wc: 75 }
]

// Uses the DICOM window convention (same as the scanner/other PACS), so W 400 C 40 shows as 400/40.
export function applyVoi(vp: Types.IViewport, ww: number, wc: number): void {
  const v = vp as Types.IStackViewport
  v.setProperties({ voiRange: csUtilities.windowLevel.toLowHighRange(Math.max(1, ww), wc) })
  v.render()
}

export function getVoi(vp: Types.IViewport): { ww: number; wc: number } | null {
  const props = (vp as Types.IStackViewport).getProperties?.()
  const r = props?.voiRange
  if (!r) return null
  const { windowWidth, windowCenter } = csUtilities.windowLevel.toWindowLevel(r.lower, r.upper)
  return { ww: windowWidth, wc: windowCenter }
}

/** How many HU (or pixel values) one pixel of mouse movement changes the window by. */
export function voiMultiplier(vp: Types.IViewport): number {
  try {
    if (vp.type === Enums.ViewportType.STACK) {
      const img = (vp as Types.IStackViewport).getCornerstoneImage()
      const range = (img?.maxPixelValue ?? 0) - (img?.minPixelValue ?? 0)
      if (range > 0) return Math.max(0.5, range / 1024)
    }
  } catch {
    /* fall through */
  }
  return 4
}

// ------------------------------------------------------------------ camera helpers

export function panBy(vp: Types.IViewport, from: [number, number], to: [number, number]): void {
  const a = vp.canvasToWorld(from)
  const b = vp.canvasToWorld(to)
  const d: Types.Point3 = [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
  const cam = vp.getCamera()
  const fp = cam.focalPoint as Types.Point3
  const pos = cam.position as Types.Point3
  vp.setCamera({
    focalPoint: [fp[0] + d[0], fp[1] + d[1], fp[2] + d[2]],
    position: [pos[0] + d[0], pos[1] + d[1], pos[2] + d[2]]
  })
  vp.render()
}

export function zoomBy(vp: Types.IViewport, factor: number): void {
  const z = vp.getZoom()
  vp.setZoom(Math.min(40, Math.max(0.05, z * factor)))
  vp.render()
}

/** Zoom so one image pixel = one screen pixel ("-" key in Synapse). */
export function zoomActualSize(vp: Types.IViewport): void {
  if (vp.type !== Enums.ViewportType.STACK) return
  const img = (vp as Types.IStackViewport).getCornerstoneImage()
  if (!img) return
  const el = vp.element as HTMLDivElement
  const fit = Math.min(el.clientWidth / img.columns, el.clientHeight / img.rows)
  if (fit > 0) {
    vp.resetCamera()
    vp.setZoom(1 / fit)
    vp.render()
  }
}

export function zoomToFit(vp: Types.IViewport): void {
  vp.resetCamera()
  vp.render()
}

// ------------------------------------------------------------------ geometry helpers

function letterFor(v: Types.Point3): string {
  const axes: [number, string, string][] = [
    [v[0], 'L', 'R'],
    [v[1], 'P', 'A'],
    [v[2], 'H', 'F']
  ]
  return axes
    .filter(([c]) => Math.abs(c) > 0.25)
    .sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]))
    .slice(0, 2)
    .map(([c, pos, neg]) => (c > 0 ? pos : neg))
    .join('')
}

/** Orientation letters at the top / bottom / left / right edges of a viewport. */
export function orientationMarkers(vp: Types.IViewport): { top: string; bottom: string; left: string; right: string } | null {
  try {
    const [w, h] = [vp.canvas.clientWidth, vp.canvas.clientHeight]
    if (!w || !h) return null
    const c = vp.canvasToWorld([w / 2, h / 2])
    const r = vp.canvasToWorld([w / 2 + 10, h / 2])
    const d = vp.canvasToWorld([w / 2, h / 2 + 10])
    const norm = (a: Types.Point3, b: Types.Point3): Types.Point3 => {
      const v: Types.Point3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
      const l = Math.hypot(v[0], v[1], v[2]) || 1
      return [v[0] / l, v[1] / l, v[2] / l]
    }
    const right = norm(c, r)
    const down = norm(c, d)
    const neg = (v: Types.Point3): Types.Point3 => [-v[0], -v[1], -v[2]]
    return { right: letterFor(right), left: letterFor(neg(right)), bottom: letterFor(down), top: letterFor(neg(down)) }
  } catch {
    return null
  }
}

// ------------------------------------------------------------------ metadata helpers

export type Naturalized = Record<string, unknown>

export function getNatural(imageId: string | undefined): Naturalized | null {
  if (!imageId) return null
  try {
    return (metaData.get('naturalized', imageId) as Naturalized) ?? null
  } catch {
    return null
  }
}

export function num(v: unknown, digits = 1): string {
  const x = Array.isArray(v) ? v[0] : v
  const n = typeof x === 'number' ? x : parseFloat(String(x ?? ''))
  if (!Number.isFinite(n)) return ''
  return Number.isInteger(n) ? String(n) : n.toFixed(digits)
}

export function str(v: unknown): string {
  if (v == null) return ''
  if (Array.isArray(v)) return v.map(str).join('\\')
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    if ('Alphabetic' in o) return String(o.Alphabetic ?? '')
    return ''
  }
  return String(v)
}

/** Loads the DICOM files of a series into the metadata cache (needed before building an MPR volume). */
export async function prefetchSeries(imageIds: string[], onProgress: (done: number, total: number) => void): Promise<void> {
  const urls = [...new Set(imageIds.map((id) => id.replace(/^wadouri:/, '').replace(/\?frame=\d+$/, '')))]
  let done = 0
  let next = 0
  const worker = async () => {
    while (next < urls.length) {
      const url = urls[next++]
      const baseId = `wadouri:${url}`
      if (!getNatural(baseId)) {
        const buf = await (await fetch(url)).arrayBuffer()
        await prefetchPart10Instance(baseId, buf)
      }
      done++
      onProgress(done, urls.length)
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker))
}

type VolumeProgress = (pct: number) => void

interface VolumeJob {
  promise: Promise<string>
  pct: number
  listeners: Set<VolumeProgress>
}

const volumeJobs = new Map<string, VolumeJob>()

interface StreamingVolume {
  load(cb: () => void): void
  loadStatus?: { loaded?: boolean; loading?: boolean }
}

/** Is the series volume built and completely filled? */
export function volumeReady(seriesId: number): boolean {
  const v = cache.getVolume(`cornerstoneStreamingImageVolume:series-${seriesId}`) as unknown as StreamingVolume | undefined
  return !!v?.loadStatus?.loaded
}

/**
 * Builds (once) and caches the 3D volume of a series for MPR / coronal / sagittal views.
 * `onProgress` gets one 0–100 % for the whole build: reading the files, decoding the slices and
 * filling the volume. The promise resolves when the volume is complete, so the new view
 * appears at 100 % in one piece. Concurrent callers for the same series share one build.
 */
export function ensureVolume(seriesId: number, imageIds: string[], onProgress?: VolumeProgress): Promise<string> {
  const volumeId = `cornerstoneStreamingImageVolume:series-${seriesId}`
  if (volumeReady(seriesId)) {
    onProgress?.(100)
    return Promise.resolve(volumeId)
  }
  let job = volumeJobs.get(volumeId)
  if (!job) {
    const j: VolumeJob = { promise: Promise.resolve(volumeId), pct: 0, listeners: new Set() }
    const report = (value: number) => {
      const v = Math.max(j.pct, Math.min(100, Math.floor(value)))
      if (v === j.pct) return
      j.pct = v
      for (const l of j.listeners) l(v)
    }
    j.promise = (async () => {
      // 1. read the files (0–30 %)
      await prefetchSeries(imageIds, (d, t) => report((30 * d) / t))
      // 2. decode the slices (30–95 %): Cornerstone decodes them while it creates the volume;
      //    progress = how many of the series' images are decoded in its image cache.
      const decoded = () => imageIds.reduce((n, id) => n + (cache.getImage(id) ? 1 : 0), 0)
      const poll = setInterval(() => report(30 + (65 * decoded()) / imageIds.length), 150)
      let volume: StreamingVolume
      try {
        volume = (cache.getVolume(volumeId) as unknown as StreamingVolume | undefined) ??
          // A copy: for wadouri ids Cornerstone reverses the array it is given in place, which
          // would flip the order of the tile's own image list (image 1 becoming the last image).
          ((await volumeLoader.createAndCacheVolume(volumeId, { imageIds: [...imageIds] })) as unknown as StreamingVolume)
      } finally {
        clearInterval(poll)
      }
      report(95)
      // 3. fill the volume (95–100 %)
      await new Promise<void>((resolve) => {
        let last = Date.now()
        const total = imageIds.length
        const onModified = (e: Event) => {
          const d = (e as CustomEvent<{ volumeId: string; framesProcessed?: number; numberOfFrames?: number }>).detail
          if (d?.volumeId !== volumeId) return
          last = Date.now()
          const n = d.numberOfFrames || total
          report(95 + (5 * Math.min(n, d.framesProcessed ?? 0)) / n)
          if ((d.framesProcessed ?? 0) >= n) finish()
        }
        const onCompleted = (e: Event) => {
          if ((e as CustomEvent<{ volumeId: string }>).detail?.volumeId === volumeId) finish()
        }
        // If slices stop arriving, show what there is rather than wait forever: after 3 s when
        // (almost) everything is there – one missing slice doesn't matter – otherwise after 30 s.
        const watchdog = setInterval(() => {
          const quiet = Date.now() - last
          if (quiet > 30_000 || (j.pct >= 99 && quiet > 3_000)) finish()
        }, 1_000)
        let finished = false
        function finish(): void {
          if (finished) return
          finished = true
          clearInterval(watchdog)
          eventTarget.removeEventListener(Enums.Events.IMAGE_VOLUME_MODIFIED, onModified)
          eventTarget.removeEventListener(Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, onCompleted)
          resolve()
        }
        eventTarget.addEventListener(Enums.Events.IMAGE_VOLUME_MODIFIED, onModified)
        eventTarget.addEventListener(Enums.Events.IMAGE_VOLUME_LOADING_COMPLETED, onCompleted)
        const status = volume.loadStatus
        if (status?.loaded) finish()
        else if (!status?.loading) volume.load(() => finish())
      })
      report(100)
      return volumeId
    })().finally(() => volumeJobs.delete(volumeId))
    job = j
    volumeJobs.set(volumeId, j)
  }
  if (onProgress) {
    const listener = onProgress
    const jj = job
    jj.listeners.add(listener)
    listener(jj.pct)
    void jj.promise.finally(() => jj.listeners.delete(listener)).catch(() => {})
  }
  return job.promise
}

/** Which way the slices of a tile run, for the scroll bar: labels of its two ends. */
export interface SliceAxis {
  top: string
  bottom: string
  /** true when image 1 is at the bottom end (the bar is drawn anatomically: H, A or R on top). */
  reversed: boolean
}

/**
 * `dir` = the direction (patient coordinates, LPS) in which the image number increases.
 * Head is always on top for axial stacks, anterior for coronal, right for sagittal.
 */
export function sliceAxis(dir: readonly number[] | null | undefined): SliceAxis | null {
  if (!dir || dir.length !== 3 || dir.some((v) => !Number.isFinite(v))) return null
  const ax = dir.map(Math.abs)
  const len = Math.hypot(dir[0], dir[1], dir[2])
  if (!(len > 0)) return null
  const i = ax[2] >= ax[0] && ax[2] >= ax[1] ? 2 : ax[1] >= ax[0] ? 1 : 0
  if (i === 2) return { top: 'H', bottom: 'F', reversed: dir[2] > 0 } // +z = head
  if (i === 1) return { top: 'A', bottom: 'P', reversed: dir[1] < 0 } // +y = posterior
  return { top: 'R', bottom: 'L', reversed: dir[0] < 0 } // +x = left
}

export { Enums, csTools, cache, volumeLoader, metaData }
