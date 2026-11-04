import { useEffect, useState } from 'react'
import type { Collection } from '../../../shared/ipc'
import { api } from '../lib/api'
import { Button, Dialog, inputClass } from './ui'

const EXAMPLES = [
  'tag:CryoNIRSP year:>2020',
  'author:Schad status:to-read',
  'coronal magnetometry -tag:read',
  'journal:ApJ is:annotated'
]

/** Create or edit a collection. With a query it is "smart": its papers are whatever matches. */
export function CollectionDialog({
  collection,
  initialQuery,
  onClose,
  onSaved
}: {
  collection?: Collection
  initialQuery?: string
  onClose: () => void
  onSaved: (id: number) => void
}) {
  const [name, setName] = useState(collection?.name ?? '')
  const [smart, setSmart] = useState(!!(collection?.query ?? initialQuery))
  const [query, setQuery] = useState(collection?.query ?? initialQuery ?? '')
  const [matches, setMatches] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!smart || !query.trim()) {
      setMatches(null)
      return
    }
    const t = setTimeout(() => void api.query(query).then((h) => setMatches(h.length)), 250)
    return () => clearTimeout(t)
  }, [smart, query])

  const save = async () => {
    setError(null)
    try {
      const q = smart ? query : null
      if (collection) {
        await api.updateCollection(collection.id, { name, query: q })
        onSaved(collection.id)
      } else {
        onSaved(await api.createCollection(name, q))
      }
    } catch (err) {
      setError(
        (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      )
    }
  }

  return (
    <Dialog
      title={collection ? 'Edit collection' : 'New collection'}
      onClose={onClose}
      footer={
        <>
          {error && <span className="mr-auto self-center text-[12px] text-danger">{error}</span>}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void save()}
            disabled={!name.trim() || (smart && !query.trim())}
          >
            {collection ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-fg-2">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputClass}
            aria-label="Collection name"
          />
        </label>
        <fieldset className="flex flex-col gap-2 text-[13px]">
          <label className="flex items-start gap-2">
            <input
              type="radio"
              checked={!smart}
              onChange={() => setSmart(false)}
              className="mt-1"
            />
            <span>
              <b>Manual</b>: add papers from the list or the details pane.
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" checked={smart} onChange={() => setSmart(true)} className="mt-1" />
            <span>
              <b>Smart</b>: always contains the papers matching a search.
            </span>
          </label>
        </fieldset>
        {smart && (
          <label className="flex flex-col gap-1">
            <span className="flex justify-between text-[11px] font-semibold text-fg-2">
              Search
              {matches !== null && (
                <span className="font-normal text-fg-3">{matches} papers match now</span>
              )}
            </span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className={`${inputClass} font-mono text-[12px]`}
              aria-label="Smart collection query"
              placeholder="tag:CryoNIRSP year:>2020"
            />
            <span className="text-[11px] leading-relaxed text-fg-3">
              Words search the full text. Filters: <code>tag:</code> <code>-tag:</code>{' '}
              <code>author:</code> <code>journal:</code> <code>year:2020</code>/
              <code>&gt;2020</code>/<code>2019-2021</code>{' '}
              <code>status:to-read|reading|read|unread|review</code>{' '}
              <code>is:starred|annotated|noted|nopdf</code> <code>collection:"…"</code>. For
              example:{' '}
              {EXAMPLES.map((ex, i) => (
                <button
                  key={ex}
                  type="button"
                  className="font-mono text-accent"
                  onClick={() => setQuery(ex)}
                >
                  {ex}
                  {i < EXAMPLES.length - 1 ? ', ' : ''}
                </button>
              ))}
            </span>
          </label>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}
