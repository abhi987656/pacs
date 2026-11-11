import { useEffect, useMemo, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { BookPlus, Copy, Plus, Save, Search, Trash } from 'lucide-react'
import type { Macro, Settings, Template } from '@shared/types'
import { useUi } from '../common/ui'
import { buildExtensions } from './editor'
import { SpellCheck } from './spell/SpellCheck'
import { useSpellMenu } from './spell/SpellMenu'
import { Ribbon } from './Ribbon'

const api = window.api
const MODALITIES = ['', 'CT', 'MR', 'CR', 'DX', 'US', 'MG', 'PT', 'NM', 'XA', 'RF', 'OT']

export function TemplatesPage({ initialTab, settings }: { initialTab: 'templates' | 'macros'; settings: Settings }) {
  const [tab, setTab] = useState(initialTab)
  return (
    <div className="manage-page">
      <header className="topbar">
        <div className="brand">
          Personal <span>PACS</span>
        </div>
        <div className="topbar-title">Templates &amp; Macros</div>
        <div className="seg">
          <button className={tab === 'templates' ? 'active' : ''} onClick={() => setTab('templates')}>
            Templates
          </button>
          <button className={tab === 'macros' ? 'active' : ''} onClick={() => setTab('macros')}>
            Macros
          </button>
        </div>
      </header>
      {tab === 'templates' ? <TemplatesEditor settings={settings} /> : <MacrosEditor />}
    </div>
  )
}

function TemplatesEditor({ settings }: { settings: Settings }) {
  const ui = useUi()
  const [list, setList] = useState<Template[]>([])
  const [current, setCurrent] = useState<Template | null>(null)
  const [name, setName] = useState('')
  const [modality, setModality] = useState('')
  const [mine, setMine] = useState(true)
  const [search, setSearch] = useState('')
  const [dirty, setDirty] = useState(false)

  const editor = useEditor({
    extensions: [...buildExtensions({ getMacros: () => [], placeholder: 'Template text…' }), SpellCheck],
    content: '',
    editorProps: { attributes: { class: 'report-doc', spellcheck: 'false' } },
    onUpdate: () => setDirty(true)
  })
  const spellMenu = useSpellMenu(editor)

  const reload = async () => setList(await api.listTemplates())
  useEffect(() => {
    void reload()
  }, [])

  const open = async (t: Template | null) => {
    if (dirty && !(await ui.confirm('Discard changes?', 'The current template has unsaved changes.', 'Discard', true))) return
    setCurrent(t)
    setName(t?.name ?? '')
    setModality(t?.modality ?? '')
    setMine(t?.mine ?? true)
    editor.commands.setContent(t?.html ?? '', { emitUpdate: false })
    setDirty(false)
  }

  const save = async () => {
    if (!name.trim()) {
      ui.toast('Please enter a template name', 'error')
      return
    }
    const saved = await api.saveTemplate({ id: current?.id, name: name.trim(), modality, html: editor.getHTML(), mine })
    await reload()
    setCurrent(saved)
    setDirty(false)
    ui.toast('Template saved', 'success')
  }

  const remove = async () => {
    if (!current) return
    if (!(await ui.confirm('Delete template?', `"${current.name}" will be deleted.`, 'Delete', true))) return
    await api.deleteTemplate(current.id)
    setDirty(false)
    await reload()
    void open(null)
  }

  const duplicate = () => {
    if (!current) return
    setCurrent(null)
    setName(`${current.name} (copy)`)
    setMine(true)
    setDirty(true)
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return list.filter((t) => !q || t.name.toLowerCase().includes(q) || t.modality.toLowerCase().includes(q))
  }, [list, search])

  const groups = useMemo(() => {
    const m = new Map<string, Template[]>()
    for (const t of filtered) {
      const k = t.modality || 'Any'
      m.set(k, [...(m.get(k) ?? []), t])
    }
    return [...m.entries()]
  }, [filtered])

  return (
    <div className="manage-body">
      <aside className="manage-list">
        <div className="search">
          <Search size={14} />
          <input placeholder="Search templates" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <button className="btn btn-green full" onClick={() => void open(null)}>
          <Plus size={15} /> New template
        </button>
        <div className="list-scroll">
          {groups.map(([mod, items]) => (
            <div key={mod}>
              <div className="list-group">{mod}</div>
              {items.map((t) => (
                <div key={t.id} className={`list-item ${current?.id === t.id ? 'active' : ''}`} onClick={() => void open(t)}>
                  {t.name}
                  {t.mine && <span className="mine">mine</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </aside>
      <section className="manage-editor">
        <div className="report-fields">
          <label className="rf grow">
            <span>Template name</span>
            <input value={name} onChange={(e) => (setName(e.target.value), setDirty(true))} placeholder="e.g. CECT Abdomen – normal" />
          </label>
          <label className="rf">
            <span>Modality</span>
            <select value={modality} onChange={(e) => (setModality(e.target.value), setDirty(true))}>
              {MODALITIES.map((m) => (
                <option key={m} value={m}>
                  {m || 'Any'}
                </option>
              ))}
            </select>
          </label>
          <label className="rf check">
            <input type="checkbox" checked={mine} onChange={(e) => (setMine(e.target.checked), setDirty(true))} />
            <span>Show under “My Templates”</span>
          </label>
          <div className="rf-actions">
            <button className="btn btn-green" onClick={() => void save()}>
              <Save size={15} /> Save
            </button>
            <button className="btn" disabled={!current} onClick={duplicate}>
              <Copy size={15} /> Duplicate
            </button>
            <button className="btn btn-red-outline" disabled={!current} onClick={() => void remove()}>
              <Trash size={15} /> Delete
            </button>
          </div>
        </div>
        <Ribbon
          editor={editor}
          disabled={false}
          settings={settings}
          view="simple"
          zoom={100}
          showMarks={false}
          fullScreen={false}
          onView={() => {}}
          onZoom={() => {}}
          onToggleMarks={() => {}}
          onToggleFullScreen={() => {}}
          onSave={() => void save()}
          onFind={() => {}}
          onSettings={() => {}}
          onSaveAsTemplate={() => void save()}
          onManage={() => {}}
          onInsertPrior={() => ui.toast('Not available while editing a template', 'info')}
          onHistory={() => {}}
          onPrint={() => {}}
          onPdf={() => {}}
        />
        <div className="editor-scroll simple">
          <div className="simple-page" style={{ fontFamily: `'${settings.editorFontFamily}', serif`, fontSize: settings.editorFontSize }}>
            <div onContextMenu={spellMenu.onContextMenu}>
              <EditorContent editor={editor} />
            </div>
            {spellMenu.menu}
          </div>
        </div>
        <p className="hint">
          <BookPlus size={14} /> Placeholders filled in automatically when the template is used: {'{{patient_name}}'}, {'{{age}}'},{' '}
          {'{{sex}}'}, {'{{study}}'}, {'{{study_date}}'}, {'{{accession}}'}, {'{{referring}}'}, {'{{radiologist}}'},{' '}
          {'{{prior_date}}'}, {'{{today}}'}.
        </p>
      </section>
    </div>
  )
}

function MacrosEditor() {
  const ui = useUi()
  const [list, setList] = useState<Macro[]>([])
  const [code, setCode] = useState('')
  const [text, setText] = useState('')
  const [editing, setEditing] = useState<Record<number, Macro>>({})

  const reload = async () => setList(await api.listMacros())
  useEffect(() => {
    void reload()
  }, [])

  const add = async () => {
    try {
      await api.saveMacro({ code, text })
      setCode('')
      setText('')
      await reload()
      ui.toast('Macro added', 'success')
    } catch (e) {
      ui.toast(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
    }
  }

  const saveRow = async (m: Macro) => {
    try {
      await api.saveMacro(m)
      setEditing((e) => {
        const n = { ...e }
        delete n[m.id]
        return n
      })
      await reload()
      ui.toast('Macro saved', 'success')
    } catch (e) {
      ui.toast(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
    }
  }

  return (
    <div className="macros">
      <p className="hint">
        In a report, type <b>.code</b> followed by <b>Space</b> (for example <b>.nad</b>) and it is replaced by the macro text. You
        can also type the code and press <b>F3</b>, or use the Macro Text box above the report.
      </p>
      <table className="grid macros-table">
        <thead>
          <tr>
            <th style={{ width: 140 }}>Code</th>
            <th>Text</th>
            <th style={{ width: 170 }}></th>
          </tr>
        </thead>
        <tbody>
          <tr className="add-row">
            <td>
              <input placeholder="e.g. nad" value={code} onChange={(e) => setCode(e.target.value)} />
            </td>
            <td>
              <textarea rows={2} placeholder="No abnormality detected." value={text} onChange={(e) => setText(e.target.value)} />
            </td>
            <td>
              <button className="btn btn-green btn-small" disabled={!code.trim() || !text.trim()} onClick={() => void add()}>
                <Plus size={14} /> Add
              </button>
            </td>
          </tr>
          {list.map((m) => {
            const e = editing[m.id]
            return (
              <tr key={m.id}>
                <td>
                  {e ? (
                    <input value={e.code} onChange={(ev) => setEditing({ ...editing, [m.id]: { ...e, code: ev.target.value } })} />
                  ) : (
                    <b>.{m.code}</b>
                  )}
                </td>
                <td>
                  {e ? (
                    <textarea rows={2} value={e.text} onChange={(ev) => setEditing({ ...editing, [m.id]: { ...e, text: ev.target.value } })} />
                  ) : (
                    m.text
                  )}
                </td>
                <td className="row-btns">
                  {e ? (
                    <>
                      <button className="btn btn-green btn-small" onClick={() => void saveRow(e)}>
                        Save
                      </button>
                      <button
                        className="btn btn-small"
                        onClick={() =>
                          setEditing((x) => {
                            const n = { ...x }
                            delete n[m.id]
                            return n
                          })
                        }
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="btn btn-small" onClick={() => setEditing({ ...editing, [m.id]: m })}>
                        Edit
                      </button>
                      <button
                        className="btn btn-small btn-red-outline"
                        onClick={async () => {
                          if (await ui.confirm('Delete macro?', `.${m.code}`, 'Delete', true)) {
                            await api.deleteMacro(m.id)
                            await reload()
                          }
                        }}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
