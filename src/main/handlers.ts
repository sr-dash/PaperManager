import { app, BrowserWindow, dialog, ipcMain, shell, ShareMenu } from 'electron'
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { schemaVersion } from '../core/db/database.js'
import { Library, NotPdfError } from '../core/library.js'
import type { InboxService } from './inboxService.js'
import { createResolver, type Resolver } from '../core/metadata/resolver.js'
import { listAnnotations } from '../core/annotations.js'
import { collectionsOf } from '../core/collections.js'
import { adsToken } from './appConfig.js'
import { disposeFile } from './dispose.js'
import { featureHandlers } from './featureHandlers.js'
import type { Jobs } from './jobs.js'
import {
  EVENT_PREFIX,
  INVOKE_PREFIX,
  type ImportOutcome,
  type IpcContract,
  type IpcEvents,
  type PaperDetail
} from '../shared/ipc.js'

type Handlers = {
  [K in keyof IpcContract]: (
    ...args: IpcContract[K]['args']
  ) => IpcContract[K]['result'] | Promise<IpcContract[K]['result']>
}

export async function registerHandlers(
  lib: Library,
  inbox: InboxService,
  jobs: Jobs,
  getWindow: () => BrowserWindow | null
): Promise<void> {
  // The token can change in Settings; the resolver follows it.
  let ads = await adsToken()
  let resolverCache: Resolver = createResolver({ adsToken: ads.token })
  const resolver = (): Resolver => resolverCache
  const refreshToken = async () => {
    ads = await adsToken()
    resolverCache = createResolver({ adsToken: ads.token })
    return ads.source
  }

  const emit = <K extends keyof IpcEvents>(event: K, payload?: IpcEvents[K]): void => {
    getWindow()?.webContents.send(EVENT_PREFIX + event, payload)
  }

  const filesChanged = () => {
    emit('libraryChanged')
    void jobs.indexAnnotations()
  }

  const fileById = (fileId: number) => {
    const row = lib.db.prepare('SELECT rel_path, paper_id FROM files WHERE id = ?').get(fileId) as
      { rel_path: string; paper_id: number } | undefined
    if (!row) throw new Error(`No file with id ${fileId}`)
    return { ...row, path: join(lib.root, row.rel_path) }
  }

  // One import at a time: the batch is sequential anyway, and progress events assume it.
  let importQueue: Promise<unknown> = Promise.resolve()
  const importPaths = (paths: string[]): Promise<ImportOutcome[]> => {
    const run = async () => {
      const outcomes: ImportOutcome[] = []
      const files = await expandPdfs(paths)
      for (const [i, path] of files.entries()) {
        emit('importProgress', { done: i, total: files.length, current: basename(path) })
        let outcome: ImportOutcome
        try {
          const r = await lib.importPdf(path, {
            resolver: resolver(),
            replacePreprints: disposeFile
          })
          outcome = { path, status: r.status, paperId: r.paperId, metadataStatus: r.metadataStatus }
        } catch (err) {
          const error = err instanceof NotPdfError ? 'Not a PDF' : (err as Error).message
          outcome = { path, status: 'failed', error }
        }
        outcomes.push(outcome)
        emit('importProgress', { done: i + 1, total: files.length, current: null, last: outcome })
      }
      filesChanged()
      return outcomes
    }
    const next = importQueue.then(run, run)
    importQueue = next.catch(() => {})
    return next
  }

  const handlers: Handlers = {
    ...featureHandlers({
      lib,
      inbox: inbox.inbox,
      jobs,
      getWindow,
      emit,
      resolver,
      token: () => ads,
      refreshToken,
      filesChanged
    }),
    getLibraryInfo: () => ({
      root: lib.root,
      schemaVersion: schemaVersion(lib.db),
      adsToken: !!ads.token,
      platform: process.platform
    }),
    listPapers: () => lib.listRows(),
    tagCounts: () => lib.tagCounts(),
    search: (query) => lib.search(query, 500).map((h) => ({ id: h.paper.id, snippet: h.snippet })),
    getPaper: (id): PaperDetail | null => {
      const row = lib.getPaper(id)
      if (!row) return null
      return {
        row,
        metadata: lib.metadataOf(id),
        tags: lib.tagsOf(id),
        note: lib.getNote(id),
        collections: collectionsOf(lib, id),
        annotations: listAnnotations(lib, { paperId: id, includeDrawings: true }),
        files: lib.filesOf(id).map((f) => ({
          id: f.id,
          name: basename(f.rel_path),
          path: join(lib.root, f.rel_path),
          size: f.size,
          originalName: f.original_name,
          annotated: f.original_sha256 !== null,
          origin: f.origin
        }))
      }
    },

    addTags: (id, tags) => lib.addTags(id, tags),
    removeTags: (id, tags) => lib.removeTags(id, tags),
    setNote: (id, body) => lib.setNote(id, body),
    setManualMetadata: (id, metadata) => lib.setManualMetadata(id, metadata),
    unlockMetadata: (id) => lib.unlockMetadata(id),
    resolvePaper: (id) => lib.resolvePaper(id, resolver()),
    removePaper: (id) => lib.removePaper(id, disposeFile),

    chooseAndImport: async () => {
      const win = getWindow()
      const options: Electron.OpenDialogOptions = {
        title: 'Import PDFs',
        buttonLabel: 'Import',
        properties: ['openFile', 'openDirectory', 'multiSelections'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      }
      const res = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      return res.canceled ? [] : importPaths(res.filePaths)
    },
    importPaths: (paths) => importPaths(paths),

    readPdf: async (fileId) => new Uint8Array(await readFile(fileById(fileId).path)),
    saveAnnotations: async (fileId, bytes) => {
      await lib.saveFileVersion(fileId, bytes)
      filesChanged()
    },
    restoreOriginal: async (fileId) => {
      await lib.restoreOriginal(fileId)
      filesChanged()
    },
    removeFile: async (fileId) => {
      await lib.removeFile(fileId, disposeFile)
      filesChanged()
    },
    shareFile: (fileId) => {
      const { path } = fileById(fileId)
      const win = getWindow()
      if (process.platform === 'darwin' && win)
        new ShareMenu({ filePaths: [path] }).popup({ window: win })
      else shell.showItemInFolder(path)
    },
    saveFileCopy: async (fileId) => {
      const { path } = fileById(fileId)
      const win = getWindow()
      const options: Electron.SaveDialogOptions = {
        title: 'Save a copy',
        defaultPath: join(app.getPath('desktop'), basename(path)),
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      }
      const res = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (res.canceled || !res.filePath) return null
      await copyFile(path, res.filePath)
      return res.filePath
    },
    openFile: async (fileId) => {
      const err = await shell.openPath(fileById(fileId).path)
      if (err) throw new Error(err)
    },
    revealFile: (fileId) => shell.showItemInFolder(fileById(fileId).path),
    openUrl: async (url) => {
      // Only web links reach the OS: never file:, javascript: or custom schemes.
      if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened')
      await shell.openExternal(url)
    },

    exportBibtex: (ids) => lib.exportBibtex(ids),
    saveBibtex: async (ids, suggestedName) => {
      const win = getWindow()
      const options: Electron.SaveDialogOptions = {
        title: 'Export BibTeX',
        defaultPath: `${suggestedName.replace(/[^\w.-]+/g, '_') || 'references'}.bib`,
        filters: [{ name: 'BibTeX', extensions: ['bib'] }]
      }
      const res = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options)
      if (res.canceled || !res.filePath) return null
      await writeFile(res.filePath, lib.exportBibtex(ids), 'utf8')
      return res.filePath
    },
    verify: async (deep) => {
      const issues = await lib.verify({ deep })
      lib.setSetting('verify.last', { at: new Date().toISOString(), issues: issues.length })
      emit('status', jobs.status())
      return issues
    },

    getInbox: () => ({
      folders: inbox.inbox.folders(),
      trashAfterFiling: inbox.inbox.trashAfterFiling,
      items: inbox.inbox.items(),
      scanning: inbox.progress
    }),
    rescanInbox: () => inbox.rescan(),
    acceptInbox: async (paths, tags) => {
      const outcomes = await inbox.inbox.accept(paths, {
        resolver: resolver(),
        tags,
        dispose: disposeFile,
        replacePreprints: disposeFile,
        onProgress: (p) => emit('importProgress', p)
      })
      filesChanged()
      emit('inboxChanged')
      return outcomes.map((o): ImportOutcome => {
        if (!o.result) return { path: o.path, status: 'failed', error: o.error }
        return {
          path: o.path,
          status: o.result.status,
          paperId: o.result.paperId,
          metadataStatus: o.result.metadataStatus
        }
      })
    },
    ignoreInbox: (paths) => {
      inbox.inbox.ignore(paths)
      emit('inboxChanged')
    },
    unignoreInbox: (paths) => {
      inbox.inbox.unignore(paths)
      emit('inboxChanged')
    },
    addInboxFolder: async () => {
      const win = getWindow()
      const options: Electron.OpenDialogOptions = {
        title: 'Watch a folder for new papers',
        buttonLabel: 'Watch',
        properties: ['openDirectory']
      }
      const res = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (!res.canceled && res.filePaths[0]) {
        inbox.inbox.setFolders([...inbox.inbox.folders(), res.filePaths[0]])
        inbox.rewatch()
        void inbox.rescan()
      }
      return inbox.inbox.folders()
    },
    removeInboxFolder: (folder) => {
      inbox.inbox.setFolders(inbox.inbox.folders().filter((f) => f !== folder))
      inbox.rewatch()
      emit('inboxChanged')
      return inbox.inbox.folders()
    },
    setTrashAfterFiling: (on) => {
      inbox.inbox.trashAfterFiling = on
    },
    disposeFiledOriginals: async () => {
      const n = await inbox.inbox.disposeFiled(disposeFile)
      emit('inboxChanged')
      return n
    },
    readInboxPdf: async (path) => {
      if (!inbox.inbox.item(path)) throw new Error('Not an inbox file')
      return new Uint8Array(await readFile(path))
    }
  }

  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle(INVOKE_PREFIX + name, (_event, ...args: unknown[]) =>
      (fn as (...a: unknown[]) => unknown)(...args)
    )
  }
}

/** Files are taken as given; folders contribute the PDFs directly inside them. */
async function expandPdfs(paths: string[]): Promise<string[]> {
  const { readdir } = await import('node:fs/promises')
  const out: string[] = []
  for (const p of paths) {
    const st = await stat(p).catch(() => undefined)
    if (!st) continue
    if (st.isDirectory()) {
      for (const name of (await readdir(p)).sort()) {
        if (name.toLowerCase().endsWith('.pdf') && !name.startsWith('.')) out.push(join(p, name))
      }
    } else {
      out.push(p)
    }
  }
  return out
}
