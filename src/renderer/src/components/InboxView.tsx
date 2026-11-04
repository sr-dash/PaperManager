import {
  Check,
  Eye,
  EyeOff,
  FileCheck2,
  FolderPlus,
  Info,
  RefreshCw,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ImportOutcome, InboxItem } from '../../../shared/ipc'
import { api } from '../lib/api'
import { formatBytes, relativeDate } from '../lib/format'
import { useStore } from '../lib/store'
import { Badge, Button, IconButton, inputClass } from './ui'

type Section = 'paper' | 'maybe' | 'other' | 'ignored' | 'filed'

const SECTIONS: { key: Section; label: string; hint: string }[] = [
  {
    key: 'paper',
    label: 'Likely papers',
    hint: 'Strong signs of a journal article, preprint or thesis.'
  },
  { key: 'maybe', label: 'Unsure', hint: 'Some signs of a paper; worth a look.' },
  {
    key: 'other',
    label: 'Not papers',
    hint: 'Figures, forms, receipts and other documents. Only their names are kept.'
  },
  {
    key: 'ignored',
    label: 'Ignored',
    hint: 'Dismissed files stay dismissed, even if renamed or downloaded again.'
  },
  { key: 'filed', label: 'Already filed', hint: 'These exact files are already in your library.' }
]

function sectionOf(i: InboxItem): Section {
  if (i.state === 'filed') return 'filed'
  if (i.state === 'ignored') return 'ignored'
  return i.verdict
}

export function InboxView({ onFiled }: { onFiled: (outcomes: ImportOutcome[]) => void }) {
  const inbox = useStore((s) => s.inbox)
  const refreshInbox = useStore((s) => s.refreshInbox)
  const toast = useStore((s) => s.toast)
  const openReader = useStore((s) => s.openReader)
  const [section, setSection] = useState<Section>('paper')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [tags, setTags] = useState('')
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    void refreshInbox()
  }, [refreshInbox])

  const bySection = useMemo(() => {
    const m: Record<Section, InboxItem[]> = {
      paper: [],
      maybe: [],
      other: [],
      ignored: [],
      filed: []
    }
    for (const i of inbox?.items ?? []) m[sectionOf(i)].push(i)
    return m
  }, [inbox])
  const items = bySection[section]

  // Selection only ever refers to rows in the current section.
  useEffect(() => setSelected(new Set()), [section])
  const chosen = items.filter((i) => selected.has(i.path)).map((i) => i.path)
  const allChosen = items.length > 0 && chosen.length === items.length

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      toast(
        'error',
        (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      )
    } finally {
      setBusy(false)
      setSelected(new Set())
      await refreshInbox()
    }
  }

  const file = (paths: string[]) =>
    run(async () => {
      const list = tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      onFiled(await api.acceptInbox(paths, list))
    })
  const ignore = (paths: string[]) => run(() => api.ignoreInbox(paths))
  const unignore = (paths: string[]) => run(() => api.unignoreInbox(paths))

  if (!inbox) return <section className="flex-1" aria-label="Inbox" />

  const canFile =
    section === 'paper' || section === 'maybe' || section === 'other' || section === 'ignored'

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg" aria-label="Inbox">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4">
        <h1 className="text-[14px] font-bold">Inbox</h1>
        <span className="text-[12px] text-fg-3">
          PDFs in watched folders that are not in your library. Originals are left in place.
        </span>
        <div className="ml-auto flex items-center gap-2">
          {inbox.scanning && (
            <span className="text-[12px] text-fg-2 tabular-nums" aria-live="polite">
              Scanning {inbox.scanning.done} of {inbox.scanning.total}…
            </span>
          )}
          <IconButton
            label="Scan again"
            onClick={() => void api.rescanInbox()}
            disabled={!!inbox.scanning}
          >
            <RefreshCw size={14} className={inbox.scanning ? 'animate-spin' : ''} />
          </IconButton>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Inbox sections"
        className="flex shrink-0 gap-1 border-b border-line px-3 pt-2"
      >
        {SECTIONS.map((s) => (
          <button
            key={s.key}
            role="tab"
            type="button"
            aria-selected={section === s.key}
            onClick={() => setSection(s.key)}
            className={`-mb-px flex h-8 items-center gap-1.5 border-b-2 px-2.5 text-[12.5px] ${
              section === s.key
                ? 'border-accent font-semibold text-fg'
                : 'border-transparent text-fg-2 hover:text-fg'
            }`}
          >
            {s.label}
            <span className="rounded bg-hover px-1.5 text-[11px] text-fg-3 tabular-nums">
              {bySection[s.key].length}
            </span>
          </button>
        ))}
      </div>

      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <label className="flex items-center gap-2 text-[12px] text-fg-2">
          <input
            type="checkbox"
            checked={allChosen}
            disabled={!items.length}
            onChange={() => setSelected(allChosen ? new Set() : new Set(items.map((i) => i.path)))}
            aria-label="Select all"
          />
          {chosen.length
            ? `${chosen.length} selected`
            : SECTIONS.find((s) => s.key === section)!.hint}
        </label>
        {chosen.length > 0 && canFile && (
          <div className="ml-auto flex items-center gap-2">
            <input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="Tags (comma separated)"
              aria-label="Tags for filed papers"
              className={`${inputClass} h-7 w-52 py-0 text-[12px]`}
            />
            <Button variant="primary" disabled={busy} onClick={() => void file(chosen)}>
              <Check size={13} /> Add {chosen.length} to library
            </Button>
            {section === 'ignored' ? (
              <Button disabled={busy} onClick={() => void unignore(chosen)}>
                <Undo2 size={13} /> Restore
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => void ignore(chosen)}>
                <EyeOff size={13} /> Ignore
              </Button>
            )}
          </div>
        )}
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto" aria-label="Inbox files">
        {items.length === 0 && (
          <li className="p-10 text-center text-[13px] text-fg-3">
            {inbox.scanning ? 'Scanning…' : 'Nothing here.'}
          </li>
        )}
        {items.map((i) => {
          const isOpen = expanded === i.path
          const id = i.identifiers[0]
          return (
            <li
              key={i.path}
              className={`border-b border-line/60 px-4 py-2 ${selected.has(i.path) ? 'bg-selected' : 'hover:bg-hover'}`}
            >
              <div className="flex items-start gap-3">
                {section !== 'filed' && (
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(i.path)}
                    aria-label={`Select ${i.name}`}
                    onChange={() =>
                      setSelected((prev) => {
                        const next = new Set(prev)
                        if (next.has(i.path)) next.delete(i.path)
                        else next.add(i.path)
                        return next
                      })
                    }
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-[13px] font-medium" title={i.title ?? i.name}>
                      {i.title ?? i.name}
                    </span>
                    {id && (
                      <Badge tone="accent">
                        {id.kind === 'doi' ? 'DOI' : id.kind === 'arxiv' ? 'arXiv' : 'bibcode'}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-fg-3">
                    {i.title && <span className="truncate font-mono">{i.name}</span>}
                    {i.copies.length > 0 && (
                      <span className="shrink-0" title={i.copies.join('\n')}>
                        +{i.copies.length} identical {i.copies.length === 1 ? 'copy' : 'copies'} ·
                      </span>
                    )}
                    <span className="shrink-0">
                      {i.pages ? `${i.pages} pp · ` : ''}
                      {formatBytes(i.size)} · {relativeDate(new Date(i.mtimeMs).toISOString())}
                    </span>
                  </div>
                  {isOpen && (
                    <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-fg-2">
                      {i.reasons.map((r) => (
                        <li key={r} className={r.startsWith('-') ? 'text-warn' : ''}>
                          {r}
                        </li>
                      ))}
                      <li className="text-fg-3">score {i.score}</li>
                    </ul>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <IconButton
                    label={isOpen ? 'Hide reasons' : 'Why this verdict?'}
                    onClick={() => setExpanded(isOpen ? null : i.path)}
                  >
                    <Info size={14} />
                  </IconButton>
                  <IconButton
                    label="Preview"
                    onClick={() =>
                      openReader({ kind: 'inbox', path: i.path, title: i.title ?? i.name })
                    }
                  >
                    <Eye size={14} />
                  </IconButton>
                  {section === 'filed' ? (
                    <FileCheck2 size={14} className="mx-1.5 text-ok" aria-label="In the library" />
                  ) : section === 'ignored' ? (
                    <IconButton label="Restore" onClick={() => void unignore([i.path])}>
                      <Undo2 size={14} />
                    </IconButton>
                  ) : (
                    <>
                      <IconButton label="Ignore" onClick={() => void ignore([i.path])}>
                        <X size={14} />
                      </IconButton>
                      <Button className="ml-1" disabled={busy} onClick={() => void file([i.path])}>
                        Add
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-2.5 text-[12px] text-fg-2">
        <span className="text-fg-3">Watching</span>
        {inbox.folders.map((f) => (
          <span
            key={f}
            className="inline-flex items-center gap-1 rounded bg-hover py-0.5 pr-1 pl-2 font-mono text-[11.5px]"
          >
            {f.replace(/^\/Users\/[^/]+/, '~')}
            <button
              type="button"
              aria-label={`Stop watching ${f}`}
              className="flex size-4 items-center justify-center rounded text-fg-3 hover:bg-line hover:text-fg"
              onClick={() => void run(async () => void (await api.removeInboxFolder(f)))}
            >
              <X size={11} />
            </button>
          </span>
        ))}
        <Button
          variant="ghost"
          onClick={() => void run(async () => void (await api.addInboxFolder()))}
        >
          <FolderPlus size={13} /> Add folder
        </Button>

        <label
          className="ml-auto flex items-center gap-2"
          title="Only after the copy is safely in the library"
        >
          <input
            type="checkbox"
            checked={inbox.trashAfterFiling}
            onChange={(e) => void run(() => api.setTrashAfterFiling(e.target.checked))}
          />
          Move originals to the Trash after adding
        </label>
        {bySection.filed.length > 0 && (
          <Button
            variant="ghost"
            onClick={() => {
              const n = bySection.filed.length
              if (
                window.confirm(
                  `Move ${n} original${n === 1 ? '' : 's'} already in your library to the Trash?`
                )
              ) {
                void run(async () => {
                  const moved = await api.disposeFiledOriginals()
                  toast('success', `Moved ${moved} original${moved === 1 ? '' : 's'} to the Trash.`)
                })
              }
            }}
          >
            <Trash2 size={13} /> Clean up {bySection.filed.length} already filed
          </Button>
        )}
      </footer>
    </section>
  )
}
