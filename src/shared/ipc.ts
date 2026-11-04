/**
 * The whole main ↔ renderer surface in one place. The preload bridge and the main
 * handlers are both typed against `IpcContract`, so a drift between them is a compile
 * error rather than a runtime surprise.
 */
import type { AddOutcome } from '../core/acquire.js'
import type { IndexedAnnotation } from '../core/annotations.js'
import type { Collection } from '../core/collections.js'
import type { PublishedVersion, RelatedItem, Watch, WatchHit } from '../core/discover.js'
import type { CitedKey, Manuscript, WriteResult } from '../core/manuscript.js'
import type { FileOrigin } from '../core/origin.js'
import type {
  InboxItem,
  Issue,
  Metadata,
  PaperListRow,
  PaperRow,
  ReadingStatus
} from '../core/types.js'

export type {
  AddOutcome,
  CitedKey,
  Collection,
  IndexedAnnotation,
  InboxItem,
  Issue,
  Manuscript,
  Metadata,
  PaperListRow,
  PaperRow,
  PublishedVersion,
  ReadingStatus,
  RelatedItem,
  Watch,
  WatchHit,
  WriteResult
}

export interface LibraryInfo {
  root: string
  schemaVersion: number
  adsToken: boolean
  platform: string
}

export interface PaperFile {
  id: number
  name: string
  path: string
  size: number
  originalName: string | null
  /** Saved with annotations; the untouched original is kept and can be restored. */
  annotated: boolean
  origin: FileOrigin | null
}

/** Interface preferences, stored with the library. */
export interface UiPrefs {
  pinnedTags: string[]
  /** Sidebar sections the user has folded. */
  collapsed: string[]
  density: 'comfortable' | 'compact'
  /** The references and citations panel beside the reader. */
  readerRelated: boolean
}

/** What is happening in the background, for the status bar. */
export interface StatusInfo {
  indexing: { done: number; total: number } | null
  classifying: { done: number; total: number } | null
  checkingAds: boolean
  lastVerify?: { at: string; issues: number } | undefined
}

export interface ReplaceOutcome {
  relPath: string
  /** arXiv PDFs that the new publisher PDF took the place of. */
  replaced?: string[] | undefined
}

export interface PaperDetail {
  row: PaperRow
  metadata: Metadata
  tags: string[]
  files: PaperFile[]
  note: string
  collections: { id: number; name: string }[]
  annotations: IndexedAnnotation[]
}

export interface ManuscriptView extends Manuscript {
  name: string
  bibPath?: string | undefined
  bibExists?: boolean | undefined
  texFiles?: string[] | undefined
  keys?: CitedKey[] | undefined
  error?: string | undefined
}

export type TokenSource = 'env' | 'app' | 'file' | null

export interface AppSettings {
  libraryRoot: string
  /** PM_LIBRARY is set, so the folder cannot be changed from the app. */
  libraryFromEnv: boolean
  adsTokenSource: TokenSource
  citeTags: boolean
  trashAfterFiling: boolean
  inboxFolders: string[]
  backups: { dir: string; count: number; last?: string | undefined }
  syncWarning?: string | undefined
  version: string
  schemaVersion: number
}

export interface DiscoverState {
  hasToken: boolean
  watches: Watch[]
  hits: WatchHit[]
  published: PublishedVersion[]
  publishedCheckedAt?: string | undefined
  running: boolean
}

export interface SearchResult {
  id: number
  snippet: string
}

export interface ImportOutcome {
  path: string
  status: 'imported' | 'duplicate' | 'attached' | 'failed'
  paperId?: number
  metadataStatus?: PaperRow['metadata_status']
  error?: string
}

export interface ImportProgress {
  done: number
  total: number
  current: string | null
  last?: ImportOutcome
}

export interface ResolveOutcome {
  status: 'resolved' | 'merged' | 'unchanged'
  paperId: number
  errors: string[]
}

export interface InboxState {
  folders: string[]
  trashAfterFiling: boolean
  items: InboxItem[]
  scanning: { done: number; total: number } | null
}

export interface IpcContract {
  getLibraryInfo: { args: []; result: LibraryInfo }
  listPapers: { args: []; result: PaperListRow[] }
  tagCounts: { args: []; result: { name: string; count: number }[] }
  search: { args: [query: string]; result: SearchResult[] }
  getPaper: { args: [id: number]; result: PaperDetail | null }

  addTags: { args: [id: number, tags: string[]]; result: void }
  removeTags: { args: [id: number, tags: string[]]; result: void }
  setNote: { args: [id: number, body: string]; result: void }
  setManualMetadata: { args: [id: number, metadata: Metadata]; result: void }
  unlockMetadata: { args: [id: number]; result: void }
  resolvePaper: { args: [id: number]; result: ResolveOutcome }
  /** Moves the paper's files to the OS Trash after removing its records. */
  removePaper: { args: [id: number]; result: void }

  chooseAndImport: { args: []; result: ImportOutcome[] }
  importPaths: { args: [paths: string[]]; result: ImportOutcome[] }

  readPdf: { args: [fileId: number]; result: Uint8Array }
  /** Replace the file with the reader's annotated copy (the original is kept once). */
  saveAnnotations: { args: [fileId: number, bytes: Uint8Array]; result: void }
  restoreOriginal: { args: [fileId: number]; result: void }
  /** Remove one of a paper's files (not its last); the file goes to the Trash. */
  removeFile: { args: [fileId: number]; result: void }
  /** macOS share sheet for the file; elsewhere, shows it in the file manager. */
  shareFile: { args: [fileId: number]; result: void }
  /** Save a copy anywhere, under the library's name for it. Returns the path, or null. */
  saveFileCopy: { args: [fileId: number]; result: string | null }
  openFile: { args: [fileId: number]; result: void }
  revealFile: { args: [fileId: number]; result: void }
  openUrl: { args: [url: string]; result: void }

  exportBibtex: { args: [ids: number[]]; result: string }
  saveBibtex: { args: [ids: number[], suggestedName: string]; result: string | null }
  verify: { args: [deep: boolean]; result: Issue[] }

  // Query language and collections
  query: { args: [q: string]; result: SearchResult[] }
  setReading: { args: [ids: number[], reading: ReadingStatus | null]; result: void }
  setStarred: { args: [ids: number[], starred: boolean]; result: void }
  listCollections: { args: []; result: Collection[] }
  createCollection: { args: [name: string, query: string | null]; result: number }
  updateCollection: {
    args: [id: number, changes: { name?: string; query?: string | null }]
    result: void
  }
  deleteCollection: { args: [id: number]; result: void }
  addToCollection: { args: [id: number, paperIds: number[]]; result: void }
  removeFromCollection: { args: [id: number, paperIds: number[]]; result: void }
  collectionPaperIds: { args: [id: number]; result: number[] }

  // Changing a paper's PDF
  /** Pick a PDF and put it in place of this file (the old one goes to the Trash). */
  replaceFile: { args: [fileId: number]; result: ReplaceOutcome | null }
  replaceFileWithPath: { args: [fileId: number, path: string]; result: ReplaceOutcome }
  /** File a dropped PDF under this paper; a publisher PDF replaces its arXiv PDF. */
  attachPath: { args: [paperId: number, path: string]; result: ReplaceOutcome }
  /** Try only the publisher's copy (works when your network has access). */
  getPublisherPdf: {
    args: [paperId: number]
    result: { source?: string | undefined; notes: string[]; replaced?: string[] | undefined }
  }

  // Interface preferences and background status
  getPrefs: { args: []; result: UiPrefs }
  setPrefs: { args: [prefs: Partial<UiPrefs>]; result: UiPrefs }
  getStatus: { args: []; result: StatusInfo }

  // Adding by identifier, fetching and attaching PDFs
  addByIdentifier: { args: [input: string, tags: string[]]; result: AddOutcome }
  fetchPdf: { args: [paperId: number]; result: { source?: string | undefined; notes: string[] } }
  attachPdf: { args: [paperId: number]; result: boolean }

  // Highlights index
  listAnnotations: {
    args: [opts: { paperId?: number; search?: string }]
    result: IndexedAnnotation[]
  }
  exportAnnotations: {
    args: [opts: { paperId?: number; search?: string }, suggestedName: string]
    result: string | null
  }

  // ADS discovery
  related: { args: [paperId: number, kind: 'references' | 'citations']; result: RelatedItem[] }
  getDiscover: { args: []; result: DiscoverState }
  createWatch: { args: [name: string, query: string]; result: number }
  deleteWatch: { args: [id: number]; result: void }
  runWatches: { args: []; result: { found: number; errors: string[] } }
  setHitState: { args: [bibcodes: string[], state: WatchHit['state']]; result: void }
  addFromAds: { args: [bibcodes: string[], tags: string[]]; result: AddOutcome[] }
  checkPublished: { args: []; result: PublishedVersion[] }
  adoptPublished: {
    args: [paperId: number]
    result: { pdfSource?: string | undefined; notes: string[] }
  }

  // Manuscripts
  listManuscripts: { args: []; result: ManuscriptView[] }
  addManuscript: { args: []; result: number | null }
  removeManuscript: { args: [id: number]; result: void }
  analyzeManuscript: { args: [id: number]; result: ManuscriptView }
  writeManuscriptBib: { args: [id: number]; result: WriteResult }
  addMissingReferences: { args: [id: number]; result: AddOutcome[] }
  collectManuscript: { args: [id: number]; result: number }
  revealPath: { args: [path: string]; result: void }

  // Settings
  getSettings: { args: []; result: AppSettings }
  setAdsToken: { args: [token: string | null]; result: TokenSource }
  testAdsToken: { args: []; result: { ok: boolean; message: string } }
  setCiteTags: { args: [on: boolean]; result: void }
  chooseLibraryFolder: { args: []; result: boolean }
  backupNow: { args: []; result: string }

  getInbox: { args: []; result: InboxState }
  rescanInbox: { args: []; result: void }
  /** File inbox PDFs into the library; progress arrives as importProgress events. */
  acceptInbox: { args: [paths: string[], tags: string[]]; result: ImportOutcome[] }
  ignoreInbox: { args: [paths: string[]]; result: void }
  unignoreInbox: { args: [paths: string[]]; result: void }
  addInboxFolder: { args: []; result: string[] }
  removeInboxFolder: { args: [folder: string]; result: string[] }
  setTrashAfterFiling: { args: [on: boolean]; result: void }
  /** Moves originals whose bytes are already in the library to the Trash; returns the count. */
  disposeFiledOriginals: { args: []; result: number }
  /** Bytes of an inbox PDF for preview. Only paths currently in the inbox are served. */
  readInboxPdf: { args: [path: string]; result: Uint8Array }
}

/** main → renderer events. */
export interface IpcEvents {
  importProgress: ImportProgress
  libraryChanged: void
  inboxChanged: void
  status: StatusInfo
  discoverChanged: void
  inboxProgress: { done: number; total: number } | null
  menu: 'import' | 'find' | 'export' | 'add' | 'settings'
}

export const INVOKE_PREFIX = 'pm:'
export const EVENT_PREFIX = 'pm-event:'

/**
 * Every invoke channel, as a runtime list for the preload bridge. The check below makes
 * a channel missing from this list a compile error.
 */
export const CHANNELS = [
  'getLibraryInfo',
  'listPapers',
  'tagCounts',
  'search',
  'getPaper',
  'addTags',
  'removeTags',
  'setNote',
  'setManualMetadata',
  'unlockMetadata',
  'resolvePaper',
  'removePaper',
  'chooseAndImport',
  'importPaths',
  'readPdf',
  'saveAnnotations',
  'restoreOriginal',
  'removeFile',
  'shareFile',
  'saveFileCopy',
  'openFile',
  'revealFile',
  'openUrl',
  'exportBibtex',
  'saveBibtex',
  'verify',
  'query',
  'setReading',
  'setStarred',
  'listCollections',
  'createCollection',
  'updateCollection',
  'deleteCollection',
  'addToCollection',
  'removeFromCollection',
  'collectionPaperIds',
  'replaceFile',
  'replaceFileWithPath',
  'attachPath',
  'getPublisherPdf',
  'getPrefs',
  'setPrefs',
  'getStatus',
  'addByIdentifier',
  'fetchPdf',
  'attachPdf',
  'listAnnotations',
  'exportAnnotations',
  'related',
  'getDiscover',
  'createWatch',
  'deleteWatch',
  'runWatches',
  'setHitState',
  'addFromAds',
  'checkPublished',
  'adoptPublished',
  'listManuscripts',
  'addManuscript',
  'removeManuscript',
  'analyzeManuscript',
  'writeManuscriptBib',
  'addMissingReferences',
  'collectManuscript',
  'revealPath',
  'getSettings',
  'setAdsToken',
  'testAdsToken',
  'setCiteTags',
  'chooseLibraryFolder',
  'backupNow',
  'getInbox',
  'rescanInbox',
  'acceptInbox',
  'ignoreInbox',
  'unignoreInbox',
  'addInboxFolder',
  'removeInboxFolder',
  'setTrashAfterFiling',
  'disposeFiledOriginals',
  'readInboxPdf'
] as const satisfies readonly (keyof IpcContract)[]

type MissingChannel = Exclude<keyof IpcContract, (typeof CHANNELS)[number]>
export const CHANNELS_COMPLETE: [MissingChannel] extends [never] ? true : MissingChannel = true
