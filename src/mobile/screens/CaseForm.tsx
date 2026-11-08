import { useEffect, useMemo, useState } from 'react'
import type { ManualStudyInput } from '@shared/types'
import { dicomDateFromDate } from '@shared/format'
import type { Nav } from '../App'
import { store } from '../db'
import { createCase, editCaseDetails } from '../repo'
import { Page, useUi } from '../ui'

const MODALITIES = ['CT', 'MR', 'US', 'CR', 'DX', 'MG', 'XA', 'RF', 'NM', 'PT', 'OT']
const toDicomDate = (iso: string) => iso.replace(/-/g, '')
const fromDicomDate = (d: string) => (d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '')
const toDicomTime = (t: string) => (t ? `${t.replace(':', '').padEnd(4, '0')}00` : '')
const fromDicomTime = (t: string) => (t && t.length >= 4 ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : '')

/** "56" / "56y" / "6 m" -> "056Y" / "006M" (DICOM style, as on the PC). */
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

/** New case without images (or editing a case's details) – same fields as "New Case" on the PC. */
export function CaseForm({ nav, studySyncId, thenReport }: { nav: Nav; studySyncId?: string; thenReport?: boolean }) {
  const ui = useUi()
  const study = studySyncId ? store.studies.get(studySyncId) : undefined
  const now = new Date()
  const [f, setF] = useState({
    patientName: study?.patientName ?? '',
    patientId: study?.patientId ?? '',
    accession: study?.accession ?? '',
    age: study ? ageFromDicom(study.age) : '',
    sex: study?.sex ?? '',
    visitType: study?.visitType ?? 'OP',
    description: study?.description ?? '',
    modality: study?.modalities.split('\\')[0] || 'CT',
    date: study ? fromDicomDate(study.studyDate) : fromDicomDate(dicomDateFromDate(now)),
    time: study ? fromDicomTime(study.studyTime) : `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    referring: study?.referring ?? '',
    clinicalHistory: study?.clinicalHistory ?? ''
  })
  const [known, setKnown] = useState<string | null>(null)
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))

  // Known patient (same CR No): fill in name / age / sex like the PC does.
  useEffect(() => {
    if (study) return
    const id = f.patientId.trim().toUpperCase()
    if (id.length < 3) {
      setKnown(null)
      return
    }
    const prev = [...store.studies.values()]
      .filter((s) => s.patientId.trim().toUpperCase() === id)
      .sort((a, b) => b.studyDate.localeCompare(a.studyDate))[0]
    if (!prev) {
      setKnown(null)
      return
    }
    setKnown(prev.patientName)
    setF((x) => ({ ...x, patientName: x.patientName || prev.patientName, sex: x.sex || prev.sex, age: x.age || ageFromDicom(prev.age) }))
  }, [f.patientId, study])

  const procedures = useMemo(
    () => [...new Set([...store.liveTemplates().map((t) => t.name.toUpperCase()), ...[...store.studies.values()].map((s) => s.description)].filter(Boolean))].sort(),
    []
  )

  const save = async () => {
    if (!f.patientName.trim()) {
      ui.toast('Please enter the patient name', 'error')
      return
    }
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
    if (study) {
      const { birthDate: _b, ...changes } = input
      await editCaseDetails(study.syncId, changes)
      nav.back()
    } else {
      const id = await createCase(input)
      if (thenReport) nav.replace({ name: 'report', id })
      else nav.back()
    }
  }

  return (
    <Page
      title={study ? 'Patient / study details' : 'New case'}
      subtitle={study ? 'Changes are sent to the PC' : 'Report now – images can be added on the PC later'}
      onBack={() => nav.back()}
      footer={
        <div className="m-actions">
          <button className="m-btn plain" onClick={() => nav.back()}>
            Cancel
          </button>
          <button className="m-btn primary grow" onClick={() => void save()}>
            {study ? 'Save' : 'Create & start report'}
          </button>
        </div>
      }
    >
      <div className="m-form">
        <label className="m-field">
          <span>Patient name *</span>
          <input autoCapitalize="characters" value={f.patientName} onChange={(e) => set('patientName', e.target.value)} placeholder="e.g. RAM KUMAR" />
        </label>
        <label className="m-field">
          <span>CR No (Patient ID)</span>
          <input inputMode="text" value={f.patientId} onChange={(e) => set('patientId', e.target.value)} />
          {known && <small className="m-ok">Known patient – previous reports will be shown.</small>}
        </label>
        <label className="m-field">
          <span>PG No (Accession No)</span>
          <input autoCapitalize="characters" value={f.accession} onChange={(e) => set('accession', e.target.value)} />
        </label>
        <div className="m-row3">
          <label className="m-field">
            <span>Age</span>
            <input value={f.age} onChange={(e) => set('age', e.target.value)} placeholder="years or 6 m" />
          </label>
          <label className="m-field">
            <span>Sex</span>
            <select value={f.sex} onChange={(e) => set('sex', e.target.value)}>
              <option value="">—</option>
              <option value="M">Male</option>
              <option value="F">Female</option>
              <option value="O">Other</option>
            </select>
          </label>
          <label className="m-field">
            <span>Visit</span>
            <select value={f.visitType} onChange={(e) => set('visitType', e.target.value)}>
              <option value="OP">OP</option>
              <option value="IP">IP</option>
              <option value="ER">Emergency</option>
              <option value="">—</option>
            </select>
          </label>
        </div>
        <label className="m-field">
          <span>Study / procedure</span>
          <input list="m-procedures" autoCapitalize="characters" value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="e.g. CT CHEST" />
          <datalist id="m-procedures">
            {procedures.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        <div className="m-row3 dt">
          <label className="m-field">
            <span>Modality</span>
            <select value={f.modality} onChange={(e) => set('modality', e.target.value)}>
              {MODALITIES.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="m-field">
            <span>Exam date</span>
            <input type="date" value={f.date} onChange={(e) => set('date', e.target.value)} />
          </label>
          <label className="m-field">
            <span>Time</span>
            <input type="time" value={f.time} onChange={(e) => set('time', e.target.value)} />
          </label>
        </div>
        <label className="m-field">
          <span>Referring doctor</span>
          <input value={f.referring} onChange={(e) => set('referring', e.target.value)} />
        </label>
        <label className="m-field">
          <span>Clinical history</span>
          <textarea rows={3} value={f.clinicalHistory} onChange={(e) => set('clinicalHistory', e.target.value)} />
        </label>
      </div>
    </Page>
  )
}
