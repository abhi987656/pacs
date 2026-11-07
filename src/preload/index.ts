import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { PacsApi } from '@shared/types'

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: PacsApi = {
  platform: process.platform,
  listStudies: (filter) => ipcRenderer.invoke('studies:list', filter),
  getStudy: (id) => ipcRenderer.invoke('studies:get', id),
  getPriors: (id) => ipcRenderer.invoke('studies:priors', id),
  updateStudy: (id, patch) => ipcRenderer.invoke('studies:update', id, patch),
  deleteStudy: (id) => ipcRenderer.invoke('studies:delete', id),
  showStudyInFolder: (id) => ipcRenderer.invoke('studies:showInFolder', id),
  getSeriesImages: (id) => ipcRenderer.invoke('series:images', id),
  saveSeriesThumb: (id, dataUrl) => ipcRenderer.invoke('series:saveThumb', id, dataUrl),

  pickAndImport: (kind) => ipcRenderer.invoke('import:pick', kind),
  importPaths: (paths) => ipcRenderer.invoke('import:paths', paths),
  cancelImport: () => ipcRenderer.invoke('import:cancel'),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onImportProgress: (cb) => on('import:progress', cb),

  openViewer: (id) => ipcRenderer.invoke('viewer:open', id),
  onViewerLoadStudy: (cb) => {
    const off = on('viewer:load-study', cb)
    ipcRenderer.send('viewer:ready')
    return off
  },
  sendKeyImage: (img) => ipcRenderer.invoke('keyimage:send', img),
  onKeyImage: (cb) => on('keyimage', cb),
  onStudiesChanged: (cb) => on('studies:changed', cb),
  openReportFor: (id) => ipcRenderer.invoke('report:openFor', id),
  onOpenReport: (cb) => on('report:open', cb),
  editCommand: (cmd) => ipcRenderer.invoke('edit:command', cmd),
  setFullScreen: (onOff) => ipcRenderer.invoke('window:fullscreen', onOff),

  getReport: (id) => ipcRenderer.invoke('report:get', id),
  saveReport: (input) => ipcRenderer.invoke('report:save', input),
  listReportVersions: (id) => ipcRenderer.invoke('report:versions', id),
  exportReportPdf: (id) => ipcRenderer.invoke('report:pdf', id),
  printReport: (id) => ipcRenderer.invoke('report:print', id),

  listTemplates: () => ipcRenderer.invoke('templates:list'),
  saveTemplate: (t) => ipcRenderer.invoke('templates:save', t),
  deleteTemplate: (id) => ipcRenderer.invoke('templates:delete', id),
  listMacros: () => ipcRenderer.invoke('macros:list'),
  saveMacro: (m) => ipcRenderer.invoke('macros:save', m),
  deleteMacro: (id) => ipcRenderer.invoke('macros:delete', id),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  pickImageAsDataUrl: () => ipcRenderer.invoke('dialog:pickImage'),
  getDataInfo: () => ipcRenderer.invoke('data:info'),
  openDataFolder: () => ipcRenderer.invoke('data:open'),
  changeDataFolder: () => ipcRenderer.invoke('data:change'),
  backupDatabase: () => ipcRenderer.invoke('data:backup')
}

contextBridge.exposeInMainWorld('api', api)
