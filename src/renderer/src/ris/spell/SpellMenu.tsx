// Right-click on an underlined word: suggestions first (bold, like Word), then Ignore All,
// Add to Dictionary, and the usual Cut / Copy / Paste.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import type { Editor } from '@tiptap/react'
import { spellKey } from './SpellCheck'
import { speller } from './speller'

const api = window.api

interface MenuState {
  x: number
  y: number
  from: number
  to: number
  word: string
  suggestions: string[] | null
}

export function useSpellMenu(editor: Editor | null): { onContextMenu: (e: ReactMouseEvent) => void; menu: ReactNode } {
  const [menu, setMenu] = useState<MenuState | null>(null)

  const onContextMenu = (e: ReactMouseEvent) => {
    if (!editor || !speller.enabled || !editor.isEditable) return
    const view = editor.view
    const hit = view.posAtCoords({ left: e.clientX, top: e.clientY })
    if (!hit) return
    const decos = spellKey.getState(view.state)?.find(hit.pos - 1, hit.pos + 1) ?? []
    const d = decos.find((x) => x.from <= hit.pos && hit.pos <= x.to)
    if (!d) return // not a misspelled word: the normal menu (cut / copy / paste)
    e.preventDefault()
    const word = (d.spec as { word: string }).word
    const at = { x: e.clientX, y: e.clientY, from: d.from, to: d.to, word }
    setMenu({ ...at, suggestions: null })
    void speller.suggest(word).then((suggestions) =>
      setMenu((m) => (m && m.from === at.from && m.word === word ? { ...m, suggestions } : m))
    )
  }

  const close = () => setMenu(null)

  const replace = (text: string) => {
    if (!editor || !menu) return
    const { from, to, word } = menu
    close()
    // Only if the word is still there (the text could have changed meanwhile).
    if (editor.state.doc.textBetween(from, to) !== word) return
    editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.insertText(text, from, to)
        return true
      })
      .run()
  }

  const node = menu ? (
    <SpellMenuView
      menu={menu}
      onPick={replace}
      onIgnore={() => {
        speller.ignore(menu.word)
        close()
      }}
      onAdd={() => {
        speller.add(menu.word)
        void api.spellAddWord(menu.word)
        close()
      }}
      onEdit={(cmd) => {
        close()
        editor?.commands.focus()
        void api.editCommand(cmd)
      }}
      onClose={close}
    />
  ) : null
  return { onContextMenu, menu: node }
}

function SpellMenuView(p: {
  menu: MenuState
  onPick: (s: string) => void
  onIgnore: () => void
  onAdd: () => void
  onEdit: (cmd: 'cut' | 'copy' | 'paste') => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: p.menu.x, top: p.menu.y })

  // Keep the menu on the screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(p.menu.x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(p.menu.y, window.innerHeight - r.height - 4))
    })
  }, [p.menu.x, p.menu.y, p.menu.suggestions])

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) p.onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && p.onClose()
    window.addEventListener('mousedown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', p.onClose)
    window.addEventListener('resize', p.onClose)
    return () => {
      window.removeEventListener('mousedown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', p.onClose)
      window.removeEventListener('resize', p.onClose)
    }
  }, [p])

  const s = p.menu.suggestions
  return (
    <div ref={ref} className="spell-menu" style={pos} role="menu" onContextMenu={(e) => e.preventDefault()}>
      {s === null && <div className="spell-item disabled">Looking for suggestions…</div>}
      {s?.length === 0 && <div className="spell-item disabled">No spelling suggestions</div>}
      {s?.map((x) => (
        <button key={x} className="spell-item suggestion" onClick={() => p.onPick(x)}>
          {x}
        </button>
      ))}
      <div className="spell-sep" />
      <button className="spell-item" onClick={p.onIgnore}>
        Ignore All
      </button>
      <button className="spell-item" onClick={p.onAdd}>
        Add to Dictionary
      </button>
      <div className="spell-sep" />
      <button className="spell-item" onClick={() => p.onEdit('cut')}>
        Cut
      </button>
      <button className="spell-item" onClick={() => p.onEdit('copy')}>
        Copy
      </button>
      <button className="spell-item" onClick={() => p.onEdit('paste')}>
        Paste
      </button>
    </div>
  )
}
