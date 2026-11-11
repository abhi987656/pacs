// The level picker shown while the spine label tool (P) is on.

import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { eventTarget } from '@cornerstonejs/core'
import type { Types } from '@cornerstonejs/core'
import * as csTools from '@cornerstonejs/tools'
import { X } from 'lucide-react'
import { DISCS, spineHint, spineSettings, SpineLabelTool, VERTEBRAE } from './spine'

const VERTEBRA_ROWS = [
  VERTEBRAE.filter((v) => /^C\d/.test(v)),
  VERTEBRAE.filter((v) => /^T\d/.test(v)),
  VERTEBRAE.filter((v) => /^(L\d|S\d|Co)/.test(v))
]
const DISC_ROWS = [DISCS.filter((d) => d.startsWith('C')), DISCS.filter((d) => d.startsWith('T')), DISCS.filter((d) => d.startsWith('L'))]

/** "L4-L5" -> "L4-5" on the buttons; "C7-T1" stays. */
const short = (label: string) => label.replace(/^([A-Z])(\d+)-\1(\d+)$/, '$1$2-$3')

const POS_KEY = 'pacs:spinePanelPos'

function savedPos(): { x: number; y: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(POS_KEY) || 'null') as { x?: unknown; y?: unknown } | null
    return v && typeof v.x === 'number' && typeof v.y === 'number' ? { x: v.x, y: v.y } : null
  } catch {
    return null
  }
}

const ANNOTATION_EVENTS = [
  csTools.Enums.Events.ANNOTATION_ADDED,
  csTools.Enums.Events.ANNOTATION_COMPLETED,
  csTools.Enums.Events.ANNOTATION_MODIFIED,
  csTools.Enums.Events.ANNOTATION_REMOVED
]

export function SpinePanel(p: { getViewport: () => Types.IViewport | undefined; activeKey: string; onClear: () => void; onClose: () => void }) {
  const [s, setS] = useState(spineSettings.get())
  const [, setTick] = useState(0)
  // Where it was dragged to (by its title bar); null = top centre.
  const [pos, setPos] = useState(savedPos)
  const ref = useRef<HTMLDivElement>(null)
  const startDrag = (e: ReactMouseEvent) => {
    const el = ref.current
    const box = el?.offsetParent?.getBoundingClientRect()
    if (!el || !box || e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const r = el.getBoundingClientRect()
    const dx = e.clientX - r.left
    const dy = e.clientY - r.top
    let last = { x: r.left - box.left, y: r.top - box.top }
    const move = (ev: MouseEvent) => {
      last = {
        x: Math.max(0, Math.min(box.width - r.width, ev.clientX - box.left - dx)),
        y: Math.max(0, Math.min(box.height - r.height, ev.clientY - box.top - dy))
      }
      setPos(last)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      try {
        localStorage.setItem(POS_KEY, JSON.stringify(last))
      } catch {
        /* storage blocked */
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  useEffect(() => spineSettings.onChange(() => setS(spineSettings.get())), [])
  // A position saved on a bigger screen: back to the top centre.
  useEffect(() => {
    const box = ref.current?.offsetParent?.getBoundingClientRect()
    if (pos && box && (pos.x + 60 > box.width || pos.y + 40 > box.height)) setPos(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Re-read the labels of the active tile when spine labels change.
  useEffect(() => {
    const bump = (e: Event) => {
      const a = (e as CustomEvent<{ annotation?: csTools.Types.Annotation }>).detail?.annotation
      if (!a || a.metadata?.toolName === SpineLabelTool.toolName) setTick((t) => t + 1)
    }
    for (const ev of ANNOTATION_EVENTS) eventTarget.addEventListener(ev, bump)
    return () => {
      for (const ev of ANNOTATION_EVENTS) eventTarget.removeEventListener(ev, bump)
    }
  }, [])

  const hint = spineHint(p.getViewport())
  const rows = s.mode === 'disc' ? DISC_ROWS : VERTEBRA_ROWS
  let text: string
  if (s.armed) text = `Click the image to place ${s.start}.`
  else if (!hint.count) text = `Click the image to place ${s.start} – or pick the first level here.`
  else {
    const parts = [hint.above && `above ↑ ${hint.above}`, hint.below && `below ↓ ${hint.below}`].filter(Boolean)
    text = parts.length ? `Next click: ${parts.join(' · ')}` : 'All levels are labelled.'
  }

  return (
    <div
      ref={ref}
      className="spine-panel"
      style={pos ? { left: pos.x, top: pos.y, transform: 'none' } : undefined}
      data-active={p.activeKey}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="spine-head" title="Drag to move" onMouseDown={startDrag}>
        <span className="spine-title">Spine labels</span>
        <div className="spine-modes">
          <button className={s.mode === 'vertebra' ? 'on' : ''} onClick={() => spineSettings.setMode('vertebra')}>
            Vertebrae
          </button>
          <button className={s.mode === 'disc' ? 'on' : ''} onClick={() => spineSettings.setMode('disc')}>
            Discs
          </button>
        </div>
        <button className="spine-x" title="Close (Esc)" onClick={p.onClose}>
          <X size={14} />
        </button>
      </div>
      {rows.map((row) => (
        <div key={row[0]} className="spine-row">
          {row.map((l) => (
            <button
              key={l}
              className={`spine-lvl ${s.start === l ? (s.armed ? 'armed' : 'sel') : ''}`}
              title={`Start at ${l}`}
              onClick={() => spineSettings.pick(l)}
            >
              {short(l)}
            </button>
          ))}
        </div>
      ))}
      <div className="spine-foot">
        <span className="spine-hint">{text}</span>
        {hint.count > 0 && (
          <button className="spine-clear" onClick={p.onClear}>
            Clear labels
          </button>
        )}
      </div>
    </div>
  )
}
