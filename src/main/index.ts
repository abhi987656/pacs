import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import type { WebContents } from 'electron'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { EditCommand, ImportResult, KeyImage, ReportSaveInput, Settings, SpeechModelId, StudyFilter } from '@shared/types'
import { Db } from './db'
import { Importer } from './importer'
import { ensureDataPaths, saveDataDir } from './paths'
import type { DataPaths } from './paths'
import { buildReportHtml, defaultPdfName, printHtml, renderPdf } from './print'
import { DICOM_BASE_URL, handleAppScheme, registerAppScheme } from './protocol'
import { seedIfEmpty } from './seed'
import { SpeechService } from './speech'
import { getSpeechModel } from './speechModels'
import { buildSeriesImages, sortInstances } from './sortImages'
import { createMainWindow, createViewerWindow } from './windows'

registerAppScheme()

let paths: DataPaths
let db: Db
let importer: Importer
let speech: SpeechService
let mainWin: BrowserWindow | null = null
let viewerWin: BrowserWindow | null = null
let viewerReady = false
let pendingViewerStudy: number | null = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore()
      mainWin.focus()
    }
  })
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
  ipcMain.handle('series:saveThumb', (_e, id: unknown, dataUrl: unknown) => {
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/') && dataUrl.length < 200_000) {
      db.setSeriesThumb(asId(id), dataUrl)
    }
  })

  // ---------------- import
  ipcMain.handle('import:pick', async (e, kind: 'folder' | 'files') => {
    const win = senderWindow(e.sender) ?? undefined
    const opts: Electron.OpenDialogOptions = {
      title: kind === 'folder' ? 'Import DICOM folder (CD/DVD, USB or any folder)' : 'Import DICOM files',
      properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections']
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
  ipcMain.handle('viewer:open', (_e, id: unknown) => openViewer(asId(id)))
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
  ipcMain.handle('settings:save', (_e, s: Settings) => db.saveSettings(s))
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
  paths = ensureDataPaths()
  db = new Db(paths.dbPath)
  seedIfEmpty(db)
  handleAppScheme(join(__dirname, '../renderer'), () => paths.archiveDir)
  importer = new Importer(db, paths.archiveDir, (p) => broadcast('import:progress', p))
  speech = new SpeechService(join(paths.dataDir, 'speech'), join(__dirname, 'speechWorker.js'), (e) =>
    broadcast('speech:event', e)
  )
  registerIpc()
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
  try {
    db?.close()
  } catch {
    /* ignore */
  }
})
