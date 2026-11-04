import { BookCheck, ExternalLink, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AddOutcome, RelatedItem } from '../../../shared/ipc'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { Badge, Button, IconButton, inputClass } from './ui'

const cleanError = (err: unknown) =>
  (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const PRESETS: { label: string; name: string; query: string; hint: string }[] = [
  {
    label: 'Papers citing me',
    name: 'Citing my papers',
    query: 'citations(author:"^Surname, Given")',
    hint: 'New papers citing any first-author paper of yours (put your name in)'
  },
  {
    label: 'New papers by an author',
    name: 'New by an author',
    query: 'author:"Surname, G" entdate:[NOW-30DAYS TO NOW]',
    hint: 'Anything an author published recently (put their name in)'
  },
  {
    label: 'arXiv astro-ph.SR this week',
    name: 'astro-ph.SR',
    query: 'arxiv_class:"astro-ph.SR" entdate:[NOW-7DAYS TO NOW]',
    hint: 'Every new solar and stellar preprint'
  },
  {
    label: 'Topic',
    name: 'Coronal magnetometry',
    query: 'abs:"coronal magnetic field" abs:(polarimetry OR Zeeman) entdate:[NOW-30DAYS TO NOW]',
    hint: 'Recent papers on a subject'
  }
]

/** ADS watches, their new results, and journal versions of preprints in the library. */
export function DiscoverView() {
  const d = useStore((s) => s.discover)
  const refresh = useStore((s) => s.refreshDiscover)
  const toast = useStore((s) => s.toast)
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [tags, setTags] = useState('')

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!d) return <section className="flex-1" aria-label="Discover" />

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    try {
      await fn()
      if (done) toast('success', done)
    } catch (err) {
      toast('error', cleanError(err))
    } finally {
      setBusy(false)
      await refresh()
    }
  }

  const add = (bibcodes: string[]) =>
    run(async () => {
      const out: AddOutcome[] = await api.addFromAds(
        bibcodes,
        tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      )
      const pdfs = out.filter((o) => o.pdfSource).length
      toast('success', `Added ${out.length} (${pdfs} with PDF).`)
    })

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg" aria-label="Discover">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4">
        <h1 className="text-[14px] font-bold">Discover</h1>
        <span className="text-[12px] text-fg-3">New papers from ADS, checked every six hours.</span>
        <Button
          className="ml-auto"
          disabled={!d.hasToken || busy || d.running}
          onClick={() => void run(() => api.runWatches())}
        >
          <RefreshCw size={13} className={d.running ? 'animate-spin' : ''} /> Check now
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {!d.hasToken && (
          <p className="mb-4 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
            Discover needs an ADS API token. Add one in Settings.
          </p>
        )}

        {d.published.length > 0 && (
          <section className="mb-6">
            <h2 className="mb-2 text-[12px] font-bold tracking-wide text-fg-3 uppercase">
              Published versions of your preprints
            </h2>
            <ul className="flex flex-col gap-1">
              {d.published.map((p) => (
                <li
                  key={p.paperId}
                  className="flex items-center gap-3 rounded-md border border-line bg-raised px-3 py-2"
                >
                  <BookCheck size={15} className="shrink-0 text-ok" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{p.title ?? p.arxivId}</div>
                    <div className="text-[11.5px] text-fg-3">
                      arXiv:{p.arxivId} → {p.pub ?? p.bibcode} {p.year}
                    </div>
                  </div>
                  <Button
                    variant="primary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const r = await api.adoptPublished(p.paperId)
                        toast(
                          r.pdfSource ? 'success' : 'warning',
                          r.pdfSource
                            ? `Updated; attached the ${r.pdfSource} PDF.`
                            : 'Details updated; the journal PDF could not be downloaded.'
                        )
                      })
                    }
                  >
                    Update to journal version
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mb-6">
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-[12px] font-bold tracking-wide text-fg-3 uppercase">
              New results ({d.hits.length})
            </h2>
            {d.hits.length > 0 && (
              <>
                <input
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="Tags for added papers"
                  aria-label="Tags for added papers"
                  className={`${inputClass} ml-auto h-7 w-48 py-0 text-[12px]`}
                />
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      api.setHitState(
                        d.hits.map((h) => h.bibcode),
                        'dismissed'
                      )
                    )
                  }
                >
                  Dismiss all
                </Button>
              </>
            )}
          </div>
          {d.hits.length === 0 && (
            <p className="text-[12.5px] text-fg-3">
              Nothing new. Results appear here when a watch finds papers you don't have.
            </p>
          )}
          <ul className="flex flex-col">
            {d.hits.map((h) => (
              <AdsRow
                key={`${h.watchId}-${h.bibcode}`}
                item={h}
                extra={<Badge>{h.watchName}</Badge>}
                onAdd={() => void add([h.bibcode])}
                onDismiss={() => void run(() => api.setHitState([h.bibcode], 'dismissed'))}
                busy={busy}
              />
            ))}
          </ul>
        </section>

        <section>
          <h2 className="mb-2 text-[12px] font-bold tracking-wide text-fg-3 uppercase">Watches</h2>
          <ul className="mb-3 flex flex-col gap-1">
            {d.watches.map((w) => (
              <li
                key={w.id}
                className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-hover"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">
                    {w.name} {w.newCount > 0 && <Badge tone="accent">{w.newCount} new</Badge>}
                  </div>
                  <div className="truncate font-mono text-[11px] text-fg-3">{w.query}</div>
                  {w.lastError && (
                    <div className="text-[11px] text-danger">Last run failed: {w.lastError}</div>
                  )}
                </div>
                <span className="text-[11px] text-fg-3">
                  {w.lastRunAt
                    ? `checked ${new Date(w.lastRunAt).toLocaleString()}`
                    : 'not run yet'}
                </span>
                <IconButton
                  label={`Delete watch ${w.name}`}
                  onClick={() => void run(() => api.deleteWatch(w.id))}
                >
                  <Trash2 size={13} />
                </IconButton>
              </li>
            ))}
          </ul>
          <form
            className="flex flex-col gap-2 rounded-md border border-line bg-raised p-3"
            onSubmit={(e) => {
              e.preventDefault()
              void run(async () => {
                await api.createWatch(name, query)
                setName('')
                setQuery('')
              }, 'Watch added; checking ADS now.')
            }}
          >
            <div className="flex gap-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name"
                aria-label="Watch name"
                className={`${inputClass} w-56`}
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="ADS query, as in the ADS search box"
                aria-label="Watch query"
                className={`${inputClass} flex-1 font-mono text-[12px]`}
              />
              <Button
                type="submit"
                variant="primary"
                disabled={!d.hasToken || busy || !name.trim() || !query.trim()}
              >
                <Plus size={13} /> Add watch
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5 text-[11.5px] text-fg-3">
              Start from:
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  title={p.hint}
                  onClick={() => {
                    setName(p.name)
                    setQuery(p.query)
                  }}
                  className="rounded border border-line px-1.5 text-accent hover:bg-accent-soft"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </form>
        </section>
      </div>
    </section>
  )
}

/** One ADS result: title, authors, venue, and add / open / dismiss actions. */
export function AdsRow({
  item,
  extra,
  onAdd,
  onDismiss,
  onOpen,
  busy
}: {
  item: RelatedItem
  extra?: React.ReactNode
  onAdd: () => void
  onDismiss?: () => void
  /** What "In library" does; defaults to selecting the paper in the list. */
  onOpen?: ((paperId: number) => void) | undefined
  busy: boolean
}) {
  const inLibrary = item.paperId !== undefined
  const authors =
    item.authors.map((a) => a.split(',')[0]).join(', ') +
    (item.authors.length >= 4 ? ' et al.' : '')
  return (
    <li className="flex items-start gap-3 border-b border-line/60 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] leading-snug font-medium">{item.title ?? item.bibcode}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-fg-3">
          <span>{authors}</span>
          <span>
            {item.pub} {item.year}
          </span>
          {extra}
        </div>
      </div>
      <IconButton
        label="Open on ADS"
        onClick={() =>
          void api.openUrl(`https://ui.adsabs.harvard.edu/abs/${encodeURIComponent(item.bibcode)}`)
        }
      >
        <ExternalLink size={13} />
      </IconButton>
      {inLibrary ? (
        <button
          type="button"
          className="h-7 shrink-0 rounded-md px-2 text-[12px] font-semibold text-ok hover:bg-ok-soft"
          onClick={() => {
            if (onOpen) return onOpen(item.paperId!)
            useStore.getState().setView({ kind: 'all' })
            useStore.getState().select(item.paperId!)
          }}
        >
          In library
        </button>
      ) : (
        <Button disabled={busy} onClick={onAdd}>
          <Plus size={13} /> Add
        </Button>
      )}
      {onDismiss && (
        <IconButton label="Dismiss" onClick={onDismiss}>
          <X size={13} />
        </IconButton>
      )}
    </li>
  )
}
