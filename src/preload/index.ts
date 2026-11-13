import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { PacsApi } from '@shared/types'

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: PacsApi = {
  getAccess: () => ipcRenderer.invoke('access:get'),
  checkAccess: () => ipcRenderer.invoke('access:check'),
  signUp: (name, email, password) => ipcRenderer.invoke('access:signUp', name, email, password),
  signIn: (email, password) => ipcRenderer.invoke('access:signIn', email, password),
  signOut: () => ipcRenderer.invoke('access:signOut'),
  askAccessAgain: () => ipcRenderer.invoke('access:askAgain'),
  onAccessChanged: (cb) => on('access:changed', cb),
  adminList: () => ipcRenderer.invoke('access:admin:list'),
  adminDecide: (userId, status, maxDevices) => ipcRenderer.invoke('access:admin:decide', userId, status, maxDevices ?? null),
  adminSetDevices: (userId, maxDevices) => ipcRenderer.invoke('access:admin:devices', userId, maxDevices),
  adminRemoveDevice: (deviceId) => ipcRenderer.invoke('access:admin:removeDevice', deviceId),
  adminDeleteMember: (userId) => ipcRenderer.invoke('access:admin:delete', userId),
  platform: process.platform,
  listStudies: (filter) => ipcRenderer.invoke('studies:list', filter),
  getStudy: (id) => ipcRenderer.invoke('studies:get', id),
  getPriors: (id) => ipcRenderer.invoke('studies:priors', id),
  updateStudy: (id, patch) => ipcRenderer.invoke('studies:update', id, patch),
  createManualStudy: (input) => ipcRenderer.invoke('studies:createManual', input),
  updateStudyDetails: (id, patch) => ipcRenderer.invoke('studies:updateDetails', id, patch),
  findPatient: (patientId) => ipcRenderer.invoke('patients:find', patientId),
  deleteStudy: (id) => ipcRenderer.invoke('studies:delete', id),
  showStudyInFolder: (id) => ipcRenderer.invoke('studies:showInFolder', id),
  getSeriesImages: (id) => ipcRenderer.invoke('series:images', id),
  saveSeriesThumb: (id, dataUrl) => ipcRenderer.invoke('series:saveThumb', id, dataUrl),
  getSavedAnnotations: (studyId) => ipcRenderer.invoke('annotations:get', studyId),
  saveAnnotations: (studyId, json) => ipcRenderer.invoke('annotations:save', studyId, json),
  getLiverAnalysis: (studyId, seriesUid) => ipcRenderer.invoke('liver:get', studyId, seriesUid),
  saveLiverAnalysis: (studyId, seriesUid, json) => ipcRenderer.invoke('liver:save', studyId, seriesUid, json),

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
  sendReportHtml: (html) => ipcRenderer.invoke('report:html', html),
  saveImage: (dataUrl, name) => ipcRenderer.invoke('image:save', dataUrl, name),
  onKeyImage: (cb) => on('keyimage', cb),
  onReportHtml: (cb) => on('report:html', cb),
  onStudiesChanged: (cb) => on('studies:changed', cb),
  openReportFor: (id) => ipcRenderer.invoke('report:openFor', id),
  onOpenReport: (cb) => on('report:open', cb),
  editCommand: (cmd) => ipcRenderer.invoke('edit:command', cmd),
  setFullScreen: (onOff) => ipcRenderer.invoke('window:fullscreen', onOff),

  speechStatus: () => ipcRenderer.invoke('speech:status'),
  speechInstall: (id) => ipcRenderer.invoke('speech:install', id),
  speechCancelInstall: () => ipcRenderer.invoke('speech:cancelInstall'),
  speechRemove: (id) => ipcRenderer.invoke('speech:remove', id),
  speechStart: (id, pauseMs) => ipcRenderer.invoke('speech:start', id, pauseMs),
  speechStop: () => ipcRenderer.invoke('speech:stop'),
  speechAudio: (samples) => ipcRenderer.send('speech:audio', samples),
  onSpeechEvent: (cb) => on('speech:event', cb),
  toggleDictation: () => ipcRenderer.invoke('dictation:toggle'),
  onToggleDictation: (cb) => on('dictation:toggle', cb),
  dictationActive: (active) => ipcRenderer.send('dictation:active', active),
  onDictationActive: (cb) => on('dictation:active', cb),

  getReport: (id) => ipcRenderer.invoke('report:get', id),
  saveReport: (input) => ipcRenderer.invoke('report:save', input),
  listReportVersions: (id) => ipcRenderer.invoke('report:versions', id),
  exportReportPdf: (id) => ipcRenderer.invoke('report:pdf', id),
  printReport: (id) => ipcRenderer.invoke('report:print', id),
  exportReport: (id, kind) => ipcRenderer.invoke('report:export', id, kind),
  onReportsChanged: (cb) => on('reports:changed', cb),

  shareCreate: (id, opts) => ipcRenderer.invoke('share:create', id, opts),
  shareList: () => ipcRenderer.invoke('share:list'),
  shareStop: (id, close) => ipcRenderer.invoke('share:stop', id, close),
  onShareEvent: (cb) => on('share:event', cb),
  receiveStart: (input) => ipcRenderer.invoke('receive:start', input),
  receiveCancel: (jobId) => ipcRenderer.invoke('receive:cancel', jobId),
  onReceiveProgress: (cb) => on('receive:progress', cb),
  onShareLink: (cb) => on('share:link', cb),
  takeShareLink: () => ipcRenderer.invoke('share:takeLink'),
  receivedInfo: (id) => ipcRenderer.invoke('share:received', id),
  replySend: (id) => ipcRenderer.invoke('share:reply', id),
  secondOpinions: (id) => ipcRenderer.invoke('share:opinions', id),

  phoneStatus: () => ipcRenderer.invoke('phone:status'),
  phoneSetEnabled: (onOff) => ipcRenderer.invoke('phone:setEnabled', onOff),
  phoneStartPairing: () => ipcRenderer.invoke('phone:startPairing'),
  phoneCancelPairing: () => ipcRenderer.invoke('phone:cancelPairing'),
  phoneRemoveDevice: (id) => ipcRenderer.invoke('phone:removeDevice', id),
  onPhoneEvent: (cb) => on('phone:event', cb),

  listTemplates: () => ipcRenderer.invoke('templates:list'),
  saveTemplate: (t) => ipcRenderer.invoke('templates:save', t),
  deleteTemplate: (id) => ipcRenderer.invoke('templates:delete', id),
  listMacros: () => ipcRenderer.invoke('macros:list'),
  saveMacro: (m) => ipcRenderer.invoke('macros:save', m),
  deleteMacro: (id) => ipcRenderer.invoke('macros:delete', id),

  spellWords: () => ipcRenderer.invoke('spell:words'),
  spellAddWord: (word) => ipcRenderer.invoke('spell:add', word),
  spellRemoveWord: (word) => ipcRenderer.invoke('spell:remove', word),
  onSpellWordsChanged: (cb) => on('spell:changed', cb),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  pickImageAsDataUrl: () => ipcRenderer.invoke('dialog:pickImage'),
  getDataInfo: () => ipcRenderer.invoke('data:info'),
  openDataFolder: () => ipcRenderer.invoke('data:open'),
  changeDataFolder: () => ipcRenderer.invoke('data:change'),
  backupDatabase: () => ipcRenderer.invoke('data:backup')
}

contextBridge.exposeInMainWorld('api', api)
