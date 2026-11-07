import { DatabaseSync } from 'node:sqlite'
import type {
  Macro,
  Report,
  ReportSaveInput,
  ReportStatus,
  ReportVersion,
  SeriesRow,
  Settings,
  StudyFilter,
  StudyRow,
  Template
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

type Row = Record<string, unknown>
type SqlValue = string | number | null

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS studies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_uid TEXT NOT NULL UNIQUE,
  patient_id TEXT NOT NULL DEFAULT '',
  patient_name TEXT NOT NULL DEFAULT '',
  patient_name_raw TEXT NOT NULL DEFAULT '',
  birth_date TEXT NOT NULL DEFAULT '',
  sex TEXT NOT NULL DEFAULT '',
  age TEXT NOT NULL DEFAULT '',
  study_date TEXT NOT NULL DEFAULT '',
  study_time TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  accession TEXT NOT NULL DEFAULT '',
  referring TEXT NOT NULL DEFAULT '',
  institution TEXT NOT NULL DEFAULT '',
  modalities TEXT NOT NULL DEFAULT '',
  body_part TEXT NOT NULL DEFAULT '',
  num_series INTEGER NOT NULL DEFAULT 0,
  num_images INTEGER NOT NULL DEFAULT 0,
  folder TEXT NOT NULL DEFAULT '',
  imported_at TEXT NOT NULL DEFAULT '',
  report_status TEXT NOT NULL DEFAULT 'NEW',
  visit_type TEXT NOT NULL DEFAULT '',
  clinical_history TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_studies_patient ON studies(patient_id);
CREATE INDEX IF NOT EXISTS idx_studies_date ON studies(study_date);

CREATE TABLE IF NOT EXISTS series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
  series_uid TEXT NOT NULL UNIQUE,
  number INTEGER,
  description TEXT NOT NULL DEFAULT '',
  modality TEXT NOT NULL DEFAULT '',
  body_part TEXT NOT NULL DEFAULT '',
  num_images INTEGER NOT NULL DEFAULT 0,
  num_frames INTEGER NOT NULL DEFAULT 0,
  is_image INTEGER NOT NULL DEFAULT 1,
  folder TEXT NOT NULL DEFAULT '',
  thumb TEXT
);
CREATE INDEX IF NOT EXISTS idx_series_study ON series(study_id);

CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE,
  sop_uid TEXT NOT NULL UNIQUE,
  sop_class TEXT NOT NULL DEFAULT '',
  instance_number INTEGER,
  frames INTEGER NOT NULL DEFAULT 1,
  ipp TEXT NOT NULL DEFAULT '',
  iop TEXT NOT NULL DEFAULT '',
  slice_location REAL,
  for_uid TEXT NOT NULL DEFAULT '',
  rows INTEGER NOT NULL DEFAULT 0,
  cols INTEGER NOT NULL DEFAULT 0,
  rel_path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instances_series ON instances(series_id);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  study_id INTEGER NOT NULL UNIQUE REFERENCES studies(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  html TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  modality TEXT NOT NULL DEFAULT '',
  procedure TEXT NOT NULL DEFAULT '',
  radiologist TEXT NOT NULL DEFAULT '',
  template_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  signed_at TEXT
);

CREATE TABLE IF NOT EXISTS report_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  html TEXT NOT NULL,
  saved_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_report ON report_versions(report_id);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  modality TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  mine INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS macros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

const str = (v: unknown): string => (v == null ? '' : String(v))
const num = (v: unknown): number => (v == null ? 0 : Number(v))
const now = (): string => new Date().toISOString()

function mapStudy(r: Row): StudyRow {
  return {
    id: num(r.id),
    studyUid: str(r.study_uid),
    patientId: str(r.patient_id),
    patientName: str(r.patient_name),
    birthDate: str(r.birth_date),
    sex: str(r.sex),
    age: str(r.age),
    studyDate: str(r.study_date),
    studyTime: str(r.study_time),
    description: str(r.description),
    accession: str(r.accession),
    referring: str(r.referring),
    institution: str(r.institution),
    modalities: str(r.modalities),
    bodyPart: str(r.body_part),
    numSeries: num(r.num_series),
    numImages: num(r.num_images),
    importedAt: str(r.imported_at),
    reportStatus: (str(r.report_status) || 'NEW') as ReportStatus,
    reportUpdatedAt: r.report_updated_at == null ? null : str(r.report_updated_at),
    visitType: str(r.visit_type),
    clinicalHistory: str(r.clinical_history)
  }
}

function mapSeries(r: Row): SeriesRow {
  return {
    id: num(r.id),
    studyId: num(r.study_id),
    seriesUid: str(r.series_uid),
    number: r.number == null ? null : num(r.number),
    description: str(r.description),
    modality: str(r.modality),
    bodyPart: str(r.body_part),
    numImages: num(r.num_images),
    numFrames: num(r.num_frames),
    isImage: num(r.is_image) === 1,
    thumb: r.thumb == null ? null : str(r.thumb)
  }
}

function mapReport(r: Row): Report {
  return {
    id: num(r.id),
    studyId: num(r.study_id),
    status: str(r.status) as ReportStatus,
    html: str(r.html),
    text: str(r.text),
    modality: str(r.modality),
    procedure: str(r.procedure),
    radiologist: str(r.radiologist),
    templateName: str(r.template_name),
    createdAt: str(r.created_at),
    updatedAt: str(r.updated_at),
    signedAt: r.signed_at == null ? null : str(r.signed_at)
  }
}

function mapTemplate(r: Row): Template {
  return {
    id: num(r.id),
    name: str(r.name),
    modality: str(r.modality),
    html: str(r.html),
    mine: num(r.mine) === 1,
    updatedAt: str(r.updated_at)
  }
}

export interface StudyInsert {
  studyUid: string
  patientId: string
  patientName: string
  patientNameRaw: string
  birthDate: string
  sex: string
  age: string
  studyDate: string
  studyTime: string
  description: string
  accession: string
  referring: string
  institution: string
  bodyPart: string
  folder: string
}

export interface SeriesInsert {
  seriesUid: string
  number: number | null
  description: string
  modality: string
  bodyPart: string
  isImage: boolean
  folder: string
}

export interface InstanceInsert {
  sopUid: string
  sopClass: string
  instanceNumber: number | null
  frames: number
  ipp: string
  iop: string
  sliceLocation: number | null
  forUid: string
  rows: number
  cols: number
  relPath: string
}

export interface InstanceRow extends InstanceInsert {
  id: number
}

export class Db {
  readonly db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;')
    this.migrate()
  }

  private migrate(): void {
    const v = num((this.db.prepare('PRAGMA user_version').get() as Row).user_version)
    if (v < 1) {
      this.db.exec(SCHEMA_V1)
      this.db.exec('PRAGMA user_version = 1')
    }
  }

  close(): void {
    this.db.close()
  }

  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  private all(sql: string, ...params: SqlValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[]
  }

  private get(sql: string, ...params: SqlValue[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined
  }

  private run(sql: string, ...params: SqlValue[]): number {
    const res = this.db.prepare(sql).run(...params)
    return Number(res.lastInsertRowid)
  }

  // ---------------------------------------------------------------- studies

  findStudyIdByUid(uid: string): number | null {
    const r = this.get('SELECT id FROM studies WHERE study_uid = ?', uid)
    return r ? num(r.id) : null
  }

  insertStudy(s: StudyInsert): number {
    return this.run(
      `INSERT INTO studies (study_uid, patient_id, patient_name, patient_name_raw, birth_date, sex, age,
        study_date, study_time, description, accession, referring, institution, body_part, folder, imported_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      s.studyUid, s.patientId, s.patientName, s.patientNameRaw, s.birthDate, s.sex, s.age,
      s.studyDate, s.studyTime, s.description, s.accession, s.referring, s.institution, s.bodyPart,
      s.folder, now()
    )
  }

  /** Fill empty study fields with values from a later instance (instances can differ). */
  fillStudyBlanks(id: number, s: StudyInsert): void {
    this.run(
      `UPDATE studies SET
        patient_id = CASE WHEN patient_id = '' THEN ? ELSE patient_id END,
        patient_name = CASE WHEN patient_name = '' THEN ? ELSE patient_name END,
        birth_date = CASE WHEN birth_date = '' THEN ? ELSE birth_date END,
        sex = CASE WHEN sex = '' THEN ? ELSE sex END,
        age = CASE WHEN age = '' THEN ? ELSE age END,
        description = CASE WHEN description = '' THEN ? ELSE description END,
        accession = CASE WHEN accession = '' THEN ? ELSE accession END,
        referring = CASE WHEN referring = '' THEN ? ELSE referring END,
        institution = CASE WHEN institution = '' THEN ? ELSE institution END,
        body_part = CASE WHEN body_part = '' THEN ? ELSE body_part END
       WHERE id = ?`,
      s.patientId, s.patientName, s.birthDate, s.sex, s.age, s.description, s.accession,
      s.referring, s.institution, s.bodyPart, id
    )
  }

  findSeriesIdByUid(uid: string): number | null {
    const r = this.get('SELECT id FROM series WHERE series_uid = ?', uid)
    return r ? num(r.id) : null
  }

  insertSeries(studyId: number, s: SeriesInsert): number {
    return this.run(
      `INSERT INTO series (study_id, series_uid, number, description, modality, body_part, is_image, folder)
       VALUES (?,?,?,?,?,?,?,?)`,
      studyId, s.seriesUid, s.number, s.description, s.modality, s.bodyPart, s.isImage ? 1 : 0, s.folder
    )
  }

  getSeriesFolder(id: number): string {
    const r = this.get('SELECT folder FROM series WHERE id = ?', id)
    return r ? str(r.folder) : ''
  }

  markSeriesImage(seriesId: number, isImage: boolean): void {
    if (isImage) this.run('UPDATE series SET is_image = 1 WHERE id = ?', seriesId)
  }

  hasInstance(sopUid: string): boolean {
    return !!this.get('SELECT 1 AS x FROM instances WHERE sop_uid = ?', sopUid)
  }

  insertInstance(seriesId: number, i: InstanceInsert): void {
    this.run(
      `INSERT OR IGNORE INTO instances (series_id, sop_uid, sop_class, instance_number, frames, ipp, iop,
        slice_location, for_uid, rows, cols, rel_path) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      seriesId, i.sopUid, i.sopClass, i.instanceNumber, i.frames, i.ipp, i.iop, i.sliceLocation,
      i.forUid, i.rows, i.cols, i.relPath
    )
  }

  /** Recompute image/series counts and the modality list after an import. */
  refreshStudyCounts(studyId: number): void {
    this.run(
      `UPDATE series SET
         num_images = (SELECT COUNT(*) FROM instances WHERE series_id = series.id),
         num_frames = (SELECT COALESCE(SUM(frames),0) FROM instances WHERE series_id = series.id)
       WHERE study_id = ?`,
      studyId
    )
    const mods = this.all(
      `SELECT modality, MAX(is_image) AS img, SUM(num_images) AS n FROM series WHERE study_id = ?
       GROUP BY modality ORDER BY img DESC, n DESC`,
      studyId
    )
      .map((r) => str(r.modality))
      .filter(Boolean)
    this.run(
      `UPDATE studies SET
         num_series = (SELECT COUNT(*) FROM series WHERE study_id = studies.id),
         num_images = (SELECT COALESCE(SUM(num_images),0) FROM series WHERE study_id = studies.id),
         modalities = ?
       WHERE id = ?`,
      mods.join('\\'),
      studyId
    )
  }

  listStudies(f: StudyFilter): StudyRow[] {
    const where: string[] = []
    const params: SqlValue[] = []
    const text = (f.text ?? '').trim()
    if (text) {
      const like = `%${text}%`
      where.push('(s.patient_name LIKE ? OR s.patient_id LIKE ? OR s.accession LIKE ? OR s.description LIKE ?)')
      params.push(like, like, like, like)
    }
    if (f.modality) {
      where.push("('\\' || s.modalities || '\\') LIKE ?")
      params.push(`%\\${f.modality}\\%`)
    }
    if (f.status === 'UNREPORTED') {
      where.push("s.report_status IN ('NEW','DRAFT','PRELIMINARY')")
    } else if (f.status) {
      where.push('s.report_status = ?')
      params.push(f.status)
    }
    if (f.dateFrom) {
      where.push('s.study_date >= ?')
      params.push(f.dateFrom)
    }
    if (f.dateTo) {
      where.push('s.study_date <= ?')
      params.push(f.dateTo)
    }
    if (f.reportText?.trim()) {
      where.push('r.text LIKE ?')
      params.push(`%${f.reportText.trim()}%`)
    }
    const sql = `SELECT s.*, r.updated_at AS report_updated_at FROM studies s
      LEFT JOIN reports r ON r.study_id = s.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.study_date DESC, s.study_time DESC, s.id DESC
      LIMIT ?`
    params.push(f.limit ?? 2000)
    return this.all(sql, ...params).map(mapStudy)
  }

  getStudy(id: number): StudyRow | null {
    const r = this.get(
      `SELECT s.*, r.updated_at AS report_updated_at FROM studies s
       LEFT JOIN reports r ON r.study_id = s.id WHERE s.id = ?`,
      id
    )
    return r ? mapStudy(r) : null
  }

  getSeriesForStudy(studyId: number): SeriesRow[] {
    return this.all(
      `SELECT * FROM series WHERE study_id = ?
       ORDER BY is_image DESC, CASE WHEN number IS NULL THEN 1 ELSE 0 END, number, id`,
      studyId
    ).map(mapSeries)
  }

  getSeries(id: number): SeriesRow | null {
    const r = this.get('SELECT * FROM series WHERE id = ?', id)
    return r ? mapSeries(r) : null
  }

  /** Other studies of the same patient (same non-empty Patient ID), newest first. */
  getPriors(studyId: number): StudyRow[] {
    const s = this.getStudy(studyId)
    if (!s || !s.patientId) return []
    return this.all(
      `SELECT s.*, r.updated_at AS report_updated_at FROM studies s
       LEFT JOIN reports r ON r.study_id = s.id
       WHERE s.patient_id = ? AND s.id != ?
       ORDER BY s.study_date DESC, s.study_time DESC`,
      s.patientId,
      studyId
    ).map(mapStudy)
  }

  updateStudy(id: number, patch: { visitType?: string; clinicalHistory?: string; referring?: string }): void {
    if (patch.visitType !== undefined) this.run('UPDATE studies SET visit_type = ? WHERE id = ?', patch.visitType, id)
    if (patch.clinicalHistory !== undefined)
      this.run('UPDATE studies SET clinical_history = ? WHERE id = ?', patch.clinicalHistory, id)
    if (patch.referring !== undefined) this.run('UPDATE studies SET referring = ? WHERE id = ?', patch.referring, id)
  }

  getStudyFolder(id: number): string | null {
    const r = this.get('SELECT folder FROM studies WHERE id = ?', id)
    return r ? str(r.folder) : null
  }

  getInstancePathsForStudy(id: number): string[] {
    return this.all(
      `SELECT i.rel_path FROM instances i JOIN series se ON se.id = i.series_id WHERE se.study_id = ?`,
      id
    ).map((r) => str(r.rel_path))
  }

  deleteStudy(id: number): void {
    this.run('DELETE FROM studies WHERE id = ?', id)
  }

  getInstances(seriesId: number): InstanceRow[] {
    return this.all('SELECT * FROM instances WHERE series_id = ?', seriesId).map((r) => ({
      id: num(r.id),
      sopUid: str(r.sop_uid),
      sopClass: str(r.sop_class),
      instanceNumber: r.instance_number == null ? null : num(r.instance_number),
      frames: num(r.frames) || 1,
      ipp: str(r.ipp),
      iop: str(r.iop),
      sliceLocation: r.slice_location == null ? null : num(r.slice_location),
      forUid: str(r.for_uid),
      rows: num(r.rows),
      cols: num(r.cols),
      relPath: str(r.rel_path)
    }))
  }

  setSeriesThumb(seriesId: number, dataUrl: string): void {
    this.run('UPDATE series SET thumb = ? WHERE id = ?', dataUrl, seriesId)
  }

  counts(): { studies: number; series: number; images: number; reports: number } {
    const c = (sql: string) => num((this.get(sql) as Row).n)
    return {
      studies: c('SELECT COUNT(*) AS n FROM studies'),
      series: c('SELECT COUNT(*) AS n FROM series'),
      images: c('SELECT COUNT(*) AS n FROM instances'),
      reports: c('SELECT COUNT(*) AS n FROM reports')
    }
  }

  // ---------------------------------------------------------------- reports

  getReport(studyId: number): Report | null {
    const r = this.get('SELECT * FROM reports WHERE study_id = ?', studyId)
    return r ? mapReport(r) : null
  }

  saveReport(input: ReportSaveInput): Report {
    const ts = now()
    const existing = this.getReport(input.studyId)
    const signedAt = input.status === 'FINAL' ? ts : null
    return this.transaction(() => {
      let reportId: number
      if (existing) {
        this.run(
          `UPDATE reports SET status = ?, html = ?, text = ?, modality = ?, procedure = ?, radiologist = ?,
             template_name = ?, updated_at = ?, signed_at = ? WHERE id = ?`,
          input.status, input.html, input.text, input.modality, input.procedure, input.radiologist,
          input.templateName, ts, signedAt, existing.id
        )
        reportId = existing.id
      } else {
        reportId = this.run(
          `INSERT INTO reports (study_id, status, html, text, modality, procedure, radiologist, template_name,
             created_at, updated_at, signed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          input.studyId, input.status, input.html, input.text, input.modality, input.procedure,
          input.radiologist, input.templateName, ts, ts, signedAt
        )
      }
      // Keep a version history, but do not store identical consecutive versions.
      const last = this.get(
        'SELECT html, status FROM report_versions WHERE report_id = ? ORDER BY id DESC LIMIT 1',
        reportId
      )
      if (!last || str(last.html) !== input.html || str(last.status) !== input.status) {
        this.run(
          'INSERT INTO report_versions (report_id, status, html, saved_at) VALUES (?,?,?,?)',
          reportId, input.status, input.html, ts
        )
      }
      this.run('UPDATE studies SET report_status = ? WHERE id = ?', input.status, input.studyId)
      return mapReport(this.get('SELECT * FROM reports WHERE id = ?', reportId) as Row)
    })
  }

  listReportVersions(studyId: number): ReportVersion[] {
    return this.all(
      `SELECT v.* FROM report_versions v JOIN reports r ON r.id = v.report_id
       WHERE r.study_id = ? ORDER BY v.id DESC LIMIT 200`,
      studyId
    ).map((r) => ({
      id: num(r.id),
      reportId: num(r.report_id),
      status: str(r.status) as ReportStatus,
      html: str(r.html),
      savedAt: str(r.saved_at)
    }))
  }

  // ---------------------------------------------------------------- templates & macros

  listTemplates(): Template[] {
    return this.all('SELECT * FROM templates ORDER BY modality, name COLLATE NOCASE').map(mapTemplate)
  }

  templateCount(): number {
    return num((this.get('SELECT COUNT(*) AS n FROM templates') as Row).n)
  }

  saveTemplate(t: { id?: number; name: string; modality: string; html: string; mine: boolean }): Template {
    const ts = now()
    let id = t.id
    if (id) {
      this.run(
        'UPDATE templates SET name = ?, modality = ?, html = ?, mine = ?, updated_at = ? WHERE id = ?',
        t.name, t.modality, t.html, t.mine ? 1 : 0, ts, id
      )
    } else {
      id = this.run(
        'INSERT INTO templates (name, modality, html, mine, updated_at) VALUES (?,?,?,?,?)',
        t.name, t.modality, t.html, t.mine ? 1 : 0, ts
      )
    }
    return mapTemplate(this.get('SELECT * FROM templates WHERE id = ?', id) as Row)
  }

  deleteTemplate(id: number): void {
    this.run('DELETE FROM templates WHERE id = ?', id)
  }

  listMacros(): Macro[] {
    return this.all('SELECT * FROM macros ORDER BY code COLLATE NOCASE').map((r) => ({
      id: num(r.id),
      code: str(r.code),
      text: str(r.text)
    }))
  }

  macroCount(): number {
    return num((this.get('SELECT COUNT(*) AS n FROM macros') as Row).n)
  }

  saveMacro(m: { id?: number; code: string; text: string }): Macro {
    let id = m.id
    if (id) {
      this.run('UPDATE macros SET code = ?, text = ? WHERE id = ?', m.code, m.text, id)
    } else {
      id = this.run('INSERT INTO macros (code, text) VALUES (?, ?)', m.code, m.text)
    }
    const r = this.get('SELECT * FROM macros WHERE id = ?', id) as Row
    return { id: num(r.id), code: str(r.code), text: str(r.text) }
  }

  deleteMacro(id: number): void {
    this.run('DELETE FROM macros WHERE id = ?', id)
  }

  // ---------------------------------------------------------------- settings

  getSettings(): Settings {
    const r = this.get("SELECT value FROM settings WHERE key = 'app'")
    if (!r) return { ...DEFAULT_SETTINGS }
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(str(r.value)) as Partial<Settings>) }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  saveSettings(s: Settings): Settings {
    const merged = { ...DEFAULT_SETTINGS, ...s }
    this.run(
      "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(merged)
    )
    return merged
  }
}
