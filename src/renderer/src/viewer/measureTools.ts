// Measurements placed point by point with clicks (or drags): the cardiothoracic ratio
// (4 points: heart borders + inner chest wall; 6 points: midline first, then the same four) and a
// polygon ROI (click the corners, click the first one again or double-click to close).

import { Enums as CoreEnums, getEnabledElement, metaData, utilities as csUtils } from '@cornerstonejs/core'
import type { Types } from '@cornerstonejs/core'
import * as csTools from '@cornerstonejs/tools'

const annState = csTools.annotation.state
const { drawing, cursors } = csTools
const { triggerAnnotationRenderForViewportIds, viewportFilters } = csTools.utilities
const Ev = csTools.Enums.Events

type Annotation = csTools.Types.Annotation
type IEvent = csTools.Types.EventTypes.InteractionEventType
type DragEvent = csTools.Types.EventTypes.MouseDragEventType
type P2 = Types.Point2
type P3 = Types.Point3
type Style = { color: string; lineWidth: number; lineDash: string }

interface RoiStats {
  targetId: string
  area: number
  mean: number | null
  sd: number | null
  min: number | null
  max: number | null
  unit: string
}

interface PointsData {
  handles: {
    points: P3[]
    activeHandleIndex?: number | null
    textBox?: { hasMoved: boolean; worldPosition: P3 }
  }
  /** World direction of the image's horizontal (screen x) when the measurement was made. */
  axis?: P3
  closed?: boolean
  roi?: RoiStats
}

const dataOf = (a: Annotation) => a.data as unknown as PointsData
const sub = (a: ArrayLike<number>, b: ArrayLike<number>): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: ArrayLike<number>, b: ArrayLike<number>): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: ArrayLike<number>, k: number): P3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const len = (a: ArrayLike<number>) => Math.hypot(a[0], a[1], a[2])
const unit = (a: ArrayLike<number>): P3 => {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
const dist2 = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1])

/** Distance from p to the segment a-b (canvas pixels). */
function segmentDistance(p: P2, a: P2, b: P2): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** cm when the image says how big its pixels are (CT / MR / most X-rays); otherwise image pixels. */
function lengthFormat(vp: Types.IViewport, a: Annotation): (mm: number) => string {
  let calibrated = true
  if (vp.type === CoreEnums.ViewportType.STACK) {
    const id = a.metadata?.referencedImageId
    const nat = id ? (metaData.get('naturalized', id) as { PixelSpacing?: unknown; ImagerPixelSpacing?: unknown } | undefined) : undefined
    calibrated = !!id && (!!metaData.get('calibratedPixelSpacing', id) || !!nat?.PixelSpacing || !!nat?.ImagerPixelSpacing)
  }
  return calibrated ? (mm) => `${(mm / 10).toFixed(1)} cm` : (px) => `${Math.round(px)} px`
}

abstract class ClickPointsTool extends csTools.AnnotationTool {
  /** Points that complete the measurement; 0 = a polygon (closed by clicking its first point). */
  protected abstract readonly needed: number
  /** Draws the shape (also while it is being placed: only `pts.length` points exist then). */
  protected abstract drawShape(svg: csTools.Types.SVGDrawingHelper, uid: string, vp: Types.IViewport, a: Annotation, pts: P2[], style: Style): void
  /** The segments a click can grab the measurement by. */
  protected abstract segments(vp: Types.IViewport, a: Annotation, pts: P2[]): [P2, P2][]
  protected abstract textLines(vp: Types.IViewport, a: Annotation): string[] | null

  private placing: HTMLDivElement | null = null

  constructor(toolProps: csTools.Types.PublicToolProps = {}) {
    super(toolProps, { supportedInteractionTypes: ['Mouse'], configuration: { shadow: true } })
  }

  protected complete(a: Annotation): boolean {
    if (this.placing && this.editData?.annotation === a) return false
    const d = dataOf(a)
    return this.needed ? d.handles.points.length >= this.needed : !!d.closed
  }

  addNewAnnotation(evt: IEvent): Annotation | null {
    if (this.placing) return null
    const { element, currentPoints } = evt.detail
    const enabled = getEnabledElement(element)
    if (!enabled) return null
    const viewport = enabled.viewport as unknown as Types.IViewport
    const w: P3 = [currentPoints.world[0], currentPoints.world[1], currentPoints.world[2]]
    const axis = unit(sub(viewport.canvasToWorld([1, 0]), viewport.canvasToWorld([0, 0])))
    const Cls = this.constructor as unknown as typeof csTools.AnnotationTool
    const annotation = Cls.createAnnotationForViewport<Annotation>(viewport, {
      data: { handles: { points: [w, [...w]] }, axis, closed: false }
    })
    annState.addAnnotation(annotation, element)
    const viewportIdsToRender = viewportFilters.getViewportIdsWithToolToRender(element, this.getToolName())
    this.editData = { annotation, newAnnotation: true, viewportIdsToRender }
    this.placing = element
    this.isDrawing = true
    csTools.state.isInteractingWithTool = true
    element.addEventListener(Ev.MOUSE_MOVE, this.onPlaceMove as EventListener)
    element.addEventListener(Ev.MOUSE_DRAG, this.onPlaceMove as EventListener)
    element.addEventListener(Ev.MOUSE_DOWN, this.onPlaceDown as EventListener)
    element.addEventListener(Ev.MOUSE_UP, this.onPlaceUp as EventListener)
    element.addEventListener(Ev.MOUSE_DOUBLE_CLICK, this.onPlaceDouble as EventListener)
    evt.preventDefault()
    triggerAnnotationRenderForViewportIds(viewportIdsToRender)
    return annotation
  }

  private stopPlacing(element: HTMLDivElement): void {
    element.removeEventListener(Ev.MOUSE_MOVE, this.onPlaceMove as EventListener)
    element.removeEventListener(Ev.MOUSE_DRAG, this.onPlaceMove as EventListener)
    element.removeEventListener(Ev.MOUSE_DOWN, this.onPlaceDown as EventListener)
    element.removeEventListener(Ev.MOUSE_UP, this.onPlaceUp as EventListener)
    element.removeEventListener(Ev.MOUSE_DOUBLE_CLICK, this.onPlaceDouble as EventListener)
    this.placing = null
    this.isDrawing = false
    csTools.state.isInteractingWithTool = false
  }

  /** The last point follows the mouse until it is clicked. */
  private onPlaceMove = (evt: IEvent): void => {
    const ed = this.editData
    if (!ed) return
    const pts = dataOf(ed.annotation).handles.points
    const w = evt.detail.currentPoints.world
    pts[pts.length - 1] = [w[0], w[1], w[2]]
    ed.annotation.invalidated = true
    triggerAnnotationRenderForViewportIds(ed.viewportIdsToRender ?? [])
  }

  private onPlaceDown = (evt: IEvent): void => {
    this.fixPoint(evt)
    evt.preventDefault()
  }

  /** End of a drag: the point where the mouse was let go counts as a click. */
  private onPlaceUp = (evt: IEvent): void => {
    const ed = this.editData
    if (!ed) return
    const viewport = getEnabledElement(evt.detail.element)?.viewport as unknown as Types.IViewport | undefined
    const pts = dataOf(ed.annotation).handles.points
    if (!viewport || pts.length < 2) return
    const fixed = viewport.worldToCanvas(pts[pts.length - 2])
    if (dist2(fixed, evt.detail.currentPoints.canvas) > 5) this.fixPoint(evt)
  }

  private onPlaceDouble = (evt: IEvent): void => {
    const ed = this.editData
    if (!ed || this.needed) return
    const pts = dataOf(ed.annotation).handles.points
    pts.pop() // the point following the mouse
    if (pts.length >= 3) this.finish(evt.detail.element, true)
    else this.cancel(evt.detail.element)
    evt.preventDefault()
  }

  private fixPoint(evt: IEvent): void {
    const ed = this.editData
    if (!ed) return
    const { element, currentPoints } = evt.detail
    const enabled = getEnabledElement(element)
    if (!enabled) return
    const pts = dataOf(ed.annotation).handles.points
    const w: P3 = [currentPoints.world[0], currentPoints.world[1], currentPoints.world[2]]
    if (!this.needed && pts.length >= 4 && dist2((enabled.viewport as unknown as Types.IViewport).worldToCanvas(pts[0]), currentPoints.canvas) < 10) {
      pts.pop() // back on the first corner: close the polygon
      this.finish(element, true)
      return
    }
    pts[pts.length - 1] = w
    if (this.needed && pts.length >= this.needed) {
      this.finish(element, false)
      return
    }
    pts.push([...w])
    ed.annotation.invalidated = true
    triggerAnnotationRenderForViewportIds(ed.viewportIdsToRender ?? [])
  }

  private finish(element: HTMLDivElement, closed: boolean): void {
    const ed = this.editData
    if (!ed) return
    this.stopPlacing(element)
    const d = dataOf(ed.annotation)
    d.closed = closed
    ed.annotation.invalidated = true
    ed.annotation.highlighted = false
    this.editData = null
    cursors.elementCursor.resetElementCursor(element)
    triggerAnnotationRenderForViewportIds(ed.viewportIdsToRender ?? [])
    annState.triggerAnnotationCompleted(ed.annotation)
  }

  cancel(element: HTMLDivElement): string | undefined {
    const ed = this.editData
    if (!ed) return undefined
    const uid = ed.annotation.annotationUID
    if (this.placing) {
      this.stopPlacing(element)
      if (uid) annState.removeAnnotation(uid) // not finished: nothing to keep
    } else {
      this.stopEditing(element)
    }
    this.editData = null
    cursors.elementCursor.resetElementCursor(element)
    triggerAnnotationRenderForViewportIds(ed.viewportIdsToRender ?? [])
    return uid
  }

  // ---------------------------------------------------------------- editing a finished measurement

  handleSelectedCallback(evt: IEvent, annotation: Annotation, handle: csTools.Types.ToolHandle): void {
    const movingTextBox = !!(handle as { worldPosition?: unknown }).worldPosition
    const handleIndex = movingTextBox ? undefined : dataOf(annotation).handles.points.findIndex((p) => p === handle)
    this.beginEdit(evt, annotation, handleIndex, movingTextBox)
  }

  toolSelectedCallback(evt: IEvent, annotation: Annotation): void {
    this.beginEdit(evt, annotation, undefined, false) // grabbed by a line: move all of it
  }

  private beginEdit(evt: IEvent, annotation: Annotation, handleIndex: number | undefined, movingTextBox: boolean): void {
    const { element } = evt.detail
    annotation.highlighted = true
    const viewportIdsToRender = viewportFilters.getViewportIdsWithToolToRender(element, this.getToolName())
    this.editData = { annotation, viewportIdsToRender, handleIndex, movingTextBox }
    csTools.state.isInteractingWithTool = true
    element.addEventListener(Ev.MOUSE_DRAG, this.onEditDrag as EventListener)
    element.addEventListener(Ev.MOUSE_UP, this.onEditEnd as EventListener)
    element.addEventListener(Ev.MOUSE_CLICK, this.onEditEnd as EventListener)
    cursors.elementCursor.hideElementCursor(element)
    triggerAnnotationRenderForViewportIds(viewportIdsToRender)
    evt.preventDefault()
  }

  private stopEditing(element: HTMLDivElement): void {
    element.removeEventListener(Ev.MOUSE_DRAG, this.onEditDrag as EventListener)
    element.removeEventListener(Ev.MOUSE_UP, this.onEditEnd as EventListener)
    element.removeEventListener(Ev.MOUSE_CLICK, this.onEditEnd as EventListener)
    csTools.state.isInteractingWithTool = false
  }

  private onEditDrag = (evt: DragEvent): void => {
    const ed = this.editData
    if (!ed) return
    const { element, currentPoints, deltaPoints } = evt.detail
    const d = dataOf(ed.annotation)
    const delta = deltaPoints.world
    if (ed.movingTextBox && d.handles.textBox) {
      d.handles.textBox.worldPosition = add(d.handles.textBox.worldPosition, delta)
      d.handles.textBox.hasMoved = true
    } else if (ed.handleIndex != null && ed.handleIndex >= 0) {
      const w = currentPoints.world
      d.handles.points[ed.handleIndex] = [w[0], w[1], w[2]]
    } else {
      d.handles.points = d.handles.points.map((p) => add(p, delta))
      if (d.handles.textBox?.hasMoved) d.handles.textBox.worldPosition = add(d.handles.textBox.worldPosition, delta)
    }
    ed.annotation.invalidated = true
    triggerAnnotationRenderForViewportIds(ed.viewportIdsToRender ?? [])
    annState.triggerAnnotationModified(ed.annotation, element, csTools.Enums.ChangeTypes.HandlesUpdated)
  }

  private onEditEnd = (evt: IEvent): void => {
    const ed = this.editData
    if (!ed) return
    const { element } = evt.detail
    this.stopEditing(element)
    ed.annotation.highlighted = false
    this.editData = null
    cursors.elementCursor.resetElementCursor(element)
    triggerAnnotationRenderForViewportIds(ed.viewportIdsToRender ?? [])
  }

  isPointNearTool(element: HTMLDivElement, annotation: Annotation, canvasCoords: P2, proximity: number): boolean {
    const enabled = getEnabledElement(element)
    if (!enabled) return false
    const viewport = enabled.viewport as unknown as Types.IViewport
    const pts = dataOf(annotation).handles.points.map((p) => viewport.worldToCanvas(p))
    return this.segments(viewport, annotation, pts).some(([a, b]) => segmentDistance(canvasCoords, a, b) < proximity)
  }

  renderAnnotation(enabledElement: Types.IEnabledElement, svg: csTools.Types.SVGDrawingHelper): boolean {
    const viewport = enabledElement.viewport as unknown as Types.IViewport
    const { element } = viewport
    const all = annState.getAnnotations(this.getToolName(), element) as Annotation[] | undefined
    if (!all?.length) return false
    const shown = this.filterInteractableAnnotationsForElement(element, all) as Annotation[]
    let rendered = false
    for (const a of shown) {
      const uid = a.annotationUID
      if (!uid || !csTools.annotation.visibility.isAnnotationVisible(uid)) continue
      const styleSpecifier = { toolGroupId: this.toolGroupId, toolName: this.getToolName(), viewportId: viewport.id, annotationUID: uid }
      const s = this.getAnnotationStyle({ annotation: a, styleSpecifier })
      const style: Style = { color: String(s.color), lineWidth: Number(s.lineWidth) || 1, lineDash: String(s.lineDash ?? '') }
      const pts = dataOf(a).handles.points.map((p) => viewport.worldToCanvas(p))
      this.drawShape(svg, uid, viewport, a, pts, style)
      const placingThis = !!this.placing && this.editData?.annotation === a
      if (a.highlighted || placingThis) drawing.drawHandles(svg, uid, 'handles', pts, { color: style.color, lineWidth: style.lineWidth, handleRadius: '4' })
      rendered = true
      if (placingThis) continue
      const lines = this.textLines(viewport, a)
      if (lines?.length) {
        this.renderLinkedTextBoxAnnotation({ enabledElement, svgDrawingHelper: svg, annotation: a, styleSpecifier, textLines: lines, canvasCoordinates: pts })
      }
    }
    return rendered
  }
}

// ------------------------------------------------------------------ cardiothoracic ratio

/** 4 points: right and left heart border, then right and left inner chest wall. */
export class CTR4Tool extends ClickPointsTool {
  static toolName = 'CTR4Point'
  protected readonly needed = 4

  protected drawShape(svg: csTools.Types.SVGDrawingHelper, uid: string, _vp: Types.IViewport, _a: Annotation, pts: P2[], st: Style): void {
    if (pts.length >= 2) drawing.drawLine(svg, uid, 'heart', pts[0], pts[1], { color: st.color, width: st.lineWidth, lineDash: st.lineDash })
    if (pts.length >= 4) drawing.drawLine(svg, uid, 'chest', pts[2], pts[3], { color: st.color, width: st.lineWidth, lineDash: st.lineDash })
  }

  protected segments(_vp: Types.IViewport, _a: Annotation, pts: P2[]): [P2, P2][] {
    return pts.length >= 4 ? [[pts[0], pts[1]], [pts[2], pts[3]]] : []
  }

  protected textLines(vp: Types.IViewport, a: Annotation): string[] | null {
    const d = dataOf(a)
    const p = d.handles.points
    if (p.length < 4 || !this.complete(a)) return null
    const axis = d.axis ?? [1, 0, 0]
    // Widths across the chest (the horizontal of the image), as on a PA film.
    const heart = Math.abs(dot(sub(p[1], p[0]), axis))
    const chest = Math.abs(dot(sub(p[3], p[2]), axis))
    if (!(chest > 0)) return null
    const f = lengthFormat(vp, a)
    return [`CTR ${(heart / chest).toFixed(2)}`, `Heart ${f(heart)}`, `Chest ${f(chest)}`]
  }
}

/**
 * 6 points: two on the midline (e.g. the spinous processes), then the right and left heart
 * border and the right and left inner chest wall. CTR = (MRD + MLD) / internal chest diameter,
 * with MRD / MLD measured square to the midline.
 */
export class CTR6Tool extends ClickPointsTool {
  static toolName = 'CTR6Point'
  protected readonly needed = 6

  private geometry(a: Annotation) {
    const d = dataOf(a)
    const p = d.handles.points
    const n = a.metadata?.viewPlaneNormal ?? [0, 0, 1]
    const axisDir = d.axis ?? [1, 0, 0]
    let m = sub(p[1] ?? p[0], p[0])
    if (len(m) < 1e-6) m = cross(n, axisDir) // no midline yet: the image's vertical
    m = unit(m)
    const foot = (q: P3): P3 => add(p[0], scale(m, dot(sub(q, p[0]), m)))
    const across = unit(cross(m, n))
    return { p, m, foot, across }
  }

  protected drawShape(svg: csTools.Types.SVGDrawingHelper, uid: string, vp: Types.IViewport, a: Annotation, pts: P2[], st: Style): void {
    const opts = { color: st.color, width: st.lineWidth, lineDash: st.lineDash }
    if (pts.length >= 2) drawing.drawLine(svg, uid, 'midline', pts[0], pts[1], { ...opts, lineDash: '4,4' })
    if (pts.length < 3) return
    const g = this.geometry(a)
    for (const k of [2, 3]) {
      if (pts.length > k) drawing.drawLine(svg, uid, `border${k}`, pts[k], vp.worldToCanvas(g.foot(g.p[k])), opts)
    }
    if (pts.length >= 6) drawing.drawLine(svg, uid, 'chest', pts[4], pts[5], opts)
  }

  protected segments(vp: Types.IViewport, a: Annotation, pts: P2[]): [P2, P2][] {
    if (pts.length < 6) return []
    const g = this.geometry(a)
    return [
      [pts[0], pts[1]],
      [pts[2], vp.worldToCanvas(g.foot(g.p[2]))],
      [pts[3], vp.worldToCanvas(g.foot(g.p[3]))],
      [pts[4], pts[5]]
    ]
  }

  protected textLines(vp: Types.IViewport, a: Annotation): string[] | null {
    if (dataOf(a).handles.points.length < 6 || !this.complete(a)) return null
    const g = this.geometry(a)
    const mrd = len(sub(g.p[2], g.foot(g.p[2])))
    const mld = len(sub(g.p[3], g.foot(g.p[3])))
    const id = Math.abs(dot(sub(g.p[5], g.p[4]), g.across))
    if (!(id > 0)) return null
    const f = lengthFormat(vp, a)
    return [`CTR ${((mrd + mld) / id).toFixed(2)}`, `MRD ${f(mrd)} + MLD ${f(mld)}`, `Chest ${f(id)}`]
  }
}

// ------------------------------------------------------------------ polygon ROI

interface SampleImage {
  dimensions: P3
  direction: Types.Mat3
  spacing: P3
  origin: P3
  imageData: unknown
  metadata?: { Modality?: string }
  voxelManager?: { getAtIJKPoint(ijk: P3): number }
}

/** Area of a flat polygon in 3D (mm² for images with a known pixel size). */
function polygonArea(points: P3[]): number {
  let s: P3 = [0, 0, 0]
  for (let i = 0; i < points.length; i++) s = add(s, cross(points[i], points[(i + 1) % points.length]))
  return len(s) / 2
}

export class PolygonROITool extends ClickPointsTool {
  static toolName = 'PolygonROI'
  protected readonly needed = 0

  protected drawShape(svg: csTools.Types.SVGDrawingHelper, uid: string, _vp: Types.IViewport, a: Annotation, pts: P2[], st: Style): void {
    drawing.drawPolyline(svg, uid, 'outline', pts, { color: st.color, width: st.lineWidth, lineDash: st.lineDash, closePath: !!dataOf(a).closed })
  }

  protected segments(_vp: Types.IViewport, a: Annotation, pts: P2[]): [P2, P2][] {
    const out: [P2, P2][] = []
    for (let i = 0; i + 1 < pts.length; i++) out.push([pts[i], pts[i + 1]])
    if (dataOf(a).closed && pts.length > 2) out.push([pts[pts.length - 1], pts[0]])
    return out
  }

  private stats(vp: Types.IViewport, a: Annotation): RoiStats | null {
    const d = dataOf(a)
    const targetId = this.getTargetId(vp, a.data)
    if (!targetId) return null
    if (d.roi && d.roi.targetId === targetId && !a.invalidated) return d.roi
    const points = d.handles.points
    let count = 0
    let sum = 0
    let sum2 = 0
    let min = Infinity
    let max = -Infinity
    let modality = ''
    try {
      const image = this.getTargetImageData(targetId) as unknown as SampleImage | undefined
      modality = image?.metadata?.Modality ?? ''
      if (image?.voxelManager) {
        csTools.utilities.sampleAreaAnnotationVoxels({
          annotation: a as never,
          image: image as never,
          voxelManager: image.voxelManager,
          points,
          minimumPoints: 3,
          createShape: ({ volume, planePoint, viewPlaneNormal }) =>
            csUtils.voxelSlab.createPolylineShape({ volume, planePoint, viewPlaneNormal, polyline: points }),
          onSample: ({ value }) => {
            if (typeof value !== 'number' || !Number.isFinite(value)) return
            count++
            sum += value
            sum2 += value * value
            if (value < min) min = value
            if (value > max) max = value
          }
        })
      }
    } catch (e) {
      console.warn('polygon ROI statistics failed', e)
    }
    const mean = count ? sum / count : null
    d.roi = {
      targetId,
      area: polygonArea(points),
      mean,
      sd: count && mean != null ? Math.sqrt(Math.max(0, sum2 / count - mean * mean)) : null,
      min: count ? min : null,
      max: count ? max : null,
      unit: modality === 'CT' ? 'HU' : ''
    }
    a.invalidated = false
    return d.roi
  }

  protected textLines(vp: Types.IViewport, a: Annotation): string[] | null {
    if (!this.complete(a) || dataOf(a).handles.points.length < 3) return null
    const r = this.stats(vp, a)
    if (!r) return null
    const calibrated = lengthFormat(vp, a)(10).endsWith('cm')
    const u = r.unit ? ` ${r.unit}` : ''
    const round = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toString() : v.toFixed(1))
    const lines = [calibrated ? `Area: ${round(r.area)} mm²` : `Area: ${Math.round(r.area)} px²`]
    if (r.mean != null) lines.push(`Mean: ${round(r.mean)}${u}`)
    if (r.sd != null) lines.push(`Std Dev: ${round(r.sd)}${u}`)
    if (r.min != null && r.max != null) lines.push(`Min: ${round(r.min)} Max: ${round(r.max)}${u}`)
    return lines
  }
}
