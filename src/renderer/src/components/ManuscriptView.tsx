import {
  CheckCircle2,
  CircleDashed,
  FileText,
  FolderOpen,
  Library,
  RefreshCw,
  Trash2,
  XCircle
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { ManuscriptView as MView } from '../../../shared/ipc'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { Badge, Button } from './ui'

const cleanError = (err: unknown) =>
  (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** A LaTeX project: its citations matched against the library, and its .bib written from it. */
export function ManuscriptView({ id }: { id: number }) {
  const toast = useStore((s) => s.toast)
  const rows = useStore((s) => s.rows)
  const [m, setM] = useState<MView | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => setM(await api.analyzeManuscript(id)), [id])
  useEffect(() => {
    void load()
  }, [load, rows])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      toast('error', cleanError(err))
    } finally {
      setBusy(false)
      await load()
    }
  }

  if (!m) return <section className="flex-1" aria-label="Manuscript" />
  const keys = m.keys ?? []
  const count = (s: string) => keys.filter((k) => k.status === s).length
  const fetchable = keys.filter((k) => k.status !== 'library' && k.identifier).length
  const titles = new Map(rows.map((r) => [r.id, r]))

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg" aria-label="Manuscript">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4">
        <FileText size={15} className="text-fg-3" />
        <h1 className="truncate text-[14px] font-bold">{m.name}</h1>
        <button
          type="button"
          className="truncate font-mono text-[11px] text-fg-3 hover:text-accent"
          onClick={() => void api.revealPath(m.path)}
          title="Show in Finder"
        >
          {m.path.replace(/^\/Users\/[^/]+/, '~')}
        </button>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" onClick={() => void load()} disabled={busy}>
            <RefreshCw size={13} /> Rescan
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (window.confirm(`Stop tracking ${m.name}? Its files are not touched.`)) {
                void api.removeManuscript(id).then(() => {
                  void useStore.getState().refreshManuscripts()
                  useStore.getState().setView({ kind: 'all' })
                })
              }
            }}
          >
            <Trash2 size={13} />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {m.error ? (
          <p className="text-[13px] text-danger">{m.error}</p>
        ) : (
          <>
            <div className="mb-4 grid grid-cols-4 gap-3">
              <Stat label="Citations" value={keys.length} />
              <Stat label="From the library" value={count('library')} tone="ok" />
              <Stat label="Only in the .bib" value={count('bib-only')} tone="warn" />
              <Stat
                label="Missing"
                value={count('missing')}
                tone={count('missing') ? 'danger' : undefined}
              />
            </div>

            <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-line bg-raised p-3">
              <div className="min-w-0 flex-1 text-[12.5px] text-fg-2">
                Writes{' '}
                <span className="font-mono text-[11.5px]">{m.bibPath?.split('/').pop()}</span>
                {m.bibExists ? ' (the current file is saved as .bak first)' : ' (new file)'} with
                every cited paper the library has, under the manuscript's own keys. Entries the
                library can't supply are kept as they are.
                {m.lastSyncedAt && (
                  <span className="text-fg-3">
                    {' '}
                    Last written {new Date(m.lastSyncedAt).toLocaleString()}.
                  </span>
                )}
              </div>
              <Button
                disabled={busy || !fetchable}
                onClick={() =>
                  void run(async () => {
                    const out = await api.addMissingReferences(id)
                    toast(
                      'success',
                      `Added ${out.length} from ADS (${out.filter((o) => o.pdfSource).length} with PDF).`
                    )
                  })
                }
                title="Add references that have a DOI, bibcode or arXiv id but are not in the library"
              >
                <Library size={13} /> Add {fetchable || ''} to library
              </Button>
              <Button
                disabled={busy || !count('library')}
                onClick={() =>
                  void run(async () => {
                    const cid = await api.collectManuscript(id)
                    await useStore.getState().refreshCollections()
                    toast('success', 'Collection updated.')
                    useStore.getState().setView({ kind: 'collection', id: cid })
                  })
                }
              >
                <FolderOpen size={13} /> Make a collection
              </Button>
              <Button
                variant="primary"
                disabled={busy || !keys.length}
                onClick={() =>
                  void run(async () => {
                    const r = await api.writeManuscriptBib(id)
                    toast(
                      r.missing.length ? 'warning' : 'success',
                      `Wrote ${r.fromLibrary} from the library, kept ${r.kept}` +
                        (r.missing.length
                          ? `; ${r.missing.length} missing: ${r.missing.slice(0, 5).join(', ')}`
                          : '.')
                    )
                  })
                }
              >
                Write .bib
              </Button>
            </div>

            <table className="w-full text-[12.5px]">
              <thead className="text-left text-[11px] text-fg-3">
                <tr>
                  <th className="w-8 py-1" />
                  <th className="py-1 font-semibold">Key</th>
                  <th className="py-1 font-semibold">Paper</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((k) => {
                  const row = k.paperId !== undefined ? titles.get(k.paperId) : undefined
                  return (
                    <tr key={k.key} className="border-t border-line/60">
                      <td className="py-1.5">
                        {k.status === 'library' ? (
                          <CheckCircle2 size={14} className="text-ok" aria-label="In the library" />
                        ) : k.status === 'bib-only' ? (
                          <CircleDashed
                            size={14}
                            className="text-warn"
                            aria-label="Only in the .bib"
                          />
                        ) : (
                          <XCircle size={14} className="text-danger" aria-label="Missing" />
                        )}
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-[11.5px]">{k.key}</td>
                      <td className="py-1.5">
                        {row ? (
                          <button
                            type="button"
                            className="text-left hover:text-accent"
                            onClick={() => {
                              useStore.getState().setView({ kind: 'all' })
                              useStore.getState().select(row.id)
                            }}
                          >
                            {row.first_author} {row.year}: {row.title}
                          </button>
                        ) : k.identifier ? (
                          <span className="text-fg-3">
                            Not in the library{' '}
                            <Badge>
                              {k.identifier.kind}: {k.identifier.value}
                            </Badge>
                          </span>
                        ) : (
                          <span className="text-fg-3">
                            {k.status === 'bib-only'
                              ? 'Kept from the existing .bib'
                              : 'No entry anywhere'}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </>
        )}
      </div>
    </section>
  )
}

function Stat({
  label,
  value,
  tone
}: {
  label: string
  value: number
  tone?: 'ok' | 'warn' | 'danger' | undefined
}) {
  const color =
    tone === 'ok'
      ? 'text-ok'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'danger'
          ? 'text-danger'
          : 'text-fg'
  return (
    <div className="rounded-md border border-line bg-raised px-3 py-2">
      <div className={`text-[20px] font-bold tabular-nums ${color}`}>{value}</div>
      <div className="text-[11px] text-fg-3">{label}</div>
    </div>
  )
}
