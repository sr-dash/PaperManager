import { Bell, RefreshCw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RelatedItem } from '../../../shared/ipc'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { AdsRow } from './DiscoverView'
import { IconButton, cleanError } from './ui'

type Kind = 'references' | 'citations'

/** ADS answers for this session, so switching papers or tabs doesn't ask again. */
const cache = new Map<string, RelatedItem[]>()
const key = (paperId: number, kind: Kind) => `${paperId}:${kind}`

/**
 * What a paper cites and what cites it, from ADS. Both lists load as soon as this shows;
 * papers already in the library are marked, and any other is one click away.
 */
export function RelatedPanel({
  paperId,
  bibcode,
  label,
  onOpenInLibrary
}: {
  paperId: number
  bibcode: string
  label: string
  /** What "In library" does; defaults to selecting the paper in the list. */
  onOpenInLibrary?: (paperId: number) => void
}) {
  const toast = useStore((s) => s.toast)
  const [kind, setKind] = useState<Kind>('references')
  const [lists, setLists] = useState<Partial<Record<Kind, RelatedItem[]>>>(() => ({
    references: cache.get(key(paperId, 'references')),
    citations: cache.get(key(paperId, 'citations'))
  }))
  const [errors, setErrors] = useState<Partial<Record<Kind, string>>>({})
  const [filter, setFilter] = useState('')
  const [missingOnly, setMissingOnly] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    async (k: Kind, fresh = false) => {
      if (!fresh && cache.has(key(paperId, k))) return
      try {
        const items = await api.related(paperId, k)
        cache.set(key(paperId, k), items)
        setLists((l) => ({ ...l, [k]: items }))
        setErrors((e) => ({ ...e, [k]: undefined }))
      } catch (err) {
        setErrors((e) => ({ ...e, [k]: cleanError(err) }))
      }
    },
    [paperId]
  )

  useEffect(() => {
    void load('references')
    void load('citations')
  }, [load])

  const items = lists[kind]
  const shown = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
    return (items ?? []).filter(
      (it) =>
        (!missingOnly || it.paperId === undefined) &&
        words.every((w) =>
          `${it.title ?? ''} ${it.authors.join(' ')} ${it.pub ?? ''} ${it.year ?? ''}`
            .toLowerCase()
            .includes(w)
        )
    )
  }, [items, filter, missingOnly])

  const add = (it: RelatedItem) => {
    setBusy(true)
    void api
      .addFromAds([it.bibcode], [])
      .then(async (out) => {
        toast(
          'success',
          out[0]?.pdfSource
            ? `Added with the ${out[0].pdfSource} PDF.`
            : 'Added (no PDF available).'
        )
        await load(kind, true)
      })
      .catch((err: Error) => toast('error', cleanError(err)))
      .finally(() => setBusy(false))
  }

  const count = (k: Kind) => lists[k]?.length
  const have = items?.filter((i) => i.paperId !== undefined).length ?? 0

  return (
    <section aria-label="References and citations" className="flex min-h-0 flex-col">
      <div className="flex items-center gap-2">
        <div role="tablist" aria-label="Which list" className="flex rounded-md bg-hover p-0.5">
          {(['references', 'citations'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={kind === k}
              onClick={() => setKind(k)}
              className={`flex h-6 items-center gap-1.5 rounded px-2.5 text-[12px] ${
                kind === k ? 'bg-raised font-medium text-fg shadow-sm' : 'text-fg-2 hover:text-fg'
              }`}
            >
              {k === 'references' ? 'References' : 'Cited by'}
              <span className="text-[11px] text-fg-3 tabular-nums">{count(k) ?? '…'}</span>
            </button>
          ))}
        </div>
        <span className="ml-auto" />
        <IconButton label="Ask ADS again" onClick={() => void load(kind, true)}>
          <RefreshCw size={13} />
        </IconButton>
        <IconButton
          label="Watch for new citations"
          onClick={() =>
            void api
              .createWatch(`Citing: ${label.slice(0, 60)}`, `citations(bibcode:"${bibcode}")`)
              .then(() => toast('success', 'Watching for new citations; see Discover.'))
              .catch((err: Error) => toast('error', cleanError(err)))
          }
        >
          <Bell size={13} />
        </IconButton>
      </div>

      {items && items.length > 0 && (
        <div className="mt-2.5 flex items-center gap-2">
          <label className="relative flex flex-1 items-center">
            <Search size={12} className="pointer-events-none absolute left-2 text-fg-3" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={`Filter ${items.length} ${kind === 'references' ? 'references' : 'citing papers'}`}
              aria-label="Filter the list"
              className="h-7 w-full rounded-md border border-line bg-input pr-2 pl-7 text-[12px] outline-none placeholder:text-fg-3 focus:border-accent"
            />
          </label>
          <label className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-fg-2">
            <input
              type="checkbox"
              checked={missingOnly}
              onChange={(e) => setMissingOnly(e.target.checked)}
            />
            Not in library
          </label>
        </div>
      )}

      <div className="mt-2 min-h-0 flex-1">
        {errors[kind] ? (
          <p className="text-[12.5px] text-danger">{errors[kind]}</p>
        ) : !items ? (
          <p className="text-[12.5px] text-fg-3">Asking ADS…</p>
        ) : items.length === 0 ? (
          <p className="text-[12.5px] text-fg-3">
            {kind === 'references'
              ? 'ADS lists no references for this paper.'
              : 'ADS knows of no papers citing this one yet.'}
          </p>
        ) : (
          <>
            <p className="text-[11.5px] text-fg-3">
              {have} of {items.length} in your library
            </p>
            <ul>
              {shown.map((it) => (
                <AdsRow
                  key={it.bibcode}
                  item={it}
                  busy={busy}
                  onAdd={() => add(it)}
                  onOpen={onOpenInLibrary}
                />
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  )
}
