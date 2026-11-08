import { useMemo, useRef, useState } from 'react'
import { Plus, Search, Trash } from 'lucide-react'
import type { Nav } from '../App'
import { leaveGuards } from '../App'
import { store, useStore } from '../db'
import { deleteTemplate, saveTemplate } from '../repo'
import { EditorToolbar, MobileEditor, useMobileEditor } from '../editor'
import { SyncPill } from './CasesScreen'
import { Page, useUi } from '../ui'
import { useEffect } from 'react'

const MODALITIES = ['', 'CT', 'MR', 'US', 'CR', 'DX', 'MG', 'XA', 'RF', 'NM', 'PT', 'OT']

export function TemplatesScreen({ nav }: { nav: Nav }) {
  useStore()
  const [q, setQ] = useState('')
  const list = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return store
      .liveTemplates()
      .filter((t) => words.every((w) => `${t.name} ${t.modality}`.toLowerCase().includes(w)))
      .sort((a, b) => a.modality.localeCompare(b.modality) || a.name.localeCompare(b.name))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, store.version])
  return (
    <Page title="Templates" subtitle="Shared with the PC" actions={<SyncPill />}>
      <div className="m-search">
        <Search size={16} />
        <input placeholder="Search templates…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="m-list">
        {list.length === 0 && <div className="m-empty">No templates. They come from the PC, or tap + to add one.</div>}
        {list.map((t) => (
          <button key={t.syncId} className="m-row" onClick={() => nav.push({ name: 'template', id: t.syncId })}>
            <span className="m-row-main">{t.name}</span>
            <span className="m-row-side">
              {t.modality}
              {t.dirty && <span className="m-dot" />}
            </span>
          </button>
        ))}
      </div>
      <button className="m-fab" onClick={() => nav.push({ name: 'template' })} aria-label="New template">
        <Plus size={26} />
      </button>
    </Page>
  )
}

export function TemplateEditor({ nav, syncId }: { nav: Nav; syncId?: string }) {
  const ui = useUi()
  const t = syncId ? store.templates.get(syncId) : undefined
  const [name, setName] = useState(t?.name ?? '')
  const [modality, setModality] = useState(t?.modality ?? '')
  const changed = useRef(false)
  const editor = useMobileEditor({
    content: t?.html ?? '',
    editable: true,
    placeholder: 'Template text. Placeholders like {{patient_name}}, {{age}}, {{study_date}} are filled in automatically.',
    getMacros: () => store.liveMacros(),
    onChange: () => {
      changed.current = true
    }
  })

  const save = async (leave: boolean) => {
    if (!name.trim()) {
      ui.toast('Give the template a name', 'error')
      return false
    }
    await saveTemplate({ syncId: t?.syncId, name, modality, html: editor?.getHTML() ?? '' })
    changed.current = false
    if (leave) {
      ui.toast('Template saved', 'success')
      nav.back()
    }
    return true
  }

  // Leaving with unsaved changes: keep them (save) rather than lose them.
  useEffect(() => {
    const guard = async () => {
      if (changed.current && name.trim()) await save(false)
    }
    leaveGuards.add(guard)
    return () => {
      leaveGuards.delete(guard)
    }
  })

  if (!editor) return null
  return (
    <Page
      title={t ? 'Edit template' : 'New template'}
      onBack={() => nav.back()}
      actions={
        t ? (
          <button
            className="m-icon-btn"
            aria-label="Delete template"
            onClick={async () => {
              if (await ui.confirm('Delete template?', `“${t.name}” will also be deleted on the PC.`, 'Delete', true)) {
                changed.current = false
                await deleteTemplate(t.syncId)
                nav.back()
              }
            }}
          >
            <Trash size={20} />
          </button>
        ) : undefined
      }
      footer={
        <div className="m-actions">
          <button className="m-btn primary grow" onClick={() => void save(true)}>
            Save template
          </button>
        </div>
      }
    >
      <div className="m-form tight">
        <label className="m-field">
          <span>Name</span>
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              changed.current = true
            }}
            placeholder="e.g. CECT Abdomen – normal"
          />
        </label>
        <label className="m-field">
          <span>Modality</span>
          <select
            value={modality}
            onChange={(e) => {
              setModality(e.target.value)
              changed.current = true
            }}
          >
            {MODALITIES.map((m) => (
              <option key={m} value={m}>
                {m || 'Any'}
              </option>
            ))}
          </select>
        </label>
      </div>
      <EditorToolbar editor={editor} />
      <div className="m-paper">
        <MobileEditor editor={editor} />
      </div>
    </Page>
  )
}
