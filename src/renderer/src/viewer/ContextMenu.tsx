import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type MenuItem =
  | 'sep'
  | {
      label: string
      hint?: string
      checked?: boolean
      disabled?: boolean
      onClick?: () => void
      submenu?: MenuItem[]
    }

function MenuList({ items, x, y, onDone, level }: { items: MenuItem[]; x: number; y: number; onDone: () => void; level: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [open, setOpen] = useState<number | null>(null)
  const [subPos, setSubPos] = useState({ x: 0, y: 0 })

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let nx = x
    let ny = y
    if (nx + r.width > window.innerWidth - 4) nx = level === 0 ? Math.max(4, window.innerWidth - r.width - 4) : Math.max(4, x - r.width * 2)
    if (ny + r.height > window.innerHeight - 4) ny = Math.max(4, window.innerHeight - r.height - 4)
    setPos({ x: nx, y: ny })
  }, [x, y, level])

  return (
    <>
      <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
        {items.map((it, i) =>
          it === 'sep' ? (
            <div key={i} className="ctx-sep" />
          ) : (
            <div
              key={i}
              className={`ctx-item ${it.disabled ? 'disabled' : ''} ${open === i ? 'open' : ''}`}
              onMouseEnter={(e) => {
                if (it.submenu) {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setSubPos({ x: r.right - 2, y: r.top - 4 })
                  setOpen(i)
                } else setOpen(null)
              }}
              onClick={() => {
                if (it.disabled || it.submenu) return
                it.onClick?.()
                onDone()
              }}
            >
              <span className="ctx-check">{it.checked ? '✓' : ''}</span>
              <span className="ctx-label">{it.label}</span>
              <span className="ctx-hint">{it.submenu ? '▸' : it.hint ?? ''}</span>
            </div>
          )
        )}
      </div>
      {open != null && items[open] !== 'sep' && (items[open] as { submenu?: MenuItem[] }).submenu && (
        <MenuList items={(items[open] as { submenu: MenuItem[] }).submenu} x={subPos.x} y={subPos.y} onDone={onDone} level={level + 1} />
      )}
    </>
  )
}

/** Right-click "image tools" menu with submenus. */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="ctx-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <MenuList items={items} x={x} y={y} onDone={onClose} level={0} />
    </div>
  )
}
