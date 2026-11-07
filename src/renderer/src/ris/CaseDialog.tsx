import { useEffect, useState } from 'react'
import type { ManualStudyInput, StudyRow } from '@shared/types'
import { dicomDateFromDate } from '@shared/format'
import { Modal, useUi } from '../common/ui'

const api = window.api
const MODALITIES = ['CT', 'MR', 'US', 'CR', 'DX', 'MG', 'XA', 'RF', 'NM', 'PT', 'OT']

const toDicomDate = (iso: string) => iso.replace(/-/g, '')
const fromDicomDate = (d: string) => (d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '')
const toDicomTime = (t: string) => (t ? `${t.replace(':', '').padEnd(4, '0')}00` : '')
const fromDicomTime = (t: string) => (t && t.length >= 4 ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : '')

/** "56" / "56y" / "6 m" -> DICOM style "056Y" / "006M"; "056Y" -> "56". */
function ageToDicom(a: string): string {
  const m = /^\s*(\d{1,3})\s*([dwmy])?\s*$/i.exec(a)
  if (!m) return a.trim()
  return `${m[1].padStart(3, '0')}${(m[2] ?? 'y').toUpperCase()}`
}
function ageFromDicom(a: string): string {
  const m = /^(\d{1,3})([DWMY])$/i.exec(a.trim())
  if (!m) return a
  const n = String(Number(m[1]))
  return m[2].toUpperCase() === 'Y' ? n : `${n} ${m[2].toLowerCase()}`
}

interface Props {
  /** Existing study to edit; omit to create a new case without images. */
  study?: StudyRow
  procedures: string[]
  onClose: () => void
  onSaved: (studyId: number) => void
}

export function CaseDialog({ study, procedures, onClose, onSaved }: Props) {
  const ui = useUi()
  const editing = !!study
  const now = new Date()
  const [f, setF] = useState({
    patientName: study?.patientName ?? '',
    patientId: study?.patientId ?? '',
    accession: study?.accession ?? '',
    age: study ? ageFromDicom(study.age) : '',
    sex: study?.sex ?? '',
    description: study?.description ?? '',
    modality: study?.modalities.split('\\')[0] || 'CT',
    date: study ? fromDicomDate(study.studyDate) : fromDicomDate(dicomDateFromDate(now)),
    time: study ? fromDicomTime(study.studyTime) : `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    referring: study?.referring ?? '',
    visitType: study?.visitType ?? 'OP',
    clinicalHistory: study?.clinicalHistory ?? ''
  })
  const [known, setKnown] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))

  // Existing patient? Fill in name/age/sex from the last study with the same CR No.
  useEffect(() => {
    if (editing) return
    const id = f.patientId.trim()
    if (id.length < 3) {
      setKnown(null)
      return
    }
    const t = setTimeout(async () => {
      const p = await api.findPatient(id)
      if (!p) {
        setKnown(null)
        return
      }
      setKnown(p.patientName)
      setF((x) => ({
        ...x,
        patientName: x.patientName || p.patientName,
        sex: x.sex || p.sex,
        age: x.age || ageFromDicom(p.age)
      }))
    }, 300)
    return () => clearTimeout(t)
  }, [f.patientId, editing])

  const save = async () => {
    if (!f.patientName.trim()) {
      ui.toast('Please enter the patient name', 'error')
      return
    }
    setBusy(true)
    const input: ManualStudyInput = {
      patientName: f.patientName.trim().toUpperCase(),
      patientId: f.patientId.trim(),
      accession: f.accession.trim().toUpperCase(),
      sex: f.sex,
      age: ageToDicom(f.age),
      birthDate: study?.birthDate ?? '',
      description: f.description.trim().toUpperCase(),
      modality: f.modality,
      studyDate: toDicomDate(f.date),
      studyTime: toDicomTime(f.time),
      referring: f.referring.trim(),
      visitType: f.visitType,
      clinicalHistory: f.clinicalHistory.trim()
    }
    try {
      if (study) {
        await api.updateStudyDetails(study.id, input)
        onSaved(study.id)
      } else {
        onSaved(await api.createManualStudy(input))
      }
    } catch (e) {
      ui.toast(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      wide
      title={editing ? 'Edit patient / study details' : 'New case – report without images'}
      onClose={onClose}
      footer={
        <>
          <span className="muted small modal-note">
            {editing
              ? 'Changes are saved in Personal PACS only (DICOM files are not modified).'
              : 'If you later import the CD, images with the same PG No are attached to this case automatically.'}
          </span>
          <div className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-green" disabled={busy} onClick={() => void save()}>
            {editing ? 'Save' : 'Create & start report'}
          </button>
        </>
      }
    >
      <div className="case-form" onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && void save()}>
        <label className="field">
          <span>Patient name *</span>
          <input autoFocus value={f.patientName} onChange={(e) => set('patientName', e.target.value)} placeholder="e.g. RAM KUMAR" />
        </label>
        <label className="field">
          <span>CR No (Patient ID)</span>
          <input value={f.patientId} onChange={(e) => set('patientId', e.target.value)} placeholder="e.g. 202601234567" />
          {known && <small className="ok-text">Existing patient – previous reports will be shown.</small>}
        </label>
        <label className="field">
          <span>PG No (Accession No)</span>
          <input value={f.accession} onChange={(e) => set('accession', e.target.value)} placeholder="e.g. PG812345" />
        </label>
        <div className="case-row">
          <label className="field">
            <span>Age</span>
            <input value={f.age} onChange={(e) => set('age', e.target.value)} placeholder="years, or 6 m" />
          </label>
          <label className="field">
            <span>Sex</span>
            <select value={f.sex} onChange={(e) => set('sex', e.target.value)}>
              <option value="">—</option>
              <option value="M">Male</option>
              <option value="F">Female</option>
              <option value="O">Other</option>
            </select>
          </label>
          <label className="field">
            <span>Visit</span>
            <select value={f.visitType} onChange={(e) => set('visitType', e.target.value)}>
              <option value="OP">OP</option>
              <option value="IP">IP</option>
              <option value="ER">Emergency</option>
              <option value="">—</option>
            </select>
          </label>
        </div>
        <label className="field span2">
          <span>Study / procedure</span>
          <input
            list="case-procedures"
            value={f.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="e.g. CT BODY (SPINE/CHEST/ABDOMEN)"
          />
          <datalist id="case-procedures">
            {procedures.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        <div className="case-row">
          <label className="field">
            <span>Modality</span>
            <select value={f.modality} onChange={(e) => set('modality', e.target.value)}>
              {MODALITIES.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Exam date</span>
            <input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} />
          </label>
          <label className="field">
            <span>Time</span>
            <input type="time" value={f.time} onChange={(e) => set('time', e.target.value)} />
          </label>
        </div>
        <label className="field">
          <span>Referring doctor</span>
          <input value={f.referring} onChange={(e) => set('referring', e.target.value)} />
        </label>
        <label className="field span2">
          <span>Clinical history</span>
          <textarea rows={2} value={f.clinicalHistory} onChange={(e) => set('clinicalHistory', e.target.value)} />
        </label>
      </div>
    </Modal>
  )
}
