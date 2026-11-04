import {
  BookMarked,
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  FileDown,
  FileUp,
  FolderSearch,
  Globe,
  Lock,
  Paperclip,
  Pencil,
  RefreshCw,
  Replace,
  Share,
  Star,
  Trash2,
  Unlock,
  X
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { PaperDetail, PaperFile, ReadingStatus } from '../../../shared/ipc'
import { api } from '../lib/api'
import { authorLine, formatBytes, middleEllipsis, relativeDate } from '../lib/format'
import { useStore } from '../lib/store'
import { AnnotationIcon } from './HighlightsView'
import { MetadataDialog } from './MetadataDialog'
import { RelatedPanel } from './RelatedPanel'
import {
  Badge,
  Button,
  IconButton,
  Menu,
  SectionLabel,
  Tabs,
  cleanError,
  type MenuItem
} from './ui'

type Tab = 'overview' | 'notes' | 'related' | 'files'

export function DetailPane({ onOpen }: { onOpen: (paperId: number, fileId: number) => void }) {
  const activeId = useStore((s) => s.activeId)
  const selectedCount = useStore((s) => s.selected.length)
  const rows = useStore((s) => s.rows) // refetch when the library changes
  const [detail, setDetail] = useState<PaperDetail | null>(null)
  // The open tab stays put while you move between papers.
  const [tab, setTab] = useState<Tab>('overview')

  const load = useCallback(async () => {
    setDetail(activeId === null ? null : await api.getPaper(activeId))
  }, [activeId])

  useEffect(() => {
    void load()
  }, [load, rows])

  return (
    <aside
      aria-label="Paper details"
      className="flex w-[384px] shrink-0 flex-col border-l border-line bg-raised"
    >
      {selectedCount > 1 ? (
        <Placeholder
          text={`${selectedCount} papers selected. Use “Selected” above the list to act on them.`}
        />
      ) : detail ? (
        <Detail
          key={detail.row.id}
          detail={detail}
          reload={load}
          onOpen={onOpen}
          tab={tab}
          setTab={setTab}
        />
      ) : (
        <Placeholder text="Select a paper to see its details." />
      )}
    </aside>
  )
}

function Placeholder({ text }: { text: string }) {
  return <div className="m-auto max-w-[240px] p-6 text-center text-[13px] text-fg-3">{text}</div>
}

function Detail({
  detail,
  reload,
  onOpen,
  tab,
  setTab
}: {
  detail: PaperDetail
  reload: () => Promise<void>
  onOpen: (paperId: number, fileId: number) => void
  tab: Tab
  setTab: (t: Tab) => void
}) {
  const { row, metadata: m, files } = detail
  const refresh = useStore((s) => s.refresh)
  const toast = useStore((s) => s.toast)
  const hasToken = useStore((s) => s.info?.adsToken)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [dropping, setDropping] = useState(false)

  const act = async (fn: () => Promise<unknown>, done?: string, key = 'busy') => {
    setBusy(key)
    try {
      await fn()
      await Promise.all([refresh(), reload()])
      if (done) toast('success', done)
    } catch (err) {
      toast('error', cleanError(err))
    } finally {
      setBusy(null)
    }
  }

  const lookUp = () =>
    act(async () => {
      const r = await api.resolvePaper(row.id)
      if (r.status === 'unchanged') {
        toast(
          r.errors.length ? 'error' : 'warning',
          r.errors.length
            ? `Lookup failed: ${r.errors[0]}`
            : 'No matching record found. Edit the details by hand.'
        )
      } else {
        toast(
          'success',
          r.status === 'merged' ? 'Found an existing copy; merged into it.' : 'Details updated.'
        )
        if (r.paperId !== row.id) useStore.getState().select(r.paperId)
      }
    })

  const main = files[0]
  const preprintOnly = files.length > 0 && files.every((f) => f.origin === 'arxiv')
  const publisherPage = m.doi
    ? `https://doi.org/${m.doi}`
    : m.bibcode
      ? `https://ui.adsabs.harvard.edu/link_gateway/${encodeURIComponent(m.bibcode)}/PUB_HTML`
      : undefined

  const getPublisher = () =>
    act(
      async () => {
        const r = await api.getPublisherPdf(row.id)
        if (!r.source) {
          toast(
            'warning',
            'The publisher’s PDF isn’t reachable from this network. Open the publisher page, sign in through your institution, download it, and drop it here.'
          )
        } else {
          toast(
            'success',
            r.replaced?.length
              ? 'Got the publisher PDF; it replaced the arXiv version.'
              : 'Got the publisher PDF.'
          )
        }
      },
      undefined,
      'publisher'
    )

  const replaceWithDialog = (f: PaperFile) =>
    act(async () => {
      const r = await api.replaceFile(f.id)
      if (r) toast('success', `Replaced. Now ${r.relPath.split('/').pop()}.`)
    })

  const links = [
    m.bibcode && {
      label: 'ADS',
      url: `https://ui.adsabs.harvard.edu/abs/${encodeURIComponent(m.bibcode)}`
    },
    m.doi && { label: 'DOI', url: `https://doi.org/${m.doi}` },
    m.arxivId && { label: 'arXiv', url: `https://arxiv.org/abs/${m.arxivId}` }
  ].filter(Boolean) as { label: string; url: string }[]

  const venue = [m.journal, m.volume && `${m.volume}`, m.page && `${m.page}`]
    .filter(Boolean)
    .join(', ')

  const more: (MenuItem | '-')[] = [
    { label: 'Edit details…', icon: <Pencil size={14} />, onSelect: () => setEditing(true) },
    row.metadata_status === 'manual'
      ? {
          label: 'Allow lookups again',
          icon: <Unlock size={14} />,
          onSelect: () =>
            void act(() => api.unlockMetadata(row.id), 'Automatic lookups re-enabled.')
        }
      : { label: 'Look up again', icon: <RefreshCw size={14} />, onSelect: () => void lookUp() },
    {
      label: 'Copy BibTeX',
      icon: <Copy size={14} />,
      onSelect: () =>
        void act(
          async () => navigator.clipboard.writeText(await api.exportBibtex([row.id])),
          'BibTeX copied.'
        )
    },
    '-',
    ...(publisherPage
      ? ([
          {
            label: 'Get publisher PDF',
            icon: <Download size={14} />,
            onSelect: () => void getPublisher()
          },
          {
            label: 'Open publisher page',
            icon: <Globe size={14} />,
            onSelect: () => void api.openUrl(publisherPage)
          }
        ] as const)
      : []),
    ...(main
      ? ([
          {
            label: 'Replace PDF…',
            icon: <Replace size={14} />,
            onSelect: () => void replaceWithDialog(main)
          }
        ] as const)
      : []),
    {
      label: main ? 'Attach another PDF…' : 'Attach PDF…',
      icon: <Paperclip size={14} />,
      onSelect: () => void act(() => api.attachPdf(row.id))
    },
    '-',
    {
      label: 'Remove from library',
      icon: <Trash2 size={14} />,
      danger: true,
      onSelect: () => {
        if (
          window.confirm(
            `Remove “${m.title ?? 'this paper'}” from the library?\n\nIts files will be moved to the Trash.`
          )
        ) {
          void act(() => api.removePaper(row.id), 'Paper removed; its files are in the Trash.')
        }
      }
    }
  ]

  return (
    <div
      data-attach-drop
      className={`relative flex min-h-0 flex-1 flex-col ${dropping ? 'ring-2 ring-accent ring-inset' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        // Not stopped: the app hides its "add to library" overlay while over this pane.
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDropping(false)
        const path = [...e.dataTransfer.files]
          .map((f) => api.pathForFile(f))
          .find((p) => /\.pdf$/i.test(p))
        if (!path) return
        void act(async () => {
          const r = await api.attachPath(row.id, path)
          toast(
            'success',
            r.replaced?.length
              ? `Added the publisher PDF; it replaced the arXiv version.`
              : `Added ${r.relPath.split('/').pop()} to this paper.`
          )
          setTab('files')
        })
      }}
    >
      {dropping && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg bg-accent-soft/90 text-center text-[13px] font-medium text-accent">
          Drop to add this PDF to the paper.
          <br />A publisher PDF replaces the arXiv version.
        </div>
      )}

      <div className="px-5 pt-4 pb-3 select-text">
        <div className="mb-2 flex items-center gap-1.5 text-[11.5px] text-fg-3">
          {row.metadata_status === 'unresolved' && <Badge tone="warn">Needs review</Badge>}
          {row.metadata_status === 'manual' && (
            <Badge tone="accent">
              <Lock size={10} className="mr-1" /> Edited by hand
            </Badge>
          )}
          {row.metadata_status === 'resolved' && row.metadata_source && (
            <span>From {sourceName(row.metadata_source)}</span>
          )}
          <span>· added {relativeDate(row.added_at)}</span>
        </div>

        <h2 className="font-serif text-[19px] leading-snug font-semibold text-balance">
          {m.title || 'Untitled'}
        </h2>
        {m.authors.length > 0 && (
          <p className="mt-2 text-[12.5px] leading-relaxed text-fg-2">{authorLine(m.authors, 6)}</p>
        )}
        <p className="mt-0.5 text-[12.5px] text-fg-3">
          {venue}
          {venue && m.year ? ' · ' : ''}
          {m.year}
          {links.map((l) => (
            <button
              key={l.label}
              type="button"
              onClick={() => void api.openUrl(l.url)}
              className="ml-2 inline-flex items-center gap-0.5 text-accent hover:underline"
            >
              {l.label}
              <ExternalLink size={10} />
            </button>
          ))}
        </p>

        <div className="mt-3.5 flex items-center gap-1.5">
          {main ? (
            <Button
              variant="primary"
              className="flex-1 justify-center"
              onClick={() => onOpen(row.id, main.id)}
            >
              <BookOpen size={14} /> Read
            </Button>
          ) : (
            <Button
              variant="primary"
              className="flex-1 justify-center"
              disabled={busy !== null}
              title="Download it from the publisher, arXiv or ADS"
              onClick={() =>
                void act(async () => {
                  const r = await api.fetchPdf(row.id)
                  toast(
                    r.source ? 'success' : 'warning',
                    r.source
                      ? `Attached the ${r.source} PDF.`
                      : 'No PDF could be downloaded. Attach one from the ⋯ menu.'
                  )
                })
              }
            >
              <Download size={14} /> Find PDF
            </Button>
          )}
          <ReadingMenu
            value={row.reading}
            onChange={(r) => void act(() => api.setReading([row.id], r))}
          />
          <IconButton
            label={row.starred ? 'Unstar' : 'Star'}
            aria-pressed={!!row.starred}
            onClick={() => void act(() => api.setStarred([row.id], !row.starred))}
            className={`border border-line ${row.starred ? 'text-warn' : ''}`}
          >
            <Star size={14} fill={row.starred ? 'currentColor' : 'none'} />
          </IconButton>
          <Menu
            label="Paper actions"
            items={more}
            trigger={(p) => (
              <IconButton label="More actions" className="border border-line" {...p}>
                <Ellipsis size={15} />
              </IconButton>
            )}
          />
        </div>
      </div>

      <div className="px-5">
        <Tabs
          label="Paper sections"
          value={tab}
          onChange={setTab}
          tabs={[
            { key: 'overview', label: 'Overview' },
            {
              key: 'notes',
              label: 'Notes',
              count: detail.annotations.length + (detail.note ? 1 : 0)
            },
            { key: 'related', label: 'Refs & citations' },
            { key: 'files', label: 'Files', count: files.length }
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-6 select-text" role="tabpanel">
        {tab === 'overview' && (
          <>
            {preprintOnly && publisherPage && (
              <PreprintNotice
                busy={busy === 'publisher'}
                onGet={() => void getPublisher()}
                onOpenPage={() => void api.openUrl(publisherPage)}
                onShowFiles={() => setTab('files')}
              />
            )}
            {m.abstract && <Abstract text={m.abstract} />}
            <Section title="Tags">
              <TagEditor paperId={row.id} tags={detail.tags} onChange={() => act(async () => {})} />
            </Section>
            <Section title="Collections">
              <CollectionPicker
                paperId={row.id}
                member={detail.collections}
                onChange={() => act(async () => {})}
              />
            </Section>
            <Section title="Identifiers">
              <dl className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1 font-mono text-[11.5px]">
                <Id label="bibcode" value={m.bibcode} />
                <Id label="DOI" value={m.doi} />
                <Id label="arXiv" value={m.arxivId} />
              </dl>
            </Section>
          </>
        )}

        {tab === 'notes' && (
          <>
            <Section title="Your note">
              <NoteEditor paperId={row.id} initial={detail.note} />
            </Section>
            <Section title="Highlights">
              {detail.annotations.length === 0 ? (
                <p className="text-[12.5px] text-fg-3">
                  Highlights and notes you make in the reader appear here.
                </p>
              ) : (
                <ul className="-mx-1 flex flex-col gap-0.5">
                  {detail.annotations.map((a) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() =>
                          useStore.getState().openReader({
                            kind: 'file',
                            paperId: row.id,
                            fileId: a.fileId,
                            page: a.page
                          })
                        }
                        className="flex w-full items-start gap-2 rounded-md px-1 py-1.5 text-left hover:bg-hover"
                        title="Open at this page"
                      >
                        <AnnotationIcon a={a} />
                        <span className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-fg-2">
                          {a.kind === 'drawing' ? 'Drawing' : (a.text ?? a.comment ?? 'Highlight')}
                          {a.comment && a.kind !== 'note' && a.kind !== 'text' && (
                            <span className="mt-0.5 block text-fg">{a.comment}</span>
                          )}
                        </span>
                        <span className="shrink-0 text-[11px] text-fg-3">p. {a.page}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </>
        )}

        {tab === 'related' &&
          (m.bibcode && hasToken ? (
            <RelatedPanel paperId={row.id} bibcode={m.bibcode} label={row.title ?? m.bibcode} />
          ) : (
            <p className="text-[12.5px] leading-relaxed text-fg-3">
              {hasToken
                ? 'References and citations come from ADS. Look this paper up first so it has an ADS bibcode.'
                : 'References and citations come from ADS. Add an ADS token in Settings to see them.'}
            </p>
          ))}

        {tab === 'files' && (
          <>
            {preprintOnly && publisherPage && (
              <PreprintNotice
                busy={busy === 'publisher'}
                onGet={() => void getPublisher()}
                onOpenPage={() => void api.openUrl(publisherPage)}
              />
            )}
            {files.length === 0 ? (
              <p className="text-[12.5px] leading-relaxed text-fg-3">
                No PDF yet. Use Find PDF above, attach one from the ⋯ menu, or drop a PDF here.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {files.map((f, i) => (
                  <FileCard
                    key={f.id}
                    f={f}
                    primary={i === 0}
                    canRemove={files.length > 1}
                    onRead={() => onOpen(row.id, f.id)}
                    onReplace={() => void replaceWithDialog(f)}
                    act={act}
                  />
                ))}
              </ul>
            )}
            <p className="mt-3 text-[11.5px] leading-relaxed text-fg-3">
              Drop a PDF anywhere on this pane to add it to the paper. Files are named after the
              paper, and the journal version opens first.
            </p>
          </>
        )}
      </div>

      {editing && (
        <MetadataDialog
          metadata={m}
          onClose={() => setEditing(false)}
          onSave={(meta) =>
            act(async () => {
              await api.setManualMetadata(row.id, meta)
              setEditing(false)
            }, 'Details saved.')
          }
        />
      )}
    </div>
  )
}

function Section({
  title,
  children,
  action
}: {
  title: string
  children: ReactNode
  action?: ReactNode
}) {
  return (
    <section className="mb-5">
      <SectionLabel action={action}>{title}</SectionLabel>
      {children}
    </section>
  )
}

function Abstract({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="mb-5">
      <p
        className={`font-serif text-[14px] leading-relaxed text-fg-2 ${open ? '' : 'line-clamp-5'}`}
      >
        {text}
      </p>
      <button
        type="button"
        className="mt-1 text-[12px] font-medium text-accent"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Show less' : 'Show more'}
      </button>
    </section>
  )
}

function PreprintNotice({
  busy,
  onGet,
  onOpenPage,
  onShowFiles
}: {
  busy: boolean
  onGet: () => void
  onOpenPage: () => void
  onShowFiles?: () => void
}) {
  return (
    <div className="mb-5 rounded-lg border border-line bg-bg px-3.5 py-3" role="note">
      <p className="text-[12.5px] leading-relaxed text-fg-2">
        You have the <b className="font-medium text-fg">arXiv version</b> of this paper. The journal
        version can replace it: get it directly if your network has access, or download it from the
        publisher’s page (signing in through your institution) and drop it here.
      </p>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <Button onClick={onGet} disabled={busy}>
          <Download size={13} className={busy ? 'animate-pulse' : ''} />{' '}
          {busy ? 'Trying…' : 'Get publisher PDF'}
        </Button>
        <Button variant="ghost" onClick={onOpenPage}>
          <Globe size={13} /> Open publisher page
        </Button>
        {onShowFiles && (
          <Button variant="ghost" onClick={onShowFiles}>
            Show files
          </Button>
        )}
      </div>
    </div>
  )
}

const ORIGIN: Record<string, { label: string; tone: 'ok' | 'neutral' | 'warn' | 'accent' }> = {
  publisher: { label: 'Publisher', tone: 'ok' },
  arxiv: { label: 'arXiv', tone: 'warn' },
  'ads-scan': { label: 'ADS scan', tone: 'neutral' },
  unknown: { label: 'PDF', tone: 'neutral' }
}

function FileCard({
  f,
  primary,
  canRemove,
  onRead,
  onReplace,
  act
}: {
  f: PaperFile
  primary: boolean
  canRemove: boolean
  onRead: () => void
  onReplace: () => void
  act: (fn: () => Promise<unknown>, done?: string) => Promise<void>
}) {
  const toast = useStore((s) => s.toast)
  const origin = ORIGIN[f.origin ?? 'unknown'] ?? ORIGIN.unknown!
  const items: (MenuItem | '-')[] = [
    {
      label: 'Open in default app',
      icon: <ExternalLink size={14} />,
      onSelect: () => void api.openFile(f.id)
    },
    {
      label: 'Show in Finder',
      icon: <FolderSearch size={14} />,
      onSelect: () => void api.revealFile(f.id)
    },
    { label: 'Share…', icon: <Share size={14} />, onSelect: () => void api.shareFile(f.id) },
    {
      label: 'Save a copy…',
      icon: <FileDown size={14} />,
      onSelect: () =>
        void api.saveFileCopy(f.id).then((p) => p && toast('success', `Saved a copy to ${p}`))
    },
    ...(f.annotated
      ? ([
          '-',
          {
            label: 'Restore the original (drop annotations)',
            icon: <RefreshCw size={14} />,
            onSelect: () => {
              if (window.confirm('Discard all saved annotations and restore the original file?')) {
                void act(() => api.restoreOriginal(f.id), 'Original restored.')
              }
            }
          }
        ] as const)
      : []),
    ...(canRemove
      ? ([
          '-',
          {
            label: 'Remove this file',
            icon: <Trash2 size={14} />,
            danger: true,
            onSelect: () => {
              if (
                window.confirm(
                  `Remove ${f.name} from this paper?\n\nThe file will be moved to the Trash; the paper and its other files stay.`
                )
              ) {
                void act(() => api.removeFile(f.id), 'File removed; it is in the Trash.')
              }
            }
          }
        ] as const)
      : [])
  ]
  return (
    <li className="rounded-lg border border-line px-3 py-2.5" aria-label={`File ${f.name}`}>
      <div className="flex items-center gap-2">
        <Badge tone={origin.tone}>{origin.label}</Badge>
        {primary && <span className="text-[11px] text-fg-3">opens first</span>}
        <span className="ml-auto text-[11px] text-fg-3 tabular-nums">{formatBytes(f.size)}</span>
      </div>
      <button
        type="button"
        onClick={onRead}
        title={f.originalName ? `${f.name}\nImported as ${f.originalName}` : f.name}
        className="mt-1.5 block w-full truncate text-left font-mono text-[11.5px] text-fg-2 hover:text-accent"
      >
        {middleEllipsis(f.name, 44)}
      </button>
      {f.annotated && (
        <p className="mt-1 text-[11.5px] text-fg-3">Has your annotations (the original is kept).</p>
      )}
      <div className="mt-2 flex items-center gap-1">
        <Button variant="ghost" onClick={onRead}>
          <BookOpen size={13} /> Read
        </Button>
        <Button variant="ghost" onClick={onReplace} title="Choose a PDF to use instead of this one">
          <FileUp size={13} /> Replace…
        </Button>
        <span className="ml-auto" />
        <Menu
          label="File actions"
          items={items}
          trigger={(p) => (
            <IconButton label="File actions" {...p}>
              <Ellipsis size={14} />
            </IconButton>
          )}
        />
      </div>
    </li>
  )
}

function Id({ label, value }: { label: string; value: string | undefined }) {
  return (
    <>
      <dt className="text-fg-3">{label}</dt>
      <dd className="truncate text-fg-2">{value ?? '—'}</dd>
    </>
  )
}

function sourceName(s: string): string {
  return (
    { ads: 'ADS', crossref: 'Crossref', arxiv: 'arXiv', legacy: 'old app', manual: 'you' }[s] ?? s
  )
}

const READING: { value: ReadingStatus | null; label: string }[] = [
  { value: 'to-read', label: 'To read' },
  { value: 'reading', label: 'Reading' },
  { value: 'read', label: 'Read' },
  { value: null, label: 'No status' }
]

function ReadingMenu({
  value,
  onChange
}: {
  value: ReadingStatus | null
  onChange: (r: ReadingStatus | null) => void
}) {
  const current = READING.find((r) => r.value === value)
  return (
    <Menu
      label="Reading status"
      items={READING.map((r) => ({
        label: r.label,
        icon: r.value === value ? <Check size={14} /> : undefined,
        onSelect: () => onChange(r.value)
      }))}
      trigger={(p) => (
        <Button {...p} aria-label="Reading status" className={value ? 'text-accent' : ''}>
          <BookMarked size={13} /> {value ? current?.label : 'Status'} <ChevronDown size={12} />
        </Button>
      )}
    />
  )
}

function TagEditor({
  paperId,
  tags,
  onChange
}: {
  paperId: number
  tags: string[]
  onChange: () => void
}) {
  const all = useStore((s) => s.tags)
  const [draft, setDraft] = useState('')
  const suggestions = draft
    ? all
        .map((t) => t.name)
        .filter((n) => n.toLowerCase().includes(draft.toLowerCase()) && !tags.includes(n))
        .slice(0, 6)
    : []

  const add = async (raw: string) => {
    const names = raw
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    if (!names.length) return
    setDraft('')
    await api.addTags(paperId, names)
    onChange()
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1">
        {tags.map((t) => (
          <span
            key={t}
            className="inline-flex h-6 items-center gap-0.5 rounded-full bg-hover pr-1 pl-2.5 text-[12px] text-fg"
          >
            {t}
            <button
              type="button"
              aria-label={`Remove tag ${t}`}
              className="flex size-4 items-center justify-center rounded-full text-fg-3 hover:bg-line hover:text-fg"
              onClick={async () => {
                await api.removeTags(paperId, [t])
                onChange()
              }}
            >
              <X size={10} />
            </button>
          </span>
        ))}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add(draft)
            if (e.key === 'Backspace' && !draft && tags.length) {
              void api.removeTags(paperId, [tags.at(-1)!]).then(onChange)
            }
          }}
          placeholder="Add a tag"
          aria-label="Add tag"
          list={`tag-suggestions-${paperId}`}
          className="h-6 min-w-[90px] flex-1 rounded-full border border-dashed border-line bg-transparent px-2.5 text-[12px] outline-none placeholder:text-fg-3 focus:border-accent"
        />
      </div>
      <datalist id={`tag-suggestions-${paperId}`}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  )
}

/** Saves on its own a moment after typing stops, and when the pane closes. */
function NoteEditor({ paperId, initial }: { paperId: number; initial: string }) {
  const [value, setValue] = useState(initial)
  const [saved, setSaved] = useState(true)
  const pending = useRef<{ timer: ReturnType<typeof setTimeout>; body: string } | null>(null)

  const flush = useCallback(() => {
    if (!pending.current) return
    clearTimeout(pending.current.timer)
    const body = pending.current.body
    pending.current = null
    void api.setNote(paperId, body).then(() => setSaved(true))
  }, [paperId])

  useEffect(() => flush, [flush])

  return (
    <div>
      <textarea
        value={value}
        onChange={(e) => {
          const body = e.target.value
          setValue(body)
          setSaved(false)
          if (pending.current) clearTimeout(pending.current.timer)
          pending.current = { body, timer: setTimeout(flush, 600) }
        }}
        onBlur={flush}
        rows={6}
        placeholder="What matters in this paper, for you"
        aria-label="Note"
        className="w-full resize-y rounded-lg border border-line bg-input px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-fg-3 focus:border-accent"
      />
      <p className="h-4 text-right text-[11px] text-fg-3">{saved ? '' : 'Saving…'}</p>
    </div>
  )
}

function CollectionPicker({
  paperId,
  member,
  onChange
}: {
  paperId: number
  member: { id: number; name: string }[]
  onChange: () => void
}) {
  const all = useStore((s) => s.collections)
  const available = all.filter((c) => !c.query && !member.some((m) => m.id === c.id))
  return (
    <div className="flex flex-wrap items-center gap-1">
      {member.map((c) => (
        <span
          key={c.id}
          className="inline-flex h-6 items-center gap-0.5 rounded-full bg-accent-soft pr-1 pl-2.5 text-[12px] text-accent"
        >
          <button
            type="button"
            onClick={() => useStore.getState().setView({ kind: 'collection', id: c.id })}
          >
            {c.name}
          </button>
          <button
            type="button"
            aria-label={`Remove from ${c.name}`}
            className="flex size-4 items-center justify-center rounded-full hover:bg-line"
            onClick={() => void api.removeFromCollection(c.id, [paperId]).then(onChange)}
          >
            <X size={10} />
          </button>
        </span>
      ))}
      {available.length > 0 ? (
        <select
          aria-label="Add to collection"
          value=""
          onChange={(e) => {
            const id = Number(e.target.value)
            if (id) void api.addToCollection(id, [paperId]).then(onChange)
          }}
          className="h-6 rounded-full border border-dashed border-line bg-transparent px-2 text-[12px] text-fg-3 outline-none hover:border-line-strong"
        >
          <option value="">Add to…</option>
          {available.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      ) : (
        member.length === 0 && (
          <span className="text-[12px] text-fg-3">None yet. Create one in the sidebar.</span>
        )
      )}
    </div>
  )
}
