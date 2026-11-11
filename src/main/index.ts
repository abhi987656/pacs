import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, net, session, shell } from 'electron'
import type { WebContents } from 'electron'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import type {
  EditCommand,
  ImportResult,
  KeyImage,
  ManualStudyInput,
  ReportSaveInput,
  Settings,
  SpeechModelId,
  StudyFilter
} from '@shared/types'
import { Db, syncSettingsOf } from './db'
import { buildReportDocx, buildReportText, exportFileBase } from '@shared/reportExport'
import { Importer } from './importer'
import { PhoneLink } from './phoneLink'
import { cleanManualInput } from './validate'
import { ensureDataPaths, saveDataDir } from './paths'
import type { DataPaths } from './paths'
import { buildReportHtml, defaultPdfName, printHtml, renderPdf } from './print'
import { DICOM_BASE_URL, handleAppScheme, registerAppScheme } from './protocol'
import { seedIfEmpty } from './seed'
import { ShareHost } from './share/host'
import { ShareReceiver } from './share/client'
import { destroyDht } from './share/dht'
import { LINK_SCHEME } from './share/protocol'
import { SpeechService } from './speech'
import { getSpeechModel } from './speechModels'
import { buildSeriesImages, sortInstances } from './sortImages'
import { createMainWindow, createViewerWindow, setSpellWordHandler } from './windows'
import { MEDICAL_WORDS } from '@shared/medicalWords'

// Tests run two copies of the app side by side (sender and receiver), each with its own profile.
if (process.env.PACS_USER_DATA_DIR) app.setPath('userData', process.env.PACS_USER_DATA_DIR)

registerAppScheme()

let paths: DataPaths
let db: Db
let importer: Importer
let speech: SpeechService
let phone: PhoneLink
let shares: ShareHost
let receiver: ShareReceiver
let mainWin: BrowserWindow | null = null
let viewerWin: BrowserWindow | null = null
let viewerReady = false
let pendingViewerStudy: number | null = null

// personalpacs://share/<code>?r=<relay> links (from the page a shared-case link opens) start or
// focus the app; the link arrives on the command line.
const isShareLink = (a: string) => a.toLowerCase().startsWith(`${LINK_SCHEME}://`)
let pendingLink: string | null = process.argv.find(isShareLink) ?? null

function deliverShareLink(link: string): void {
  if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.isLoading()) {
    mainWin.webContents.send('share:link', link)
    pendingLink = null
  } else pendingLink = link
}

const firstInstance = app.requestSingleInstanceLock()
if (!firstInstance) {
  app.quit() // the running copy gets our command line (e.g. a share link) via 'second-instance'
} else {
  app.on('second-instance', (_e, argv) => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore()
      mainWin.focus()
    }
    const link = argv.find(isShareLink)
    if (link) deliverShareLink(link)
  })
  app.on('open-url', (e, url) => {
    e.preventDefault()
    if (isShareLink(url)) deliverShareLink(url)
  })
}

/** Lets share links open this app (Windows; the installer registers it as well). */
function registerLinkHandler(): void {
  if (process.platform !== 'win32' || process.env.PACS_E2E_SAVE_DIR) return
  try {
    if (process.defaultApp) {
      // development: electron.exe <app folder>
      if (process.argv[1]) app.setAsDefaultProtocolClient(LINK_SCHEME, process.execPath, [resolve(process.argv[1])])
    } else {
      // The portable build runs from a temporary folder: register the .exe the user started.
      const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath
      app.setAsDefaultProtocolClient(LINK_SCHEME, exe, [])
    }
  } catch {
    /* not important enough to stop the app */
  }
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, ...args)
  }
}

const asId = (v: unknown): number => {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new Error('Invalid id')
  return n
}

function senderWindow(wc: WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(wc)
}

// Automated tests set PACS_E2E_SAVE_DIR so save dialogs don't block.
const E2E_SAVE_DIR = process.env.PACS_E2E_SAVE_DIR

async function askSavePath(win: BrowserWindow | undefined, opts: Electron.SaveDialogOptions): Promise<string | null> {
  if (E2E_SAVE_DIR) return join(E2E_SAVE_DIR, basename(opts.defaultPath ?? 'file'))
  const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
  return res.canceled || !res.filePath ? null : res.filePath
}

function openFile(path: string): void {
  if (!E2E_SAVE_DIR) void shell.openPath(path)
}

async function runImport(inputPaths: string[]): Promise<ImportResult> {
  const result = await importer.run(inputPaths)
  broadcast('studies:changed')
  return result
}

function openViewer(studyId: number): void {
  if (!viewerWin || viewerWin.isDestroyed()) {
    viewerReady = false
    viewerWin = createViewerWindow(mainWin)
    viewerWin.on('closed', () => {
      viewerWin = null
      viewerReady = false
    })
    pendingViewerStudy = studyId
    return
  }
  if (viewerWin.isMinimized()) viewerWin.restore()
  viewerWin.show()
  viewerWin.focus()
  if (viewerReady) viewerWin.webContents.send('viewer:load-study', studyId)
  else pendingViewerStudy = studyId
}

// ------------------------------------------------------------------ spelling
// The report editor has its own spell checker (offline, with radiology words). Plain text boxes
// (clinical details, case details) use Chromium's, set to the same English dictionaries here.

const spellWords = (): string[] => db.getKv<string[]>('spellWords') ?? []

function addSpellWord(input: string): string[] {
  const w = input.trim().slice(0, 60)
  const list = spellWords()
  if (!w || /\s/.test(w) || list.some((x) => x.toLowerCase() === w.toLowerCase())) return list
  const next = [...list, w].sort((a, b) => a.localeCompare(b))
  db.setKv('spellWords', next)
  try {
    session.defaultSession.addWordToSpellCheckerDictionary(w)
  } catch {
    /* in-memory session */
  }
  broadcast('spell:changed', next)
  return next
}

function applySpelling(s: Settings): void {
  const ses = session.defaultSession
  try {
    ses.setSpellCheckerEnabled(s.spellCheck)
    if (process.platform !== 'darwin') {
      // Without this Chromium uses the Windows language, and for e.g. English (India) it has no dictionary.
      const wanted = s.spellLanguage === 'en-GB' ? ['en-GB'] : s.spellLanguage === 'en-US' ? ['en-US'] : ['en-GB', 'en-US']
      const langs = wanted.filter((l) => ses.availableSpellCheckerLanguages.includes(l))
      if (langs.length) ses.setSpellCheckerLanguages(langs)
    }
    // Radiology words into Chromium's dictionary too (once per word-list version).
    const version = `${MEDICAL_WORDS.length}`
    if (db.getKv<string>('chromiumMedicalWords') !== version) {
      for (const w of MEDICAL_WORDS) ses.addWordToSpellCheckerDictionary(w)
      db.setKv('chromiumMedicalWords', version)
    }
  } catch (e) {
    console.error('[spelling]', e)
  }
}

function registerIpc(): void {
  // ---------------- studies
  ipcMain.handle('studies:list', (_e, filter: StudyFilter) => db.listStudies(filter ?? {}))
  ipcMain.handle('studies:get', (_e, id: unknown) => {
    const study = db.getStudy(asId(id))
    if (!study) return null
    return { study, series: db.getSeriesForStudy(study.id) }
  })
  ipcMain.handle('studies:priors', (_e, id: unknown) => db.getPriors(asId(id)))
  ipcMain.handle('studies:update', (_e, id: unknown, patch: Record<string, unknown>) => {
    const p: { visitType?: string; clinicalHistory?: string; referring?: string } = {}
    if (typeof patch?.visitType === 'string') p.visitType = patch.visitType
    if (typeof patch?.clinicalHistory === 'string') p.clinicalHistory = patch.clinicalHistory
    if (typeof patch?.referring === 'string') p.referring = patch.referring
    db.updateStudy(asId(id), p)
    broadcast('studies:changed')
  })
  const cleanManual = cleanManualInput
  ipcMain.handle('studies:createManual', (_e, input: Record<string, unknown>) => {
    const m = cleanManual(input, false) as ManualStudyInput
    if (!m.patientName) throw new Error('Patient name is required')
    const id = db.createManualStudy(m)
    broadcast('studies:changed')
    return id
  })
  ipcMain.handle('studies:updateDetails', (_e, id: unknown, patch: Record<string, unknown>) => {
    db.updateStudyDetails(asId(id), cleanManual(patch, true))
    broadcast('studies:changed')
  })
  ipcMain.handle('patients:find', (_e, patientId: unknown) => (typeof patientId === 'string' ? db.findPatient(patientId) : null))
  ipcMain.handle('studies:delete', async (_e, id: unknown) => {
    const studyId = asId(id)
    const folder = db.getStudyFolder(studyId)
    const files = db.getInstancePathsForStudy(studyId)
    db.deleteStudy(studyId)
    if (folder) {
      await rm(join(paths.archiveDir, ...folder.split('/')), { recursive: true, force: true })
    } else {
      for (const f of files) await rm(join(paths.archiveDir, ...f.split('/')), { force: true })
    }
    broadcast('studies:changed')
  })
  ipcMain.handle('studies:showInFolder', (_e, id: unknown) => {
    const folder = db.getStudyFolder(asId(id))
    if (folder) void shell.openPath(join(paths.archiveDir, ...folder.split('/')))
  })
  ipcMain.handle('series:images', (_e, id: unknown) => {
    const seriesId = asId(id)
    const sorted = sortInstances(db.getInstances(seriesId))
    return buildSeriesImages(seriesId, sorted, DICOM_BASE_URL)
  })
  ipcMain.handle('annotations:get', (_e, id: unknown) => db.getAnnotations(asId(id)))
  ipcMain.handle('annotations:save', (_e, id: unknown, json: unknown) => {
    if (typeof json !== 'string' || json.length > 20_000_000) throw new Error('Invalid annotations')
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) throw new Error('Invalid annotations')
    db.saveAnnotations(asId(id), parsed.length ? json : null)
  })
  ipcMain.handle('series:saveThumb', (_e, id: unknown, dataUrl: unknown) => {
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/') && dataUrl.length < 200_000) {
      db.setSeriesThumb(asId(id), dataUrl)
    }
  })

  // ---------------- import
  ipcMain.handle('import:pick', async (e, kind: 'folder' | 'files') => {
    const win = senderWindow(e.sender) ?? undefined
    const opts: Electron.OpenDialogOptions = {
      title: kind === 'folder' ? 'Import DICOM folder (CD/DVD, USB or any folder)' : 'Import DICOM files or ZIP archives',
      properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
      // DICOM files often have no extension, so "all files" comes first.
      filters: kind === 'folder' ? undefined : [
        { name: 'DICOM files and ZIP archives', extensions: ['*'] },
        { name: 'ZIP archives', extensions: ['zip'] }
      ]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    return runImport(res.filePaths)
  })
  ipcMain.handle('import:paths', (_e, list: unknown) => {
    const ps = Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string' && p.length > 0) : []
    return runImport(ps)
  })
  ipcMain.handle('import:cancel', () => importer.cancel())

  // ---------------- windows / cross-window messages
  ipcMain.handle('viewer:open', (_e, id: unknown) => {
    const study = db.getStudy(asId(id))
    if (!study || study.numImages === 0) return false // case without images
    openViewer(study.id)
    return true
  })
  ipcMain.on('viewer:ready', (e) => {
    if (viewerWin && e.sender === viewerWin.webContents) {
      viewerReady = true
      if (pendingViewerStudy != null) {
        viewerWin.webContents.send('viewer:load-study', pendingViewerStudy)
        pendingViewerStudy = null
      }
    }
  })
  ipcMain.handle('report:openFor', (_e, id: unknown) => {
    const studyId = asId(id)
    if (!mainWin || mainWin.isDestroyed()) mainWin = createMainWindow()
    if (mainWin.isMinimized()) mainWin.restore()
    mainWin.show()
    mainWin.focus()
    mainWin.webContents.send('report:open', studyId)
  })
  ipcMain.handle('keyimage:send', (_e, img: KeyImage) => {
    if (!img || typeof img.dataUrl !== 'string' || !img.dataUrl.startsWith('data:image/')) return
    mainWin?.webContents.send('keyimage', { dataUrl: img.dataUrl, caption: String(img.caption ?? '') })
  })
  ipcMain.handle('edit:command', (e, cmd: EditCommand) => {
    const wc = e.sender
    if (cmd === 'cut') wc.cut()
    else if (cmd === 'copy') wc.copy()
    else if (cmd === 'paste') wc.paste()
    else if (cmd === 'selectAll') wc.selectAll()
  })
  // ---------------- speech / dictation
  const asModel = (v: unknown): SpeechModelId => {
    if (typeof v !== 'string' || !getSpeechModel(v)) throw new Error('Unknown speech model')
    return v as SpeechModelId
  }
  ipcMain.handle('speech:status', () => speech.status())
  ipcMain.handle('speech:install', (_e, id: unknown) => speech.installModel(asModel(id)))
  ipcMain.handle('speech:cancelInstall', () => speech.cancelInstall())
  ipcMain.handle('speech:remove', (_e, id: unknown) => speech.removeModel(asModel(id)))
  ipcMain.handle('speech:start', (_e, id: unknown, pauseMs: unknown) =>
    speech.start(asModel(id), Math.min(2000, Math.max(250, Number(pauseMs) || 600)))
  )
  ipcMain.handle('speech:stop', () => speech.stop())
  ipcMain.on('speech:audio', (_e, samples: unknown) => {
    if (samples instanceof Float32Array) speech.audio(samples)
  })
  // F4 / mic button in the viewer controls dictation in the report window.
  ipcMain.handle('dictation:toggle', () => {
    mainWin?.webContents.send('dictation:toggle')
  })
  ipcMain.on('dictation:active', (_e, active: unknown) => broadcast('dictation:active', !!active))

  ipcMain.handle('image:save', async (e, dataUrl: unknown, name: unknown) => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null
    const win = senderWindow(e.sender) ?? undefined
    const safe = String(name ?? 'image').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'image'
    const filePath = await askSavePath(win, {
      title: 'Save image',
      defaultPath: join(app.getPath('pictures'), `${safe}.png`),
      filters: [{ name: 'PNG image', extensions: ['png'] }]
    })
    if (!filePath) return null
    await writeFile(filePath, nativeImage.createFromDataURL(dataUrl).toPNG())
    return filePath
  })

  ipcMain.handle('window:fullscreen', (e, on: boolean) => {
    senderWindow(e.sender)?.setFullScreen(!!on)
  })

  // ---------------- reports
  ipcMain.handle('report:get', (_e, id: unknown) => db.getReport(asId(id)))
  ipcMain.handle('report:save', (_e, input: ReportSaveInput) => {
    const studyId = asId(input?.studyId)
    if (!db.getStudy(studyId)) throw new Error('Study not found')
    const status = ['DRAFT', 'PRELIMINARY', 'FINAL'].includes(input.status) ? input.status : 'DRAFT'
    const saved = db.saveReport({
      studyId,
      status,
      html: String(input.html ?? ''),
      text: String(input.text ?? ''),
      modality: String(input.modality ?? ''),
      procedure: String(input.procedure ?? ''),
      radiologist: String(input.radiologist ?? ''),
      templateName: String(input.templateName ?? '')
    })
    broadcast('studies:changed')
    return saved
  })
  ipcMain.handle('report:versions', (_e, id: unknown) => db.listReportVersions(asId(id)))
  ipcMain.handle('report:pdf', async (e, id: unknown) => {
    const study = db.getStudy(asId(id))
    if (!study) return null
    const html = buildReportHtml(study, db.getReport(study.id), db.getSettings())
    const win = senderWindow(e.sender) ?? undefined
    const opts: Electron.SaveDialogOptions = {
      title: 'Save report as PDF',
      defaultPath: join(app.getPath('documents'), defaultPdfName(study)),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    }
    const filePath = await askSavePath(win, opts)
    if (!filePath) return null
    const pdf = await renderPdf(html, paths.tmpDir)
    await writeFile(filePath, pdf)
    openFile(filePath)
    return filePath
  })
  ipcMain.handle('report:print', async (_e, id: unknown) => {
    const study = db.getStudy(asId(id))
    if (!study) return false
    const html = buildReportHtml(study, db.getReport(study.id), db.getSettings())
    return printHtml(html, paths.tmpDir)
  })

  ipcMain.handle('report:export', async (e, id: unknown, kind: unknown) => {
    const study = db.getStudy(asId(id))
    if (!study) return null
    const ext = kind === 'docx' ? 'docx' : 'txt'
    const input = { study, report: db.getReport(study.id), settings: syncSettingsOf(db.getSettings()) }
    const win = senderWindow(e.sender) ?? undefined
    const filePath = await askSavePath(win, {
      title: ext === 'docx' ? 'Save report as Word document' : 'Save report as text file',
      defaultPath: join(app.getPath('documents'), `${exportFileBase(study)}.${ext}`),
      filters: [ext === 'docx' ? { name: 'Word document', extensions: ['docx'] } : { name: 'Text file', extensions: ['txt'] }]
    })
    if (!filePath) return null
    if (ext === 'docx') await writeFile(filePath, await buildReportDocx(input))
    else await writeFile(filePath, '\ufeff' + buildReportText(input), 'utf8')
    openFile(filePath)
    return filePath
  })

  // ---------------- phone app
  ipcMain.handle('phone:status', () => phone.status())
  ipcMain.handle('phone:setEnabled', (_e, on: unknown) => phone.setEnabled(!!on))
  ipcMain.handle('phone:startPairing', () => phone.startPairing())
  ipcMain.handle('phone:cancelPairing', () => phone.cancelPairing())
  ipcMain.handle('phone:removeDevice', (_e, id: unknown) => phone.removeDevice(String(id ?? '')))

  // ---------------- case sharing with other Personal PACS users
  ipcMain.handle('share:create', (_e, id: unknown, opts: { anonymize?: unknown; allowReply?: unknown }) =>
    shares.create(asId(id), { anonymize: opts?.anonymize === true, allowReply: opts?.allowReply !== false })
  )
  ipcMain.handle('share:list', () => shares.list())
  ipcMain.handle('share:stop', (_e, id: unknown, close: unknown) => shares.stop(String(id ?? ''), close === true))
  ipcMain.handle('receive:start', (_e, input: unknown) => receiver.start(String(input ?? '').slice(0, 4000)))
  ipcMain.handle('receive:cancel', (_e, jobId: unknown) => receiver.cancel(String(jobId ?? '')))
  ipcMain.handle('share:takeLink', () => {
    const link = pendingLink
    pendingLink = null
    return link
  })
  ipcMain.handle('share:received', (_e, id: unknown) => {
    const r = db.receivedForStudy(asId(id))
    if (!r) return null
    const { code: _code, relayUrl: _relay, ...info } = r // eslint-disable-line @typescript-eslint/no-unused-vars
    return info
  })
  ipcMain.handle('share:reply', async (_e, id: unknown) => {
    const msg = await receiver.reply(asId(id))
    broadcast('studies:changed')
    return msg
  })
  ipcMain.handle('share:opinions', (_e, id: unknown) => db.listSecondOpinions(asId(id)))

  // ---------------- templates & macros
  ipcMain.handle('templates:list', () => db.listTemplates())
  ipcMain.handle('templates:save', (_e, t) => {
    const name = String(t?.name ?? '').trim()
    if (!name) throw new Error('Template name is required')
    return db.saveTemplate({
      id: t?.id ? asId(t.id) : undefined,
      name,
      modality: String(t?.modality ?? ''),
      html: String(t?.html ?? ''),
      mine: t?.mine !== false
    })
  })
  ipcMain.handle('templates:delete', (_e, id: unknown) => db.deleteTemplate(asId(id)))
  ipcMain.handle('macros:list', () => db.listMacros())
  ipcMain.handle('macros:save', (_e, m) => {
    const code = String(m?.code ?? '').trim().replace(/^\./, '')
    if (!/^[A-Za-z0-9_-]{1,20}$/.test(code)) throw new Error('Macro code must be 1–20 letters/numbers')
    return db.saveMacro({ id: m?.id ? asId(m.id) : undefined, code, text: String(m?.text ?? '') })
  })
  ipcMain.handle('macros:delete', (_e, id: unknown) => db.deleteMacro(asId(id)))

  // ---------------- settings & data
  ipcMain.handle('settings:get', () => db.getSettings())
  ipcMain.handle('settings:save', (_e, s: Settings) => {
    const saved = db.saveSettings(s)
    applySpelling(saved)
    return saved
  })

  // ---------------- spelling: the user's own words ("Add to Dictionary")
  ipcMain.handle('spell:words', () => spellWords())
  ipcMain.handle('spell:add', (_e, word: unknown) => addSpellWord(String(word ?? '')))
  ipcMain.handle('spell:remove', (_e, word: unknown) => {
    const w = String(word ?? '').trim()
    const list = spellWords().filter((x) => x !== w)
    db.setKv('spellWords', list)
    try {
      session.defaultSession.removeWordFromSpellCheckerDictionary(w)
    } catch {
      /* not there */
    }
    broadcast('spell:changed', list)
    return list
  })
  ipcMain.handle('dialog:pickImage', async (e) => {
    const win = senderWindow(e.sender) ?? undefined
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose an image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }]
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return null
    const file = res.filePaths[0]
    const buf = await readFile(file)
    if (buf.length > 3 * 1024 * 1024) throw new Error('Please choose an image smaller than 3 MB')
    const mime = extname(file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg'
    return `data:${mime};base64,${buf.toString('base64')}`
  })
  ipcMain.handle('data:info', () => ({
    dataDir: paths.dataDir,
    archiveDir: paths.archiveDir,
    dbPath: paths.dbPath,
    ...db.counts(),
    appVersion: app.getVersion()
  }))
  ipcMain.handle('data:open', () => shell.openPath(paths.dataDir))
  ipcMain.handle('data:change', async (e) => {
    const win = senderWindow(e.sender) ?? undefined
    const opts: Electron.OpenDialogOptions = {
      title: 'Choose a new data folder',
      properties: ['openDirectory', 'createDirectory']
    }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || !res.filePaths[0]) return false
    const dir = res.filePaths[0]
    const confirmOpts: Electron.MessageBoxOptions = {
      type: 'question',
      buttons: ['Switch and restart', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: 'Use this data folder?',
      detail:
        `${dir}\n\nThe app will restart and keep its database and images there. ` +
        (existsSync(join(dir, 'pacs.db'))
          ? 'This folder already contains Personal PACS data, which will be opened.'
          : `Your current data stays in:\n${paths.dataDir}\nTo bring it along, close the app and copy that folder's contents into the new folder first.`)
    }
    const ok = win ? await dialog.showMessageBox(win, confirmOpts) : await dialog.showMessageBox(confirmOpts)
    if (ok.response !== 0) return false
    saveDataDir(dir)
    app.relaunch()
    app.exit(0)
    return true
  })
  ipcMain.handle('data:backup', async (e) => {
    const win = senderWindow(e.sender) ?? undefined
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    const opts: Electron.SaveDialogOptions = {
      title: 'Back up reports database',
      defaultPath: join(app.getPath('documents'), `PersonalPACS-backup-${stamp}.db`),
      filters: [{ name: 'Database', extensions: ['db'] }]
    }
    const filePath = await askSavePath(win, opts)
    if (!filePath) return null
    if (existsSync(filePath)) await rm(filePath, { force: true })
    db.db.exec(`VACUUM INTO '${filePath.replace(/'/g, "''")}'`)
    return filePath
  })
}

app.whenReady().then(() => {
  if (!firstInstance) return
  // No menu bar: keeps the Alt key free for viewer shortcuts (Alt+C compare, Alt+drag W/L …).
  Menu.setApplicationMenu(null)
  paths = ensureDataPaths()
  db = new Db(paths.dbPath)
  seedIfEmpty(db)
  handleAppScheme(join(__dirname, '../renderer'), () => paths.archiveDir)
  importer = new Importer(db, paths.archiveDir, (p) => broadcast('import:progress', p), paths.tmpDir)
  speech = new SpeechService(join(paths.dataDir, 'speech'), join(__dirname, 'speechWorker.js'), (e) =>
    broadcast('speech:event', e)
  )
  phone = new PhoneLink(
    db,
    (e) => broadcast('phone:event', e),
    (studyIds) => {
      broadcast('studies:changed')
      if (studyIds.length) broadcast('reports:changed', studyIds)
    },
    process.env.PACS_PHONE_PORT ? Number(process.env.PACS_PHONE_PORT) : undefined
  )
  // Electron's network stack (net.fetch) uses the system's proxy settings, like the browser.
  const netFetch = ((input: string | URL | Request, init?: RequestInit) => net.fetch(input instanceof URL ? input.href : input, init)) as typeof fetch
  shares = new ShareHost(db, paths.archiveDir, join(paths.dataDir, 'tools'), (e) => broadcast('share:event', e), netFetch)
  receiver = new ShareReceiver(
    db,
    importer,
    paths.tmpDir,
    (p) => broadcast('receive:progress', p),
    () => broadcast('studies:changed'),
    netFetch
  )
  registerIpc()
  registerLinkHandler()
  applySpelling(db.getSettings())
  setSpellWordHandler((w) => addSpellWord(w))
  void phone.init()
  void receiver.cleanup()
  void shares.init()
  mainWin = createMainWindow()
  mainWin.on('closed', () => {
    mainWin = null
    // Closing the reporting window closes the whole app (viewer included).
    if (viewerWin && !viewerWin.isDestroyed()) viewerWin.close()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  speech?.shutdown()
  void phone?.stop()
  void shares?.shutdown().then(() => destroyDht())
  try {
    db?.close()
  } catch {
    /* ignore */
  }
})
