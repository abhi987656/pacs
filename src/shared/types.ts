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
  showSignatureBlock: true
}

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
  openViewer(studyId: number): Promise<void>
  onViewerLoadStudy(cb: (studyId: number) => void): () => void
  sendKeyImage(img: KeyImage): Promise<void>
  onKeyImage(cb: (img: KeyImage) => void): () => void
  onStudiesChanged(cb: () => void): () => void
  openReportFor(studyId: number): Promise<void>
  onOpenReport(cb: (studyId: number) => void): () => void
  editCommand(cmd: EditCommand): Promise<void>
  setFullScreen(on: boolean): Promise<void>
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
