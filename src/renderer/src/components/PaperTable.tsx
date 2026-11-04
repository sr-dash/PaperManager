import {
  ArrowDownWideNarrow,
  BookMarked,
  BookOpen,
  Check,
  CircleAlert,
  Ellipsis,
  FileDown,
  FileX2,
  FolderMinus,
  FolderPlus,
  Highlighter,
  NotebookPen,
  Pencil,
  Sparkles,
  Star,
  Trash2
} from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import type { PaperListRow, ReadingStatus } from '../../../shared/ipc'
import { api } from '../lib/api'
import { shortAuthors, snippetParts } from '../lib/format'
import {
  FILTER_LABEL,
  LIBRARY_FILTERS,
  isLibraryFilter,
  matchesFilter,
  useStore,
  viewTitle,
  visibleRows,
  type SortKey
} from '../lib/store'
import { Button, Chip, IconButton, Menu, cleanError, type MenuItem } from './ui'

const SORTS: { key: SortKey; desc: boolean; label: string }[] = [
  { key: 'added', desc: true, label: 'Recently added' },
  { key: 'year', desc: true, label: 'Newest first' },
  { key: 'year', desc: false, label: 'Oldest first' },
  { key: 'author', desc: false, label: 'First author' },
  { key: 'title', desc: false, label: 'Title' },
  { key: 'journal', desc: false, label: 'Journal' }
]

/** The paper list: two lines per paper, title first. */
export function PaperTable({
  onOpen,
  onExport,
  onEditCollection
}: {
  onOpen: (row: PaperListRow) => void
  onExport: (ids: number[], name: string) => void
  onEditCollection: (id: number) => void
}) {
  const state = useStore()
  const { rows, snippets } = useMemo(() => visibleRows(state), [state])
  const ids = useMemo(() => rows.map((r) => r.id), [rows])
  const listRef = useRef<HTMLDivElement>(null)
  const searching = state.hits !== null
  const view = state.view

  // Keep the active row in view when it moves by keyboard.
  useEffect(() => {
    if (state.activeId === null) return
    listRef.current
      ?.querySelector(`[data-id="${state.activeId}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [state.activeId])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!rows.length) return
    const i = state.activeId === null ? -1 : ids.indexOf(state.activeId)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = e.key === 'ArrowDown' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1)
      state.select(ids[next]!, e.shiftKey ? 'range' : 'replace', ids)
    } else if (e.key === 'Enter' && i >= 0) {
      onOpen(rows[i]!)
    } else if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      useStore.setState({ selected: ids })
    }
  }

  const multi = state.selected.length > 1
  const exportIds = multi ? state.selected : ids
  const collection =
    view.kind === 'collection' ? state.collections.find((c) => c.id === view.id) : undefined
  const manualCollections = state.collections.filter((c) => !c.query)
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn()
      if (done) state.toast('success', done)
    } catch (err) {
      state.toast('error', cleanError(err))
    }
  }
  const mark = (reading: ReadingStatus | null) => act(() => api.setReading(state.selected, reading))
  const sortLabel =
    SORTS.find((s) => s.key === state.sort.key && s.desc === state.sort.desc)?.label ?? 'Sort'

  const bulk: (MenuItem | '-')[] = [
    {
      label: 'Mark as to read',
      icon: <BookMarked size={14} />,
      onSelect: () => void mark('to-read')
    },
    {
      label: 'Mark as reading',
      icon: <BookOpen size={14} />,
      onSelect: () => void mark('reading')
    },
    { label: 'Mark as read', icon: <Check size={14} />, onSelect: () => void mark('read') },
    { label: 'Clear reading status', onSelect: () => void mark(null) },
    '-',
    {
      label: 'Star',
      icon: <Star size={14} />,
      onSelect: () => void act(() => api.setStarred(state.selected, true))
    },
    { label: 'Unstar', onSelect: () => void act(() => api.setStarred(state.selected, false)) },
    ...(manualCollections.length ? (['-'] as const) : []),
    ...manualCollections.map((c): MenuItem => ({
      label: `Add to ${c.name}`,
      icon: <FolderPlus size={14} />,
      onSelect: () =>
        void act(
          () => api.addToCollection(c.id, state.selected),
          `Added ${state.selected.length} to ${c.name}.`
        )
    })),
    ...(collection && !collection.query
      ? ([
          '-',
          {
            label: 'Remove from this collection',
            icon: <FolderMinus size={14} />,
            onSelect: () => void act(() => api.removeFromCollection(collection.id, state.selected))
          }
        ] as const)
      : [])
  ]

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg" aria-label="Papers">
      <header className="flex h-12 shrink-0 items-center gap-2 px-5">
        {collection?.query && <Sparkles size={15} className="shrink-0 text-accent" />}
        <h1 className="truncate text-[16px] font-semibold tracking-tight">
          {searching ? 'Search results' : viewTitle(view, state.collections)}
        </h1>
        <span className="shrink-0 text-[12.5px] text-fg-3 tabular-nums">
          {multi ? `${state.selected.length} selected` : rows.length}
        </span>
        {collection?.query && !searching && (
          <span
            className="truncate font-mono text-[11.5px] text-fg-3"
            title="Smart collection search"
          >
            {collection.query}
          </span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {multi && (
            <Menu
              label="Selected papers"
              items={bulk}
              trigger={(p) => (
                <Button {...p} aria-label="Actions for selected papers">
                  <Ellipsis size={14} /> Selected
                </Button>
              )}
            />
          )}
          {!searching && (
            <Menu
              label="Sort by"
              items={SORTS.map((s) => ({
                label: s.label,
                icon:
                  s.key === state.sort.key && s.desc === state.sort.desc ? (
                    <Check size={14} />
                  ) : undefined,
                onSelect: () => state.setSort(s.key, s.desc)
              }))}
              trigger={(p) => (
                <Button variant="ghost" {...p} aria-label="Sort">
                  <ArrowDownWideNarrow size={14} /> {sortLabel}
                </Button>
              )}
            />
          )}
          <Menu
            label="List actions"
            items={[
              {
                label: multi
                  ? `Export ${state.selected.length} as BibTeX…`
                  : 'Export these as BibTeX…',
                icon: <FileDown size={14} />,
                hint: '⌘⇧E',
                disabled: !exportIds.length,
                onSelect: () =>
                  onExport(
                    exportIds,
                    view.kind === 'tag' ? view.tag : (collection?.name ?? 'references')
                  )
              },
              ...(collection
                ? ([
                    '-',
                    {
                      label: 'Edit collection…',
                      icon: <Pencil size={14} />,
                      onSelect: () => onEditCollection(collection.id)
                    },
                    {
                      label: 'Delete collection',
                      icon: <Trash2 size={14} />,
                      danger: true,
                      onSelect: () => {
                        if (
                          window.confirm(
                            `Delete the collection “${collection.name}”? Its papers stay in the library.`
                          )
                        ) {
                          void act(async () => {
                            await api.deleteCollection(collection.id)
                            state.setView({ kind: 'all' })
                          })
                        }
                      }
                    }
                  ] as const)
                : [])
            ]}
            trigger={(p) => (
              <IconButton label="More list actions" {...p}>
                <Ellipsis size={16} />
              </IconButton>
            )}
          />
        </div>
      </header>

      {isLibraryFilter(view) && !searching && (
        <div
          className="flex shrink-0 gap-1.5 overflow-x-auto px-5 pb-2.5"
          role="group"
          aria-label="Filters"
        >
          {LIBRARY_FILTERS.map((f) => (
            <Chip
              key={f}
              active={view.kind === f}
              onClick={() => state.setView({ kind: f })}
              count={f === 'all' ? undefined : state.rows.filter((r) => matchesFilter(r, f)).length}
            >
              {FILTER_LABEL[f]}
            </Chip>
          ))}
        </div>
      )}

      <div
        ref={listRef}
        role="grid"
        aria-label="Paper list"
        aria-multiselectable="true"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto border-t border-line outline-none"
      >
        {rows.length === 0 && <Empty searching={searching} total={state.rows.length} />}
        {rows.map((r) => {
          const selected = state.selected.includes(r.id)
          const snippet = snippets.get(r.id)
          return (
            <div
              key={r.id}
              role="row"
              data-id={r.id}
              aria-selected={selected}
              onMouseDown={(e) =>
                state.select(
                  r.id,
                  e.metaKey || e.ctrlKey ? 'toggle' : e.shiftKey ? 'range' : 'replace',
                  ids
                )
              }
              onDoubleClick={() => onOpen(r)}
              style={{ paddingTop: 'var(--row-py)', paddingBottom: 'var(--row-py)' }}
              className={`group flex cursor-default gap-2 border-b border-line/70 pr-5 pl-3 ${
                selected ? 'bg-selected' : 'hover:bg-hover/60'
              }`}
            >
              <div role="gridcell" className="flex w-5 shrink-0 justify-center pt-[3px]">
                <button
                  type="button"
                  aria-label={r.starred ? 'Unstar' : 'Star'}
                  aria-pressed={r.starred}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => void act(() => api.setStarred([r.id], !r.starred))}
                  className={
                    r.starred
                      ? 'text-warn'
                      : 'text-transparent group-hover:text-line-strong hover:!text-fg-3'
                  }
                >
                  <Star size={13} fill={r.starred ? 'currentColor' : 'none'} />
                </button>
              </div>
              <div role="gridcell" className="min-w-0 flex-1">
                <div
                  className={`truncate font-serif text-[14.5px] leading-snug ${
                    r.reading === 'read' ? 'text-fg-2' : 'font-medium text-fg'
                  }`}
                >
                  {r.title || 'Untitled'}
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-fg-3">
                  <span className="truncate">
                    {shortAuthors(r.first_author, r.author_count)}
                    {' · '}
                    {r.journal_abbrev ?? r.journal ?? (r.arxiv_id ? 'arXiv' : 'Unknown venue')}
                    {r.year ? ` ${r.year}` : ''}
                  </span>
                  <RowMarks r={r} />
                  {r.tags.length > 0 && (
                    <span className="ml-auto flex shrink-0 gap-1 pl-2">
                      {r.tags.slice(0, 3).map((t) => (
                        <span
                          key={t}
                          className="max-w-[110px] truncate rounded-full bg-hover px-1.5 text-[11px] text-fg-2"
                        >
                          {t}
                        </span>
                      ))}
                      {r.tags.length > 3 && (
                        <span className="text-[11px]">+{r.tags.length - 3}</span>
                      )}
                    </span>
                  )}
                </div>
                {snippet && (
                  <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-fg-3">
                    {snippetParts(snippet).map((p, i) =>
                      p.hit ? (
                        <mark key={i} className="rounded-sm bg-mark text-fg">
                          {p.text}
                        </mark>
                      ) : (
                        <span key={i}>{p.text}</span>
                      )
                    )}
                  </p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** The few markers worth a glance: reading status, review, PDF kind, highlights, notes. */
function RowMarks({ r }: { r: PaperListRow }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {r.reading === 'to-read' && <span className="text-accent">· to read</span>}
      {r.reading === 'reading' && <span className="text-accent">· reading</span>}
      {r.metadata_status === 'unresolved' && (
        <CircleAlert size={12} className="text-warn" aria-label="Needs review" />
      )}
      {r.file_count === 0 && <FileX2 size={12} aria-label="No PDF" />}
      {r.pdf_origin === 'arxiv' && (
        <span
          className="rounded bg-hover px-1 text-[10.5px] font-medium"
          title="Only the arXiv PDF so far"
        >
          arXiv PDF
        </span>
      )}
      {r.annotation_count > 0 && (
        <span className="flex items-center gap-0.5" aria-label={`${r.annotation_count} highlights`}>
          <Highlighter size={11} /> {r.annotation_count}
        </span>
      )}
      {r.has_note && <NotebookPen size={11} aria-label="Has note" />}
    </span>
  )
}

function Empty({ searching, total }: { searching: boolean; total: number }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 p-8 text-center">
      {total === 0 ? (
        <>
          <p className="text-[15px] font-semibold">Start your library</p>
          <p className="max-w-[340px] text-[13px] leading-relaxed text-fg-3">
            Drop PDFs anywhere in this window, or use Add. Each paper is identified, named and filed
            into your library folder.
          </p>
        </>
      ) : (
        <p className="text-[13px] text-fg-3">
          {searching ? 'No papers match this search here.' : 'No papers here yet.'}
        </p>
      )}
    </div>
  )
}
