/**
 * IPC handlers for collections, adding by identifier, the highlights index, ADS
 * discovery, manuscripts and settings. Registered together with the core handlers.
 */
import { app, dialog, shell, type BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  addByIdentifier,
  fetchPdfFor,
  parseIdentifierInput,
  type AddOutcome
} from '../core/acquire.js'
import { annotationsToMarkdown, listAnnotations } from '../core/annotations.js'
import { backupDatabase, BACKUPS_DIR, listBackups, syncFolderWarning } from '../core/backup.js'
import {
  addToCollection,
  collectionPaperIds,
  createCollection,
  deleteCollection,
  listCollections,
  removeFromCollection,
  updateCollection
} from '../core/collections.js'
import { schemaVersion } from '../core/db/database.js'
import {
  createWatch,
  deleteWatch,
  related,
  setHitState,
  watchHits,
  listWatches
} from '../core/discover.js'
import type { Inbox } from '../core/inbox.js'
import type { Library } from '../core/library.js'
import {
  addManuscript,
  analyzeManuscript,
  listManuscripts,
  markSynced,
  removeManuscript,
  writeManuscriptBib
} from '../core/manuscript.js'
import { adsList } from '../core/metadata/ads.js'
import type { Resolver } from '../core/metadata/resolver.js'
import { runQuery } from '../core/query.js'
import type { IpcContract, IpcEvents, ManuscriptView, TokenSource, UiPrefs } from '../shared/ipc.js'

const DEFAULT_PREFS: UiPrefs = {
  pinnedTags: [],
  collapsed: [],
  density: 'comfortable',
  readerRelated: true
}
import { libraryRoot, setLibraryRoot, setStoredToken } from './appConfig.js'
import { disposeFile } from './dispose.js'
import type { Jobs } from './jobs.js'

type Handler<K extends keyof IpcContract> = (
  ...args: IpcContract[K]['args']
) => IpcContract[K]['result'] | Promise<IpcContract[K]['result']>

export interface FeatureContext {
  lib: Library
  inbox: Inbox
  jobs: Jobs
  getWindow: () => BrowserWindow | null
  emit: <K extends keyof IpcEvents>(event: K, payload?: IpcEvents[K]) => void
  resolver: () => Resolver
  token: () => { token?: string | undefined; source: TokenSource }
  refreshToken: () => Promise<TokenSource>
  /** Something changed files in the library: refresh the window and the annotation index. */
  filesChanged: () => void
}

export function featureHandlers(ctx: FeatureContext) {
  const { lib, jobs, emit } = ctx
  const needToken = (): string => {
    const t = ctx.token().token
    if (!t) throw new Error('This needs an ADS token (Settings → ADS)')
    return t
  }
  const dialogParent = () => ctx.getWindow() ?? undefined

  const manuscriptView = async (id: number): Promise<ManuscriptView> => {
    const m = listManuscripts(lib).find((x) => x.id === id)
    if (!m) throw new Error('No such manuscript')
    const base = { ...m, name: basename(m.path) }
    try {
      const a = await analyzeManuscript(lib, m.path)
      return {
        ...base,
        bibPath: a.bibPath,
        bibExists: a.bibExists,
        texFiles: a.texFiles,
        keys: a.keys
      }
    } catch (err) {
      return { ...base, error: (err as Error).message }
    }
  }

  const addMany = async (items: { input: string; tags: string[] }[]): Promise<AddOutcome[]> => {
    const out: AddOutcome[] = []
    for (const [i, it] of items.entries()) {
      emit('importProgress', { done: i, total: items.length, current: it.input })
      const id = parseIdentifierInput(it.input)
      if (!id) continue
      try {
        out.push(await addByIdentifier(lib, id, { resolver: ctx.resolver(), tags: it.tags }))
      } catch (err) {
        out.push({
          status: 'exists',
          paperId: -1,
          notes: [`${it.input}: ${(err as Error).message}`]
        })
      }
    }
    emit('importProgress', { done: items.length, total: items.length, current: null })
    ctx.filesChanged()
    return out.filter((o) => o.paperId !== -1 || o.notes.length)
  }

  return {
    // ── Query language and collections ──────────────────────────────────────
    query: (q) => runQuery(lib, q, 1000).map((h) => ({ id: h.id, snippet: h.snippet ?? '' })),
    setReading: (ids, reading) => {
      for (const id of ids) lib.setReading(id, reading)
      emit('libraryChanged')
    },
    setStarred: (ids, starred) => {
      for (const id of ids) lib.setStarred(id, starred)
      emit('libraryChanged')
    },
    listCollections: () => listCollections(lib),
    createCollection: (name, query) => {
      const id = createCollection(lib, name, query ?? undefined)
      emit('libraryChanged')
      return id
    },
    updateCollection: (id, changes) => {
      updateCollection(lib, id, changes)
      emit('libraryChanged')
    },
    deleteCollection: (id) => {
      deleteCollection(lib, id)
      emit('libraryChanged')
    },
    addToCollection: (id, paperIds) => {
      addToCollection(lib, id, paperIds)
      emit('libraryChanged')
    },
    removeFromCollection: (id, paperIds) => {
      removeFromCollection(lib, id, paperIds)
      emit('libraryChanged')
    },
    collectionPaperIds: (id) => collectionPaperIds(lib, id),

    // ── Adding by identifier ────────────────────────────────────────────────
    addByIdentifier: async (input, tags) => {
      const id = parseIdentifierInput(input)
      if (!id) throw new Error('Paste a DOI, arXiv id, ADS bibcode, or an ADS, arXiv or DOI link')
      const out = await addByIdentifier(lib, id, { resolver: ctx.resolver(), tags })
      ctx.filesChanged()
      return out
    },
    fetchPdf: async (paperId) => {
      const out = await fetchPdfFor(lib, paperId)
      ctx.filesChanged()
      return out
    },
    attachPdf: async (paperId) => {
      const options: Electron.OpenDialogOptions = {
        title: 'Attach a PDF to this paper',
        buttonLabel: 'Attach',
        properties: ['openFile'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      }
      const parent = dialogParent()
      const res = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      if (res.canceled || !res.filePaths[0]) return false
      await lib.importPdf(res.filePaths[0], { attachTo: paperId })
      ctx.filesChanged()
      return true
    },

    // ── Changing a paper's PDF ──────────────────────────────────────────────
    replaceFile: async (fileId) => {
      const options: Electron.OpenDialogOptions = {
        title: 'Replace this PDF',
        message: 'Choose the PDF to use instead, such as the journal version you downloaded.',
        buttonLabel: 'Replace',
        defaultPath: app.getPath('downloads'),
        properties: ['openFile'],
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      }
      const parent = dialogParent()
      const res = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      if (res.canceled || !res.filePaths[0]) return null
      const r = await lib.replaceFile(fileId, res.filePaths[0], disposeFile)
      ctx.filesChanged()
      return { relPath: r.relPath }
    },
    replaceFileWithPath: async (fileId, path) => {
      const r = await lib.replaceFile(fileId, path, disposeFile)
      ctx.filesChanged()
      return { relPath: r.relPath }
    },
    attachPath: async (paperId, path) => {
      const r = await lib.importPdf(path, { attachTo: paperId, replacePreprints: disposeFile })
      ctx.filesChanged()
      return { relPath: r.relPath, replaced: r.replaced }
    },
    getPublisherPdf: async (paperId) => {
      const r = await fetchPdfFor(lib, paperId, {
        only: 'publisher',
        replacePreprints: disposeFile
      })
      ctx.filesChanged()
      return r
    },

    // ── Interface preferences and status ────────────────────────────────────
    getPrefs: () => ({ ...DEFAULT_PREFS, ...lib.getSetting<Partial<UiPrefs>>('ui.prefs', {}) }),
    setPrefs: (prefs) => {
      const next = {
        ...DEFAULT_PREFS,
        ...lib.getSetting<Partial<UiPrefs>>('ui.prefs', {}),
        ...prefs
      }
      lib.setSetting('ui.prefs', next)
      return next
    },
    getStatus: () => jobs.status(),

    // ── Highlights index ────────────────────────────────────────────────────
    listAnnotations: (opts) => listAnnotations(lib, opts),
    exportAnnotations: async (opts, suggestedName) => {
      const md = annotationsToMarkdown(listAnnotations(lib, opts))
      const options: Electron.SaveDialogOptions = {
        title: 'Export highlights and notes',
        defaultPath: join(
          app.getPath('documents'),
          `${suggestedName.replace(/[^\w.-]+/g, '_') || 'highlights'}.md`
        ),
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      }
      const parent = dialogParent()
      const res = parent
        ? await dialog.showSaveDialog(parent, options)
        : await dialog.showSaveDialog(options)
      if (res.canceled || !res.filePath) return null
      await writeFile(res.filePath, md, 'utf8')
      return res.filePath
    },

    // ── ADS discovery ───────────────────────────────────────────────────────
    related: (paperId, kind) =>
      related(lib, paperId, kind, { fetch: globalThis.fetch, token: needToken() }),
    getDiscover: () => ({
      hasToken: !!ctx.token().token,
      watches: listWatches(lib),
      hits: watchHits(lib, 'new'),
      published: jobs.publishedResults(),
      publishedCheckedAt: lib.getSetting<string | undefined>('published.checkedAt', undefined),
      running: jobs.watchesRunning
    }),
    createWatch: async (name, query) => {
      needToken()
      // Validate the query against ADS before saving it.
      await adsList(globalThis.fetch, needToken(), query, { rows: 1 })
      const id = createWatch(lib, name, query)
      void jobs.runWatches()
      return id
    },
    deleteWatch: (id) => {
      deleteWatch(lib, id)
      emit('discoverChanged')
    },
    runWatches: () => jobs.runWatches(),
    setHitState: (bibcodes, state) => {
      setHitState(lib, bibcodes, state)
      emit('discoverChanged')
    },
    addFromAds: async (bibcodes, tags) => {
      const out = await addMany(bibcodes.map((b) => ({ input: b, tags })))
      setHitState(lib, bibcodes, 'added')
      emit('discoverChanged')
      return out
    },
    checkPublished: () => jobs.checkPublished(),
    adoptPublished: async (paperId) => {
      // ADS returns the journal record for the arXiv id; resolving adopts its metadata.
      const r = await lib.resolvePaper(paperId, ctx.resolver())
      const got = await fetchPdfFor(lib, r.paperId, { replacePreprints: disposeFile })
      ctx.filesChanged()
      emit('discoverChanged')
      return got
    },

    // ── Manuscripts ─────────────────────────────────────────────────────────
    listManuscripts: () => listManuscripts(lib).map((m) => ({ ...m, name: basename(m.path) })),
    addManuscript: async () => {
      const options: Electron.OpenDialogOptions = {
        title: 'Choose a LaTeX project folder',
        buttonLabel: 'Add',
        properties: ['openDirectory']
      }
      const parent = dialogParent()
      const res = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      if (res.canceled || !res.filePaths[0]) return null
      return addManuscript(lib, res.filePaths[0])
    },
    removeManuscript: (id) => removeManuscript(lib, id),
    analyzeManuscript: (id) => manuscriptView(id),
    writeManuscriptBib: async (id) => {
      const m = listManuscripts(lib).find((x) => x.id === id)
      if (!m) throw new Error('No such manuscript')
      const result = await writeManuscriptBib(lib, await analyzeManuscript(lib, m.path))
      markSynced(lib, id)
      return result
    },
    addMissingReferences: async (id) => {
      const view = await manuscriptView(id)
      const inputs = (view.keys ?? [])
        .filter((k) => k.status !== 'library' && k.identifier)
        .map((k) => ({ input: k.identifier!.value, tags: [] }))
      return addMany(inputs)
    },
    collectManuscript: async (id) => {
      const view = await manuscriptView(id)
      const name = `Cited in ${view.name}`
      const existing = listCollections(lib).find((c) => c.name.toLowerCase() === name.toLowerCase())
      const cid = existing?.id ?? createCollection(lib, name)
      const ids = (view.keys ?? []).flatMap((k) => (k.paperId !== undefined ? [k.paperId] : []))
      addToCollection(lib, cid, ids)
      emit('libraryChanged')
      return cid
    },
    revealPath: (path) => {
      // Only paths this app deals in: the library, manuscripts, or their files.
      const allowed = [lib.root, ...listManuscripts(lib).map((m) => m.path)]
      if (!allowed.some((a) => path === a || path.startsWith(a + '/')))
        throw new Error('Not a library path')
      shell.showItemInFolder(path)
    },

    // ── Settings ────────────────────────────────────────────────────────────
    getSettings: () => {
      const backups = listBackups(lib)
      const { fromEnv } = libraryRoot()
      return {
        libraryRoot: lib.root,
        libraryFromEnv: fromEnv,
        adsTokenSource: ctx.token().source,
        citeTags: lib.autoCiteTags,
        trashAfterFiling: ctx.inbox.trashAfterFiling,
        inboxFolders: ctx.inbox.folders(),
        backups: { dir: join(lib.root, BACKUPS_DIR), count: backups.length, last: backups[0]?.at },
        syncWarning: syncFolderWarning(lib.root),
        version: app.getVersion(),
        schemaVersion: schemaVersion(lib.db)
      }
    },
    setAdsToken: async (token) => {
      setStoredToken(token)
      const source = await ctx.refreshToken()
      emit('discoverChanged')
      return source
    },
    testAdsToken: async () => {
      const t = ctx.token().token
      if (!t) return { ok: false, message: 'No token set' }
      try {
        await adsList(globalThis.fetch, t, 'bibcode:"2024ApJ...975..288D"', { rows: 1 })
        return { ok: true, message: 'ADS accepted the token' }
      } catch (err) {
        return { ok: false, message: (err as Error).message }
      }
    },
    setCiteTags: (on) => {
      lib.autoCiteTags = on
    },
    chooseLibraryFolder: async () => {
      if (libraryRoot().fromEnv) throw new Error('The library is set by PM_LIBRARY')
      const options: Electron.OpenDialogOptions = {
        title: 'Choose a library folder',
        message: 'Pick an existing PaperManager library, or an empty folder for a new one.',
        buttonLabel: 'Use this folder',
        properties: ['openDirectory', 'createDirectory']
      }
      const parent = dialogParent()
      const res = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
      if (res.canceled || !res.filePaths[0] || res.filePaths[0] === lib.root) return false
      setLibraryRoot(res.filePaths[0])
      app.relaunch()
      app.quit()
      return true
    },
    backupNow: () => backupDatabase(lib)
  } satisfies { [K in Exclude<keyof IpcContract, CoreChannel>]: Handler<K> }
}

/** Channels implemented in handlers.ts. */
export type CoreChannel =
  | 'getLibraryInfo'
  | 'listPapers'
  | 'tagCounts'
  | 'search'
  | 'getPaper'
  | 'addTags'
  | 'removeTags'
  | 'setNote'
  | 'setManualMetadata'
  | 'unlockMetadata'
  | 'resolvePaper'
  | 'removePaper'
  | 'chooseAndImport'
  | 'importPaths'
  | 'readPdf'
  | 'saveAnnotations'
  | 'restoreOriginal'
  | 'removeFile'
  | 'shareFile'
  | 'saveFileCopy'
  | 'openFile'
  | 'revealFile'
  | 'openUrl'
  | 'exportBibtex'
  | 'saveBibtex'
  | 'verify'
  | 'getInbox'
  | 'rescanInbox'
  | 'acceptInbox'
  | 'ignoreInbox'
  | 'unignoreInbox'
  | 'addInboxFolder'
  | 'removeInboxFolder'
  | 'setTrashAfterFiling'
  | 'disposeFiledOriginals'
  | 'readInboxPdf'
