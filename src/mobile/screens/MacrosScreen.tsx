import { useMemo, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import type { Nav } from '../App'
import { store, useStore } from '../db'
import type { LocalMacro } from '../db'
import { deleteMacro, saveMacro } from '../repo'
import { SyncPill } from './CasesScreen'
import { Page, useUi } from '../ui'

export function MacrosScreen(_props: { nav: Nav }) {
  useStore()
  const ui = useUi()
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<{ macro?: LocalMacro; code: string; text: string } | null>(null)
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return store
      .liveMacros()
      .filter((m) => words.every((w) => `${m.code} ${m.text}`.toLowerCase().includes(w)))
      .sort((a, b) => a.code.localeCompare(b.code))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, store.version])

  const save = async () => {
    if (!edit) return
    const code = edit.code.trim().replace(/^\./, '')
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(code)) {
      ui.toast('The code must be 1–20 letters or numbers (no spaces)', 'error')
      return
    }
    const clash = store.liveMacros().find((m) => m.code.toLowerCase() === code.toLowerCase() && m.syncId !== edit.macro?.syncId)
    if (clash) {
      ui.toast(`.${code} already exists`, 'error')
      return
    }
    await saveMacro({ syncId: edit.macro?.syncId, code, text: edit.text })
    setEdit(null)
    ui.toast('Macro saved', 'success')
  }

  return (
    <Page title="Macros" subtitle="Type .code then space in a report" actions={<SyncPill />}>
      <div className="m-search">
        <Search size={16} />
        <input placeholder="Search macros…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="m-list">
        {list.length === 0 && <div className="m-empty">No macros yet.</div>}
        {list.map((m) => (
          <button key={m.syncId} className="m-row" onClick={() => setEdit({ macro: m, code: m.code, text: m.text })}>
            <span className="m-row-main">
              .{m.code} {m.dirty && <span className="m-dot" />}
            </span>
            <span className="m-row-sub">{m.text}</span>
          </button>
        ))}
      </div>
      <button className="m-fab" onClick={() => setEdit({ code: '', text: '' })} aria-label="New macro">
        <Plus size={26} />
      </button>
      {edit && (
        <div className="m-backdrop" onClick={() => setEdit(null)}>
          <div className="m-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="m-sheet-grip" />
            <div className="m-sheet-title">{edit.macro ? 'Edit macro' : 'New macro'}</div>
            <div className="m-form tight">
              <label className="m-field">
                <span>Code (type .code then space)</span>
                <input autoCapitalize="none" autoCorrect="off" value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value })} placeholder="e.g. nad" />
              </label>
              <label className="m-field">
                <span>Text</span>
                <textarea rows={5} value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} />
              </label>
              <div className="m-actions">
                {edit.macro && (
                  <button
                    className="m-btn danger"
                    onClick={async () => {
                      if (await ui.confirm('Delete macro?', `.${edit.macro!.code} will also be deleted on the PC.`, 'Delete', true)) {
                        await deleteMacro(edit.macro!.syncId)
                        setEdit(null)
                      }
                    }}
                  >
                    Delete
                  </button>
                )}
                <button className="m-btn primary grow" onClick={() => void save()}>
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Page>
  )
}
