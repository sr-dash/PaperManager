import { FileDown, X } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import type { ImportOutcome, Issue, PaperListRow } from '../../shared/ipc'
import { AddPaperDialog } from './components/AddPaperDialog'
import { CommandPalette } from './components/CommandPalette'
import { CollectionDialog } from './components/CollectionDialog'
import { DetailPane } from './components/DetailPane'
import { DiscoverView } from './components/DiscoverView'
import { HighlightsView } from './components/HighlightsView'
import { InboxView } from './components/InboxView'
import { ManuscriptView } from './components/ManuscriptView'
import { PaperTable } from './components/PaperTable'
import type { ReaderHandle } from './components/Reader'
import { SettingsView } from './components/SettingsView'
import { Sidebar } from './components/Sidebar'
import { StatusBar } from './components/StatusBar'
import { TagsView } from './components/TagsView'
import { TitleBar } from './components/TitleBar'
import { Button, Dialog } from './components/ui'
import { api } from './lib/api'
import { useStore, visibleRows } from './lib/store'

const Reader = lazy(() => import('./components/Reader'))

export function App() {
  const refresh = useStore((s) => s.refresh)
  const reader = useStore((s) => s.reader)
  const view = useStore((s) => s.view)
  const collections = useStore((s) => s.collections)
  const addOpen = useStore((s) => s.addOpen)
  const refreshInbox = useStore((s) => s.refreshInbox)
  const refreshDiscover = useStore((s) => s.refreshDiscover)
  const toast = useStore((s) => s.toast)
  const paletteOpen = useStore((s) => s.paletteOpen)
  const searchRef = useRef<HTMLInputElement>(null)
  const readerRef = useRef<ReaderHandle>(null)
  const [dragging, setDragging] = useState(false)
  const [issues, setIssues] = useState<Issue[] | null>(null)
  /** The collection dialog: closed, new (optionally from the current search), or editing. */
  const [collectionDialog, setCollectionDialog] = useState<{
    editId?: number
    query?: string
  } | null>(null)

  useEffect(() => {
    void refresh()
    void refreshInbox()
    void refreshDiscover()
    void useStore.getState().loadPrefs()
    void api.getStatus().then((status) => useStore.setState({ status }))
    const offs = [
      api.on('status', (status) => useStore.setState({ status })),
      api.on('libraryChanged', () => void refresh()),
      api.on('inboxChanged', () => void refreshInbox()),
      api.on('discoverChanged', () => void refreshDiscover()),
      api.on('inboxProgress', (scanning) =>
        useStore.setState((s) => ({ inbox: s.inbox && { ...s.inbox, scanning } }))
      ),
      api.on('importProgress', (p) => useStore.setState({ importing: p.done < p.total ? p : null }))
    ]
    return () => offs.forEach((off) => off())
  }, [refresh, refreshInbox, refreshDiscover])

  const reportImport = useCallback(
    (outcomes: ImportOutcome[]) => {
      if (!outcomes.length) return
      const count = (s: ImportOutcome['status']) => outcomes.filter((o) => o.status === s).length
      const added = count('imported') + count('attached')
      const review = outcomes.filter(
        (o) => o.status !== 'failed' && o.metadataStatus === 'unresolved'
      ).length
      const parts = [
        added && `${added} added`,
        count('duplicate') && `${count('duplicate')} already in the library`,
        count('failed') && `${count('failed')} skipped`
      ].filter(Boolean)
      toast(count('failed') ? 'warning' : 'success', parts.join(', ') + '.')
      if (review)
        toast('warning', `${review} need review: their details could not be found automatically.`)
      for (const f of outcomes.filter((o) => o.status === 'failed').slice(0, 3)) {
        toast('error', `${f.path.split('/').pop()}: ${f.error}`)
      }
      const first = outcomes.find((o) => o.paperId !== undefined)
      if (first?.paperId !== undefined && useStore.getState().view.kind !== 'inbox') {
        useStore.getState().select(first.paperId)
      }
    },
    [toast]
  )

  const importDialog = useCallback(
    async () => reportImport(await api.chooseAndImport()),
    [reportImport]
  )

  const exportBib = useCallback(
    async (ids: number[], name: string) => {
      const path = await api.saveBibtex(ids, name)
      if (path)
        toast(
          'success',
          `Saved ${ids.length} ${ids.length === 1 ? 'entry' : 'entries'} to ${path.split('/').pop()}.`
        )
    },
    [toast]
  )

  const open = useCallback((paperId: number, fileId: number) => {
    useStore.getState().openReader({ kind: 'file', paperId, fileId })
  }, [])

  const openRow = useCallback(
    async (row: PaperListRow) => {
      const detail = await api.getPaper(row.id)
      const file = detail?.files[0]
      if (file) open(row.id, file.id)
    },
    [open]
  )

  useEffect(
    () =>
      api.on('menu', (cmd) => {
        if (cmd === 'import') void importDialog()
        if (cmd === 'add') useStore.setState({ addOpen: true })
        if (cmd === 'settings') useStore.getState().setView({ kind: 'settings' })
        if (cmd === 'find') {
          if (useStore.getState().reader) readerRef.current?.focusFind()
          else searchRef.current?.focus()
        }
        if (cmd === 'export') {
          const s = useStore.getState()
          const ids = s.selected.length > 1 ? s.selected : visibleRows(s).rows.map((r) => r.id)
          if (ids.length) void exportBib(ids, s.view.kind === 'tag' ? s.view.tag : 'references')
        }
      }),
    [importDialog, exportBib]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        useStore.setState((s) => ({ paletteOpen: !s.paletteOpen }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const verify = async () => {
    toast('info', 'Checking every file against the library…')
    setIssues(await api.verify(true))
  }

  return (
    <div
      className="flex h-full flex-col"
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes('Files')) setDragging(true)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        if (!e.dataTransfer.types.includes('Files')) return
        // Over a paper's details, a drop attaches to that paper instead (DetailPane).
        setDragging(!(e.target as Element).closest?.('[data-attach-drop]'))
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.relatedTarget) setDragging(false)
      }}
      onDrop={async (e) => {
        e.preventDefault()
        setDragging(false)
        const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean)
        if (paths.length) reportImport(await api.importPaths(paths))
      }}
    >
      <TitleBar
        ref={searchRef}
        onImport={() => void importDialog()}
        onAdd={() => useStore.setState({ addOpen: true })}
        onSaveSearch={(query) => setCollectionDialog({ query })}
        onPalette={() => useStore.setState({ paletteOpen: true })}
      />
      <div className="flex min-h-0 flex-1">
        <Sidebar onNewCollection={() => setCollectionDialog({})} />
        {reader ? (
          <Suspense fallback={<div className="flex-1" />}>
            <Reader
              key={reader.kind === 'file' ? `${reader.fileId}:${reader.page ?? 1}` : reader.path}
              handle={readerRef}
              source={reader}
              onClose={() => useStore.getState().closeReader()}
            />
          </Suspense>
        ) : view.kind === 'inbox' ? (
          <InboxView onFiled={reportImport} />
        ) : view.kind === 'discover' ? (
          <DiscoverView />
        ) : view.kind === 'highlights' ? (
          <HighlightsView />
        ) : view.kind === 'manuscript' ? (
          <ManuscriptView key={view.id} id={view.id} />
        ) : view.kind === 'settings' ? (
          <SettingsView />
        ) : view.kind === 'tags' ? (
          <TagsView />
        ) : (
          <>
            <PaperTable
              onOpen={(row) => void openRow(row)}
              onExport={(ids, name) => void exportBib(ids, name)}
              onEditCollection={(id) => setCollectionDialog({ editId: id })}
            />
            <DetailPane onOpen={open} />
          </>
        )}
      </div>
      <StatusBar onVerify={() => void verify()} />

      {addOpen && <AddPaperDialog onClose={() => useStore.setState({ addOpen: false })} />}
      {collectionDialog && (
        <CollectionDialog
          collection={collections.find((c) => c.id === collectionDialog.editId)}
          initialQuery={collectionDialog.query}
          onClose={() => setCollectionDialog(null)}
          onSaved={(id) => {
            setCollectionDialog(null)
            // A saved search now lives in the collection; show it, not the search results.
            if (collectionDialog.query) useStore.getState().setQuery('')
            void useStore
              .getState()
              .refreshCollections()
              .then(() => useStore.getState().setView({ kind: 'collection', id }))
          }}
        />
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-2 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent-soft/80">
          <div className="flex flex-col items-center gap-2 text-accent">
            <FileDown size={28} />
            <p className="text-[14px] font-bold">Drop PDFs to add them to the library</p>
            <p className="text-[12px]">Originals are left where they are.</p>
          </div>
        </div>
      )}

      {paletteOpen && (
        <CommandPalette
          onClose={() => useStore.setState({ paletteOpen: false })}
          actions={{
            importPdfs: () => void importDialog(),
            addById: () => useStore.setState({ addOpen: true }),
            newCollection: () => setCollectionDialog({}),
            exportView: () => {
              const s = useStore.getState()
              const ids = visibleRows(s).rows.map((r) => r.id)
              if (ids.length) void exportBib(ids, s.view.kind === 'tag' ? s.view.tag : 'references')
            },
            verify: () => void verify(),
            openPaper: (id) =>
              void api.getPaper(id).then((d) => d?.files[0] && open(id, d.files[0].id))
          }}
        />
      )}
      {issues && <VerifyDialog issues={issues} onClose={() => setIssues(null)} />}
      <Toasts />
    </div>
  )
}

function VerifyDialog({ issues, onClose }: { issues: Issue[]; onClose: () => void }) {
  const describe = (i: Issue): string => {
    switch (i.kind) {
      case 'missing-file':
        return `Missing file: ${i.relPath} (paper #${i.paperId})`
      case 'size-mismatch':
        return `Changed size: ${i.relPath}`
      case 'hash-mismatch':
        return `Changed contents: ${i.relPath}`
      case 'untracked-file':
        return `Not in the database: ${i.relPath}`
      case 'missing-original':
        return `Original of an annotated file is missing: ${i.relPath}`
    }
  }
  return (
    <Dialog
      title="Library check"
      onClose={onClose}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      {issues.length === 0 ? (
        <p className="text-[13px]">
          Everything is consistent: every record has its file, every file is recorded, and every
          file's contents match what was imported.
        </p>
      ) : (
        <ul className="flex flex-col gap-1 font-mono text-[12px]">
          {issues.map((i, n) => (
            <li key={n}>{describe(i)}</li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}

function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  const tones = {
    info: 'border-line',
    success: 'border-ok/40',
    warning: 'border-warn/50',
    error: 'border-danger/50'
  }
  return (
    <div
      className="toast-stack pointer-events-none fixed left-3 z-50 flex w-[340px] flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className={`pointer-events-auto flex items-start gap-2 rounded-lg border bg-raised px-3 py-2.5 text-[12.5px] shadow-[var(--shadow)] ${tones[t.tone]}`}
        >
          <span
            className={`mt-1 size-2 shrink-0 rounded-full ${
              { info: 'bg-fg-3', success: 'bg-ok', warning: 'bg-warn', error: 'bg-danger' }[t.tone]
            }`}
          />
          <span className="flex-1 leading-snug select-text">{t.text}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
            className="text-fg-3 hover:text-fg"
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
