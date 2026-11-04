import {
  BookMarked,
  ChevronDown,
  ChevronRight,
  FileText,
  FolderClosed,
  Highlighter,
  Inbox,
  Library,
  Plus,
  Settings,
  Sparkles,
  Star,
  Tag,
  Tags,
  Telescope
} from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { api } from '../lib/api'
import { isLibraryFilter, useStore, type View } from '../lib/store'

/**
 * Navigation. A short fixed set of places, then foldable sections for collections,
 * manuscripts and pinned tags. Library subsets (recent, needs review…) are filter chips
 * above the list; the full tag list is its own page.
 */
export function Sidebar({ onNewCollection }: { onNewCollection: () => void }) {
  const rows = useStore((s) => s.rows)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const info = useStore((s) => s.info)
  const inbox = useStore((s) => s.inbox)
  const collections = useStore((s) => s.collections)
  const manuscripts = useStore((s) => s.manuscripts)
  const discover = useStore((s) => s.discover)
  const prefs = useStore((s) => s.prefs)
  const setPrefs = useStore((s) => s.setPrefs)
  const tagCounts = useStore((s) => s.tags)
  const refreshManuscripts = useStore((s) => s.refreshManuscripts)

  useEffect(() => {
    void refreshManuscripts()
  }, [refreshManuscripts])

  const inboxCount =
    inbox?.items.filter((i) => i.state === 'pending' && i.verdict !== 'other').length ?? 0
  const discoverCount = (discover?.hits.length ?? 0) + (discover?.published.length ?? 0)
  const highlights = rows.reduce((n, r) => n + r.annotation_count, 0)
  const pinned = prefs.pinnedTags
    .map((name) => tagCounts.find((t) => t.name.toLowerCase() === name.toLowerCase()))
    .filter((t): t is { name: string; count: number } => !!t)

  const is = (v: View) => {
    if (v.kind === 'all') return isLibraryFilter(view)
    if (v.kind !== view.kind) return false
    if (v.kind === 'tag') return view.kind === 'tag' && view.tag === v.tag
    if (v.kind === 'collection') return view.kind === 'collection' && view.id === v.id
    if (v.kind === 'manuscript') return view.kind === 'manuscript' && view.id === v.id
    return true
  }
  const item = (v: View, icon: ReactNode, label: string, n?: number, badge = false) => (
    <Item
      key={`${v.kind}-${label}`}
      icon={icon}
      label={label}
      count={n}
      badge={badge}
      active={is(v)}
      onClick={() => setView(v)}
    />
  )
  const folded = (key: string) => prefs.collapsed.includes(key)
  const toggle = (key: string) =>
    setPrefs({
      collapsed: folded(key) ? prefs.collapsed.filter((k) => k !== key) : [...prefs.collapsed, key]
    })

  return (
    <nav aria-label="Library" className="flex w-[216px] shrink-0 flex-col bg-sidebar">
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pt-2 pb-3">
        <ul className="flex flex-col gap-px">
          {item({ kind: 'inbox' }, <Inbox size={15} />, 'Inbox', inboxCount, inboxCount > 0)}
          {item(
            { kind: 'discover' },
            <Telescope size={15} />,
            'Discover',
            discoverCount,
            discoverCount > 0
          )}
        </ul>

        <ul className="mt-4 flex flex-col gap-px">
          {item({ kind: 'all' }, <Library size={15} />, 'Library', rows.length)}
          {item(
            { kind: 'to-read' },
            <BookMarked size={15} />,
            'To read',
            rows.filter((r) => r.reading === 'to-read').length || undefined
          )}
          {item(
            { kind: 'starred' },
            <Star size={15} />,
            'Starred',
            rows.filter((r) => r.starred).length || undefined
          )}
          {item(
            { kind: 'highlights' },
            <Highlighter size={15} />,
            'Highlights',
            highlights || undefined
          )}
        </ul>

        <Group
          id="collections"
          label="Collections"
          folded={folded('collections')}
          onToggle={() => toggle('collections')}
          action={<AddButton label="New collection" onClick={onNewCollection} />}
        >
          {collections.length === 0 && <Hint>Group papers by hand or by a search</Hint>}
          {collections.map((c) =>
            item(
              { kind: 'collection', id: c.id },
              c.query ? <Sparkles size={14} /> : <FolderClosed size={14} />,
              c.name,
              c.count
            )
          )}
        </Group>

        <Group
          id="manuscripts"
          label="Manuscripts"
          folded={folded('manuscripts')}
          onToggle={() => toggle('manuscripts')}
          action={
            <AddButton
              label="Add a LaTeX project"
              onClick={() =>
                void api.addManuscript().then(async (id) => {
                  await refreshManuscripts()
                  if (id !== null) setView({ kind: 'manuscript', id })
                })
              }
            />
          }
        >
          {manuscripts.length === 0 && <Hint>Keep a LaTeX project's .bib in step</Hint>}
          {manuscripts.map((m) =>
            item(
              { kind: 'manuscript', id: m.id },
              <FileText size={14} />,
              m.path.split('/').pop() ?? m.path
            )
          )}
        </Group>

        <Group
          id="tags"
          label="Pinned tags"
          folded={folded('tags')}
          onToggle={() => toggle('tags')}
        >
          {pinned.map((t) =>
            item({ kind: 'tag', tag: t.name }, <Tag size={14} />, t.name, t.count)
          )}
          {item(
            { kind: 'tags' },
            <Tags size={14} />,
            pinned.length ? 'All tags' : 'Browse tags',
            tagCounts.length
          )}
        </Group>
      </div>

      <div className="px-2.5 pb-2.5">
        <ul className="flex flex-col gap-px">
          {item({ kind: 'settings' }, <Settings size={15} />, 'Settings')}
        </ul>
        {info && !info.adsToken && (
          <p className="mt-1 px-2 text-[11.5px] leading-snug text-warn">
            Add an ADS token in Settings for full lookups and Discover.
          </p>
        )}
      </div>
    </nav>
  )
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-[12px] leading-snug text-fg-3">{children}</p>
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="rounded p-0.5 text-fg-3 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-fg focus:opacity-100"
    >
      <Plus size={14} />
    </button>
  )
}

function Group({
  id,
  label,
  folded,
  onToggle,
  action,
  children
}: {
  id: string
  label: string
  folded: boolean
  onToggle: () => void
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="group mt-4">
      <div className="flex items-center justify-between pr-1">
        <button
          type="button"
          aria-expanded={!folded}
          aria-controls={`sidebar-${id}`}
          onClick={onToggle}
          className="flex h-6 items-center gap-1 rounded px-1 text-[12px] font-medium text-fg-3 hover:text-fg"
        >
          {folded ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          {label}
        </button>
        {action}
      </div>
      {!folded && (
        <ul id={`sidebar-${id}`} className="mt-0.5 flex flex-col gap-px">
          {children}
        </ul>
      )}
    </div>
  )
}

function Item(props: {
  icon: ReactNode
  label: string
  count?: number | undefined
  active: boolean
  badge?: boolean
  onClick: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={props.onClick}
        aria-current={props.active ? 'page' : undefined}
        className={`flex h-[30px] w-full items-center gap-2.5 rounded-md px-2 text-left text-[13px] transition-colors ${
          props.active
            ? 'bg-selected font-medium text-fg'
            : 'text-fg-2 hover:bg-hover hover:text-fg'
        }`}
      >
        <span className={props.active ? 'text-accent' : 'text-fg-3'}>{props.icon}</span>
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        {props.count !== undefined &&
          (props.badge ? (
            <span className="rounded-full bg-accent-soft px-1.5 text-[11px] font-medium text-accent tabular-nums">
              {props.count}
            </span>
          ) : (
            <span className="text-[11.5px] text-fg-3 tabular-nums">{props.count}</span>
          ))}
      </button>
    </li>
  )
}
