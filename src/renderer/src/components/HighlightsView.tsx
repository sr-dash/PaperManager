import { FileDown, Highlighter, MessageSquareText, Search, StickyNote } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { IndexedAnnotation } from '../../../shared/ipc'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { Button } from './ui'

/** Every highlight and note across the library, grouped by paper; click to jump to the page. */
export function HighlightsView() {
  const rows = useStore((s) => s.rows) // reload when the library changes
  const openReader = useStore((s) => s.openReader)
  const toast = useStore((s) => s.toast)
  const [search, setSearch] = useState('')
  const [items, setItems] = useState<IndexedAnnotation[] | null>(null)

  useEffect(() => {
    const t = setTimeout(() => void api.listAnnotations({ search }).then(setItems), 150)
    return () => clearTimeout(t)
  }, [search, rows])

  const groups = useMemo(() => {
    const m = new Map<number, IndexedAnnotation[]>()
    for (const a of items ?? []) m.set(a.paperId, [...(m.get(a.paperId) ?? []), a])
    return [...m.values()]
  }, [items])

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg" aria-label="Highlights and notes">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4">
        <h1 className="text-[14px] font-bold">Highlights and notes</h1>
        <span className="text-[12px] text-fg-3 tabular-nums">
          {items?.length ?? 0} across {groups.length} {groups.length === 1 ? 'paper' : 'papers'}
        </span>
        <label className="relative ml-auto flex items-center">
          <Search size={13} className="pointer-events-none absolute left-2 text-fg-3" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter highlights"
            aria-label="Filter highlights"
            className="h-7 w-56 rounded-md border border-line bg-input pr-2 pl-7 text-[12px] outline-none placeholder:text-fg-3 focus:border-accent"
          />
        </label>
        <Button
          variant="ghost"
          disabled={!items?.length}
          onClick={() =>
            void api
              .exportAnnotations({ search }, search ? `highlights-${search}` : 'highlights')
              .then((p) => p && toast('success', `Exported to ${p.split('/').pop()}`))
          }
        >
          <FileDown size={14} /> Export Markdown
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4 select-text">
        {items && items.length === 0 && (
          <div className="mx-auto mt-16 max-w-[380px] text-center text-[13px] text-fg-3">
            {search
              ? 'No highlights match.'
              : 'Highlights and notes you make in the reader, or that PDFs arrive with, are collected here.'}
          </div>
        )}
        {groups.map((g) => (
          <article key={g[0]!.paperId} className="mb-6">
            <h2 className="mb-2 font-serif text-[15px] font-semibold">
              <button
                type="button"
                className="text-left hover:text-accent"
                onClick={() => {
                  useStore.getState().setView({ kind: 'all' })
                  useStore.getState().select(g[0]!.paperId)
                }}
              >
                {g[0]!.paperTitle ?? 'Untitled'}
              </button>
              <span className="ml-2 font-sans text-[12px] font-normal text-fg-3">
                {g[0]!.citeLabel}
              </span>
            </h2>
            <ul className="flex flex-col gap-1.5">
              {g.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() =>
                      openReader({
                        kind: 'file',
                        paperId: a.paperId,
                        fileId: a.fileId,
                        page: a.page
                      })
                    }
                    className="group flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-hover"
                    title="Open at this page"
                  >
                    <AnnotationIcon a={a} />
                    <span className="min-w-0 flex-1 text-[13px] leading-relaxed">
                      {a.kind === 'note' || a.kind === 'text' ? (
                        <span className="text-fg">{a.text}</span>
                      ) : (
                        <span className="font-serif text-fg-2">“{a.text ?? '…'}”</span>
                      )}
                      {a.comment && (
                        <span className="mt-0.5 block text-[12px] text-fg">{a.comment}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-[11px] text-fg-3 tabular-nums group-hover:text-accent">
                      p. {a.page}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  )
}

export function AnnotationIcon({ a }: { a: Pick<IndexedAnnotation, 'kind' | 'color'> }) {
  if (a.kind === 'note') return <StickyNote size={14} className="mt-0.5 shrink-0 text-warn" />
  if (a.kind === 'text')
    return <MessageSquareText size={14} className="mt-0.5 shrink-0 text-accent" />
  return (
    <span
      className="mt-1 flex size-3.5 shrink-0 items-center justify-center rounded-sm"
      style={{ background: a.color ?? '#ffe066' }}
    >
      <Highlighter size={9} className="text-black/60" />
    </span>
  )
}
