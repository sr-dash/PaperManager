import { create } from 'zustand'
import type {
  Collection,
  DiscoverState,
  ImportProgress,
  InboxState,
  LibraryInfo,
  Manuscript,
  PaperListRow,
  SearchResult,
  StatusInfo,
  UiPrefs
} from '../../../shared/ipc'
import { api } from './api'

export type View =
  | { kind: 'inbox' }
  | { kind: 'discover' }
  | { kind: 'all' }
  | { kind: 'review' }
  | { kind: 'recent' }
  | { kind: 'untagged' }
  | { kind: 'preprint' }
  | { kind: 'to-read' }
  | { kind: 'reading' }
  | { kind: 'starred' }
  | { kind: 'highlights' }
  | { kind: 'tags' }
  | { kind: 'tag'; tag: string }
  | { kind: 'collection'; id: number }
  | { kind: 'manuscript'; id: number }
  | { kind: 'settings' }

/** Views that show the paper list (as opposed to a view of their own). */
export function isListView(v: View): boolean {
  return !['inbox', 'discover', 'highlights', 'manuscript', 'settings', 'tags'].includes(v.kind)
}

/**
 * Subsets of the whole library, offered as filter chips above the list rather than as
 * separate sidebar entries. The sidebar's "Library" item is active for all of them.
 */
export const LIBRARY_FILTERS = [
  'all',
  'recent',
  'reading',
  'review',
  'untagged',
  'preprint'
] as const
export type LibraryFilter = (typeof LIBRARY_FILTERS)[number]

export function isLibraryFilter(v: View): v is { kind: LibraryFilter } {
  return (LIBRARY_FILTERS as readonly string[]).includes(v.kind)
}

export type SortKey = 'added' | 'author' | 'year' | 'title' | 'journal'

/** What the reader shows: a library file, or an inbox PDF being previewed before filing. */
export type ReaderSource =
  | { kind: 'file'; paperId: number; fileId: number; page?: number }
  | { kind: 'inbox'; path: string; title: string }

export interface Toast {
  id: number
  tone: 'info' | 'success' | 'warning' | 'error'
  text: string
}

const DEFAULT_PREFS: UiPrefs = {
  pinnedTags: [],
  collapsed: [],
  density: 'comfortable',
  readerRelated: true
}

interface State {
  info: LibraryInfo | null
  rows: PaperListRow[]
  tags: { name: string; count: number }[]
  view: View
  query: string
  hits: SearchResult[] | null
  sort: { key: SortKey; desc: boolean }
  selected: number[]
  /** The paper shown in the detail pane: the last one clicked. */
  activeId: number | null
  reader: ReaderSource | null
  importing: ImportProgress | null
  inbox: InboxState | null
  collections: Collection[]
  /** Members of the collection being viewed, in its order. */
  collectionIds: number[] | null
  discover: DiscoverState | null
  manuscripts: Manuscript[]
  prefs: UiPrefs
  status: StatusInfo | null
  addOpen: boolean
  paletteOpen: boolean
  toasts: Toast[]

  refresh: () => Promise<void>
  refreshInbox: () => Promise<void>
  refreshCollections: () => Promise<void>
  refreshDiscover: () => Promise<void>
  refreshManuscripts: () => Promise<void>
  loadPrefs: () => Promise<void>
  setPrefs: (p: Partial<UiPrefs>) => void
  setView: (view: View) => void
  setQuery: (query: string) => void
  setSort: (key: SortKey, desc?: boolean) => void
  select: (id: number, mode?: 'replace' | 'toggle' | 'range', visible?: number[]) => void
  openReader: (source: ReaderSource) => void
  closeReader: () => void
  toast: (tone: Toast['tone'], text: string) => void
  dismissToast: (id: number) => void
}

export const RECENT_DAYS = 30
let toastSeq = 0
let searchSeq = 0

export const useStore = create<State>((set, get) => ({
  info: null,
  rows: [],
  tags: [],
  view: { kind: 'all' },
  query: '',
  hits: null,
  sort: { key: 'added', desc: true },
  selected: [],
  activeId: null,
  reader: null,
  importing: null,
  inbox: null,
  collections: [],
  collectionIds: null,
  discover: null,
  manuscripts: [],
  prefs: DEFAULT_PREFS,
  status: null,
  addOpen: false,
  paletteOpen: false,
  toasts: [],

  refresh: async () => {
    const [rows, tags, info] = await Promise.all([
      api.listPapers(),
      api.tagCounts(),
      get().info ? Promise.resolve(get().info!) : api.getLibraryInfo()
    ])
    const ids = new Set(rows.map((r) => r.id))
    set((s) => ({
      rows,
      tags,
      info,
      selected: s.selected.filter((id) => ids.has(id)),
      activeId: s.activeId !== null && ids.has(s.activeId) ? s.activeId : null
    }))
    if (get().query) get().setQuery(get().query)
    void get().refreshCollections()
  },

  refreshInbox: async () => set({ inbox: await api.getInbox() }),

  refreshCollections: async () => {
    const collections = await api.listCollections()
    const v = get().view
    set({
      collections,
      collectionIds: v.kind === 'collection' ? await api.collectionPaperIds(v.id) : null
    })
  },
  refreshDiscover: async () => set({ discover: await api.getDiscover() }),
  refreshManuscripts: async () => set({ manuscripts: await api.listManuscripts() }),

  loadPrefs: async () => {
    const prefs = await api.getPrefs()
    set({ prefs })
    document.documentElement.dataset.density = prefs.density
  },
  setPrefs: (p) => {
    const prefs = { ...get().prefs, ...p }
    set({ prefs })
    document.documentElement.dataset.density = prefs.density
    void api.setPrefs(p)
  },

  setView: (view) => {
    set({ view, selected: [], activeId: null, reader: null, collectionIds: null })
    if (view.kind === 'collection') {
      void api.collectionPaperIds(view.id).then((ids) => {
        const v = get().view
        if (v.kind === 'collection' && v.id === view.id) set({ collectionIds: ids })
      })
    }
  },

  setQuery: (query) => {
    set({ query })
    const seq = ++searchSeq
    if (!query.trim()) {
      set({ hits: null })
      return
    }
    void api.query(query).then((hits) => {
      if (seq === searchSeq) set({ hits })
    })
  },

  setSort: (key, desc) =>
    set((s) => ({
      sort: {
        key,
        desc: desc ?? (s.sort.key === key ? !s.sort.desc : key === 'added' || key === 'year')
      }
    })),

  select: (id, mode = 'replace', visible = []) =>
    set((s) => {
      if (mode === 'toggle') {
        const selected = s.selected.includes(id)
          ? s.selected.filter((x) => x !== id)
          : [...s.selected, id]
        return { selected, activeId: id }
      }
      if (mode === 'range' && s.activeId !== null) {
        const a = visible.indexOf(s.activeId)
        const b = visible.indexOf(id)
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          return { selected: visible.slice(lo, hi + 1) }
        }
      }
      return { selected: [id], activeId: id }
    }),

  openReader: (source) => set({ reader: source }),
  closeReader: () => set({ reader: null }),

  toast: (tone, text) => {
    const id = ++toastSeq
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, tone, text }] }))
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 9000 : 5000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

/** Whether a paper belongs to one of the library-wide filters. */
export function matchesFilter(r: PaperListRow, kind: LibraryFilter): boolean {
  switch (kind) {
    case 'all':
      return true
    case 'recent':
      return Date.now() - Date.parse(r.added_at) < RECENT_DAYS * 86_400_000
    case 'reading':
      return r.reading === 'reading'
    case 'review':
      return r.metadata_status === 'unresolved'
    case 'untagged':
      return r.tags.length === 0
    case 'preprint':
      return r.pdf_origin === 'arxiv'
  }
}

/** Rows for the current view, search and sort — the list the table shows. */
export function visibleRows(s: State): { rows: PaperListRow[]; snippets: Map<number, string> } {
  const memberIds = s.collectionIds ? new Set(s.collectionIds) : null
  const view = s.view
  const inView = (r: PaperListRow): boolean => {
    if (isLibraryFilter(view)) return matchesFilter(r, view.kind)
    switch (view.kind) {
      case 'to-read':
        return r.reading === 'to-read'
      case 'starred':
        return r.starred
      case 'collection':
        return memberIds?.has(r.id) ?? false
      case 'tag':
        return r.tags.some((t) => t.toLowerCase() === view.tag.toLowerCase())
      default:
        return true
    }
  }

  const snippets = new Map<number, string>()
  if (s.hits) {
    // Search results keep relevance order; the view still filters them.
    const byId = new Map(s.rows.map((r) => [r.id, r]))
    const rows: PaperListRow[] = []
    for (const h of s.hits) {
      const r = byId.get(h.id)
      if (r && inView(r)) {
        rows.push(r)
        snippets.set(h.id, h.snippet)
      }
    }
    return { rows, snippets }
  }

  // A collection keeps its own order (a smart collection's query order) until re-sorted.
  if (view.kind === 'collection' && s.collectionIds && s.sort.key === 'added') {
    const byId = new Map(s.rows.map((r) => [r.id, r]))
    const rows = s.collectionIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))
    return { rows, snippets }
  }
  const rows = s.rows.filter(inView)
  const dir = s.sort.desc ? -1 : 1
  const text = (v: string | null) => (v ?? '').toLocaleLowerCase()
  const cmp: Record<SortKey, (a: PaperListRow, b: PaperListRow) => number> = {
    added: (a, b) => a.added_at.localeCompare(b.added_at),
    author: (a, b) => text(a.first_author).localeCompare(text(b.first_author)),
    year: (a, b) => (a.year ?? 0) - (b.year ?? 0),
    title: (a, b) => text(a.title).localeCompare(text(b.title)),
    journal: (a, b) =>
      text(a.journal_abbrev ?? a.journal).localeCompare(text(b.journal_abbrev ?? b.journal))
  }
  rows.sort((a, b) => dir * cmp[s.sort.key](a, b) || b.id - a.id)
  return { rows, snippets }
}

export const FILTER_LABEL: Record<LibraryFilter, string> = {
  all: 'All',
  recent: 'Recently added',
  reading: 'Reading',
  review: 'Needs review',
  untagged: 'Untagged',
  preprint: 'arXiv PDF only'
}

export function viewTitle(view: View, collections: Collection[] = []): string {
  if (isLibraryFilter(view)) return 'Library'
  switch (view.kind) {
    case 'discover':
      return 'Discover'
    case 'to-read':
      return 'To read'
    case 'starred':
      return 'Starred'
    case 'highlights':
      return 'Highlights and notes'
    case 'tags':
      return 'Tags'
    case 'collection':
      return collections.find((c) => c.id === view.id)?.name ?? 'Collection'
    case 'manuscript':
      return 'Manuscript'
    case 'settings':
      return 'Settings'
    case 'inbox':
      return 'Inbox'
    case 'tag':
      return view.tag
    default:
      return 'Library'
  }
}
