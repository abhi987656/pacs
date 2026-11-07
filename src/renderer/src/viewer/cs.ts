import {
  cache,
  cornerstoneStreamingImageVolumeLoader,
  Enums,
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
  EllipticalROITool,
  RectangleROITool,
  ProbeTool,
  ArrowAnnotateTool,
  BidirectionalTool,
  EraserTool,
  MagnifyTool,
  CrosshairsTool,
  ToolGroupManager,
  Enums: ToolEnums
} = csTools

export type ToolName =
  | 'WindowLevel'
  | 'Pan'
  | 'Zoom'
  | 'StackScroll'
  | 'Length'
  | 'Angle'
  | 'EllipticalROI'
  | 'RectangleROI'
  | 'Probe'
  | 'ArrowAnnotate'
  | 'Bidirectional'
  | 'Eraser'
  | 'Magnify'
  | 'Crosshairs'

const TOOL_CLASS: Record<ToolName, { toolName: string }> = {
  WindowLevel: WindowLevelTool,
  Pan: PanTool,
  Zoom: ZoomTool,
  StackScroll: StackScrollTool,
  Length: LengthTool,
  Angle: AngleTool,
  EllipticalROI: EllipticalROITool,
  RectangleROI: RectangleROITool,
  Probe: ProbeTool,
  ArrowAnnotate: ArrowAnnotateTool,
  Bidirectional: BidirectionalTool,
  Eraser: EraserTool,
  Magnify: MagnifyTool,
  Crosshairs: CrosshairsTool
}

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

  // Stack tool group: used by all normal viewports.
  const stack = ToolGroupManager.createToolGroup(STACK_TOOLGROUP)!
  for (const t of Object.keys(TOOL_CLASS) as ToolName[]) {
    if (t === 'Crosshairs') continue
    if (t === 'ArrowAnnotate') {
      stack.addTool(toolNameOf(t), {
        getTextCallback: (done: (text: string) => void) => {
          void textPrompt('Annotation text').then((v) => done(v ?? ''))
        },
        changeTextCallback: (_data: unknown, _evt: unknown, done: (text: string) => void) => {
          void textPrompt('Annotation text').then((v) => done(v ?? ''))
        }
      })
    } else {
      stack.addTool(toolNameOf(t))
    }
  }
  setDefaultBindings(stack, 'WindowLevel')

  // MPR tool group: crosshairs + navigation.
  const mpr = ToolGroupManager.createToolGroup(MPR_TOOLGROUP)!
  for (const t of ['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'Length', 'Angle', 'EllipticalROI', 'Probe', 'Crosshairs'] as ToolName[]) {
    mpr.addTool(toolNameOf(t))
  }
  setDefaultBindings(mpr, 'WindowLevel')

  engine = new RenderingEngine(RENDERING_ENGINE_ID)
}

type ToolGroup = NonNullable<ReturnType<typeof ToolGroupManager.getToolGroup>>

/** Primary button = chosen tool; middle = pan; right = zoom; wheel = scroll. */
export function setDefaultBindings(group: ToolGroup, primary: ToolName): void {
  const { MouseBindings } = ToolEnums
  const names = group.getToolInstances ? Object.keys(group.getToolInstances()) : []
  for (const n of names) {
    // Annotation tools stay "passive" so existing measurements remain editable.
    group.setToolPassive(n)
  }
  group.setToolActive(toolNameOf(primary), { bindings: [{ mouseButton: MouseBindings.Primary }] })
  if (primary !== 'Pan') group.setToolActive(toolNameOf('Pan'), { bindings: [{ mouseButton: MouseBindings.Auxiliary }] })
  if (primary !== 'Zoom') group.setToolActive(toolNameOf('Zoom'), { bindings: [{ mouseButton: MouseBindings.Secondary }] })
  group.setToolActive(toolNameOf('StackScroll'), { bindings: [{ mouseButton: MouseBindings.Wheel }] })
  if (primary === 'StackScroll') {
    group.setToolActive(toolNameOf('StackScroll'), {
      bindings: [{ mouseButton: MouseBindings.Primary }, { mouseButton: MouseBindings.Wheel }]
    })
  }
}

export function setPrimaryTool(primary: ToolName, mprMode: boolean): void {
  const g = ToolGroupManager.getToolGroup(mprMode ? MPR_TOOLGROUP : STACK_TOOLGROUP)
  if (!g) return
  if (mprMode && !['WindowLevel', 'Pan', 'Zoom', 'StackScroll', 'Length', 'Angle', 'EllipticalROI', 'Probe', 'Crosshairs'].includes(primary)) {
    primary = 'WindowLevel'
  }
  setDefaultBindings(g, primary)
}

// ------------------------------------------------------------------ window/level presets

export interface WlPreset {
  key: string
  name: string
  ww: number
  wc: number
}

export const CT_PRESETS: WlPreset[] = [
  { key: '1', name: 'Abdomen / soft tissue', ww: 400, wc: 40 },
  { key: '2', name: 'Lung', ww: 1500, wc: -600 },
  { key: '3', name: 'Bone', ww: 1800, wc: 400 },
  { key: '4', name: 'Brain', ww: 80, wc: 40 },
  { key: '5', name: 'Mediastinum', ww: 350, wc: 50 },
  { key: '6', name: 'Liver', ww: 150, wc: 30 },
  { key: '7', name: 'Subdural', ww: 200, wc: 75 },
  { key: '8', name: 'Stroke', ww: 40, wc: 40 },
  { key: '9', name: 'Angio (CTA)', ww: 600, wc: 150 }
]

// Uses the DICOM window convention (same as the scanner/other PACS), so W 400 C 40 shows as 400/40.
export function applyVoi(vp: Types.IViewport, ww: number, wc: number): void {
  const v = vp as Types.IStackViewport
  v.setProperties({ voiRange: csUtilities.windowLevel.toLowHighRange(ww, wc) })
  v.render()
}

export function getVoi(vp: Types.IViewport): { ww: number; wc: number } | null {
  const props = (vp as Types.IStackViewport).getProperties?.()
  const r = props?.voiRange
  if (!r) return null
  const { windowWidth, windowCenter } = csUtilities.windowLevel.toWindowLevel(r.lower, r.upper)
  return { ww: windowWidth, wc: windowCenter }
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

export { Enums, csTools, cache, volumeLoader, metaData }
