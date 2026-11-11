// Spine labels (P). Pick the first level in the panel and click it on the image; every further
// click above or below the labels names the next vertebra (or disc) in order: above L3 -> L2,
// below -> L4. Labels on sagittal / coronal images show on every slice of the series (and on the
// other series of the same scan in that plane), and axial images show the level they are at.

import { Enums as CoreEnums, getEnabledElement, metaData } from '@cornerstonejs/core'
import type { Types } from '@cornerstonejs/core'
import * as csTools from '@cornerstonejs/tools'

const annState = csTools.annotation.state
const { drawing, cursors } = csTools
const { triggerAnnotationRenderForViewportIds, viewportFilters } = csTools.utilities
const ToolEvents = csTools.Enums.Events

type Annotation = csTools.Types.Annotation
type InteractionEvent = csTools.Types.EventTypes.InteractionEventType
type Point3 = Types.Point3
type Box = { x: number; y: number; width: number; height: number }

export type SpineMode = 'vertebra' | 'disc'

const range = (prefix: string, from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`)

/** Head to tail. */
export const VERTEBRAE: string[] = [...range('C', 1, 7), ...range('T', 1, 12), ...range('L', 1, 5), ...range('S', 1, 5), 'Co']
/** C2-C3 … L5-S1 (C1-C2 has no disc). */
export const DISCS: string[] = VERTEBRAE.slice(1, VERTEBRAE.indexOf('S1')).map((v, i) => `${v}-${VERTEBRAE[i + 2]}`)

export const levelsOf = (mode: SpineMode): string[] => (mode === 'disc' ? DISCS : VERTEBRAE)
export const modeOf = (label: string): SpineMode | null =>
  VERTEBRAE.includes(label) ? 'vertebra' : DISCS.includes(label) ? 'disc' : null

// ------------------------------------------------------------------ the level picked in the panel

export interface SpineSettings {
  mode: SpineMode
  /** The level the next click places when nothing is labelled yet (or right after picking it). */
  start: string
  /** true right after a level was picked: the next click places exactly that level. */
  armed: boolean
}

let settings: SpineSettings = { mode: 'vertebra', start: 'L1', armed: false }
const settingsListeners = new Set<() => void>()
const emitSettings = () => settingsListeners.forEach((l) => l())

export const spineSettings = {
  get: (): SpineSettings => settings,
  pick(label: string): void {
    const mode = modeOf(label)
    if (!mode) return
    settings = { mode, start: label, armed: true }
    emitSettings()
  },
  setMode(mode: SpineMode): void {
    if (mode === settings.mode) return
    settings = { mode, start: mode === 'disc' ? 'L4-L5' : 'L1', armed: true }
    emitSettings()
  },
  disarm(): void {
    if (!settings.armed) return
    settings = { ...settings, armed: false }
    emitSettings()
  },
  onChange(l: () => void): () => void {
    settingsListeners.add(l)
    return () => settingsListeners.delete(l)
  }
}

let notify: (message: string) => void = () => {}
/** How the tool tells the user why a click placed nothing. */
export function setSpineNotifier(fn: (message: string) => void): void {
  notify = fn
}

// ------------------------------------------------------------------ geometry

interface SpineData {
  handles: { points: Point3[]; activeHandleIndex?: number | null }
  label: string
  /** Placed on an image with a known position in the patient (CT / MR), not a plain X-ray. */
  spine?: { oriented: boolean }
}

const dataOf = (a: Annotation) => a.data as unknown as SpineData
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/**
 * Whether the image says where it is in the patient (CT / MR). Read from the DICOM tags: for
 * X-rays without them Cornerstone fills in a default orientation and position.
 */
function imageIsOriented(imageId: string | undefined): boolean {
  if (!imageId) return false
  const nat = metaData.get('naturalized', imageId) as { ImageOrientationPatient?: unknown; ImagePositionPatient?: unknown } | undefined
  if (nat) {
    const iop = nat.ImageOrientationPatient
    const ipp = nat.ImagePositionPatient
    return Array.isArray(iop) && iop.length === 6 && Array.isArray(ipp) && ipp.length === 3
  }
  const plane = metaData.get('imagePlaneModule', imageId) as { usingDefaultValues?: boolean } | undefined
  return !!plane && !plane.usingDefaultValues
}

const isStack = (vp: Types.IViewport) => vp.type === CoreEnums.ViewportType.STACK
const currentImageId = (vp: Types.IViewport) => (isStack(vp) ? (vp as Types.IStackViewport).getCurrentImageId() : undefined)

/** Volumes (coronal / sagittal / MPR) are only built from series with a known position. */
function viewportIsOriented(vp: Types.IViewport): boolean {
  return isStack(vp) ? imageIsOriented(currentImageId(vp)) : true
}

/**
 * The direction of "up the spine" in world coordinates: the patient's head (+z in DICOM
 * patient coordinates) for CT / MR, the top of the screen for X-rays without a position.
 */
function headAxis(vp: Types.IViewport): Point3 {
  if (viewportIsOriented(vp)) return [0, 0, 1]
  const up = vp.getCamera().viewUp
  return up ? [up[0], up[1], up[2]] : [0, -1, 0]
}

/** Whether a label is drawn on what this viewport shows now. */
function showsOn(vp: Types.IViewport, a: Annotation): boolean {
  if (a.isVisible === false) return false
  const d = dataOf(a)
  const imageId = currentImageId(vp)
  if (!d.spine?.oriented || (isStack(vp) && !imageIsOriented(imageId))) {
    return isStack(vp) && !!imageId && a.metadata?.referencedImageId === imageId // X-rays: only its own image
  }
  const { viewPlaneNormal: n, focalPoint: f } = vp.getCamera()
  const an = a.metadata?.viewPlaneNormal
  if (!n || !f || !an || Math.abs(dot(an, n)) < 0.9) return false // another plane
  // Sagittal / coronal: the spine runs through the image, so the label shows on every slice
  // at its height. Axial-type images: only on the slice it was placed on.
  if (Math.abs(n[2]) < 0.5) return true
  if (imageId && a.metadata?.referencedImageId === imageId) return true
  const p = d.handles.points[0]
  return Math.abs(dot([p[0] - f[0], p[1] - f[1], p[2] - f[2]], n)) < 1
}

/** The labels the next click continues from (same kind, same plane, same scan). */
function sequenceOf(vp: Types.IViewport, mode: SpineMode): { label: string; index: number; s: number }[] {
  const levels = levelsOf(mode)
  const h = headAxis(vp)
  const all = (annState.getAnnotations(SpineLabelTool.toolName, vp.element) ?? []) as Annotation[]
  return all
    .filter((a) => showsOn(vp, a) && modeOf(dataOf(a).label) === mode)
    .map((a) => {
      const d = dataOf(a)
      return { label: d.label, index: levels.indexOf(d.label), s: dot(d.handles.points[0], h) }
    })
    .sort((x, y) => y.s - x.s) // head first
}

const SAME_HEIGHT_MM = 1

/** The label a click at `world` gets, or why it gets none. */
export function nextSpineLabel(vp: Types.IViewport, world: Point3): { label: string } | { error: string } {
  const { mode, start, armed } = settings
  if (armed) return { label: start }
  const levels = levelsOf(mode)
  const placed = sequenceOf(vp, mode)
  if (!placed.length) return { label: start }
  const s = dot(world, headAxis(vp))
  const taken = new Set(placed.map((p) => p.index))
  const free = (i: number) => (taken.has(i) ? { error: `${levels[i]} is labelled already. Drag that label to move it, or pick a level in the panel.` } : { label: levels[i] })
  const top = placed[0]
  const bottom = placed[placed.length - 1]
  if (s > top.s + SAME_HEIGHT_MM) {
    return top.index > 0 ? free(top.index - 1) : { error: `${top.label} is the first level – there is none above it.` }
  }
  if (s < bottom.s - SAME_HEIGHT_MM) {
    return bottom.index < levels.length - 1 ? free(bottom.index + 1) : { error: `${bottom.label} is the last level.` }
  }
  const near = placed.find((p) => Math.abs(p.s - s) <= SAME_HEIGHT_MM)
  if (near) return { error: `${near.label} is at this height already. Click above or below the labels for the next level.` }
  // Between two labels: fill a gap (e.g. L3 deleted between L2 and L4).
  const upper = [...placed].reverse().find((p) => p.s > s)
  const lower = placed.find((p) => p.s < s)
  if (upper && lower && lower.index - upper.index > 1) {
    return free(s - lower.s < upper.s - s ? lower.index - 1 : upper.index + 1)
  }
  return { error: `There is no free level between ${upper?.label} and ${lower?.label}. Drag a label to move it, or pick a level in the panel.` }
}

/** For the panel: what a click above / below the labels of this tile would add. */
export function spineHint(vp: Types.IViewport | undefined): { above: string | null; below: string | null; count: number } {
  if (!vp) return { above: null, below: null, count: 0 }
  try {
    const levels = levelsOf(settings.mode)
    const placed = sequenceOf(vp, settings.mode)
    if (!placed.length) return { above: null, below: null, count: 0 }
    const top = placed[0].index
    const bottom = placed[placed.length - 1].index
    return { above: top > 0 ? levels[top - 1] : null, below: bottom < levels.length - 1 ? levels[bottom + 1] : null, count: placed.length }
  } catch {
    return { above: null, below: null, count: 0 }
  }
}

/** Removes the spine labels of the scan shown in this viewport. Returns how many. */
export function clearSpineLabels(vp: Types.IViewport): number {
  const all = (annState.getAnnotations(SpineLabelTool.toolName, vp.element) ?? []) as Annotation[]
  let n = 0
  for (const a of [...all]) {
    if (a.annotationUID) {
      annState.removeAnnotation(a.annotationUID)
      n++
    }
  }
  return n
}

/**
 * The level an axial image is at, from the labels placed on sagittal / coronal images of the same
 * scan: "L4" (vertebral body), "L4-L5" (disc space) or null when it is not near a labelled level.
 */
export function spineLevelAt(vp: Types.IViewport): string | null {
  try {
    if (!viewportIsOriented(vp)) return null
    const { viewPlaneNormal: n, focalPoint: f } = vp.getCamera()
    if (!n || !f || Math.abs(n[2]) < 0.7) return null // not an axial image
    const labels = ((annState.getAnnotations(SpineLabelTool.toolName, vp.element) ?? []) as Annotation[]).filter((a) => {
      const an = a.metadata?.viewPlaneNormal
      return a.isVisible !== false && !!dataOf(a).spine?.oriented && !!an && Math.abs(an[2]) < 0.5
    })
    if (!labels.length) return null
    // Height of this image's plane where the spine is (it may be angled along a disc).
    const pts = labels.map((a) => dataOf(a).handles.points[0])
    const xs = pts.reduce((t, p) => t + p[0], 0) / pts.length
    const ys = pts.reduce((t, p) => t + p[1], 0) / pts.length
    const z = f[2] - (n[0] * (xs - f[0]) + n[1] * (ys - f[1])) / n[2]
    return levelAtHeight(labels, 'vertebra', z) ?? levelAtHeight(labels, 'disc', z)
  } catch {
    return null
  }
}

function levelAtHeight(labels: Annotation[], mode: SpineMode, z: number): string | null {
  const levels = levelsOf(mode)
  const byLevel = new Map<number, number[]>()
  for (const a of labels) {
    const d = dataOf(a)
    const i = levels.indexOf(d.label)
    if (i < 0) continue
    byLevel.set(i, [...(byLevel.get(i) ?? []), d.handles.points[0][2]])
  }
  const list = [...byLevel.entries()]
    .map(([i, zs]) => ({ i, z: zs.reduce((t, v) => t + v, 0) / zs.length }))
    .sort((a, b) => b.z - a.z)
  if (!list.length) return null
  // Typical distance between neighbouring levels (for how far above / below the end labels to go).
  let sum = 0
  let count = 0
  for (let k = 0; k + 1 < list.length; k++) {
    const steps = Math.abs(list[k + 1].i - list[k].i)
    if (steps > 0) {
      sum += (list[k].z - list[k + 1].z) / steps
      count++
    }
  }
  const spacing = count ? sum / count : 20
  const half = spacing / 2
  const first = list[0]
  const last = list[list.length - 1]
  if (z >= first.z) return z - first.z <= half ? levels[first.i] : null
  if (z <= last.z) return last.z - z <= half ? levels[last.i] : null
  for (let k = 0; k + 1 < list.length; k++) {
    const up = list[k]
    const down = list[k + 1]
    if (z > up.z || z < down.z) continue
    const t = (up.z - z) / (up.z - down.z || 1)
    if (mode === 'vertebra' && down.i - up.i === 1) {
      if (t < 0.35) return levels[up.i]
      if (t > 0.65) return levels[down.i]
      return `${levels[up.i]}-${levels[down.i]}` // the disc space between them
    }
    const nearest = t < 0.5 ? up : down
    return Math.abs(nearest.z - z) <= half ? levels[nearest.i] : null
  }
  return null
}

// ------------------------------------------------------------------ the Cornerstone tool

export class SpineLabelTool extends csTools.AnnotationTool {
  static toolName = 'SpineLabel'
  /** Text boxes as last drawn, per viewport, for hit testing. */
  private boxes = new Map<string, Map<string, Box>>()
  private dragOffset: Point3 = [0, 0, 0]

  constructor(toolProps: csTools.Types.PublicToolProps = {}) {
    super(toolProps, {
      supportedInteractionTypes: ['Mouse', 'Touch'],
      configuration: { shadow: true }
    })
  }

  addNewAnnotation(evt: InteractionEvent): Annotation | null {
    const { element, currentPoints } = evt.detail
    const enabled = getEnabledElement(element)
    if (!enabled) return null
    const viewport = enabled.viewport as unknown as Types.IViewport
    const world: Point3 = [currentPoints.world[0], currentPoints.world[1], currentPoints.world[2]]
    const next = nextSpineLabel(viewport, world)
    evt.preventDefault()
    if ('error' in next) {
      notify(next.error)
      return null
    }
    spineSettings.disarm()
    const annotation = SpineLabelTool.createAnnotationForViewport<Annotation>(viewport, {
      data: {
        handles: { points: [world] },
        label: next.label,
        spine: { oriented: viewportIsOriented(viewport) }
      }
    })
    annState.addAnnotation(annotation, element)
    const viewportIdsToRender = viewportFilters.getViewportIdsWithToolToRender(element, this.getToolName())
    this.editData = { annotation, newAnnotation: true, viewportIdsToRender }
    this.dragOffset = [0, 0, 0]
    this.startEditing(element)
    triggerAnnotationRenderForViewportIds(viewportIdsToRender)
    return annotation
  }

  /** The dot was grabbed: move it. */
  handleSelectedCallback(evt: InteractionEvent, annotation: Annotation): void {
    this.select(evt, annotation, [0, 0, 0])
  }

  /** The text was grabbed: move the label, keeping where it was grabbed. */
  toolSelectedCallback(evt: InteractionEvent, annotation: Annotation): void {
    const p = dataOf(annotation).handles.points[0]
    const w = evt.detail.currentPoints.world
    this.select(evt, annotation, [p[0] - w[0], p[1] - w[1], p[2] - w[2]])
  }

  private select(evt: InteractionEvent, annotation: Annotation, offset: Point3): void {
    const { element } = evt.detail
    annotation.highlighted = true
    const viewportIdsToRender = viewportFilters.getViewportIdsWithToolToRender(element, this.getToolName())
    this.editData = { annotation, viewportIdsToRender }
    this.dragOffset = offset
    this.startEditing(element)
    cursors.elementCursor.hideElementCursor(element)
    triggerAnnotationRenderForViewportIds(viewportIdsToRender)
    evt.preventDefault()
  }

  private startEditing(element: HTMLDivElement): void {
    csTools.state.isInteractingWithTool = true
    element.addEventListener(ToolEvents.MOUSE_UP, this.onEnd as EventListener)
    element.addEventListener(ToolEvents.MOUSE_CLICK, this.onEnd as EventListener)
    element.addEventListener(ToolEvents.MOUSE_DRAG, this.onDrag as EventListener)
    element.addEventListener(ToolEvents.TOUCH_END, this.onEnd as EventListener)
    element.addEventListener(ToolEvents.TOUCH_TAP, this.onEnd as EventListener)
    element.addEventListener(ToolEvents.TOUCH_DRAG, this.onDrag as EventListener)
  }

  private stopEditing(element: HTMLDivElement): void {
    csTools.state.isInteractingWithTool = false
    element.removeEventListener(ToolEvents.MOUSE_UP, this.onEnd as EventListener)
    element.removeEventListener(ToolEvents.MOUSE_CLICK, this.onEnd as EventListener)
    element.removeEventListener(ToolEvents.MOUSE_DRAG, this.onDrag as EventListener)
    element.removeEventListener(ToolEvents.TOUCH_END, this.onEnd as EventListener)
    element.removeEventListener(ToolEvents.TOUCH_TAP, this.onEnd as EventListener)
    element.removeEventListener(ToolEvents.TOUCH_DRAG, this.onDrag as EventListener)
  }

  private onDrag = (evt: InteractionEvent): void => {
    const ed = this.editData
    if (!ed) return
    const { element, currentPoints } = evt.detail
    const w = currentPoints.world
    const o = this.dragOffset
    dataOf(ed.annotation).handles.points[0] = [w[0] + o[0], w[1] + o[1], w[2] + o[2]]
    ed.annotation.invalidated = true
    triggerAnnotationRenderForViewportIds(ed.viewportIdsToRender ?? [])
    annState.triggerAnnotationModified(ed.annotation, element, csTools.Enums.ChangeTypes.HandlesUpdated)
  }

  private onEnd = (evt: InteractionEvent): void => {
    const ed = this.editData
    if (!ed) return
    const { element } = evt.detail
    this.stopEditing(element)
    cursors.elementCursor.resetElementCursor(element)
    this.editData = null
    this.isDrawing = false
    triggerAnnotationRenderForViewportIds(ed.viewportIdsToRender ?? [])
    if (ed.newAnnotation) annState.triggerAnnotationCompleted(ed.annotation)
  }

  cancel(element: HTMLDivElement): string | undefined {
    const ed = this.editData
    if (!ed) return undefined
    this.stopEditing(element)
    cursors.elementCursor.resetElementCursor(element)
    this.editData = null
    this.isDrawing = false
    ed.annotation.highlighted = false
    triggerAnnotationRenderForViewportIds(ed.viewportIdsToRender ?? [])
    if (ed.newAnnotation) annState.triggerAnnotationCompleted(ed.annotation)
    return ed.annotation.annotationUID
  }

  isPointNearTool(element: HTMLDivElement, annotation: Annotation, canvasCoords: Types.Point2, proximity: number): boolean {
    const enabled = getEnabledElement(element)
    if (!enabled) return false
    const viewport = enabled.viewport as unknown as Types.IViewport
    const c = viewport.worldToCanvas(dataOf(annotation).handles.points[0])
    if (Math.hypot(c[0] - canvasCoords[0], c[1] - canvasCoords[1]) < proximity) return true
    const box = this.boxes.get(viewport.id)?.get(annotation.annotationUID ?? '')
    return (
      !!box &&
      canvasCoords[0] >= box.x - 2 &&
      canvasCoords[0] <= box.x + box.width + 2 &&
      canvasCoords[1] >= box.y - 2 &&
      canvasCoords[1] <= box.y + box.height + 2
    )
  }

  getHandleNearImagePoint(element: HTMLDivElement, annotation: Annotation, canvasCoords: Types.Point2, proximity: number): csTools.Types.ToolHandle | undefined {
    const enabled = getEnabledElement(element)
    if (!enabled) return undefined
    const handles = dataOf(annotation).handles
    const p = handles.points[0]
    const c = (enabled.viewport as unknown as Types.IViewport).worldToCanvas(p)
    if (Math.hypot(c[0] - canvasCoords[0], c[1] - canvasCoords[1]) < proximity) {
      handles.activeHandleIndex = 0
      return p
    }
    handles.activeHandleIndex = null
    return undefined
  }

  filterInteractableAnnotationsForElement(element: HTMLDivElement, annotations: csTools.Types.Annotations): csTools.Types.Annotations {
    if (!annotations?.length) return []
    const enabled = getEnabledElement(element)
    if (!enabled) return []
    return annotations.filter((a) => showsOn(enabled.viewport as unknown as Types.IViewport, a))
  }

  renderAnnotation(enabledElement: Types.IEnabledElement, svgDrawingHelper: csTools.Types.SVGDrawingHelper): boolean {
    const viewport = enabledElement.viewport as unknown as Types.IViewport
    const { element } = viewport
    const boxes = new Map<string, Box>()
    this.boxes.set(viewport.id, boxes)
    const all = annState.getAnnotations(this.getToolName(), element) as Annotation[] | undefined
    if (!all?.length) return false
    const shown = this.filterInteractableAnnotationsForElement(element, all) as Annotation[]
    let rendered = false
    for (const a of shown) {
      const uid = a.annotationUID
      if (!uid || !csTools.annotation.visibility.isAnnotationVisible(uid)) continue
      const d = dataOf(a)
      const c = viewport.worldToCanvas(d.handles.points[0])
      const styleSpecifier = { toolGroupId: this.toolGroupId, toolName: this.getToolName(), viewportId: viewport.id, annotationUID: uid }
      const { color, lineWidth } = this.getAnnotationStyle({ annotation: a, styleSpecifier })
      drawing.drawHandles(svgDrawingHelper, uid, '0', [c], { color, lineWidth, handleRadius: '3', fill: color })
      const textStyle = this.getLinkedTextBoxStyle(styleSpecifier, a)
      const box = drawing.drawTextBox(svgDrawingHelper, uid, '1', [d.label], [c[0] + 9, c[1] - 10], { ...textStyle, padding: 1 })
      if (box) boxes.set(uid, { x: box.x, y: box.y, width: box.width, height: box.height })
      rendered = true
    }
    return rendered
  }
}
