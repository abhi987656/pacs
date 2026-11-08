// Edits made on the phone. Each one is saved locally at once and marked for the next sync.

import type { ManualStudyInput, ReportStatus } from '@shared/types'
import { Batch, store } from './db'
import type { DetailField, LocalMacro, LocalReport, LocalStudy, LocalTemplate } from './db'

const nowIso = () => new Date().toISOString()
const uuid = () => crypto.randomUUID()

/** ManualStudyInput field -> value stored on the local study. */
export function detailValue(s: LocalStudy, k: DetailField): string {
  if (k === 'modality') return s.modalities.split('\\')[0] ?? ''
  return String((s as unknown as Record<string, unknown>)[k] ?? '')
}

function applyDetails(s: LocalStudy, fields: Partial<ManualStudyInput>): { next: LocalStudy; changed: DetailField[] } {
  const next = { ...s }
  const changed: DetailField[] = []
  for (const [k, v] of Object.entries(fields) as [DetailField, string | undefined][]) {
    if (typeof v !== 'string' || detailValue(s, k) === v) continue
    if (k === 'modality') next.modalities = v
    else (next as unknown as Record<string, unknown>)[k] = v
    changed.push(k)
  }
  return { next, changed }
}

export async function createCase(fields: ManualStudyInput): Promise<string> {
  const ts = nowIso()
  const s: LocalStudy = {
    syncId: uuid(),
    patientName: fields.patientName,
    patientId: fields.patientId,
    accession: fields.accession,
    sex: fields.sex,
    age: fields.age,
    birthDate: fields.birthDate,
    description: fields.description,
    modalities: fields.modality,
    studyDate: fields.studyDate,
    studyTime: fields.studyTime,
    referring: fields.referring,
    visitType: fields.visitType,
    clinicalHistory: fields.clinicalHistory,
    institution: '',
    numImages: 0,
    manual: true,
    reportStatus: 'NEW',
    importedAt: ts,
    modifiedAt: ts,
    rev: 0,
    listed: true,
    isNew: true,
    dirtyFields: Object.keys(fields) as DetailField[],
    editedAt: ts,
    localVer: store.nextVer()
  }
  const b = new Batch()
  b.put('studies', s)
  await store.commit(b)
  return s.syncId
}

export async function editCaseDetails(syncId: string, fields: Partial<ManualStudyInput>): Promise<void> {
  const s = store.studies.get(syncId)
  if (!s) return
  const { next, changed } = applyDetails(s, fields)
  if (!changed.length) return
  const ts = nowIso()
  const b = new Batch()
  b.put('studies', {
    ...next,
    dirtyFields: [...new Set([...s.dirtyFields, ...changed])],
    editedAt: ts,
    modifiedAt: ts,
    localVer: store.nextVer()
  })
  await store.commit(b)
}

export function blankReport(s: LocalStudy): LocalReport {
  return {
    studySyncId: s.syncId,
    status: 'NEW',
    html: '',
    text: '',
    modality: s.modalities.split('\\')[0] ?? '',
    procedure: s.description,
    radiologist: store.meta.settings.radiologistName,
    templateName: '',
    updatedAt: '',
    signedAt: null,
    rev: 0,
    dirty: false,
    localVer: 0
  }
}

/** Saves the report text on the phone. The phone never signs off: DRAFT or PRELIMINARY only. */
export async function saveReportLocal(
  studySyncId: string,
  patch: { html: string; text: string; status?: 'DRAFT' | 'PRELIMINARY'; templateName?: string; procedure?: string; modality?: string }
): Promise<LocalReport | null> {
  const s = store.studies.get(studySyncId)
  if (!s) return null
  const cur = store.reports.get(studySyncId) ?? blankReport(s)
  if (cur.status === 'FINAL') return cur
  const status: ReportStatus = patch.status ?? (cur.status === 'PRELIMINARY' ? 'PRELIMINARY' : 'DRAFT')
  const ts = nowIso()
  const rep: LocalReport = {
    ...cur,
    html: patch.html,
    text: patch.text,
    status,
    templateName: patch.templateName ?? cur.templateName,
    procedure: patch.procedure ?? cur.procedure,
    modality: patch.modality ?? cur.modality,
    radiologist: cur.radiologist || store.meta.settings.radiologistName,
    updatedAt: ts,
    dirty: true,
    localVer: store.nextVer()
  }
  const b = new Batch()
  b.put('reports', rep)
  if (s.reportStatus !== status) b.put('studies', { ...s, reportStatus: status })
  await store.commit(b)
  return rep
}

export async function saveTemplate(t: { syncId?: string; name: string; modality: string; html: string }): Promise<string> {
  const cur = t.syncId ? store.templates.get(t.syncId) : undefined
  const rec: LocalTemplate = {
    syncId: cur?.syncId ?? uuid(),
    name: t.name.trim(),
    modality: t.modality,
    html: t.html,
    mine: cur?.mine ?? true,
    updatedAt: nowIso(),
    rev: cur?.rev ?? 0,
    dirty: true,
    deleted: false,
    localVer: store.nextVer()
  }
  const b = new Batch()
  b.put('templates', rec)
  await store.commit(b)
  return rec.syncId
}

export async function deleteTemplate(syncId: string): Promise<void> {
  const cur = store.templates.get(syncId)
  if (!cur) return
  const b = new Batch()
  if (cur.rev === 0) b.del('templates', syncId) // never reached the PC
  else b.put('templates', { ...cur, deleted: true, dirty: true, updatedAt: nowIso(), localVer: store.nextVer() })
  await store.commit(b)
}

export async function saveMacro(m: { syncId?: string; code: string; text: string }): Promise<string> {
  const cur = m.syncId ? store.macros.get(m.syncId) : undefined
  const rec: LocalMacro = {
    syncId: cur?.syncId ?? uuid(),
    code: m.code.trim().replace(/^\./, ''),
    text: m.text,
    updatedAt: nowIso(),
    rev: cur?.rev ?? 0,
    dirty: true,
    deleted: false,
    localVer: store.nextVer()
  }
  const b = new Batch()
  b.put('macros', rec)
  await store.commit(b)
  return rec.syncId
}

export async function deleteMacro(syncId: string): Promise<void> {
  const cur = store.macros.get(syncId)
  if (!cur) return
  const b = new Batch()
  if (cur.rev === 0) b.del('macros', syncId)
  else b.put('macros', { ...cur, deleted: true, dirty: true, updatedAt: nowIso(), localVer: store.nextVer() })
  await store.commit(b)
}
