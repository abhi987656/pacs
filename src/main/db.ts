import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  Macro,
  ManualStudyInput,
  PhoneDevice,
  PullRequest,
  PullResponse,
  PushMacro,
  PushReport,
  PushResult,
  PushStudy,
  PushTemplate,
  ReceivedShareInfo,
  Report,
  ReportSaveInput,
  ReportStatus,
  ReportVersion,
  SecondOpinion,
  SeriesRow,
  Settings,
  StudyFilter,
  StudyRow,
  SyncMacro,
  SyncReport,
  SyncSettings,
  SyncStudy,
  SyncTemplate,
  Template
} from '@shared/types'
import { DEFAULT_SETTINGS, SYNC_SETTING_KEYS } from '@shared/types'

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
    clinicalHistory: str(r.clinical_history),
    manual: num(r.manual) === 1,
    sharedFrom: r.shared_from == null ? null : str(r.shared_from)
  }
}

const SHARED_FROM = `(SELECT rs.sender_name FROM received_shares rs WHERE rs.study_id = s.id ORDER BY rs.received_at DESC LIMIT 1) AS shared_from`

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

function mapSyncStudy(r: Row): Omit<SyncStudy, 'listed'> {
  return {
    syncId: str(r.sync_id),
    patientName: str(r.patient_name),
    patientId: str(r.patient_id),
    accession: str(r.accession),
    sex: str(r.sex),
    age: str(r.age),
    birthDate: str(r.birth_date),
    description: str(r.description),
    modalities: str(r.modalities),
    studyDate: str(r.study_date),
    studyTime: str(r.study_time),
    referring: str(r.referring),
    visitType: str(r.visit_type),
    clinicalHistory: str(r.clinical_history),
    institution: str(r.institution),
    numImages: num(r.num_images),
    manual: num(r.manual) === 1,
    reportStatus: (str(r.report_status) || 'NEW') as ReportStatus,
    importedAt: str(r.imported_at),
    modifiedAt: str(r.modified_at),
    rev: num(r.rev)
  }
}

function mapSyncReport(r: Row): SyncReport {
  return {
    studySyncId: str(r.study_sync_id),
    status: str(r.status) as ReportStatus,
    html: str(r.html),
    text: str(r.text),
    modality: str(r.modality),
    procedure: str(r.procedure),
    radiologist: str(r.radiologist),
    templateName: str(r.template_name),
    updatedAt: str(r.updated_at),
    signedAt: r.signed_at == null ? null : str(r.signed_at),
    rev: num(r.rev)
  }
}

export function syncSettingsOf(s: Settings): SyncSettings {
  const out: Record<string, unknown> = {}
  for (const k of SYNC_SETTING_KEYS) out[k] = s[k]
  return out as unknown as SyncSettings
}

/** A timestamp from the phone, clamped so a wrong phone clock cannot claim to be in the future. */
function saneTime(iso: string): string {
  const t = Date.parse(iso)
  const nowMs = Date.now()
  if (!Number.isFinite(t) || t > nowMs + 5 * 60000) return new Date(nowMs).toISOString()
  return new Date(t).toISOString()
}

export interface ShareRow {
  id: string
  studyId: number
  code: string
  anonymize: boolean
  allowReply: boolean
  pseudoId: string
  createdAt: string
  expiresAt: string
  stoppedAt: string | null
  downloads: number
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
    if (v < 2) {
      // Cases created by hand (reporting without images).
      this.db.exec('ALTER TABLE studies ADD COLUMN manual INTEGER NOT NULL DEFAULT 0')
      this.db.exec('PRAGMA user_version = 2')
    }
    if (v < 3) this.transaction(() => this.migrateV3())
    if (v < 4) this.transaction(() => this.migrateV4())
    if (v < 5) this.transaction(() => this.migrateV5())
    if (v < 6) this.transaction(() => this.migrateV6())
  }

  /** Liver analyses (volumetry) saved from the viewer, per study and series. */
  private migrateV6(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS liver_analysis (
        study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
        series_uid TEXT NOT NULL,
        json TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        PRIMARY KEY (study_id, series_uid)
      );
    `)
    this.db.exec('PRAGMA user_version = 6')
  }

  /** Measurements and labels saved from the viewer (V), per study. */
  private migrateV5(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS annotations (
        study_id INTEGER PRIMARY KEY REFERENCES studies(id) ON DELETE CASCADE,
        json TEXT NOT NULL,
        saved_at TEXT NOT NULL
      );
    `)
    this.db.exec('PRAGMA user_version = 5')
  }

  /** Case sharing with other Personal PACS users (sender and receiver side). */
  private migrateV4(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        id TEXT PRIMARY KEY,
        study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        anonymize INTEGER NOT NULL DEFAULT 0,
        allow_reply INTEGER NOT NULL DEFAULT 1,
        pseudo_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        stopped_at TEXT,
        closed_at TEXT,
        downloads INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS received_shares (
        id TEXT PRIMARY KEY,
        study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
        code TEXT NOT NULL,
        relay_url TEXT NOT NULL DEFAULT '',
        sender_name TEXT NOT NULL DEFAULT '',
        allow_reply INTEGER NOT NULL DEFAULT 0,
        anonymized INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT NOT NULL DEFAULT '',
        received_at TEXT NOT NULL,
        replied_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_received_study ON received_shares(study_id);
      CREATE TABLE IF NOT EXISTS second_opinions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        study_id INTEGER NOT NULL REFERENCES studies(id) ON DELETE CASCADE,
        from_name TEXT NOT NULL DEFAULT '',
        from_designation TEXT NOT NULL DEFAULT '',
        reply_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'DRAFT',
        html TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL DEFAULT '',
        received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_opinions_study ON second_opinions(study_id);
    `)
    this.db.exec('PRAGMA user_version = 4')
  }

  /**
   * Phone app sync: every case/template/macro gets a permanent sync id, and every change bumps a
   * global revision number (via triggers, so no write path can forget it). The phone asks for
   * "everything changed since revision N". Deleted templates/macros/cases leave a tombstone.
   */
  private migrateV3(): void {
    this.db.exec(`
      ALTER TABLE studies ADD COLUMN sync_id TEXT;
      ALTER TABLE studies ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE studies ADD COLUMN modified_at TEXT NOT NULL DEFAULT '';
      ALTER TABLE reports ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE report_versions ADD COLUMN note TEXT NOT NULL DEFAULT '';
      ALTER TABLE templates ADD COLUMN sync_id TEXT;
      ALTER TABLE templates ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE macros ADD COLUMN sync_id TEXT;
      ALTER TABLE macros ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE macros ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        rev INTEGER NOT NULL DEFAULT 1,
        settings_rev INTEGER NOT NULL DEFAULT 1
      );
      INSERT OR IGNORE INTO sync_state (id, rev, settings_rev) VALUES (1, 1, 1);
      CREATE TABLE IF NOT EXISTS tombstones (
        kind TEXT NOT NULL,
        sync_id TEXT NOT NULL,
        rev INTEGER NOT NULL,
        deleted_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (kind, sync_id)
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen TEXT,
        last_ip TEXT
      );
    `)
    const ts = now()
    for (const table of ['studies', 'templates', 'macros']) {
      for (const r of this.all(`SELECT id FROM ${table} WHERE sync_id IS NULL`)) {
        this.run(`UPDATE ${table} SET sync_id = ? WHERE id = ?`, randomUUID(), num(r.id))
      }
    }
    this.db.exec(`
      UPDATE studies SET rev = 1;
      UPDATE reports SET rev = 1;
      UPDATE templates SET rev = 1;
      UPDATE macros SET rev = 1, updated_at = '${ts}';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_studies_sync ON studies(sync_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_sync ON templates(sync_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_macros_sync ON macros(sync_id);
      CREATE INDEX IF NOT EXISTS idx_studies_rev ON studies(rev);
      CREATE INDEX IF NOT EXISTS idx_reports_rev ON reports(rev);
    `)
    const uuidSql = `lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
      substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) ||
      substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))`
    const bump = 'UPDATE sync_state SET rev = rev + 1 WHERE id = 1;'
    const cur = '(SELECT rev FROM sync_state WHERE id = 1)'
    for (const [table, kind] of [['studies', 'study'], ['templates', 'template'], ['macros', 'macro']]) {
      this.db.exec(`
        CREATE TRIGGER trg_${table}_ins AFTER INSERT ON ${table} BEGIN
          ${bump}
          UPDATE ${table} SET rev = ${cur}, sync_id = COALESCE(NEW.sync_id, ${uuidSql}) WHERE id = NEW.id;
          DELETE FROM tombstones WHERE kind = '${kind}' AND sync_id = NEW.sync_id;
        END;
        CREATE TRIGGER trg_${table}_upd AFTER UPDATE ON ${table} WHEN NEW.rev = OLD.rev BEGIN
          ${bump}
          UPDATE ${table} SET rev = ${cur} WHERE id = NEW.id;
        END;
        CREATE TRIGGER trg_${table}_del AFTER DELETE ON ${table} WHEN OLD.sync_id IS NOT NULL BEGIN
          ${bump}
          INSERT OR REPLACE INTO tombstones (kind, sync_id, rev, deleted_at)
            VALUES ('${kind}', OLD.sync_id, ${cur}, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
        END;
      `)
    }
    this.db.exec(`
      CREATE TRIGGER trg_reports_ins AFTER INSERT ON reports BEGIN
        ${bump}
        UPDATE reports SET rev = ${cur} WHERE id = NEW.id;
      END;
      CREATE TRIGGER trg_reports_upd AFTER UPDATE ON reports WHEN NEW.rev = OLD.rev BEGIN
        ${bump}
        UPDATE reports SET rev = ${cur} WHERE id = NEW.id;
      END;
    `)
    this.db.exec('PRAGMA user_version = 3')
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
    const sql = `SELECT s.*, r.updated_at AS report_updated_at, ${SHARED_FROM} FROM studies s
      LEFT JOIN reports r ON r.study_id = s.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.study_date DESC, s.study_time DESC, s.id DESC
      LIMIT ?`
    params.push(f.limit ?? 2000)
    return this.all(sql, ...params).map(mapStudy)
  }

  getStudy(id: number): StudyRow | null {
    const r = this.get(
      `SELECT s.*, r.updated_at AS report_updated_at, ${SHARED_FROM} FROM studies s
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
      `SELECT s.*, r.updated_at AS report_updated_at, ${SHARED_FROM} FROM studies s
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
    if (Object.keys(patch).length) this.run('UPDATE studies SET modified_at = ? WHERE id = ?', now(), id)
  }

  /** Creates a case without images so it can be reported straight away. */
  createManualStudy(m: ManualStudyInput, opts: { syncId?: string; modifiedAt?: string } = {}): number {
    const syncId = opts.syncId ?? randomUUID()
    const ts = now()
    return this.run(
      `INSERT INTO studies (study_uid, sync_id, patient_id, patient_name, patient_name_raw, birth_date, sex, age, study_date,
        study_time, description, accession, referring, modalities, imported_at, visit_type, clinical_history, manual,
        modified_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      `manual-${syncId}`, syncId, m.patientId, m.patientName, m.patientName, m.birthDate, m.sex, m.age, m.studyDate,
      m.studyTime, m.description, m.accession, m.referring, m.modality, ts, m.visitType, m.clinicalHistory,
      opts.modifiedAt ?? ts
    )
  }

  /** Corrects patient / study details (stored in this app only – the DICOM files are not changed). */
  updateStudyDetails(id: number, m: Partial<ManualStudyInput>, modifiedAt: string = now()): void {
    const cols: [keyof ManualStudyInput, string][] = [
      ['patientName', 'patient_name'],
      ['patientId', 'patient_id'],
      ['accession', 'accession'],
      ['sex', 'sex'],
      ['age', 'age'],
      ['birthDate', 'birth_date'],
      ['description', 'description'],
      ['modality', 'modalities'],
      ['studyDate', 'study_date'],
      ['studyTime', 'study_time'],
      ['referring', 'referring'],
      ['visitType', 'visit_type'],
      ['clinicalHistory', 'clinical_history']
    ]
    let changed = false
    for (const [key, col] of cols) {
      const v = m[key]
      if (typeof v === 'string') {
        this.run(`UPDATE studies SET ${col} = ? WHERE id = ?`, v, id)
        changed = true
      }
    }
    if (changed) this.run('UPDATE studies SET modified_at = ? WHERE id = ?', modifiedAt, id)
  }

  /** A hand-made case (no images yet) with this accession number, for attaching imported images. */
  findManualStudyFor(accession: string, patientId: string): number | null {
    if (!accession.trim()) return null
    const r = this.get(
      `SELECT s.id FROM studies s WHERE s.manual = 1 AND UPPER(TRIM(s.accession)) = UPPER(TRIM(?))
         AND (s.patient_id = '' OR ? = '' OR UPPER(TRIM(s.patient_id)) = UPPER(TRIM(?)))
         AND NOT EXISTS (SELECT 1 FROM series se WHERE se.study_id = s.id)
       ORDER BY s.id DESC LIMIT 1`,
      accession, patientId, patientId
    )
    return r ? num(r.id) : null
  }

  /** Turns a hand-made case into the imported study (keeps what the user typed). */
  adoptManualStudy(id: number, s: StudyInsert): void {
    this.run('UPDATE studies SET study_uid = ?, folder = ?, manual = 0 WHERE id = ?', s.studyUid, s.folder, id)
    this.fillStudyBlanks(id, s)
    this.run(
      `UPDATE studies SET
        study_date = CASE WHEN ? != '' THEN ? ELSE study_date END,
        study_time = CASE WHEN ? != '' THEN ? ELSE study_time END,
        institution = CASE WHEN institution = '' THEN ? ELSE institution END
       WHERE id = ?`,
      s.studyDate, s.studyDate, s.studyTime, s.studyTime, s.institution, id
    )
  }

  /** Latest demographics for a patient ID (used to pre-fill the New Case form). */
  findPatient(patientId: string): { patientName: string; sex: string; age: string; birthDate: string } | null {
    if (!patientId.trim()) return null
    const r = this.get(
      `SELECT patient_name, sex, age, birth_date, study_date FROM studies WHERE UPPER(TRIM(patient_id)) = UPPER(TRIM(?))
       ORDER BY study_date DESC, id DESC LIMIT 1`,
      patientId
    )
    return r ? { patientName: str(r.patient_name), sex: str(r.sex), age: str(r.age), birthDate: str(r.birth_date) } : null
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

  getAnnotations(studyId: number): string | null {
    const r = this.get('SELECT json FROM annotations WHERE study_id = ?', studyId) as Row | undefined
    return r ? str(r.json) : null
  }

  getLiverAnalysis(studyId: number, seriesUid: string): string | null {
    const r = this.get('SELECT json FROM liver_analysis WHERE study_id = ? AND series_uid = ?', studyId, seriesUid) as Row | undefined
    return r ? str(r.json) : null
  }

  saveLiverAnalysis(studyId: number, seriesUid: string, json: string): void {
    this.run(
      `INSERT INTO liver_analysis (study_id, series_uid, json, saved_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(study_id, series_uid) DO UPDATE SET json = excluded.json, saved_at = excluded.saved_at`,
      studyId,
      seriesUid,
      json,
      new Date().toISOString()
    )
  }

  /** null = nothing saved any more. */
  saveAnnotations(studyId: number, json: string | null): void {
    if (json == null) this.run('DELETE FROM annotations WHERE study_id = ?', studyId)
    else {
      this.run(
        `INSERT INTO annotations (study_id, json, saved_at) VALUES (?, ?, ?)
         ON CONFLICT(study_id) DO UPDATE SET json = excluded.json, saved_at = excluded.saved_at`,
        studyId,
        json,
        new Date().toISOString()
      )
    }
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
      savedAt: str(r.saved_at),
      note: str(r.note)
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
        'INSERT INTO templates (sync_id, name, modality, html, mine, updated_at) VALUES (?,?,?,?,?,?)',
        randomUUID(), t.name, t.modality, t.html, t.mine ? 1 : 0, ts
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
      this.run('UPDATE macros SET code = ?, text = ?, updated_at = ? WHERE id = ?', m.code, m.text, now(), id)
    } else {
      id = this.run('INSERT INTO macros (sync_id, code, text, updated_at) VALUES (?, ?, ?, ?)', randomUUID(), m.code, m.text, now())
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
    const before = JSON.stringify(syncSettingsOf(this.getSettings()))
    const merged = { ...DEFAULT_SETTINGS, ...s }
    this.run(
      "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      JSON.stringify(merged)
    )
    if (JSON.stringify(syncSettingsOf(merged)) !== before) {
      this.run('UPDATE sync_state SET rev = rev + 1, settings_rev = rev + 1 WHERE id = 1')
    }
    return merged
  }

  /** Small JSON values stored next to the settings (phone link configuration …). */
  getKv<T>(key: string): T | null {
    const r = this.get('SELECT value FROM settings WHERE key = ?', key)
    if (!r) return null
    try {
      return JSON.parse(str(r.value)) as T
    } catch {
      return null
    }
  }

  setKv(key: string, value: unknown): void {
    this.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      JSON.stringify(value)
    )
  }

  // ---------------------------------------------------------------- case sharing

  insertShare(r: { id: string; studyId: number; code: string; anonymize: boolean; allowReply: boolean; pseudoId: string; expiresAt: string }): void {
    this.run(
      `INSERT OR REPLACE INTO shares (id, study_id, code, anonymize, allow_reply, pseudo_id, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      r.id, r.studyId, r.code, r.anonymize ? 1 : 0, r.allowReply ? 1 : 0, r.pseudoId, now(), r.expiresAt
    )
  }

  /** Shares that are not closed and were made in the last `days` days (downloads may have ended). */
  listShareRows(days: number): ShareRow[] {
    const rows = this.all(
      'SELECT * FROM shares WHERE closed_at IS NULL AND created_at > ? ORDER BY created_at DESC',
      new Date(Date.now() - days * 86400000).toISOString()
    )
    return rows.map((r) => ({
      id: str(r.id),
      studyId: num(r.study_id),
      code: str(r.code),
      anonymize: num(r.anonymize) === 1,
      allowReply: num(r.allow_reply) === 1,
      pseudoId: str(r.pseudo_id),
      createdAt: str(r.created_at),
      expiresAt: str(r.expires_at),
      stoppedAt: r.stopped_at == null ? null : str(r.stopped_at),
      downloads: num(r.downloads)
    }))
  }

  /** Stops downloads (replies are still accepted). */
  stopShare(id: string): void {
    this.run('UPDATE shares SET stopped_at = COALESCE(stopped_at, ?) WHERE id = ?', now(), id)
  }

  /** Ends a share completely (no downloads, no replies). */
  closeShare(id: string): void {
    const ts = now()
    this.run('UPDATE shares SET stopped_at = COALESCE(stopped_at, ?), closed_at = COALESCE(closed_at, ?) WHERE id = ?', ts, ts, id)
  }

  countShareDownload(id: string): void {
    this.run('UPDATE shares SET downloads = downloads + 1 WHERE id = ?', id)
  }

  saveReceivedShare(r: Omit<ReceivedShareInfo, 'receivedAt' | 'repliedAt'> & { code: string; relayUrl: string }): void {
    this.run(
      `INSERT INTO received_shares (id, study_id, code, relay_url, sender_name, allow_reply, anonymized, expires_at, received_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET study_id = excluded.study_id, relay_url = excluded.relay_url,
         sender_name = excluded.sender_name, expires_at = excluded.expires_at, received_at = excluded.received_at`,
      r.id, r.studyId, r.code, r.relayUrl, r.senderName, r.allowReply ? 1 : 0, r.anonymized ? 1 : 0, r.replyUntil, now()
    )
  }

  receivedForStudy(studyId: number): (ReceivedShareInfo & { code: string; relayUrl: string }) | null {
    // Prefer a share that still accepts a report back (the same case may have been received twice).
    const r = this.get(
      `SELECT * FROM received_shares WHERE study_id = ?
       ORDER BY (allow_reply = 1 AND expires_at > ?) DESC, received_at DESC LIMIT 1`,
      studyId,
      now()
    )
    if (!r) return null
    return {
      id: str(r.id),
      studyId: num(r.study_id),
      code: str(r.code),
      relayUrl: str(r.relay_url),
      senderName: str(r.sender_name),
      allowReply: num(r.allow_reply) === 1,
      anonymized: num(r.anonymized) === 1,
      replyUntil: str(r.expires_at),
      receivedAt: str(r.received_at),
      repliedAt: r.replied_at == null ? null : str(r.replied_at)
    }
  }

  findReceivedShare(id: string): { studyId: number } | null {
    const r = this.get('SELECT rs.study_id FROM received_shares rs JOIN studies s ON s.id = rs.study_id WHERE rs.id = ?', id)
    return r ? { studyId: num(r.study_id) } : null
  }

  markReplied(id: string, relayUrl?: string): void {
    this.run('UPDATE received_shares SET replied_at = ? WHERE id = ?', now(), id)
    if (relayUrl) this.run('UPDATE received_shares SET relay_url = ? WHERE id = ?', relayUrl, id)
  }

  /** A report sent back by the person a case was shared with. Also kept in the report's History. */
  addSecondOpinion(
    studyId: number,
    o: { replyId: string; fromName: string; fromDesignation: string; status: ReportStatus; html: string; text: string }
  ): boolean {
    if (o.replyId && this.get('SELECT 1 AS x FROM second_opinions WHERE reply_id = ?', o.replyId)) return false // sent twice
    const ts = now()
    this.run(
      `INSERT INTO second_opinions (study_id, from_name, from_designation, reply_id, status, html, text, received_at) VALUES (?,?,?,?,?,?,?,?)`,
      studyId, o.fromName, o.fromDesignation, o.replyId, o.status, o.html, o.text, ts
    )
    const rep = this.get('SELECT id FROM reports WHERE study_id = ?', studyId)
    if (rep) {
      this.run(
        'INSERT INTO report_versions (report_id, status, html, saved_at, note) VALUES (?,?,?,?,?)',
        num(rep.id), o.status, o.html, ts, `Second opinion from ${o.fromName || 'a colleague'}`
      )
    }
    return true
  }

  listSecondOpinions(studyId: number): SecondOpinion[] {
    return this.all('SELECT * FROM second_opinions WHERE study_id = ? ORDER BY id DESC', studyId).map((r) => ({
      id: num(r.id),
      studyId: num(r.study_id),
      fromName: str(r.from_name),
      fromDesignation: str(r.from_designation),
      status: str(r.status) as ReportStatus,
      html: str(r.html),
      text: str(r.text),
      receivedAt: str(r.received_at)
    }))
  }

  countSecondOpinions(studyId: number): number {
    return num((this.get('SELECT COUNT(*) AS n FROM second_opinions WHERE study_id = ?', studyId) as Row).n)
  }

  /** Labels the newest saved version (e.g. "Received from …"). */
  noteLatestVersion(studyId: number, note: string): void {
    this.run(
      `UPDATE report_versions SET note = ? WHERE id = (SELECT MAX(v.id) FROM report_versions v JOIN reports r ON r.id = v.report_id WHERE r.study_id = ?)`,
      note, studyId
    )
  }

  /** Adds a version note without changing the report (e.g. "Received from …"). */
  addReportVersionNote(studyId: number, html: string, status: ReportStatus, note: string): void {
    const rep = this.get('SELECT id FROM reports WHERE study_id = ?', studyId)
    if (rep) this.run('INSERT INTO report_versions (report_id, status, html, saved_at, note) VALUES (?,?,?,?,?)', num(rep.id), status, html, now(), note)
  }

  // ---------------------------------------------------------------- paired phones

  listDevices(): (PhoneDevice & { key: string })[] {
    return this.all('SELECT * FROM devices ORDER BY created_at').map((r) => ({
      id: str(r.id),
      name: str(r.name),
      key: str(r.key),
      createdAt: str(r.created_at),
      lastSeen: r.last_seen == null ? null : str(r.last_seen),
      lastIp: r.last_ip == null ? null : str(r.last_ip)
    }))
  }

  addDevice(d: { id: string; name: string; key: string }): void {
    this.run(
      `INSERT INTO devices (id, name, key, created_at) VALUES (?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, key = excluded.key`,
      d.id, d.name, d.key, now()
    )
  }

  removeDevice(id: string): void {
    this.run('DELETE FROM devices WHERE id = ?', id)
  }

  touchDevice(id: string, ip: string): void {
    this.run('UPDATE devices SET last_seen = ?, last_ip = ? WHERE id = ?', now(), ip, id)
  }

  // ---------------------------------------------------------------- phone sync

  syncRev(): number {
    return num((this.get('SELECT rev FROM sync_state WHERE id = 1') as Row | undefined)?.rev)
  }

  /**
   * Cases the phone keeps: everything not yet signed off, plus anything from (or touched in) the
   * last 30 days, plus older studies of those patients (for "previous reports").
   */
  private phoneScope(days = 30): { listed: Set<string>; all: string[] } {
    const cutoff = new Date(Date.now() - days * 86400000)
    const cutoffIso = cutoff.toISOString()
    const cutoffDate = `${cutoff.getFullYear()}${String(cutoff.getMonth() + 1).padStart(2, '0')}${String(cutoff.getDate()).padStart(2, '0')}`
    const listedRows = this.all(
      `SELECT s.sync_id, s.patient_id FROM studies s LEFT JOIN reports r ON r.study_id = s.id
       WHERE s.report_status != 'FINAL' OR s.study_date >= ? OR s.imported_at >= ?
          OR COALESCE(r.updated_at, '') >= ? OR s.modified_at >= ?`,
      cutoffDate, cutoffIso, cutoffIso, cutoffIso
    )
    const listed = new Set(listedRows.map((r) => str(r.sync_id)))
    const pids = [...new Set(listedRows.map((r) => str(r.patient_id).trim()).filter(Boolean))]
    const all = [...listed]
    if (pids.length) {
      for (const r of this.all(
        'SELECT sync_id FROM studies WHERE TRIM(patient_id) IN (SELECT value FROM json_each(?))',
        JSON.stringify(pids)
      )) {
        const id = str(r.sync_id)
        if (!listed.has(id)) all.push(id)
      }
    }
    return { listed, all }
  }

  syncPull(req: PullRequest): Omit<PullResponse, 'pcId' | 'pcName'> {
    const rev = this.syncRev()
    const since = req.since > rev ? 0 : Math.max(0, Math.floor(req.since))
    const { listed, all } = this.phoneScope()
    const scopeJson = JSON.stringify(all)
    const haveJson = JSON.stringify(Array.isArray(req.have) ? req.have.filter((x) => typeof x === 'string') : [])
    const studies: SyncStudy[] = this.all(
      `SELECT s.* FROM studies s
       WHERE s.sync_id IN (SELECT value FROM json_each(?))
         AND (s.rev > ? OR s.sync_id NOT IN (SELECT value FROM json_each(?)))`,
      scopeJson, since, haveJson
    ).map((r) => ({ ...mapSyncStudy(r), listed: listed.has(str(r.sync_id)) }))
    const reports: SyncReport[] = this.all(
      `SELECT r.*, s.sync_id AS study_sync_id FROM reports r JOIN studies s ON s.id = r.study_id
       WHERE s.sync_id IN (SELECT value FROM json_each(?))
         AND (r.rev > ? OR s.sync_id NOT IN (SELECT value FROM json_each(?)))`,
      scopeJson, since, haveJson
    ).map(mapSyncReport)
    const templates: SyncTemplate[] = this.all('SELECT * FROM templates WHERE rev > ?', since).map((r) => ({
      syncId: str(r.sync_id),
      name: str(r.name),
      modality: str(r.modality),
      html: str(r.html),
      mine: num(r.mine) === 1,
      updatedAt: str(r.updated_at),
      rev: num(r.rev)
    }))
    const macros: SyncMacro[] = this.all('SELECT * FROM macros WHERE rev > ?', since).map((r) => ({
      syncId: str(r.sync_id),
      code: str(r.code),
      text: str(r.text),
      updatedAt: str(r.updated_at),
      rev: num(r.rev)
    }))
    const deleted = { studies: [] as string[], templates: [] as string[], macros: [] as string[] }
    if (since > 0) {
      for (const t of this.all('SELECT kind, sync_id FROM tombstones WHERE rev > ?', since)) {
        const k = str(t.kind)
        if (k === 'study') deleted.studies.push(str(t.sync_id))
        else if (k === 'template') deleted.templates.push(str(t.sync_id))
        else if (k === 'macro') deleted.macros.push(str(t.sync_id))
      }
    }
    const settingsRev = num((this.get('SELECT settings_rev FROM sync_state WHERE id = 1') as Row | undefined)?.settings_rev)
    const settings = since === 0 || settingsRev > since ? syncSettingsOf(this.getSettings()) : null
    return { rev, studies, reports, templates, macros, deleted, scope: all, settings }
  }

  /** Applies one case created or edited on the phone (newest edit wins). */
  applyPushStudy(p: PushStudy, fields: Partial<ManualStudyInput>): PushResult {
    const row = this.get('SELECT id, rev, modified_at FROM studies WHERE sync_id = ?', p.syncId)
    const editedAt = saneTime(p.modifiedAt)
    if (!row) {
      if (!p.isNew) return { kind: 'study', id: p.syncId, outcome: 'missing', message: 'This case was deleted on the PC.' }
      if (!fields.patientName) return { kind: 'study', id: p.syncId, outcome: 'rejected', message: 'Patient name is required.' }
      const full: ManualStudyInput = {
        patientName: '', patientId: '', accession: '', sex: '', age: '', birthDate: '', description: '', modality: 'CT',
        studyDate: '', studyTime: '', referring: '', visitType: '', clinicalHistory: '', ...fields
      }
      this.createManualStudy(full, { syncId: p.syncId, modifiedAt: editedAt })
      return { kind: 'study', id: p.syncId, outcome: 'applied' }
    }
    const pcEdited = str(row.modified_at)
    if (num(row.rev) > p.baseRev && pcEdited && pcEdited > editedAt) {
      return { kind: 'study', id: p.syncId, outcome: 'kept-pc', message: 'The details were changed later on the PC.' }
    }
    this.updateStudyDetails(num(row.id), fields, editedAt)
    return { kind: 'study', id: p.syncId, outcome: 'applied' }
  }

  /** Applies a report edited on the phone. Signed-off reports are never changed from the phone. */
  applyPushReport(p: PushReport, html: string, deviceName: string): PushResult & { studyId?: number } {
    const st = this.get('SELECT id FROM studies WHERE sync_id = ?', p.studySyncId)
    if (!st) return { kind: 'report', id: p.studySyncId, outcome: 'missing', message: 'This case was deleted on the PC.' }
    const studyId = num(st.id)
    const curRow = this.get('SELECT * FROM reports WHERE study_id = ?', studyId)
    const cur = curRow ? mapReport(curRow) : null
    const editedAt = saneTime(p.updatedAt)
    const keepInHistory = (note: string) => {
      if (cur && html !== cur.html) {
        this.run(
          'INSERT INTO report_versions (report_id, status, html, saved_at, note) VALUES (?,?,?,?,?)',
          cur.id, p.status, html, editedAt, note
        )
      }
    }
    if (cur?.status === 'FINAL') {
      keepInHistory(`From ${deviceName} – not applied, the report was already signed off`)
      return { kind: 'report', id: p.studySyncId, outcome: 'rejected', studyId, message: 'Already signed off on the PC; the phone version is kept in History.' }
    }
    if (cur && num(curRow?.rev) > p.baseRev && cur.updatedAt > editedAt) {
      keepInHistory(`From ${deviceName} – older than the PC version`)
      return { kind: 'report', id: p.studySyncId, outcome: 'kept-pc', studyId, message: 'The PC version was newer; the phone version is kept in History.' }
    }
    this.saveReportFrom(studyId, p, html, editedAt, `Saved on ${deviceName}`)
    return { kind: 'report', id: p.studySyncId, outcome: 'applied', studyId }
  }

  private saveReportFrom(studyId: number, p: PushReport, html: string, ts: string, note: string): void {
    const existing = this.get('SELECT id FROM reports WHERE study_id = ?', studyId)
    let reportId: number
    if (existing) {
      reportId = num(existing.id)
      this.run(
        `UPDATE reports SET status = ?, html = ?, text = ?, modality = ?, procedure = ?, radiologist = ?,
           template_name = ?, updated_at = ?, signed_at = NULL WHERE id = ?`,
        p.status, html, p.text, p.modality, p.procedure, p.radiologist, p.templateName, ts, reportId
      )
    } else {
      reportId = this.run(
        `INSERT INTO reports (study_id, status, html, text, modality, procedure, radiologist, template_name,
           created_at, updated_at, signed_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
        studyId, p.status, html, p.text, p.modality, p.procedure, p.radiologist, p.templateName, ts, ts
      )
    }
    this.run(
      'INSERT INTO report_versions (report_id, status, html, saved_at, note) VALUES (?,?,?,?,?)',
      reportId, p.status, html, ts, note
    )
    this.run('UPDATE studies SET report_status = ? WHERE id = ?', p.status, studyId)
  }

  applyPushTemplate(p: PushTemplate): PushResult {
    const row = this.get('SELECT id, rev, updated_at FROM templates WHERE sync_id = ?', p.syncId)
    const editedAt = saneTime(p.updatedAt)
    const pcNewer = row ? num(row.rev) > p.baseRev && str(row.updated_at) > editedAt : false
    if (p.deleted) {
      if (!row) return { kind: 'template', id: p.syncId, outcome: 'applied' }
      if (pcNewer) return { kind: 'template', id: p.syncId, outcome: 'kept-pc', message: 'Changed later on the PC.' }
      this.run('DELETE FROM templates WHERE id = ?', num(row.id))
      return { kind: 'template', id: p.syncId, outcome: 'applied' }
    }
    if (!row) {
      const tomb = this.get("SELECT deleted_at FROM tombstones WHERE kind = 'template' AND sync_id = ?", p.syncId)
      if (tomb && p.baseRev > 0 && str(tomb.deleted_at) > editedAt) {
        return { kind: 'template', id: p.syncId, outcome: 'kept-pc', message: 'Deleted later on the PC.' }
      }
      this.run(
        'INSERT INTO templates (sync_id, name, modality, html, mine, updated_at) VALUES (?,?,?,?,?,?)',
        p.syncId, p.name, p.modality, p.html, p.mine ? 1 : 0, editedAt
      )
      return { kind: 'template', id: p.syncId, outcome: 'applied' }
    }
    if (pcNewer) return { kind: 'template', id: p.syncId, outcome: 'kept-pc', message: 'Changed later on the PC.' }
    this.run(
      'UPDATE templates SET name = ?, modality = ?, html = ?, mine = ?, updated_at = ? WHERE id = ?',
      p.name, p.modality, p.html, p.mine ? 1 : 0, editedAt, num(row.id)
    )
    return { kind: 'template', id: p.syncId, outcome: 'applied' }
  }

  applyPushMacro(p: PushMacro): PushResult {
    const row = this.get('SELECT id, rev, updated_at FROM macros WHERE sync_id = ?', p.syncId)
    const editedAt = saneTime(p.updatedAt)
    const pcNewer = row ? num(row.rev) > p.baseRev && str(row.updated_at) > editedAt : false
    if (p.deleted) {
      if (!row) return { kind: 'macro', id: p.syncId, outcome: 'applied' }
      if (pcNewer) return { kind: 'macro', id: p.syncId, outcome: 'kept-pc', message: 'Changed later on the PC.' }
      this.run('DELETE FROM macros WHERE id = ?', num(row.id))
      return { kind: 'macro', id: p.syncId, outcome: 'applied' }
    }
    // Another macro already uses this code: keep one macro per code (newest text wins).
    const clash = this.get('SELECT id, sync_id, updated_at FROM macros WHERE code = ? COLLATE NOCASE AND sync_id != ?', p.code, p.syncId)
    if (clash) {
      const phoneNewer = editedAt > str(clash.updated_at)
      if (phoneNewer) this.run('UPDATE macros SET text = ?, updated_at = ? WHERE id = ?', p.text, editedAt, num(clash.id))
      if (row) this.run('DELETE FROM macros WHERE id = ?', num(row.id))
      return {
        kind: 'macro',
        id: p.syncId,
        outcome: phoneNewer ? 'applied' : 'kept-pc',
        replacedBy: str(clash.sync_id),
        message: `Macro .${p.code} already existed; merged.`
      }
    }
    if (!row) {
      const tomb = this.get("SELECT deleted_at FROM tombstones WHERE kind = 'macro' AND sync_id = ?", p.syncId)
      if (tomb && p.baseRev > 0 && str(tomb.deleted_at) > editedAt) {
        return { kind: 'macro', id: p.syncId, outcome: 'kept-pc', message: 'Deleted later on the PC.' }
      }
      this.run('INSERT INTO macros (sync_id, code, text, updated_at) VALUES (?,?,?,?)', p.syncId, p.code, p.text, editedAt)
      return { kind: 'macro', id: p.syncId, outcome: 'applied' }
    }
    if (pcNewer) return { kind: 'macro', id: p.syncId, outcome: 'kept-pc', message: 'Changed later on the PC.' }
    this.run('UPDATE macros SET code = ?, text = ?, updated_at = ? WHERE id = ?', p.code, p.text, editedAt, num(row.id))
    return { kind: 'macro', id: p.syncId, outcome: 'applied' }
  }

  studyIdForSync(syncId: string): number | null {
    const r = this.get('SELECT id FROM studies WHERE sync_id = ?', syncId)
    return r ? num(r.id) : null
  }
}
