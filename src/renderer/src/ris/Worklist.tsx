import { useCallback, useEffect, useMemo, useState } from 'react'
import type { DragEvent } from 'react'
import { Disc, Download, FilePlus, Files, FileText, FolderOpen, Image as ImageIcon, RefreshCw, Search, Share2, Trash, X } from 'lucide-react'
import type { ImportProgress, Settings, StudyFilter, StudyRow } from '@shared/types'
import {
  dicomDateFromDate,
  formatAge,
  formatDicomDate,
  formatDicomTime,
  formatIsoDateTime,
  formatSex,
  STATUS_LABEL
} from '@shared/format'
import { Modal, useEvent, useUi } from '../common/ui'
import { CaseDialog } from './CaseDialog'
import { ShareDialog, SharesList, useShares } from './Sharing'

const api = window.api

const MODALITIES = ['', 'CT', 'MR', 'CR', 'DX', 'US', 'MG', 'PT', 'NM', 'XA', 'RF', 'OT']

type DateRange = 'all' | 'today' | 'yesterday' | '7d' | '30d' | 'custom'

function rangeToDates(r: DateRange): { dateFrom?: string; dateTo?: string } {
  const d = new Date()
  const today = dicomDateFromDate(d)
  if (r === 'today') return { dateFrom: today, dateTo: today }
  if (r === 'yesterday') {
    const y = new Date(d.getTime() - 86400000)
    const ys = dicomDateFromDate(y)
    return { dateFrom: ys, dateTo: ys }
  }
  if (r === '7d') return { dateFrom: dicomDateFromDate(new Date(d.getTime() - 6 * 86400000)), dateTo: today }
  if (r === '30d') return { dateFrom: dicomDateFromDate(new Date(d.getTime() - 29 * 86400000)), dateTo: today }
  return {}
}

const toDicom = (iso: string) => iso.replace(/-/g, '')
const fromDicom = (d?: string) => (d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '')

interface Props {
  filter: StudyFilter
  onFilterChange: (f: StudyFilter) => void
  onOrderChange: (ids: number[]) => void
  onOpenReport: (studyId: number) => void
  onOpenImages: (studyId: number) => void
  onReceive: () => void
  settings: Settings
}

export function Worklist({ filter, onFilterChange, onOrderChange, onOpenReport, onOpenImages, onReceive, settings }: Props) {
  const ui = useUi()
  const [rows, setRows] = useState<StudyRow[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [range, setRange] = useState<DateRange>('all')
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadedOnce, setLoadedOnce] = useState(false)
  const [newCase, setNewCase] = useState(false)
  const [procedures, setProcedures] = useState<string[]>([])
  const [shareFor, setShareFor] = useState<StudyRow | null>(null)
  const [showShares, setShowShares] = useState(false)
  const shares = useShares()
  const sharingNow = shares.filter((s) => s.status === 'active' || s.status === 'preparing').length

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const list = await api.listStudies(filter)
      setRows(list)
      onOrderChange(list.map((r) => r.id))
    } finally {
      setLoading(false)
      setLoadedOnce(true)
    }
  }, [filter, onOrderChange])

  useEffect(() => {
    const t = setTimeout(() => void load(), 150)
    return () => clearTimeout(t)
  }, [load])

  useEvent(api.onStudiesChanged, () => void load())
  useEvent(api.onImportProgress, (p: ImportProgress) => setProgress(p))

  const setF = (patch: Partial<StudyFilter>) => onFilterChange({ ...filter, ...patch })

  const chooseRange = (r: DateRange) => {
    setRange(r)
    if (r !== 'custom') setF({ dateFrom: undefined, dateTo: undefined, ...rangeToDates(r) })
  }

  const startImport = async (kind: 'folder' | 'files') => {
    try {
      const res = await api.pickAndImport(kind)
      if (res) ui.toast(res.message, res.errors ? 'error' : 'success')
    } catch (e) {
      ui.toast(String((e as Error).message ?? e), 'error')
    }
  }

  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => api.getPathForFile(f))
      .filter(Boolean)
    if (!paths.length) return
    try {
      const res = await api.importPaths(paths)
      ui.toast(res.message, res.errors ? 'error' : 'success')
    } catch (err) {
      ui.toast(String((err as Error).message ?? err), 'error')
    }
  }

  const sel = useMemo(() => rows.find((r) => r.id === selected) ?? null, [rows, selected])

  const deleteStudy = async () => {
    if (!sel) return
    const ok = await ui.confirm(
      'Delete study?',
      <>
        <p>
          <b>{sel.patientName}</b> – {sel.description || 'study'} ({formatDicomDate(sel.studyDate)})
        </p>
        <p>The images and the report will be permanently removed from this computer.</p>
      </>,
      'Delete',
      true
    )
    if (!ok) return
    await api.deleteStudy(sel.id)
    setSelected(null)
    ui.toast('Study deleted', 'success')
  }

  const running = progress?.running
  return (
    <div
      className={`worklist ${dragOver ? 'drag-over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <header className="topbar">
        <div className="brand">
          Personal <span>PACS</span>
        </div>
        <div className="topbar-title">Worklist</div>
        <div className="topbar-actions">
          <button
            className="btn btn-outline"
            title="Start a report for a patient without images (enter name, CR No, PG No)"
            onClick={() => {
              void Promise.all([api.listStudies({ limit: 500 }), api.listTemplates()]).then(([st, tp]) =>
                setProcedures([...new Set([...st.map((x) => x.description).filter(Boolean), ...tp.map((t) => t.name.toUpperCase())])].sort())
              )
              setNewCase(true)
            }}
          >
            <FilePlus size={16} /> New Case
          </button>
          {shares.length > 0 && (
            <button className="btn btn-outline sharing-chip" title="Cases you are sharing" onClick={() => setShowShares(true)}>
              <Share2 size={16} /> {sharingNow > 0 ? `Sharing ${sharingNow}` : 'Shared cases'}
            </button>
          )}
          <button className="btn btn-outline" title="Receive a case shared by another Personal PACS user" onClick={onReceive}>
            <Download size={16} /> Receive Case
          </button>
          <button className="btn btn-green" onClick={() => void startImport('folder')} disabled={running}>
            <Disc size={16} /> Import CD / Folder
          </button>
          <button className="btn" title="Import DICOM files or ZIP archives (e.g. a study downloaded from a PACS portal)" onClick={() => void startImport('files')} disabled={running}>
            <Files size={16} /> Import Files / ZIP
          </button>
        </div>
      </header>

      <div className="filters">
        <div className="search">
          <Search size={15} />
          <input
            placeholder="Patient name, ID, accession or study"
            value={filter.text ?? ''}
            onChange={(e) => setF({ text: e.target.value })}
          />
          {filter.text && (
            <button className="icon-btn" onClick={() => setF({ text: '' })} title="Clear">
              <X size={14} />
            </button>
          )}
        </div>
        <label className="field-inline">
          Modality
          <select value={filter.modality ?? ''} onChange={(e) => setF({ modality: e.target.value })}>
            {MODALITIES.map((m) => (
              <option key={m} value={m}>
                {m || 'All'}
              </option>
            ))}
          </select>
        </label>
        <label className="field-inline">
          Status
          <select value={filter.status ?? ''} onChange={(e) => setF({ status: e.target.value as StudyFilter['status'] })}>
            <option value="">All</option>
            <option value="UNREPORTED">Not signed off</option>
            <option value="NEW">Unreported</option>
            <option value="DRAFT">Draft</option>
            <option value="PRELIMINARY">Preliminary</option>
            <option value="FINAL">Signed off</option>
          </select>
        </label>
        <label className="field-inline">
          Date
          <select value={range} onChange={(e) => chooseRange(e.target.value as DateRange)}>
            <option value="all">All dates</option>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="custom">Custom…</option>
          </select>
        </label>
        {range === 'custom' && (
          <>
            <input type="date" value={fromDicom(filter.dateFrom)} onChange={(e) => setF({ dateFrom: toDicom(e.target.value) || undefined })} />
            <span className="muted">to</span>
            <input type="date" value={fromDicom(filter.dateTo)} onChange={(e) => setF({ dateTo: toDicom(e.target.value) || undefined })} />
          </>
        )}
        <div className="search small">
          <FileText size={14} />
          <input
            placeholder="Search in report text"
            value={filter.reportText ?? ''}
            onChange={(e) => setF({ reportText: e.target.value })}
          />
        </div>
        <button className="icon-btn" title="Refresh" onClick={() => void load()}>
          <RefreshCw size={16} className={loading ? 'spin' : ''} />
        </button>
      </div>

      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th style={{ width: 8 }}></th>
              <th>Patient Name</th>
              <th>Patient ID</th>
              <th>Age/Sex</th>
              <th>Study</th>
              <th>Mod.</th>
              <th>Study Date</th>
              <th>Accession No</th>
              <th className="num">Images</th>
              <th>Report</th>
              <th>Last Saved</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className={selected === r.id ? 'selected' : ''}
                onClick={() => setSelected(r.id)}
                onDoubleClick={() => onOpenReport(r.id)}
              >
                <td className={`status-bar st-${r.reportStatus}`}></td>
                <td className="strong">
                  {r.patientName || '(no name)'}
                  {r.sharedFrom && (
                    <span className="from-badge" title={`Received from ${r.sharedFrom}`}>
                      from {r.sharedFrom}
                    </span>
                  )}
                </td>
                <td>{r.patientId}</td>
                <td>{[formatAge(r.age, r.birthDate, r.studyDate), formatSex(r.sex)].filter(Boolean).join(' / ')}</td>
                <td>{r.description}</td>
                <td>{r.modalities.split('\\').filter(Boolean).join(', ')}</td>
                <td>
                  {formatDicomDate(r.studyDate)} <span className="muted">{formatDicomTime(r.studyTime)}</span>
                </td>
                <td>{r.accession}</td>
                <td className="num">{r.numImages > 0 ? r.numImages : <span className="no-img">no images</span>}</td>
                <td>
                  <span className={`badge st-${r.reportStatus}`}>{STATUS_LABEL[r.reportStatus]}</span>
                </td>
                <td className="muted">{formatIsoDateTime(r.reportUpdatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && !loading && loadedOnce && (
          <div className="empty">
            <FolderOpen size={44} />
            <p>No studies found.</p>
            <p className="muted">
              Click <b>Import CD / Folder</b> and choose a CD/DVD drive, USB stick or folder with DICOM files, or{' '}
              <b>Import Files / ZIP</b> for a ZIP archive – or drag files, folders and ZIP files onto this window.
            </p>
          </div>
        )}
      </div>

      <footer className="actionbar">
        <span className="muted">{rows.length} studies</span>
        <div className="spacer" />
        <button className="btn" disabled={!sel} onClick={() => sel && void api.showStudyInFolder(sel.id)}>
          <FolderOpen size={16} /> Show files
        </button>
        <button className="btn btn-red-outline" disabled={!sel} onClick={() => void deleteStudy()}>
          <Trash size={16} /> Delete
        </button>
        <button className="btn" disabled={!sel} onClick={() => sel && setShareFor(sel)} title="Share this case with another Personal PACS user">
          <Share2 size={16} /> Share
        </button>
        <button className="btn" disabled={!sel} onClick={() => sel && onOpenImages(sel.id)}>
          <ImageIcon size={16} /> Images
        </button>
        <button className="btn btn-green" disabled={!sel} onClick={() => sel && onOpenReport(sel.id)}>
          <FileText size={16} /> Report
        </button>
      </footer>

      {progress && (progress.running || progress.phase !== 'scanning') && (
        <div className={`import-card ${progress.running ? '' : 'done'}`}>
          <div className="import-title">
            {progress.running
              ? progress.phase === 'unpacking'
                ? 'Unpacking ZIP…'
                : progress.phase === 'scanning'
                  ? 'Scanning…'
                  : 'Importing…'
              : 'Import finished'}
            {!progress.running && (
              <button className="icon-btn" onClick={() => setProgress(null)} title="Close">
                <X size={14} />
              </button>
            )}
          </div>
          {progress.running && progress.phase === 'importing' && (
            <div className="progress">
              <div style={{ width: `${progress.filesFound ? (100 * progress.processed) / progress.filesFound : 0}%` }} />
            </div>
          )}
          {progress.running && progress.phase === 'unpacking' && progress.zip && (
            <div className="progress">
              <div style={{ width: `${progress.zip.total ? (100 * progress.zip.done) / progress.zip.total : 0}%` }} />
            </div>
          )}
          <div className="import-stats">
            {progress.running ? (
              <>
                {progress.phase === 'unpacking' && progress.zip
                  ? `${progress.zip.name}: ${progress.zip.done} / ${progress.zip.total} files`
                  : progress.phase === 'scanning'
                    ? `${progress.filesFound} files found`
                    : `${progress.processed} / ${progress.filesFound} files · ${progress.imported} images imported`}
              </>
            ) : (
              progress.message
            )}
          </div>
          {progress.running && (
            <button className="btn btn-small" onClick={() => void api.cancelImport()}>
              Cancel
            </button>
          )}
        </div>
      )}
      {dragOver && <div className="drop-hint">Drop DICOM files or folders to import</div>}
      {shareFor && <ShareDialog study={shareFor} senderName={settings.radiologistName} onClose={() => setShareFor(null)} />}
      {showShares && (
        <Modal
          title="Shared cases"
          onClose={() => setShowShares(false)}
          footer={
            <button className="btn" onClick={() => setShowShares(false)}>
              Close
            </button>
          }
        >
          <div className="shares-modal">
            <SharesList shares={shares} />
          </div>
        </Modal>
      )}
      {newCase && (
        <CaseDialog
          procedures={procedures}
          onClose={() => setNewCase(false)}
          onSaved={(id) => {
            setNewCase(false)
            onOpenReport(id)
          }}
        />
      )}
    </div>
  )
}
