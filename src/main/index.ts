import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { app, BrowserWindow, dialog, Menu, nativeTheme, net, protocol, shell } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_INBOX_FOLDERS } from '../core/inbox.js'
import { Library } from '../core/library.js'
import { EVENT_PREFIX, type IpcEvents } from '../shared/ipc.js'
import { adsToken, libraryRoot } from './appConfig.js'
import { registerHandlers } from './handlers.js'
import { Jobs } from './jobs.js'
import { InboxService } from './inboxService.js'

app.setName('PaperManager')

// The packaged renderer is served from app://renderer/ rather than file://. Chromium treats
// file:// as an opaque origin, which breaks fetch() and module workers, both of which pdf.js
// uses for its worker, character maps and fonts.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])
const RENDERER_DIR = join(import.meta.dirname, '../renderer')

function serveRenderer(): void {
  protocol.handle('app', (request) => {
    const { host, pathname } = new URL(request.url)
    const file = normalize(join(RENDERER_DIR, decodeURIComponent(pathname)))
    if (host !== 'renderer' || !file.startsWith(RENDERER_DIR + sep)) {
      return new Response('Not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(file).toString())
  })
}

// E2E tests and alternative libraries: PM_LIBRARY picks the folder, PM_USER_DATA isolates
// Electron's own state (window caches etc.) from the real app.
if (process.env.PM_USER_DATA) app.setPath('userData', process.env.PM_USER_DATA)
const hideWindow = process.env.PM_HIDE_WINDOW === '1'

const DARK_BG = '#18191b'
const LIGHT_BG = '#fbfbfa'

let mainWindow: BrowserWindow | null = null
let library: Library | null = null
let inbox: InboxService | null = null
let jobs: Jobs | null = null

function send<K extends keyof IpcEvents>(event: K, payload: IpcEvents[K]): void {
  mainWindow?.webContents.send(EVENT_PREFIX + event, payload)
}

function installMenu(): void {
  const isMac = process.platform === 'darwin'
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac
        ? [
            {
              label: app.name,
              submenu: [
                { role: 'about' as const },
                { type: 'separator' as const },
                {
                  label: 'Settings…',
                  accelerator: 'CmdOrCtrl+,',
                  click: () => send('menu', 'settings')
                },
                { type: 'separator' as const },
                { role: 'services' as const },
                { type: 'separator' as const },
                { role: 'hide' as const },
                { role: 'hideOthers' as const },
                { role: 'unhide' as const },
                { type: 'separator' as const },
                { role: 'quit' as const }
              ]
            }
          ]
        : []),
      {
        label: 'File',
        submenu: [
          {
            label: 'Import PDFs…',
            accelerator: 'CmdOrCtrl+O',
            click: () => send('menu', 'import')
          },
          {
            label: 'Add Paper by Identifier…',
            accelerator: 'CmdOrCtrl+Shift+N',
            click: () => send('menu', 'add')
          },
          {
            label: 'Export BibTeX…',
            accelerator: 'CmdOrCtrl+Shift+E',
            click: () => send('menu', 'export')
          },
          { type: 'separator' },
          {
            label: 'Show Library in Finder',
            click: () => library && void shell.openPath(library.root)
          },
          { type: 'separator' },
          isMac ? { role: 'close' } : { role: 'quit' }
        ]
      },
      {
        role: 'editMenu',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
          { type: 'separator' },
          { label: 'Find', accelerator: 'CmdOrCtrl+F', click: () => send('menu', 'find') }
        ]
      },
      {
        role: 'viewMenu',
        submenu: [
          ...(is.dev ? [{ role: 'reload' as const }, { role: 'toggleDevTools' as const }] : []),
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      { role: 'windowMenu' }
    ])
  )
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 960,
    minHeight: 560,
    show: false,
    title: 'PaperManager',
    backgroundColor: nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG,
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 15 } }
      : {}),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: !hideWindow
    }
  })

  mainWindow.on('ready-to-show', () => {
    if (!hideWindow) mainWindow?.show()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // The renderer never navigates or opens windows itself; links go through openUrl.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault()
  })

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadURL('app://renderer/index.html')
  }
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('org.sr-dash.papermanager')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  const { root } = libraryRoot()
  try {
    library = Library.open(root)
  } catch (err) {
    // Most likely a library written by a newer build (SchemaTooNewError): never touch it.
    dialog.showErrorBox(
      'PaperManager cannot open the library',
      `${root}\n\n${(err as Error).message}`
    )
    app.exit(1)
    return
  }

  serveRenderer()
  // PM_INBOX_FOLDERS (colon-separated) replaces the default ~/Downloads until the user
  // picks folders in the app; tests use it to watch a scratch folder.
  const inboxDefaults =
    process.env.PM_INBOX_FOLDERS?.split(':').filter(Boolean) ?? DEFAULT_INBOX_FOLDERS
  inbox = new InboxService(library, inboxDefaults, (event) => {
    if (event === 'changed') send('inboxChanged', undefined)
    else send('inboxProgress', inbox?.progress ?? null)
  })
  jobs = new Jobs(
    library,
    async () => (await adsToken()).token,
    (what) => {
      if (what === 'status') send('status', jobs!.status())
      else send(what === 'library' ? 'libraryChanged' : 'discoverChanged', undefined)
    }
  )
  await registerHandlers(library, inbox, jobs, () => mainWindow)
  installMenu()
  nativeTheme.on('updated', () =>
    mainWindow?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG)
  )
  // Packaged builds take the icon from the bundle; in dev the Dock would show Electron's.
  if (is.dev && process.platform === 'darwin') {
    app.dock?.setIcon(join(import.meta.dirname, '../../build/icon.png'))
  }
  createWindow()
  if (hideWindow) app.dock?.hide()
  inbox.start()
  jobs.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  inbox?.stop()
  jobs?.stop()
  library?.close()
  library = null
})
