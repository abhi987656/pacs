import { app, BrowserWindow, Menu, MenuItem, screen, shell } from 'electron'
import type { Rectangle } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ORIGIN } from './protocol'

interface WinState {
  bounds?: Rectangle
  maximized?: boolean
}
type StateFile = Record<string, WinState>

const stateFile = () => join(app.getPath('userData'), 'window-state.json')

function readState(): StateFile {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8')) as StateFile
  } catch {
    return {}
  }
}

function saveState(key: string, win: BrowserWindow): void {
  try {
    const all = readState()
    all[key] = { bounds: win.getNormalBounds(), maximized: win.isMaximized() }
    writeFileSync(stateFile(), JSON.stringify(all, null, 2))
  } catch {
    /* ignore */
  }
}

function boundsVisible(b: Rectangle): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y < a.y + a.height - 50 && b.y + b.height > a.y
  })
}

function pageUrl(page: 'index' | 'viewer'): string {
  const dev = process.env.ELECTRON_RENDERER_URL
  return dev ? `${dev}/${page}.html` : `${APP_ORIGIN}/${page}.html`
}

const preloadPath = () => join(__dirname, '../preload/index.js')

function attachCommonHandlers(win: BrowserWindow, allowContextMenu: boolean): void {
  // Open external links in the default browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    const dev = process.env.ELECTRON_RENDERER_URL
    if (!(url.startsWith(APP_ORIGIN) || (dev && url.startsWith(dev)))) e.preventDefault()
  })
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'i') {
      win.webContents.toggleDevTools()
    }
  })
  if (allowContextMenu) {
    // Spell-check suggestions + clipboard menu for the report editor.
    win.webContents.on('context-menu', (_e, params) => {
      const menu = new Menu()
      for (const s of params.dictionarySuggestions.slice(0, 6)) {
        menu.append(new MenuItem({ label: s, click: () => win.webContents.replaceMisspelling(s) }))
      }
      if (params.misspelledWord) {
        if (params.dictionarySuggestions.length === 0) menu.append(new MenuItem({ label: 'No suggestions', enabled: false }))
        menu.append(
          new MenuItem({
            label: `Add "${params.misspelledWord}" to dictionary`,
            click: () => win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
          })
        )
        menu.append(new MenuItem({ type: 'separator' }))
      }
      if (params.isEditable) {
        menu.append(new MenuItem({ role: 'cut', enabled: params.editFlags.canCut }))
        menu.append(new MenuItem({ role: 'copy', enabled: params.editFlags.canCopy }))
        menu.append(new MenuItem({ role: 'paste', enabled: params.editFlags.canPaste }))
        menu.append(new MenuItem({ role: 'selectAll' }))
      } else if (params.selectionText) {
        menu.append(new MenuItem({ role: 'copy' }))
      }
      if (menu.items.length) menu.popup({ window: win })
    })
  }
}

export function createMainWindow(): BrowserWindow {
  const st = readState().main
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    title: 'Personal PACS',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    ...(st?.bounds && boundsVisible(st.bounds) ? st.bounds : {}),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      // Keep dictation running while the viewer window has the focus.
      backgroundThrottling: false
    }
  })
  win.setMenuBarVisibility(false)
  attachCommonHandlers(win, true)
  win.once('ready-to-show', () => {
    if (!st || st.maximized !== false) win.maximize()
    win.show()
  })
  win.on('close', () => saveState('main', win))
  void win.loadURL(pageUrl('index'))
  return win
}

export function createViewerWindow(mainWin: BrowserWindow | null): BrowserWindow {
  const st = readState().viewer
  let bounds: Partial<Rectangle> = {}
  if (st?.bounds && boundsVisible(st.bounds)) {
    bounds = st.bounds
  } else {
    // Prefer a second monitor for the images, like a reading workstation.
    const displays = screen.getAllDisplays()
    const mainDisplay = mainWin ? screen.getDisplayMatching(mainWin.getBounds()) : screen.getPrimaryDisplay()
    const other = displays.find((d) => d.id !== mainDisplay.id)
    const target = other ?? mainDisplay
    bounds = { ...target.workArea }
  }
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    show: false,
    title: 'Personal PACS – Viewer',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    ...bounds,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })
  win.setMenuBarVisibility(false)
  attachCommonHandlers(win, false)
  win.once('ready-to-show', () => {
    if (!st || st.maximized !== false) win.maximize()
    win.show()
  })
  win.on('close', () => saveState('viewer', win))
  void win.loadURL(pageUrl('viewer'))
  return win
}
