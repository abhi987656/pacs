import {
  cache,
  cornerstoneStreamingImageVolumeLoader,
  Enums,
  eventTarget,
  getEnabledElement,
  getRenderingCapabilities,
  init as csInit,
  metaData,
  RenderingEngine,
  utilities as csUtilities,
  volumeLoader
} from '@cornerstonejs/core'
import type { Types } from '@cornerstonejs/core'
import { init as dicomLoaderInit, prefetchPart10Instance } from '@cornerstonejs/dicom-image-loader'
import * as csTools from '@cornerstonejs/tools'
import type { SeriesImages } from '@shared/types'
import { CTR4Tool, CTR6Tool, PolygonROITool } from './measureTools'
import { initReformat } from './reformat'
import type { Projection } from './reformat'
import { SpineLabelTool } from './spine'

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
  CircleROITool,
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
  | 'CircleROI'
  | 'RectangleROI'
  | 'PolygonROI'
  | 'FreehandROI'
  | 'Probe'
  | 'ArrowAnnotate'
  | 'Label'
  | 'Bidirectional'
  | 'SpineLabel'
  | 'CTR4'
  | 'CTR6'
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
  CircleROI: CircleROITool,
  RectangleROI: RectangleROITool,
  PolygonROI: PolygonROITool,
  FreehandROI: PlanarFreehandROITool,
  Probe: ProbeTool,
  ArrowAnnotate: ArrowAnnotateTool,
  Label: LabelTool,
  Bidirectional: BidirectionalTool,
  SpineLabel: SpineLabelTool,
  CTR4: CTR4Tool,
  CTR6: CTR6Tool,
  Eraser: EraserTool,
  Magnify: MagnifyTool,
  Crosshairs: CrosshairsTool
}

export const TOOL_LABEL: Record<ToolName, string> = {
  WindowLevel: 'Window level',
  Pan: 'Pan',
  Zoom: 'Zoom',
  StackScroll: 'Dynamic scroll',
  Length: 'Ruler',
  Angle: 'Angle',
  CobbAngle: 'Cobb angle',
  EllipticalROI: 'Elliptical ROI',
  CircleROI: 'Circle ROI',
  RectangleROI: 'Rectangular ROI',
  PolygonROI: 'Polygon ROI',
  FreehandROI: 'Freehand ROI',
  Probe: 'Density value',
  ArrowAnnotate: 'Arrow',
  Label: 'Text',
  Bidirectional: 'Bidirectional',
  SpineLabel: 'Spine labels',
  CTR4: 'CTR (4 points)',
  CTR6: 'CTR (6 points)',
  Eraser: 'Eraser',
  Magnify: 'Magnifying glass',
  Crosshairs: 'Crosshairs'
}

const MPR_TOOLS: ToolName[] = [
  'WindowLevel',
  'Pan',
  'Zoom',
  'StackScroll',
  'Length',
  'Angle',
  'EllipticalROI',
  'CircleROI',
  'Probe',
  'SpineLabel',
  'Crosshairs'
]

/** Tools that stay on after use (modes, and tools used for many clicks in a row). */
export const STICKY_TOOLS: ToolName[] = ['StackScroll', 'SpineLabel', 'Eraser', 'Crosshairs']

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
  // Volumes (MPR, coronal, sagittal) go to the graphics card as one 3D texture: 16-bit where the
  // card filters 16-bit textures, otherwise 32-bit floats (vtk.js only falls back to half floats
  // on cards that cannot filter floats). textureBytesPerVoxel() follows the same rule.
  csInit({ rendering: { preferSizeOverAccuracy: !gpu().norm16 } } as Parameters<typeof csInit>[0])
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
  // Coronal / sagittal / MPR images computed on the processor (series too big for the graphics card).
  initReformat()
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
  // Crosshairs on processor-reformatted MPR tiles (normal stacks) are handled by the viewer itself.
  if (!isDragMode(primary) && g.hasTool(toolNameOf(primary))) {
    g.setToolActive(toolNameOf(primary), { bindings: [{ mouseButton: MouseBindings.Primary }] })
  }
  // MPR view: while a measurement tool (spine labels, ruler …) is chosen, the crosshair is only
  // drawn, so a click on one of its lines labels or measures there instead of moving it. With
  // window/level, zoom or pan it can still be dragged.
  if (mprMode && primary !== 'Crosshairs' && !isDragMode(primary)) g.setToolEnabled(toolNameOf('Crosshairs'))
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

interface HitTestTool {
  getToolName(): string
  filterInteractableAnnotationsForElement?(element: HTMLDivElement, annotations: csTools.Types.Annotations): csTools.Types.Annotations
  isPointNearTool?(element: HTMLDivElement, annotation: csTools.Types.Annotation, point: Types.Point2, proximity: number, type: string): boolean
  getHandleNearImagePoint?(element: HTMLDivElement, annotation: csTools.Types.Annotation, point: Types.Point2, proximity: number): unknown
}

/**
 * Whether a click here would grab a measurement (then it is edited instead of changing the window).
 * Checks what each tool shows on this image, so spine labels drawn on every slice count too.
 */
export function annotationNear(element: HTMLDivElement, x: number, y: number): boolean {
  try {
    const enabled = getEnabledElement(element)
    if (!enabled) return false
    const group = ToolGroupManager.getToolGroupForViewport(enabled.viewportId, enabled.renderingEngineId)
    if (!group) return false
    for (const tool of Object.values(group.getToolInstances()) as HitTestTool[]) {
      if (!tool.isPointNearTool || !tool.filterInteractableAnnotationsForElement) continue
      const all = csTools.annotation.state.getAnnotations(tool.getToolName(), element)
      if (!all?.length) continue
      for (const a of tool.filterInteractableAnnotationsForElement(element, all) ?? []) {
        if (a.isLocked || a.isVisible === false) continue
        if (tool.isPointNearTool(element, a, [x, y], 8, 'mouse') || tool.getHandleNearImagePoint?.(element, a, [x, y], 8)) return true
      }
    }
  } catch {
    /* not ready */
  }
  return false
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

/** Thin slice, or a MIP / MinIP slab, on a plane shown by the graphics card (volume viewport). */
export function applyProjection(vp: Types.IVolumeViewport, projection: Projection | null | undefined): void {
  if (projection && projection.mm > 0) {
    vp.setBlendMode(projection.mode === 'minip' ? Enums.BlendModes.MINIMUM_INTENSITY_BLEND : Enums.BlendModes.MAXIMUM_INTENSITY_BLEND)
    vp.setSlabThickness(projection.mm)
  } else {
    vp.setBlendMode(Enums.BlendModes.COMPOSITE)
    vp.resetSlabThickness()
  }
}

/** Moves a volume view along its normal so that it shows the plane through `at` (pan and zoom stay). */
export function moveViewTo(vp: Pick<Types.IViewport, 'getCamera' | 'setCamera'>, at: readonly number[]): void {
  const cam = vp.getCamera()
  const n = cam.viewPlaneNormal
  const f = cam.focalPoint
  const p = cam.position
  if (!n || !f || !p) return
  const d = (at[0] - f[0]) * n[0] + (at[1] - f[1]) * n[1] + (at[2] - f[2]) * n[2]
  vp.setCamera({
    focalPoint: [f[0] + d * n[0], f[1] + d * n[1], f[2] + d * n[2]],
    position: [p[0] + d * n[0], p[1] + d * n[1], p[2] + d * n[2]]
  })
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

const LETTER_DIR: Record<string, Types.Point3> = { L: [1, 0, 0], R: [-1, 0, 0], P: [0, 1, 0], A: [0, -1, 0], H: [0, 0, 1], F: [0, 0, -1] }

/** "LF" -> the patient direction it names (DICOM Patient Orientation letters). */
function directionOf(letters: string): Types.Point3 | null {
  let v: Types.Point3 = [0, 0, 0]
  for (const ch of letters.trim().toUpperCase()) {
    const d = LETTER_DIR[ch]
    if (!d) return null
    v = [v[0] + d[0], v[1] + d[1], v[2] + d[2]]
  }
  return Math.hypot(v[0], v[1], v[2]) > 0 ? v : null
}

/**
 * Maps the viewport's world directions to the patient. CT / MR: world = patient coordinates.
 * X-rays have no position in the patient; their Patient Orientation tag says which way the rows
 * and columns run (e.g. L\F). Without it no letters are shown rather than wrong ones.
 */
function patientMapping(vp: Types.IViewport): ((v: Types.Point3) => Types.Point3) | null {
  if (vp.type !== Enums.ViewportType.STACK) return (v) => v
  const nat = getNatural((vp as Types.IStackViewport).getCurrentImageId())
  if (!nat) return (v) => v
  const iop = nat.ImageOrientationPatient
  if (Array.isArray(iop) && iop.length === 6) return (v) => v
  const po = str(nat.PatientOrientation).split('\\')
  const rowDir = po.length === 2 ? directionOf(po[0]) : null
  const colDir = po.length === 2 ? directionOf(po[1]) : null
  if (!rowDir || !colDir) return null
  // Without an orientation Cornerstone lays the image out with rows along +x and columns along +y.
  return (v) => [
    v[0] * rowDir[0] + v[1] * colDir[0],
    v[0] * rowDir[1] + v[1] * colDir[1],
    v[0] * rowDir[2] + v[1] * colDir[2]
  ]
}

/** Orientation letters at the top / bottom / left / right edges of a viewport. */
export function orientationMarkers(vp: Types.IViewport): { top: string; bottom: string; left: string; right: string } | null {
  try {
    const [w, h] = [vp.canvas.clientWidth, vp.canvas.clientHeight]
    if (!w || !h) return null
    const toPatient = patientMapping(vp)
    if (!toPatient) return null
    const c = vp.canvasToWorld([w / 2, h / 2])
    const r = vp.canvasToWorld([w / 2 + 10, h / 2])
    const d = vp.canvasToWorld([w / 2, h / 2 + 10])
    const norm = (a: Types.Point3, b: Types.Point3): Types.Point3 => {
      const v = toPatient([b[0] - a[0], b[1] - a[1], b[2] - a[2]])
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

// ------------------------------------------------------------------ volumes and graphics memory

export interface GpuInfo {
  renderer: string
  kind: 'software' | 'integrated' | 'dedicated'
  norm16: boolean
}

let gpuCache: GpuInfo | null = null

/** What graphics the viewer runs on (from WebGL; read once). */
export function gpu(): GpuInfo {
  if (gpuCache) return gpuCache
  let renderer = ''
  let norm16 = false
  let software = false
  try {
    const caps = getRenderingCapabilities()
    renderer = caps.renderer || ''
    norm16 = !!(caps.norm16 && caps.norm16Linear)
    software = caps.softwareRasterizer || !caps.webgl
  } catch {
    /* no WebGL */
  }
  const r = renderer.toLowerCase()
  const integrated =
    (/intel/.test(r) && !/\barc\b/.test(r)) || /radeon\(tm\) graphics|radeon graphics|radeon vega|vega \d|apple m\d/.test(r)
  gpuCache = { renderer, kind: software ? 'software' : integrated ? 'integrated' : 'dedicated', norm16 }
  return gpuCache
}

const BUDGET_KEY = 'pacs:volumeBudgetMB'
/**
 * Largest series (MB as a 3D texture, see volumeMB) shown through the graphics card.
 * Windows (Direct3D 11, which Chromium's WebGL runs on) only guarantees one texture of
 * max(128 MB, a quarter of the card's dedicated memory), up to 2 GB. Built-in graphics report
 * about 128 MB of dedicated memory, so they get 128 MB minus a margin; a 500-image CT (250–500 MB)
 * fails there. Software rendering always reformats on the processor.
 */
const DEFAULT_BUDGET_MB: Record<GpuInfo['kind'], number> = { software: 0, integrated: 120, dedicated: 1024 }

/**
 * How much graphics memory one volume may take on this card. Bigger series are reformatted on
 * the processor instead (reformat.ts): same images, nothing left out. The limit is halved (and
 * remembered for this card) each time the card is reset while a volume is shown.
 */
export function volumeBudgetMB(): number {
  const g = gpu()
  let mb = DEFAULT_BUDGET_MB[g.kind]
  try {
    const saved = JSON.parse(localStorage.getItem(BUDGET_KEY) || 'null') as { renderer?: string; mb?: number } | null
    if (saved?.renderer === g.renderer && typeof saved.mb === 'number' && saved.mb > 0) mb = Math.min(mb, saved.mb)
  } catch {
    /* storage blocked */
  }
  return mb
}

/** Largest volume (MB on the graphics card) built since this window opened. */
let largestVolumeMB = 0

/**
 * The card was reset while volumes were shown: use at most half as much from now on (series
 * above that are reformatted on the processor).
 */
export function lowerVolumeBudget(): boolean {
  if (!largestVolumeMB) return false
  const mb = Math.max(32, Math.floor(Math.min(largestVolumeMB, volumeBudgetMB()) / 2))
  try {
    localStorage.setItem(BUDGET_KEY, JSON.stringify({ renderer: gpu().renderer, mb }))
  } catch {
    /* storage blocked */
  }
  return true
}

/**
 * Bytes per voxel of Cornerstone's volume texture: 16-bit (norm16) when the card filters 16-bit
 * textures – the same test Cornerstone makes – otherwise 32-bit floats.
 */
export const textureBytesPerVoxel = (): number => (gpu().norm16 ? 2 : 4)

/** Graphics memory (MB) the series takes as one 3D texture on this card. */
export function volumeMB(images: SeriesImages): number {
  return ((images.rows || 512) * (images.cols || 512) * images.imageIds.length * textureBytesPerVoxel()) / 2 ** 20
}

/**
 * Coronal / sagittal / MPR of this series are computed on the processor (reformat.ts) instead of
 * the graphics card: when the series is bigger than one texture may be on this card, or there is
 * no graphics card. Full detail either way.
 */
export const reformatOnCpu = (images: SeriesImages): boolean => volumeMB(images) > volumeBudgetMB()

export interface VolumePlan {
  volumeId: string
}

const volumesInFlight = new Map<number, Promise<VolumePlan>>()
/** Volumes this window built: volume id -> series. */
const builtVolumes = new Map<string, number>()

/**
 * Builds (once) and caches the 3D volume of a series for MPR / coronal / sagittal views on the
 * graphics card (only for series that fit it, see reformatOnCpu). Concurrent callers for the same
 * series share one build. The view is shown straight away and the slices stream into it.
 */
export function ensureVolume(seriesId: number, imageIds: string[]): Promise<VolumePlan> {
  let job = volumesInFlight.get(seriesId)
  if (!job) {
    job = (async () => {
      const volumeId = `cornerstoneStreamingImageVolume:series-${seriesId}`
      if (!cache.getVolume(volumeId)) {
        await prefetchSeries(imageIds, () => {})
        if (!cache.getVolume(volumeId)) {
          // A copy: for wadouri ids Cornerstone reverses the array it is given in place, which
          // would flip the order of the tile's own image list.
          const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds: [...imageIds] })
          ;(volume as unknown as { load: () => void }).load()
        }
      }
      const first = getNatural(imageIds[0])
      const mb = ((Number(first?.Rows) || 512) * (Number(first?.Columns) || 512) * imageIds.length * textureBytesPerVoxel()) / 2 ** 20
      builtVolumes.set(volumeId, seriesId)
      largestVolumeMB = Math.max(largestVolumeMB, mb)
      return { volumeId }
    })().finally(() => volumesInFlight.delete(seriesId))
    volumesInFlight.set(seriesId, job)
  }
  return job
}

/** Frees the graphics memory of volumes no tile shows any more (all but these series). */
export function releaseVolumes(keepSeries: Set<number>): void {
  for (const [volumeId, seriesId] of [...builtVolumes]) {
    if (keepSeries.has(seriesId) || volumesInFlight.has(seriesId)) continue
    builtVolumes.delete(volumeId)
    try {
      if (cache.getVolume(volumeId)) cache.removeVolumeLoadObject(volumeId)
    } catch (e) {
      console.warn('could not release volume', volumeId, e)
    }
  }
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
