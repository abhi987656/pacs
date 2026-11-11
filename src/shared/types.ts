// Types shared by the main process, the preload bridge and both renderer windows.

export type ReportStatus = 'NEW' | 'DRAFT' | 'PRELIMINARY' | 'FINAL'

export interface StudyRow {
  id: number
  studyUid: string
  patientId: string
  patientName: string
  birthDate: string // YYYYMMDD
  sex: string
  age: string // e.g. "056Y" from DICOM, or computed
  studyDate: string // YYYYMMDD
  studyTime: string // HHMMSS
  description: string
  accession: string
  referring: string
  institution: string
  modalities: string // e.g. "CT" or "CT\\SR"
  bodyPart: string
  numSeries: number
  numImages: number
  importedAt: string // ISO
  reportStatus: ReportStatus
  reportUpdatedAt: string | null
  visitType: string
  clinicalHistory: string
  manual: boolean // created by hand (reporting without images)
  sharedFrom: string | null // received from another Personal PACS user (sender's name)
}

/** Details typed in for a case without images (also used to correct any study's details). */
export interface ManualStudyInput {
  patientName: string
  patientId: string // CR No
  accession: string // PG No
  sex: string
  age: string // DICOM style, e.g. "056Y"
  birthDate: string // YYYYMMDD or ''
  description: string
  modality: string
  studyDate: string // YYYYMMDD
  studyTime: string // HHMMSS
  referring: string
  visitType: string
  clinicalHistory: string
}

export interface SeriesRow {
  id: number
  studyId: number
  seriesUid: string
  number: number | null
  description: string
  modality: string
  bodyPart: string
  numImages: number
  numFrames: number
  isImage: boolean
  thumb: string | null // data URL
}

export interface StudyDetail {
  study: StudyRow
  series: SeriesRow[]
}

export interface SeriesImages {
  seriesId: number
  // Image ids for Cornerstone (one per frame), already sorted for display.
  imageIds: string[]
  // Position of each image along the slice normal (mm), null when unknown (used for linked scrolling).
  positions: (number | null)[]
  // Unit slice normal of the series, if all images share one orientation.
  normal: [number, number, number] | null
  frameOfReferenceUid: string
  // True when the series can be reconstructed in MPR (parallel slices, >= 3 images, same size).
  reconstructable: boolean
}

export interface StudyFilter {
  text?: string // name / ID / accession / description
  modality?: string
  status?: ReportStatus | 'UNREPORTED' | ''
  dateFrom?: string // YYYYMMDD
  dateTo?: string // YYYYMMDD
  reportText?: string
  limit?: number
}

export interface Report {
  id: number
  studyId: number
  status: ReportStatus
  html: string
  text: string
  modality: string
  procedure: string
  radiologist: string
  templateName: string
  createdAt: string
  updatedAt: string
  signedAt: string | null
}

export interface ReportSaveInput {
  studyId: number
  status: ReportStatus
  html: string
  text: string
  modality: string
  procedure: string
  radiologist: string
  templateName: string
}

export interface ReportVersion {
  id: number
  reportId: number
  status: ReportStatus
  html: string
  savedAt: string
  note: string // e.g. "Saved on Phone" for versions that came from the phone app
}

export interface Template {
  id: number
  name: string
  modality: string
  html: string
  mine: boolean
  updatedAt: string
}

export interface Macro {
  id: number
  code: string
  text: string
}

export interface Settings {
  radiologistName: string
  radiologistDesignation: string
  radiologistRegNo: string
  signatureImage: string // data URL or ''
  institutionName: string
  institutionAddress: string
  institutionContact: string
  logoImage: string // data URL or ''
  showLetterhead: boolean
  reportTitle: string
  footerText: string
  pageSize: 'A4' | 'Letter'
  pageMargin: 'normal' | 'narrow' | 'wide'
  pageOrientation: 'portrait' | 'landscape'
  editorFontFamily: string
  editorFontSize: string
  autoOpenViewer: boolean
  autosaveSeconds: number
  showSignatureBlock: boolean
  dictationModel: SpeechModelId
  dictationMicId: string
  dictationPauseMs: number
  dictationCommands: boolean
  dictationReplacements: DictationReplacement[]
  /** Red underline under misspelled words, right-click for suggestions (like Word). */
  spellCheck: boolean
  /** Dictionaries: British + American English, or one of them. */
  spellLanguage: 'en-GB+en-US' | 'en-GB' | 'en-US'
}

export interface DictationReplacement {
  from: string
  to: string
}

export const DEFAULT_SETTINGS: Settings = {
  radiologistName: '',
  radiologistDesignation: '',
  radiologistRegNo: '',
  signatureImage: '',
  institutionName: '',
  institutionAddress: '',
  institutionContact: '',
  logoImage: '',
  showLetterhead: true,
  reportTitle: 'RADIOLOGY REPORT',
  footerText: '',
  pageSize: 'A4',
  pageMargin: 'normal',
  pageOrientation: 'portrait',
  editorFontFamily: 'Times New Roman',
  editorFontSize: '12pt',
  autoOpenViewer: true,
  autosaveSeconds: 60,
  showSignatureBlock: true,
  dictationModel: 'parakeet-v2',
  dictationMicId: '',
  dictationPauseMs: 600,
  dictationCommands: true,
  dictationReplacements: [],
  spellCheck: true,
  spellLanguage: 'en-GB+en-US'
}

// ------------------------------------------------------------------ speech recognition

export type SpeechModelId = 'parakeet-v2' | 'whisper-base'

export interface SpeechModelStatus {
  id: SpeechModelId
  name: string
  description: string
  downloadMB: number
  installed: boolean
}

export interface SpeechInstallState {
  modelId: SpeechModelId
  phase: 'downloading' | 'unpacking'
  progress: number // 0..1
}

export type SpeechEngineState = 'off' | 'loading' | 'ready' | 'listening' | 'error'

export interface SpeechStatus {
  models: SpeechModelStatus[]
  install: SpeechInstallState | null
  engine: SpeechEngineState
  loadedModel: SpeechModelId | null
  error: string | null
}

export type SpeechEvent =
  | { type: 'status'; status: SpeechStatus }
  | { type: 'text'; text: string }
  | { type: 'speaking'; speaking: boolean }
  | { type: 'pending'; count: number }

// ------------------------------------------------------------------ phone app sync (PC <-> Android)

/** A case as the phone app sees it. `syncId` never changes (unlike the DICOM study UID). */
export interface SyncStudy {
  syncId: string
  patientName: string
  patientId: string // CR No
  accession: string // PG No
  sex: string
  age: string // DICOM style "056Y"
  birthDate: string
  description: string
  modalities: string
  studyDate: string // YYYYMMDD
  studyTime: string // HHMMSS
  referring: string
  visitType: string
  clinicalHistory: string
  institution: string
  numImages: number
  manual: boolean
  reportStatus: ReportStatus
  importedAt: string
  modifiedAt: string // last time the details were edited ('' = never)
  rev: number
  /** true: shown in the phone worklist; false: only kept as a previous study of a listed patient. */
  listed: boolean
}

export interface SyncReport {
  studySyncId: string
  status: ReportStatus
  html: string
  text: string
  modality: string
  procedure: string
  radiologist: string
  templateName: string
  updatedAt: string
  signedAt: string | null
  rev: number
}

export interface SyncTemplate {
  syncId: string
  name: string
  modality: string
  html: string
  mine: boolean
  updatedAt: string
  rev: number
}

export interface SyncMacro {
  syncId: string
  code: string
  text: string
  updatedAt: string
  rev: number
}

/** PC settings the phone needs (letterhead/signature for exports, dictation corrections). */
export const SYNC_SETTING_KEYS = [
  'radiologistName',
  'radiologistDesignation',
  'radiologistRegNo',
  'signatureImage',
  'institutionName',
  'institutionAddress',
  'institutionContact',
  'logoImage',
  'showLetterhead',
  'reportTitle',
  'footerText',
  'pageSize',
  'pageMargin',
  'pageOrientation',
  'editorFontFamily',
  'editorFontSize',
  'showSignatureBlock',
  'dictationCommands',
  'dictationReplacements'
] as const
export type SyncSettings = Pick<Settings, (typeof SYNC_SETTING_KEYS)[number]>

export interface PullRequest {
  since: number // PC revision the phone has already seen (0 = everything)
  have: string[] // study sync ids stored on the phone
}

export interface PullResponse {
  rev: number
  pcId: string
  pcName: string
  studies: SyncStudy[]
  reports: SyncReport[]
  templates: SyncTemplate[]
  macros: SyncMacro[]
  deleted: { studies: string[]; templates: string[]; macros: string[] }
  /** Every study the phone should keep; anything else can be removed from the phone. */
  scope: string[]
  settings: SyncSettings | null
}

export interface PushStudy {
  syncId: string
  isNew: boolean // a new case created on the phone
  fields: Partial<ManualStudyInput>
  modifiedAt: string
  baseRev: number
}

export interface PushReport {
  studySyncId: string
  status: 'DRAFT' | 'PRELIMINARY' // the phone cannot sign off
  html: string
  text: string
  modality: string
  procedure: string
  radiologist: string
  templateName: string
  updatedAt: string
  baseRev: number
}

export interface PushTemplate {
  syncId: string
  name: string
  modality: string
  html: string
  mine: boolean
  updatedAt: string
  deleted: boolean
  baseRev: number
}

export interface PushMacro {
  syncId: string
  code: string
  text: string
  updatedAt: string
  deleted: boolean
  baseRev: number
}

export interface PushRequest {
  studies: PushStudy[]
  reports: PushReport[]
  templates: PushTemplate[]
  macros: PushMacro[]
}

export type PushOutcome =
  | 'applied' // the phone's change is now on the PC
  | 'kept-pc' // both changed; the PC's version was newer and wins (phone version kept in history for reports)
  | 'rejected' // not allowed (e.g. report already signed off on the PC); phone text kept in history
  | 'missing' // the case no longer exists on the PC

export interface PushResult {
  kind: 'study' | 'report' | 'template' | 'macro'
  id: string
  outcome: PushOutcome
  message?: string
  /** Macro with the same code already on the PC: the phone should use this one instead. */
  replacedBy?: string
}

export interface PushResponse {
  results: PushResult[]
}

export interface PhoneDevice {
  id: string
  name: string
  createdAt: string
  lastSeen: string | null
  lastIp: string | null
}

export interface PhonePairing {
  code: string // typed on the phone if the camera is not used
  uri: string // contents of the QR code
  expiresAt: string
}

export interface PhoneLinkStatus {
  enabled: boolean
  running: boolean
  port: number
  addresses: string[]
  pcName: string
  pcId: string
  devices: PhoneDevice[]
  pairing: PhonePairing | null
  error: string | null
  lastSync: { device: string; at: string; summary: string } | null
}

export type PhoneEvent =
  | { type: 'status'; status: PhoneLinkStatus }
  | { type: 'paired'; device: PhoneDevice }
  | { type: 'synced'; device: string; changedStudies: number[]; summary: string }

// ------------------------------------------------------------------ case sharing (PC <-> PC over the internet)

/** stopped/expired: no more downloads (a report can still be sent back); closed: gone completely. */
export type ShareStatus = 'preparing' | 'active' | 'stopped' | 'expired' | 'error' | 'closed'
export type ShareLinkState = 'off' | 'starting' | 'ready' | 'unavailable'

export interface ShareDownload {
  id: string
  name: string // receiver's name (from their Settings), '' if not set
  via: 'direct' | 'relay'
  bytes: number
  total: number
  done: boolean
  lastSeen: string
}

/** A case this PC is sharing (sender side). */
export interface ShareInfo {
  id: string
  studyId: number
  title: string
  code: string // "ABCDE-23456"
  link: string | null // https link through the relay (clickable in WhatsApp), when the relay is up
  message: string // ready-to-send text (link + code + instructions)
  createdAt: string
  expiresAt: string
  replyUntil: string | null // a report can be sent back until then (null: replies not allowed)
  anonymized: boolean
  allowReply: boolean
  status: ShareStatus
  direct: ShareLinkState
  relay: ShareLinkState
  error: string | null
  files: number
  totalBytes: number
  downloads: ShareDownload[]
  replies: number
}

export type ReceivePhase = 'connecting' | 'downloading' | 'importing' | 'done' | 'error' | 'cancelled'

export interface ReceiveProgress {
  jobId: string
  phase: ReceivePhase
  via: 'direct' | 'relay' | null
  title: string
  sender: string
  bytes: number
  total: number
  rate: number // bytes per second
  message: string
  studyId: number | null
}

/** A case this PC received (receiver side). */
export interface ReceivedShareInfo {
  id: string
  studyId: number
  senderName: string
  receivedAt: string
  replyUntil: string
  allowReply: boolean
  anonymized: boolean
  repliedAt: string | null
}

export interface SecondOpinion {
  id: number
  studyId: number
  fromName: string
  fromDesignation: string
  status: ReportStatus
  html: string
  text: string
  receivedAt: string
}

export type ShareEvent =
  | { type: 'share'; share: ShareInfo }
  | { type: 'opinion'; studyId: number; fromName: string; title: string }

export interface ImportProgress {
  running: boolean
  phase: 'scanning' | 'unpacking' | 'importing' | 'done' | 'cancelled'
  /** While a ZIP archive is being unpacked. */
  zip?: { name: string; done: number; total: number } | null
  filesFound: number
  processed: number
  imported: number
  duplicates: number
  skipped: number
  errors: number
  studiesTouched: number
  currentFile: string
  message: string
}

export interface ImportResult extends ImportProgress {
  studyIds: number[]
}

export interface DataInfo {
  dataDir: string
  archiveDir: string
  dbPath: string
  studies: number
  series: number
  images: number
  reports: number
  appVersion: string
}

export interface KeyImage {
  dataUrl: string
  caption: string
}

export type EditCommand = 'cut' | 'copy' | 'paste' | 'selectAll'

// The API exposed on window.api by the preload script.
export interface PacsApi {
  platform: string
  // studies
  listStudies(filter: StudyFilter): Promise<StudyRow[]>
  getStudy(studyId: number): Promise<StudyDetail | null>
  getPriors(studyId: number): Promise<StudyRow[]>
  updateStudy(studyId: number, patch: Partial<Pick<StudyRow, 'visitType' | 'clinicalHistory' | 'referring'>>): Promise<void>
  createManualStudy(input: ManualStudyInput): Promise<number>
  updateStudyDetails(studyId: number, patch: Partial<ManualStudyInput>): Promise<void>
  findPatient(patientId: string): Promise<{ patientName: string; sex: string; age: string; birthDate: string } | null>
  deleteStudy(studyId: number): Promise<void>
  showStudyInFolder(studyId: number): Promise<void>
  getSeriesImages(seriesId: number): Promise<SeriesImages>
  saveSeriesThumb(seriesId: number, dataUrl: string): Promise<void>
  /** Viewer measurements / labels saved for a study (V), as JSON; null when none were saved. */
  getSavedAnnotations(studyId: number): Promise<string | null>
  saveAnnotations(studyId: number, json: string): Promise<void>
  // import
  pickAndImport(kind: 'folder' | 'files'): Promise<ImportResult | null>
  importPaths(paths: string[]): Promise<ImportResult>
  cancelImport(): Promise<void>
  getPathForFile(file: File): string
  onImportProgress(cb: (p: ImportProgress) => void): () => void
  // windows / cross-window
  openViewer(studyId: number): Promise<boolean>
  onViewerLoadStudy(cb: (studyId: number) => void): () => void
  sendKeyImage(img: KeyImage): Promise<void>
  saveImage(dataUrl: string, name: string): Promise<string | null>
  onKeyImage(cb: (img: KeyImage) => void): () => void
  onStudiesChanged(cb: () => void): () => void
  openReportFor(studyId: number): Promise<void>
  onOpenReport(cb: (studyId: number) => void): () => void
  editCommand(cmd: EditCommand): Promise<void>
  setFullScreen(on: boolean): Promise<void>
  // speech / dictation
  speechStatus(): Promise<SpeechStatus>
  speechInstall(id: SpeechModelId): Promise<void>
  speechCancelInstall(): Promise<void>
  speechRemove(id: SpeechModelId): Promise<void>
  speechStart(id: SpeechModelId, pauseMs: number): Promise<void>
  speechStop(): Promise<void>
  speechAudio(samples: Float32Array): void
  onSpeechEvent(cb: (e: SpeechEvent) => void): () => void
  toggleDictation(): Promise<void>
  onToggleDictation(cb: () => void): () => void
  dictationActive(active: boolean): void
  onDictationActive(cb: (active: boolean) => void): () => void
  // reports
  getReport(studyId: number): Promise<Report | null>
  saveReport(input: ReportSaveInput): Promise<Report>
  listReportVersions(studyId: number): Promise<ReportVersion[]>
  exportReportPdf(studyId: number): Promise<string | null>
  printReport(studyId: number): Promise<boolean>
  /** Exports the saved report as a Word document or a text file (asks where to save). */
  exportReport(studyId: number, kind: 'docx' | 'txt'): Promise<string | null>
  /** Reports changed by the phone app (study ids). */
  onReportsChanged(cb: (studyIds: number[]) => void): () => void
  // case sharing with other Personal PACS users
  shareCreate(studyId: number, opts: { anonymize: boolean; allowReply: boolean }): Promise<ShareInfo>
  shareList(): Promise<ShareInfo[]>
  /** Stops downloads; `close` also stops accepting a report back. */
  shareStop(id: string, close?: boolean): Promise<void>
  onShareEvent(cb: (e: ShareEvent) => void): () => void
  receiveStart(input: string): Promise<string>
  receiveCancel(jobId: string): Promise<void>
  onReceiveProgress(cb: (p: ReceiveProgress) => void): () => void
  /** A personalpacs:// link opened the app (takeShareLink: one that arrived before the window was ready). */
  onShareLink(cb: (link: string) => void): () => void
  takeShareLink(): Promise<string | null>
  receivedInfo(studyId: number): Promise<ReceivedShareInfo | null>
  replySend(studyId: number): Promise<string>
  secondOpinions(studyId: number): Promise<SecondOpinion[]>
  // phone app
  phoneStatus(): Promise<PhoneLinkStatus>
  phoneSetEnabled(on: boolean): Promise<PhoneLinkStatus>
  phoneStartPairing(): Promise<PhoneLinkStatus>
  phoneCancelPairing(): Promise<PhoneLinkStatus>
  phoneRemoveDevice(id: string): Promise<PhoneLinkStatus>
  onPhoneEvent(cb: (e: PhoneEvent) => void): () => void
  // templates & macros
  listTemplates(): Promise<Template[]>
  saveTemplate(t: Omit<Template, 'id' | 'updatedAt'> & { id?: number }): Promise<Template>
  deleteTemplate(id: number): Promise<void>
  listMacros(): Promise<Macro[]>
  saveMacro(m: Omit<Macro, 'id'> & { id?: number }): Promise<Macro>
  deleteMacro(id: number): Promise<void>
  // settings
  // spelling: the words the user added to the dictionary
  spellWords(): Promise<string[]>
  spellAddWord(word: string): Promise<string[]>
  spellRemoveWord(word: string): Promise<string[]>
  onSpellWordsChanged(cb: (words: string[]) => void): () => void
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<Settings>
  pickImageAsDataUrl(): Promise<string | null>
  getDataInfo(): Promise<DataInfo>
  openDataFolder(): Promise<void>
  changeDataFolder(): Promise<boolean>
  backupDatabase(): Promise<string | null>
}
