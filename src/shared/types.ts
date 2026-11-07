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
  dictationReplacements: []
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

export interface ImportProgress {
  running: boolean
  phase: 'scanning' | 'importing' | 'done' | 'cancelled'
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
  // templates & macros
  listTemplates(): Promise<Template[]>
  saveTemplate(t: Omit<Template, 'id' | 'updatedAt'> & { id?: number }): Promise<Template>
  deleteTemplate(id: number): Promise<void>
  listMacros(): Promise<Macro[]>
  saveMacro(m: Omit<Macro, 'id'> & { id?: number }): Promise<Macro>
  deleteMacro(id: number): Promise<void>
  // settings
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<Settings>
  pickImageAsDataUrl(): Promise<string | null>
  getDataInfo(): Promise<DataInfo>
  openDataFolder(): Promise<void>
  changeDataFolder(): Promise<boolean>
  backupDatabase(): Promise<string | null>
}
