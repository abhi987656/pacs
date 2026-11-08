import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Search, X } from 'lucide-react'

/** Full-screen searchable list (templates, macros, previous reports). */
export function Picker<T>({
  title,
  items,
  keyOf,
  textOf,
  render,
  onPick,
  onClose,
  empty
}: {
  title: string
  items: T[]
  keyOf: (x: T) => string
  textOf: (x: T) => string
  render: (x: T) => ReactNode
  onPick: (x: T) => void
  onClose: () => void
  empty?: string
}) {
  const [q, setQ] = useState('')
  const shown = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return items.filter((x) => words.every((w) => textOf(x).toLowerCase().includes(w)))
  }, [q, items, textOf])
  return (
    <div className="m-overlay">
      <header className="m-topbar">
        <div className="m-topbar-title">
          <div className="m-title">{title}</div>
        </div>
        <button className="m-icon-btn" onClick={onClose} aria-label="Close" data-close>
          <X size={22} />
        </button>
      </header>
      <div className="m-search">
        <Search size={16} />
        <input autoFocus={items.length > 8} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="m-list">
        {shown.length === 0 && <div className="m-empty">{empty ?? 'Nothing found.'}</div>}
        {shown.map((x) => (
          <button key={keyOf(x)} className="m-row" onClick={() => onPick(x)}>
            {render(x)}
          </button>
        ))}
      </div>
    </div>
  )
}
