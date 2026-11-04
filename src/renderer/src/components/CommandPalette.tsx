import {
  ArrowRight,
  BookMarked,
  BookOpen,
  Check,
  CornerDownLeft,
  Copy,
  Download,
  FileDown,
  FilePlus2,
  FileText,
  FolderClosed,
  FolderPlus,
  Highlighter,
  Inbox,
  Library,
  Link2,
  Replace,
  Rows3,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Tag,
  Tags,
  Telescope
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { shortAuthors } from '../lib/format'
import { FILTER_LABEL, LIBRARY_FILTERS, useStore, type View } from '../lib/store'
import { cleanError } from './ui'

interface Command {
  id: string
  group: 'Paper' | 'Actions' | 'Go to' | 'Papers'
  label: string
  detail?: string
  icon: ReactNode
  run: () => void
}

// Loose check for "this looks like something Add by ID understands".
const IDENTIFIER =
  /^(https?:\/\/\S+|10\.\d{4,9}\/\S+|(arxiv:\s*)?\d{4}\.\d{4,5}(v\d+)?|\d{4}[A-Za-z&.]{5}[\w.]{4}[A-Za-z.][\w.]{4}[A-Z.])$/i

/**
 * ⌘K: jump to any place, collection, tag or paper, and run any action, by typing a few
 * letters. Paste a DOI, arXiv id or bibcode to add that paper.
 */
export function CommandPalette({
  onClose,
  actions
}: {
  onClose: () => void
  actions: {
    importPdfs: () => void
    addById: () => void
    newCollection: () => void
    exportView: () => void
    verify: () => void
    openPaper: (paperId: number) => void
  }
}) {
  const s = useStore()
  const [q, setQ] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => inputRef.current?.focus(), [])

  const go = (v: View) => () => s.setView(v)
  const active = s.rows.find((r) => r.id === s.activeId)

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = []
    const run = (fn: () => Promise<unknown>, done?: string) => () =>
      void fn().then(
        () => done && s.toast('success', done),
        (err) => s.toast('error', cleanError(err))
      )

    if (active) {
      const t = active.title ?? 'this paper'
      out.push(
        {
          id: 'p-read',
          group: 'Paper',
          label: 'Read',
          detail: t,
          icon: <BookOpen size={15} />,
          run: () => actions.openPaper(active.id)
        },
        {
          id: 'p-star',
          group: 'Paper',
          label: active.starred ? 'Unstar' : 'Star',
          detail: t,
          icon: <Star size={15} />,
          run: run(() => api.setStarred([active.id], !active.starred))
        },
        {
          id: 'p-toread',
          group: 'Paper',
          label: 'Mark as to read',
          detail: t,
          icon: <BookMarked size={15} />,
          run: run(() => api.setReading([active.id], 'to-read'))
        },
        {
          id: 'p-readdone',
          group: 'Paper',
          label: 'Mark as read',
          detail: t,
          icon: <Check size={15} />,
          run: run(() => api.setReading([active.id], 'read'))
        },
        {
          id: 'p-pub',
          group: 'Paper',
          label: 'Get publisher PDF',
          detail: t,
          icon: <Download size={15} />,
          run: run(async () => {
            const r = await api.getPublisherPdf(active.id)
            if (!r.source) throw new Error('The publisher’s PDF isn’t reachable from this network')
          }, 'Got the publisher PDF.')
        },
        {
          id: 'p-bib',
          group: 'Paper',
          label: 'Copy BibTeX',
          detail: t,
          icon: <Copy size={15} />,
          run: run(
            async () => navigator.clipboard.writeText(await api.exportBibtex([active.id])),
            'BibTeX copied.'
          )
        }
      )
      if (active.file_count > 0) {
        out.push({
          id: 'p-replace',
          group: 'Paper',
          label: 'Replace PDF…',
          detail: t,
          icon: <Replace size={15} />,
          run: run(async () => {
            const d = await api.getPaper(active.id)
            if (d?.files[0]) await api.replaceFile(d.files[0].id)
          })
        })
      }
    }

    out.push(
      {
        id: 'a-add',
        group: 'Actions',
        label: 'Add papers by identifier…',
        icon: <Link2 size={15} />,
        run: actions.addById
      },
      {
        id: 'a-import',
        group: 'Actions',
        label: 'Import PDFs…',
        icon: <FilePlus2 size={15} />,
        run: actions.importPdfs
      },
      {
        id: 'a-coll',
        group: 'Actions',
        label: 'New collection…',
        icon: <FolderPlus size={15} />,
        run: actions.newCollection
      },
      {
        id: 'a-export',
        group: 'Actions',
        label: 'Export this list as BibTeX…',
        icon: <FileDown size={15} />,
        run: actions.exportView
      },
      {
        id: 'a-watch',
        group: 'Actions',
        label: 'Check ADS watches now',
        icon: <Telescope size={15} />,
        run: run(() => api.runWatches(), 'Checked ADS.')
      },
      {
        id: 'a-verify',
        group: 'Actions',
        label: 'Verify library',
        icon: <ShieldCheck size={15} />,
        run: actions.verify
      },
      {
        id: 'a-density',
        group: 'Actions',
        label: s.prefs.density === 'compact' ? 'Use comfortable rows' : 'Use compact rows',
        icon: <Rows3 size={15} />,
        run: () =>
          s.setPrefs({ density: s.prefs.density === 'compact' ? 'comfortable' : 'compact' })
      }
    )

    const places: [View, string, ReactNode][] = [
      [{ kind: 'inbox' }, 'Inbox', <Inbox key="i" size={15} />],
      [{ kind: 'discover' }, 'Discover', <Telescope key="d" size={15} />],
      [{ kind: 'all' }, 'Library', <Library key="l" size={15} />],
      [{ kind: 'to-read' }, 'To read', <BookMarked key="t" size={15} />],
      [{ kind: 'starred' }, 'Starred', <Star key="s" size={15} />],
      [{ kind: 'highlights' }, 'Highlights', <Highlighter key="h" size={15} />],
      [{ kind: 'tags' }, 'Tags', <Tags key="g" size={15} />],
      [{ kind: 'settings' }, 'Settings', <Settings key="x" size={15} />]
    ]
    for (const [v, label, icon] of places)
      out.push({ id: `g-${v.kind}`, group: 'Go to', label, icon, run: go(v) })
    for (const f of LIBRARY_FILTERS.filter((f) => f !== 'all')) {
      out.push({
        id: `f-${f}`,
        group: 'Go to',
        label: `Library: ${FILTER_LABEL[f]}`,
        icon: <Library size={15} />,
        run: go({ kind: f })
      })
    }
    for (const c of s.collections) {
      out.push({
        id: `c-${c.id}`,
        group: 'Go to',
        label: c.name,
        detail: c.query ? 'Smart collection' : 'Collection',
        icon: c.query ? <Sparkles size={15} /> : <FolderClosed size={15} />,
        run: go({ kind: 'collection', id: c.id })
      })
    }
    for (const m of s.manuscripts) {
      out.push({
        id: `m-${m.id}`,
        group: 'Go to',
        label: m.path.split('/').pop() ?? m.path,
        detail: 'Manuscript',
        icon: <FileText size={15} />,
        run: go({ kind: 'manuscript', id: m.id })
      })
    }
    for (const t of s.tags) {
      out.push({
        id: `t-${t.name}`,
        group: 'Go to',
        label: t.name,
        detail: `Tag · ${t.count}`,
        icon: <Tag size={15} />,
        run: go({ kind: 'tag', tag: t.name })
      })
    }
    return out
    // Rebuilt when the things it lists change.
  }, [active, s.collections, s.manuscripts, s.tags, s.prefs.density]) // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo<Command[]>(() => {
    const text = q.trim()
    if (!text)
      return commands.filter((c) => c.group !== 'Go to' || !c.id.startsWith('t-')).slice(0, 40)
    const words = text.toLowerCase().split(/\s+/)
    const matches = (hay: string) => words.every((w) => hay.includes(w))
    const found = commands.filter((c) => matches(`${c.label} ${c.detail ?? ''}`.toLowerCase()))
    const papers: Command[] = s.rows
      .filter((r) =>
        matches(
          `${r.title ?? ''} ${r.first_author ?? ''} ${r.year ?? ''} ${r.tags.join(' ')}`.toLowerCase()
        )
      )
      .slice(0, 8)
      .map((r) => ({
        id: `r-${r.id}`,
        group: 'Papers',
        label: r.title ?? 'Untitled',
        detail: `${shortAuthors(r.first_author, r.author_count)} ${r.year ?? ''}`,
        icon: <BookOpen size={15} />,
        run: () => {
          s.setView({ kind: 'all' })
          s.select(r.id)
        }
      }))
    const add: Command[] = IDENTIFIER.test(text)
      ? [
          {
            id: 'add-id',
            group: 'Actions',
            label: `Add ${text}`,
            detail: 'Look it up and fetch the PDF',
            icon: <Link2 size={15} />,
            run: () =>
              void api.addByIdentifier(text, []).then(
                (r) => {
                  s.setView({ kind: 'all' })
                  s.select(r.paperId)
                  s.toast('success', r.status === 'exists' ? 'Already in your library.' : 'Added.')
                },
                (err) => s.toast('error', cleanError(err))
              )
          }
        ]
      : []
    return [
      ...add,
      ...found.filter((c) => c.group !== 'Go to'),
      ...papers,
      ...found.filter((c) => c.group === 'Go to')
    ].slice(0, 40)
  }, [q, commands, s])

  useEffect(() => setIndex(0), [q])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const choose = (c: Command | undefined) => {
    if (!c) return
    onClose()
    c.run()
  }

  let lastGroup = ''
  return (
    <div
      className="fixed inset-0 z-50 flex justify-center bg-black/20 pt-[12vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="flex h-fit max-h-[62vh] w-[600px] flex-col overflow-hidden rounded-xl border border-line bg-raised shadow-[var(--shadow)]"
      >
        <label className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-4">
          <Search size={16} className="text-fg-3" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIndex((i) => Math.min(results.length - 1, i + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex((i) => Math.max(0, i - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(results[index])
              } else if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              }
            }}
            placeholder="Type a command, a place, a paper, or paste a DOI"
            aria-label="Command"
            className="h-full flex-1 bg-transparent text-[14.5px] outline-none placeholder:text-fg-3"
          />
          <kbd className="rounded border border-line px-1.5 text-[11px] text-fg-3">esc</kbd>
        </label>
        <ul
          ref={listRef}
          role="listbox"
          aria-label="Results"
          className="min-h-0 overflow-y-auto p-1.5"
        >
          {results.length === 0 && (
            <li className="px-3 py-6 text-center text-[13px] text-fg-3">Nothing matches.</li>
          )}
          {results.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null
            lastGroup = c.group
            return (
              <li key={c.id}>
                {header && (
                  <div className="px-2.5 pt-2 pb-1 text-[11.5px] font-medium text-fg-3">
                    {header}
                  </div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === index}
                  data-index={i}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => choose(c)}
                  className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left text-[13.5px] ${
                    i === index ? 'bg-selected' : ''
                  }`}
                >
                  <span className="text-fg-3">{c.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.detail && (
                    <span className="max-w-[200px] shrink-0 truncate text-[12px] text-fg-3">
                      {c.detail}
                    </span>
                  )}
                  {i === index ? (
                    <CornerDownLeft size={13} className="text-fg-3" />
                  ) : (
                    <ArrowRight size={13} className="text-transparent" />
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
