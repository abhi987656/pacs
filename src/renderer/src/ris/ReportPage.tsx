import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import {
  ChevronDown,
  ChevronUp,
  FileDown,
  FileText,
  FileType2,
  History,
  Image as ImageIcon,
  Info,
  Lock,
  LockOpen,
  Plus,
  Printer,
  UserRound
} from 'lucide-react'
import type { Macro, Report, ReportStatus, ReportVersion, Settings, StudyRow, Template } from '@shared/types'
import {
  formatAge,
  formatDicomDate,
  formatDicomDateTime,
  formatIsoDateTime,
  formatSex,
  STATUS_LABEL
} from '@shared/format'
import { Modal, Panel, useEvent, useUi } from '../common/ui'
import { buildExtensions, fillPlaceholders, findNext, insertMacroText, replaceAll, replaceCurrent } from './editor'
import { Ribbon } from './Ribbon'
import { DictationControl } from './DictationControl'
import { CaseDialog } from './CaseDialog'
import { ShareDialog, SharingPanel } from './Sharing'
import { SpellCheck } from './spell/SpellCheck'
import { useSpellMenu } from './spell/SpellMenu'

const api = window.api
const MODALITY_OPTIONS = ['CT', 'MR', 'CR', 'DX', 'US', 'MG', 'PT', 'NM', 'XA', 'RF', 'OT']

export interface ReportPageHandle {
  confirmLeave(): Promise<boolean>
}

interface Props {
  studyId: number
  studyOrder: number[]
  settings: Settings
  onSettingsChange: (s: Settings) => void
  onBack: () => void
  onOpenStudy: (studyId: number) => void
  onManageTemplates: (tab: 'templates' | 'macros') => void
}

function SidePanel({ title, children, defaultOpen = true }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="side-panel">
      <button className="side-panel-hdr" onClick={() => setOpen((o) => !o)}>
        <span>{title}</span>
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {open && <div className="side-panel-body">{children}</div>}
    </section>
  )
}

export const ReportPage = forwardRef<ReportPageHandle, Props>(function ReportPage(props, ref) {
  const { studyId, settings } = props
  const ui = useUi()
  const [study, setStudy] = useState<StudyRow | null>(null)
  const [priors, setPriors] = useState<StudyRow[]>([])
  const [report, setReport] = useState<Report | null>(null)
  const [status, setStatus] = useState<ReportStatus>('NEW')
  const [templates, setTemplates] = useState<Template[]>([])
  const [macros, setMacros] = useState<Macro[]>([])
  const [modality, setModality] = useState('')
  const [procedure, setProcedure] = useState('')
  const [radiologist, setRadiologist] = useState('')
  const [templateName, setTemplateName] = useState('')
  const [myOnly, setMyOnly] = useState(false)
  const [macroInput, setMacroInput] = useState('')
  const [dirty, setDirty] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [view, setView] = useState<'print' | 'simple'>('print')
  const [zoom, setZoom] = useState(100)
  const [showMarks, setShowMarks] = useState(false)
  const [fullScreen, setFullScreen] = useState(false)
  const [find, setFind] = useState<{ replace: boolean } | null>(null)
  const [findText, setFindText] = useState('')
  const [replaceText, setReplaceText] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [priorView, setPriorView] = useState<{ study: StudyRow; report: Report | null } | null>(null)
  const [versions, setVersions] = useState<ReportVersion[] | null>(null)
  const [versionPreview, setVersionPreview] = useState<ReportVersion | null>(null)
  const [clinical, setClinical] = useState('')
  const [autosavedAt, setAutosavedAt] = useState<string | null>(null)
  const [editDetails, setEditDetails] = useState(false)
  const [sharing, setSharing] = useState(false)

  const macrosRef = useRef<Macro[]>([])
  macrosRef.current = macros
  const loadingRef = useRef(true)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  const readOnly = status === 'FINAL'

  const editor = useEditor({
    extensions: [
      ...buildExtensions({
        getMacros: () => macrosRef.current,
        placeholder: 'Type the report here, choose a template above, or type a macro such as .nad and press Space…'
      }),
      SpellCheck
    ],
    content: '',
    // The browser's own spell check is off here: the app's checker (radiology words, offline) underlines instead.
    editorProps: { attributes: { class: 'report-doc', spellcheck: 'false' } },
    onUpdate: () => {
      if (!loadingRef.current) setDirty(true)
    }
  })

  const spellMenu = useSpellMenu(editor)

  // ------------------------------------------------------------ load
  useEffect(() => {
    let cancelled = false
    loadingRef.current = true
    void (async () => {
      const [detail, pri, rep, tpls, mcs] = await Promise.all([
        api.getStudy(studyId),
        api.getPriors(studyId),
        api.getReport(studyId),
        api.listTemplates(),
        api.listMacros()
      ])
      if (cancelled || !detail) return
      const s = detail.study
      setStudy(s)
      setPriors(pri)
      setReport(rep)
      setStatus(rep?.status ?? 'NEW')
      setTemplates(tpls)
      setMacros(mcs)
      setClinical(s.clinicalHistory)
      const mod = rep?.modality || s.modalities.split('\\')[0] || ''
      setModality(mod)
      setProcedure(rep?.procedure || s.description)
      setRadiologist(rep?.radiologist || settings.radiologistName)
      setTemplateName(rep?.templateName ?? '')
      editor.commands.setContent(rep?.html ?? '', { emitUpdate: false })
      editor.setEditable(rep?.status !== 'FINAL', false)
      setDirty(false)
      setLoaded(true)
      loadingRef.current = false
      if (rep?.status !== 'FINAL') setTimeout(() => editor.commands.focus('end'), 50)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyId])

  useEffect(() => {
    // Second argument false: changing editability must not mark the report as modified.
    editor.setEditable(!readOnly, false)
  }, [editor, readOnly])

  // ------------------------------------------------------------ save
  const save = useCallback(
    async (newStatus: ReportStatus, opts: { silent?: boolean; radiologist?: string } = {}): Promise<Report | null> => {
      if (!study) return null
      const text = editor.getText().trim()
      if (newStatus === 'FINAL' && !text) {
        ui.toast('The report is empty – nothing to sign off.', 'error')
        return null
      }
      try {
        const saved = await api.saveReport({
          studyId,
          status: newStatus === 'NEW' ? 'DRAFT' : newStatus,
          html: editor.getHTML(),
          text: editor.getText(),
          modality,
          procedure,
          radiologist: opts.radiologist ?? radiologist,
          templateName
        })
        setReport(saved)
        setStatus(saved.status)
        setDirty(false)
        if (opts.silent) setAutosavedAt(formatIsoDateTime(saved.updatedAt).slice(-5))
        else ui.toast(newStatus === 'FINAL' ? 'Report signed off' : newStatus === 'PRELIMINARY' ? 'Saved as preliminary' : 'Report saved', 'success')
        return saved
      } catch (e) {
        ui.toast(`Could not save: ${(e as Error).message}`, 'error')
        return null
      }
    },
    [editor, modality, procedure, radiologist, templateName, study, studyId, ui]
  )

  const draftStatus = (): ReportStatus => (status === 'PRELIMINARY' ? 'PRELIMINARY' : 'DRAFT')

  useImperativeHandle(ref, () => ({
    async confirmLeave() {
      if (!dirtyRef.current) return true
      const choice = await ui.ask<'save' | 'discard' | 'cancel'>(
        'Save changes?',
        'This report has unsaved changes.',
        [
          { label: 'Cancel', value: 'cancel' },
          { label: "Don't save", value: 'discard', kind: 'danger' },
          { label: 'Save', value: 'save', kind: 'primary' }
        ]
      )
      if (choice === 'save') return (await save(draftStatus())) != null
      return choice === 'discard'
    }
  }))

  // Autosave + save on window close.
  useEffect(() => {
    const secs = settings.autosaveSeconds
    if (!secs || secs < 10) return
    const t = setInterval(() => {
      if (dirtyRef.current && !readOnly && !loadingRef.current) void save(draftStatus(), { silent: true })
    }, secs * 1000)
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save, settings.autosaveSeconds, readOnly, status])

  useEffect(() => {
    const onUnload = () => {
      if (dirtyRef.current && !readOnly) void save(draftStatus(), { silent: true })
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save, readOnly, status])

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (!readOnly) void save(draftStatus())
      } else if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFind({ replace: false })
      } else if (e.ctrlKey && e.key.toLowerCase() === 'h') {
        e.preventDefault()
        setFind({ replace: true })
      } else if (e.key === 'F11') {
        e.preventDefault()
        toggleFullScreen()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Details changed elsewhere (viewer notes, edit dialog, images attached to a new case).
  useEvent(api.onStudiesChanged, () => {
    void api.getStudy(studyId).then((d) => {
      if (!d) return
      setStudy(d.study)
      if (!(document.activeElement instanceof HTMLTextAreaElement && document.activeElement.classList.contains('clinical')))
        setClinical(d.study.clinicalHistory)
    })
  })

  // Report edited on the phone app and synced while this page is open.
  useEvent(api.onReportsChanged, (ids: number[]) => {
    if (!ids.includes(studyId)) return
    void api.getReport(studyId).then((rep) => {
      if (!rep) return
      if (dirtyRef.current) {
        ui.toast('This report was also changed on your phone. The phone version is in History (clock icon).', 'info')
        return
      }
      loadingRef.current = true
      setReport(rep)
      setStatus(rep.status)
      setModality(rep.modality || modality)
      setProcedure(rep.procedure || procedure)
      setTemplateName(rep.templateName)
      editor.commands.setContent(rep.html, { emitUpdate: false })
      editor.setEditable(rep.status !== 'FINAL', false)
      setDirty(false)
      loadingRef.current = false
      ui.toast('Report updated from your phone', 'info')
    })
  })

  // Key images sent from the viewer.
  useEvent(api.onKeyImage, (img: { dataUrl: string; caption: string }) => {
    if (readOnly) {
      ui.toast('Report is signed off – reopen it to add images.', 'error')
      return
    }
    editor
      .chain()
      .focus()
      .insertContent([
        { type: 'image', attrs: { src: img.dataUrl, alt: img.caption, title: img.caption, width: 340 } },
        { type: 'paragraph', content: img.caption ? [{ type: 'text', marks: [{ type: 'italic' }], text: img.caption }] : [] }
      ])
      .run()
    ui.toast('Key image added to the report', 'success')
  })

  // Report text sent from the viewer (liver volumetry tables).
  useEvent(api.onReportHtml, (html: string) => {
    if (readOnly) {
      ui.toast('Report is signed off – reopen it to add results.', 'error')
      return
    }
    editor.chain().focus().insertContent(html).run()
    ui.toast('Results added to the report', 'success')
  })

  // ------------------------------------------------------------ actions
  const toggleFullScreen = () => {
    const next = !fullScreen
    setFullScreen(next)
    void api.setFullScreen(next)
  }

  const signOff = async (andNext: boolean) => {
    let name = radiologist.trim()
    if (!name) {
      name = (await ui.prompt('Radiologist name', 'Enter your name as it should appear on the report', settings.radiologistName, 'Dr. ...'))?.trim() ?? ''
      if (!name) return
      setRadiologist(name)
      if (!settings.radiologistName) {
        const s = await api.saveSettings({ ...settings, radiologistName: name })
        props.onSettingsChange(s)
      }
    }
    const saved = await save('FINAL', { radiologist: name })
    if (saved && andNext) goNext(1, true)
  }

  const reopen = async () => {
    const ok = await ui.confirm(
      'Reopen signed report?',
      'The report will become a draft again so you can edit it. The signed version is kept in the history.',
      'Reopen'
    )
    if (!ok) return
    await save('DRAFT', { silent: true })
    ui.toast('Report reopened for editing', 'info')
  }

  const idx = props.studyOrder.indexOf(studyId)
  const goNext = (dir: 1 | -1, unreportedOnly = false) => {
    if (idx < 0) return
    let j = idx + dir
    // When signing off, skip to the next study that still needs a report.
    if (unreportedOnly) {
      void (async () => {
        const list = await api.listStudies({ status: 'UNREPORTED' })
        const ids = new Set(list.map((s) => s.id))
        while (j >= 0 && j < props.studyOrder.length && !ids.has(props.studyOrder[j])) j += dir
        if (j >= 0 && j < props.studyOrder.length) props.onOpenStudy(props.studyOrder[j])
        else ui.toast('No more unreported studies in the worklist.', 'info')
      })()
      return
    }
    if (j >= 0 && j < props.studyOrder.length) props.onOpenStudy(props.studyOrder[j])
  }

  const placeholderCtx = () => ({
    patient_name: study?.patientName ?? '',
    patient_id: study?.patientId ?? '',
    age: study ? formatAge(study.age, study.birthDate, study.studyDate) : '',
    sex: study ? formatSex(study.sex) : '',
    study: procedure,
    study_date: study ? formatDicomDate(study.studyDate) : '',
    accession: study?.accession ?? '',
    referring: study?.referring ?? '',
    radiologist,
    prior_date: priors[0] ? formatDicomDate(priors[0].studyDate) : '',
    today: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
  })

  const applyTemplate = async (t: Template) => {
    const html = fillPlaceholders(t.html, placeholderCtx())
    let mode: 'replace' | 'insert' | null = 'replace'
    if (!editor.isEmpty) {
      mode = await ui.ask<'replace' | 'insert'>('Insert template', `"${t.name}" – replace the current text or insert at the cursor?`, [
        { label: 'Cancel', value: null as unknown as 'replace' },
        { label: 'Insert at cursor', value: 'insert' },
        { label: 'Replace all', value: 'replace', kind: 'primary' }
      ])
    }
    if (!mode) return
    if (mode === 'replace') editor.chain().setContent(html).focus('end').run()
    else editor.chain().focus().insertContent(html).run()
    setTemplateName(t.name)
    setDirty(true)
  }

  const saveAsTemplate = async () => {
    if (editor.isEmpty) {
      ui.toast('Write something first – the current report text becomes the template.', 'info')
      return
    }
    const name = await ui.prompt('Save as template', 'Template name', templateName || procedure)
    if (!name) return
    const t = await api.saveTemplate({ name, modality, html: editor.getHTML(), mine: true })
    setTemplates(await api.listTemplates())
    setTemplateName(t.name)
    ui.toast(`Template "${t.name}" saved`, 'success')
  }

  const insertMacroFromBox = () => {
    const code = macroInput.trim().replace(/^\./, '').toLowerCase()
    if (!code) return
    const m = macros.find((x) => x.code.toLowerCase() === code)
    if (!m) {
      ui.toast(`No macro ".${code}" – add it under Templates › Manage macros.`, 'error')
      return
    }
    insertMacroText(editor, m.text + ' ')
    setMacroInput('')
  }

  const openPrior = async (p: StudyRow) => {
    setPriorView({ study: p, report: await api.getReport(p.id) })
  }

  const openHistory = async () => {
    setVersions(await api.listReportVersions(studyId))
    setVersionPreview(null)
  }

  const updateSettings = async (patch: Partial<Settings>) => {
    const s = await api.saveSettings({ ...settings, ...patch })
    props.onSettingsChange(s)
  }

  const openImages = async (id: number) => {
    if (!(await api.openViewer(id))) ui.toast('No images for this case yet. Import the CD – images with the same PG No attach automatically.', 'info')
  }

  const exportPdf = async () => {
    if (dirty && !readOnly) await save(draftStatus(), { silent: true })
    const file = await api.exportReportPdf(studyId)
    if (file) ui.toast(`PDF saved: ${file}`, 'success')
  }
  const print = async () => {
    if (dirty && !readOnly) await save(draftStatus(), { silent: true })
    await api.printReport(studyId)
  }
  const exportAs = async (kind: 'docx' | 'txt') => {
    if (dirty && !readOnly) await save(draftStatus(), { silent: true })
    try {
      const file = await api.exportReport(studyId, kind)
      if (file) ui.toast(`${kind === 'docx' ? 'Word document' : 'Text file'} saved: ${file}`, 'success')
    } catch (e) {
      ui.toast(`Could not export: ${(e as Error).message}`, 'error')
    }
  }

  // ------------------------------------------------------------ derived
  const visibleTemplates = useMemo(() => {
    const list = myOnly ? templates.filter((t) => t.mine) : templates
    const same = list.filter((t) => !modality || !t.modality || t.modality === modality)
    const other = list.filter((t) => !(!modality || !t.modality || t.modality === modality))
    return { same, other }
  }, [templates, myOnly, modality])

  if (!study) return <div className="loading">Loading…</div>

  const ageSex = [study.patientName.toUpperCase(), formatSex(study.sex), formatAge(study.age, study.birthDate, study.studyDate)]
    .filter(Boolean)
    .join(' / ')
  const zoomStyle = { zoom: zoom / 100 } as CSSProperties
  const pageClass = `paper ${settings.pageSize === 'Letter' ? 'letter' : 'a4'} ${settings.pageOrientation} margin-${settings.pageMargin}`

  return (
    <div className="report-page">
      {/* ---------------- patient banner */}
      <header className="banner">
        <div className="banner-col">
          <div className="kv">
            <span>Patient ID</span>: <b>{study.patientId || '—'}</b>
          </div>
          <div className="kv big">{ageSex}</div>
        </div>
        <div className="banner-col">
          <div className="kv">
            <span>Study</span>: <b>{study.description || procedure || '—'}</b>
          </div>
          <div className="kv">
            <span>Exam Date</span>: <b>{formatDicomDateTime(study.studyDate, study.studyTime)}</b>
          </div>
        </div>
        <div className="banner-col">
          <div className="kv">
            <span>Visit Type</span>:{' '}
            <select
              className="banner-select"
              value={study.visitType}
              onChange={(e) => {
                const v = e.target.value
                setStudy({ ...study, visitType: v })
                void api.updateStudy(study.id, { visitType: v })
              }}
            >
              <option value="">—</option>
              <option value="OP">OP</option>
              <option value="IP">IP</option>
              <option value="ER">Emergency</option>
            </select>
          </div>
          <div className="kv">
            <span>Accession No</span>: <b>{study.accession || '—'}</b>
          </div>
        </div>
        <div className="banner-col">
          <div className="kv">
            <span>Ref. Doctor</span>:{' '}
            <input
              className="banner-input"
              value={study.referring}
              placeholder="—"
              onChange={(e) => setStudy({ ...study, referring: e.target.value })}
              onBlur={(e) => void api.updateStudy(study.id, { referring: e.target.value })}
            />
          </div>
          <div className="kv">
            <span>Images</span>: <b>{study.numImages}</b> in {study.numSeries} series
          </div>
        </div>
        <div className="banner-user" title="Radiologist">
          <UserRound size={18} />
          <span>{radiologist || settings.radiologistName || 'Radiologist'}</span>
        </div>
      </header>

      <div className="report-body">
        {/* ---------------- left panels */}
        <aside className="side">
          <SidePanel title="Scan Status">
            <div className="kv-s">
              <span>Completed:</span> {formatDicomDateTime(study.studyDate, study.studyTime) || '—'}
            </div>
            <div className="kv-s">
              <span>Imported:</span> {formatIsoDateTime(study.importedAt)}
            </div>
            <div className="kv-s">
              <span>Modality:</span> {study.modalities.split('\\').join(', ')} · {study.institution || (study.manual ? 'No images' : 'Unknown site')}
            </div>
            <button className="link-btn" onClick={() => setEditDetails(true)}>
              Edit patient / study details…
            </button>
          </SidePanel>
          <SidePanel title="Clinical Details">
            <textarea
              className="clinical"
              placeholder="Clinical history / indication (printed on the report)"
              value={clinical}
              onChange={(e) => setClinical(e.target.value)}
              onBlur={() => void api.updateStudy(study.id, { clinicalHistory: clinical })}
            />
          </SidePanel>
          <SidePanel title="Report Last Saved By">
            {report ? (
              <>
                <div className="kv-s strong">{report.radiologist || '—'}</div>
                <div className="kv-s">{formatIsoDateTime(report.updatedAt)}</div>
                <div className="kv-s">
                  <span className={`badge st-${status}`}>{STATUS_LABEL[status]}</span>
                </div>
              </>
            ) : (
              <div className="kv-s muted">Not saved yet</div>
            )}
          </SidePanel>
          <SidePanel title="Sharing">
            <SharingPanel
              study={study}
              onShare={() => setSharing(true)}
              saveFirst={async () => (dirtyRef.current && !readOnly ? (await save(draftStatus(), { silent: true })) != null : true)}
              onInsert={
                readOnly
                  ? undefined
                  : (html) => {
                      editor.chain().focus().insertContent(html).run()
                      setDirty(true)
                    }
              }
            />
          </SidePanel>
          <SidePanel title="Previous Reports">
            {priors.length === 0 && <div className="kv-s muted">No previous studies for this patient ID.</div>}
            {priors.map((p) => (
              <div key={p.id} className="prior">
                <div className="prior-title">{p.description || p.modalities}</div>
                <div className="prior-row">
                  <span>{formatDicomDateTime(p.studyDate, p.studyTime)}</span>
                  <span className="prior-icons">
                    <span
                      className="icon-btn"
                      title={`Accession: ${p.accession || '—'}\nImages: ${p.numImages}\nStatus: ${STATUS_LABEL[p.reportStatus]}`}
                    >
                      <Info size={15} />
                    </span>
                    <button className="icon-btn" title="View report" onClick={() => void openPrior(p)}>
                      <FileText size={15} />
                    </button>
                    <button
                      className="icon-btn"
                      title="Open images of this study"
                      onClick={() => void openImages(p.id)}
                    >
                      <ImageIcon size={15} />
                    </button>
                    <button
                      className="icon-btn red"
                      title="Save report as PDF"
                      disabled={p.reportStatus === 'NEW'}
                      onClick={() => void api.exportReportPdf(p.id)}
                    >
                      <FileDown size={15} />
                    </button>
                  </span>
                </div>
              </div>
            ))}
          </SidePanel>
        </aside>

        {/* ---------------- editor area */}
        <main className="report-main">
          <div className="report-fields">
            <label className="rf">
              <span>Modality</span>
              <select value={modality} onChange={(e) => setModality(e.target.value)} disabled={readOnly}>
                <option value="">—</option>
                {[...new Set([...MODALITY_OPTIONS, ...study.modalities.split('\\').filter(Boolean)])].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label className="rf grow">
              <span>Procedure</span>
              <input value={procedure} disabled={readOnly} onChange={(e) => (setProcedure(e.target.value), setDirty(true))} />
            </label>
            <label className="rf grow">
              <span>Radiologist</span>
              <input value={radiologist} disabled={readOnly} onChange={(e) => (setRadiologist(e.target.value), setDirty(true))} />
            </label>
            <label className="rf grow">
              <span>Template Name</span>
              <div className="rf-row">
                <button className="icon-btn" title="Save current text as a new template" onClick={() => void saveAsTemplate()} disabled={readOnly}>
                  <Plus size={16} />
                </button>
                <select
                  value=""
                  disabled={readOnly}
                  onChange={(e) => {
                    const t = templates.find((x) => x.id === Number(e.target.value))
                    if (t) void applyTemplate(t)
                  }}
                >
                  <option value="">{templateName || 'Choose a template…'}</option>
                  {visibleTemplates.same.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                  {visibleTemplates.other.length > 0 && (
                    <optgroup label="Other modalities">
                      {visibleTemplates.other.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.modality})
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </div>
            </label>
            <label className="rf check">
              <input type="checkbox" checked={myOnly} onChange={(e) => setMyOnly(e.target.checked)} />
              <span>My Templates</span>
            </label>
            <label className="rf">
              <span>Macro Text</span>
              <div className="rf-row">
                <input
                  list="macro-list"
                  value={macroInput}
                  disabled={readOnly}
                  placeholder="code + Enter"
                  onChange={(e) => setMacroInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && insertMacroFromBox()}
                />
                <span className="icon-btn" title="Type a macro code and press Enter to insert it at the cursor. In the report you can also type .code then Space (e.g. .nad), or the code then F3.">
                  <Info size={15} />
                </span>
              </div>
              <datalist id="macro-list">
                {macros.map((m) => (
                  <option key={m.id} value={m.code}>
                    {m.text.slice(0, 60)}
                  </option>
                ))}
              </datalist>
            </label>
            <DictationControl
              editor={editor}
              settings={settings}
              onSettingsChange={props.onSettingsChange}
              readOnly={readOnly}
              macros={macros}
              templates={templates}
              onTemplate={(t) => void applyTemplate(t)}
            />
          </div>

          <Ribbon
            editor={editor}
            disabled={readOnly}
            settings={settings}
            view={view}
            zoom={zoom}
            showMarks={showMarks}
            fullScreen={fullScreen}
            onView={setView}
            onZoom={setZoom}
            onToggleMarks={() => setShowMarks((v) => !v)}
            onToggleFullScreen={toggleFullScreen}
            onSave={() => void save(draftStatus())}
            onFind={(replace) => setFind({ replace })}
            onSettings={(p) => void updateSettings(p)}
            onSaveAsTemplate={() => void saveAsTemplate()}
            onManage={props.onManageTemplates}
            onInsertPrior={() => {
              if (priors.length === 0) ui.toast('No previous studies for this patient.', 'info')
              else void openPrior(priors[0])
            }}
            onHistory={() => void openHistory()}
            onPrint={() => void print()}
            onPdf={() => void exportPdf()}
          />

          {readOnly && (
            <div className="signed-bar">
              <Lock size={15} /> Signed off by {report?.radiologist || '—'} on {formatIsoDateTime(report?.signedAt)}.
              <button className="btn btn-small" onClick={() => void reopen()}>
                <LockOpen size={14} /> Reopen for editing
              </button>
            </div>
          )}

          <div className={`editor-scroll ${view} ${showMarks ? 'show-marks' : ''}`} onContextMenu={spellMenu.onContextMenu}>
            <div className={view === 'print' ? pageClass : 'simple-page'} style={zoomStyle}>
              <div style={{ fontFamily: `'${settings.editorFontFamily}', serif`, fontSize: settings.editorFontSize }}>
                {loaded && <EditorContent editor={editor} />}
              </div>
            </div>
          </div>

          {find && (
            <Panel title={find.replace ? 'Find and replace' : 'Find'} onClose={() => setFind(null)}>
              <label className="field">
                <span>Find</span>
                <input
                  autoFocus
                  value={findText}
                  onChange={(e) => setFindText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !findNext(editor, findText, matchCase)) ui.toast('Not found', 'info')
                  }}
                />
              </label>
              {find.replace && (
                <label className="field">
                  <span>Replace with</span>
                  <input value={replaceText} onChange={(e) => setReplaceText(e.target.value)} />
                </label>
              )}
              <label className="check-line">
                <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Match case
              </label>
              <div className="row-btns">
                <button className="btn btn-small" onClick={() => !findNext(editor, findText, matchCase) && ui.toast('Not found', 'info')}>
                  Find next
                </button>
                {find.replace && !readOnly && (
                  <>
                    <button className="btn btn-small" onClick={() => replaceCurrent(editor, findText, replaceText, matchCase)}>
                      Replace
                    </button>
                    <button
                      className="btn btn-small btn-green"
                      onClick={() => ui.toast(`${replaceAll(editor, findText, replaceText, matchCase)} replaced`, 'info')}
                    >
                      Replace all
                    </button>
                  </>
                )}
              </div>
            </Panel>
          )}

          {/* ---------------- bottom action bar */}
          <footer className="report-actions">
            <span className={`badge st-${status}`}>{STATUS_LABEL[status]}</span>
            {dirty && <span className="muted">● unsaved</span>}
            {!dirty && autosavedAt && <span className="muted">Autosaved {autosavedAt}</span>}
            <div className="spacer" />
            <button className="btn btn-green" disabled={readOnly} onClick={() => void signOff(false)} title="Sign off (final report)">
              Sign off
            </button>
            <button className="btn btn-green" disabled={readOnly} onClick={() => void signOff(true)} title="Sign off and open the next unreported study">
              Sign off »
            </button>
            <button className="btn btn-green" disabled={readOnly} onClick={() => void save('PRELIMINARY')}>
              Preliminary
            </button>
            <button className="btn btn-gray" disabled={idx <= 0} onClick={() => goNext(-1)} title="Previous study in worklist">
              «
            </button>
            <button className="btn btn-green" disabled={readOnly} onClick={() => void save(draftStatus())} title="Save (Ctrl+S)">
              Save
            </button>
            <button
              className="btn btn-gray"
              disabled={idx < 0 || idx >= props.studyOrder.length - 1}
              onClick={() => goNext(1)}
              title="Next study in worklist"
            >
              »
            </button>
            <button className="btn btn-blue" onClick={() => void openImages(studyId)} title="Open images in the viewer">
              <ImageIcon size={15} /> Images
            </button>
            <button className="icon-btn big" title="Version history" onClick={() => void openHistory()}>
              <History size={18} />
            </button>
            <button className="icon-btn big" title="Print" onClick={() => void print()}>
              <Printer size={18} />
            </button>
            <button className="icon-btn big" title="Save as PDF" onClick={() => void exportPdf()}>
              <FileDown size={18} />
            </button>
            <button className="icon-btn big" title="Save as Word document (.docx)" onClick={() => void exportAs('docx')}>
              <FileType2 size={18} />
            </button>
            <button className="icon-btn big" title="Save as text file (.txt)" onClick={() => void exportAs('txt')}>
              <FileText size={18} />
            </button>
            <button className="btn btn-red" onClick={props.onBack}>
              Back
            </button>
          </footer>
        </main>
      </div>

      {sharing && <ShareDialog study={study} senderName={settings.radiologistName} onClose={() => setSharing(false)} />}
      {spellMenu.menu}

      {editDetails && (
        <CaseDialog
          study={study}
          procedures={[]}
          onClose={() => setEditDetails(false)}
          onSaved={async () => {
            setEditDetails(false)
            const d = await api.getStudy(studyId)
            if (d) {
              setStudy(d.study)
              setPriors(await api.getPriors(studyId))
            }
            ui.toast('Details updated', 'success')
          }}
        />
      )}

      {priorView && (
        <Modal
          wide
          title={`Previous report – ${priorView.study.description} (${formatDicomDate(priorView.study.studyDate)})`}
          onClose={() => setPriorView(null)}
          footer={
            <>
              <select
                className="prior-switch"
                value={priorView.study.id}
                onChange={(e) => {
                  const p = priors.find((x) => x.id === Number(e.target.value))
                  if (p) void openPrior(p)
                }}
              >
                {priors.map((p) => (
                  <option key={p.id} value={p.id}>
                    {formatDicomDate(p.studyDate)} – {p.description}
                  </option>
                ))}
              </select>
              <div className="spacer" />
              <button className="btn" onClick={() => setPriorView(null)}>
                Close
              </button>
              <button
                className="btn"
                disabled={readOnly || !priorView.report}
                onClick={() => {
                  editor.chain().focus().insertContent(priorView.report?.html ?? '').run()
                  setPriorView(null)
                }}
              >
                Insert at cursor
              </button>
              <button
                className="btn btn-green"
                disabled={readOnly || !priorView.report}
                onClick={async () => {
                  if (!editor.isEmpty && !(await ui.confirm('Replace report?', 'Replace the current text with the previous report?', 'Replace')))
                    return
                  editor.chain().setContent(priorView.report?.html ?? '').focus('end').run()
                  setDirty(true)
                  setPriorView(null)
                }}
              >
                Copy as starting point
              </button>
            </>
          }
        >
          {priorView.report ? (
            <div className="prior-report report-doc" dangerouslySetInnerHTML={{ __html: priorView.report.html }} />
          ) : (
            <p className="muted">This study has no report.</p>
          )}
        </Modal>
      )}

      {versions && (
        <Modal
          wide
          title="Report history"
          onClose={() => setVersions(null)}
          footer={
            <>
              <div className="spacer" />
              <button className="btn" onClick={() => setVersions(null)}>
                Close
              </button>
              <button
                className="btn btn-green"
                disabled={!versionPreview || readOnly}
                onClick={() => {
                  if (!versionPreview) return
                  editor.chain().setContent(versionPreview.html).run()
                  setDirty(true)
                  setVersions(null)
                }}
              >
                Restore this version
              </button>
            </>
          }
        >
          <div className="history">
            <ul className="history-list">
              {versions.length === 0 && <li className="muted">No saved versions yet.</li>}
              {versions.map((v) => (
                <li key={v.id} className={versionPreview?.id === v.id ? 'active' : ''} onClick={() => setVersionPreview(v)}>
                  <b>{formatIsoDateTime(v.savedAt)}</b>
                  <span className={`badge st-${v.status}`}>{STATUS_LABEL[v.status]}</span>
                  {v.note && <span className="history-note">{v.note}</span>}
                </li>
              ))}
            </ul>
            <div className="history-preview report-doc">
              {versionPreview ? <div dangerouslySetInnerHTML={{ __html: versionPreview.html }} /> : <p className="muted">Select a version.</p>}
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
})
