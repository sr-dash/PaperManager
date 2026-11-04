import 'pdfjs-dist/web/pdf_viewer.css'
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Highlighter,
  Library,
  Minus,
  MousePointer2,
  MoveHorizontal,
  PenLine,
  Plus,
  Save,
  Search,
  Share,
  Type
} from 'lucide-react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { PDFFindController, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import type { PaperDetail } from '../../../shared/ipc'
import { api } from '../lib/api'
import { useStore, type ReaderSource } from '../lib/store'
import { loadViewer, PDF_ASSETS, pdfjsLib } from './pdfjs'
import { RelatedPanel } from './RelatedPanel'
import { IconButton } from './ui'

export interface ReaderHandle {
  focusFind: () => void
}

const { AnnotationEditorType } = pdfjsLib
const TOOLS = [
  { mode: AnnotationEditorType.NONE, label: 'Select', icon: MousePointer2 },
  { mode: AnnotationEditorType.HIGHLIGHT, label: 'Highlight', icon: Highlighter },
  { mode: AnnotationEditorType.FREETEXT, label: 'Text note', icon: Type },
  { mode: AnnotationEditorType.INK, label: 'Draw', icon: PenLine }
] as const
const HIGHLIGHT_COLORS = 'yellow=#FFF08A,green=#9BE8B4,blue=#9ED8FF,pink=#FFC2DF,red=#FF9E9E'

export default function Reader({
  source,
  onClose,
  handle
}: {
  source: ReaderSource
  onClose: () => void
  handle?: Ref<ReaderHandle>
}) {
  const libraryTitle = useStore((s) =>
    source.kind === 'file' ? s.rows.find((r) => r.id === source.paperId)?.title : undefined
  )
  const title = source.kind === 'inbox' ? source.title : (libraryTitle ?? 'Untitled')
  const sourceKey = source.kind === 'file' ? `file:${source.fileId}` : `inbox:${source.path}`
  const containerRef = useRef<HTMLDivElement>(null)
  const findRef = useRef<HTMLInputElement>(null)
  const viewerRef = useRef<PDFViewer | null>(null)
  const findCtl = useRef<PDFFindController | null>(null)
  const eventBusRef = useRef<{ dispatch: (name: string, data: object) => void } | null>(null)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(0)
  const [scale, setScale] = useState(1)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<{ current: number; total: number } | null>(null)
  const editable = source.kind === 'file'
  const fileId = source.kind === 'file' ? source.fileId : null
  const toast = useStore((s) => s.toast)
  const hasToken = useStore((s) => s.info?.adsToken)
  const showRelated = useStore((s) => s.prefs.readerRelated)
  const paperId = source.kind === 'file' ? source.paperId : null
  const [paper, setPaper] = useState<PaperDetail | null>(null)
  useEffect(() => {
    if (paperId !== null) void api.getPaper(paperId).then(setPaper)
  }, [paperId])
  const bibcode = paper?.metadata.bibcode
  const docRef = useRef<PDFDocumentProxy | null>(null)
  const dirtyRef = useRef(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [tool, setTool] = useState<number>(AnnotationEditorType.NONE)

  useImperativeHandle(handle, () => ({
    focusFind: () => {
      findRef.current?.focus()
      findRef.current?.select()
    }
  }))

  useEffect(() => {
    let cancelled = false
    let destroy: (() => void) | undefined
    ;(async () => {
      const { EventBus, PDFFindController, PDFLinkService, PDFViewer } = await loadViewer()
      const container = containerRef.current
      if (cancelled || !container) return
      const eventBus = new EventBus()
      const linkService = new PDFLinkService({ eventBus })
      const findController = new PDFFindController({ eventBus, linkService })
      const viewer = new PDFViewer({
        container,
        eventBus,
        linkService,
        findController,
        // Editing (highlights, notes, drawing) only for library files; previews stay read-only.
        annotationEditorMode: editable ? AnnotationEditorType.NONE : AnnotationEditorType.DISABLE,
        annotationEditorHighlightColors: HIGHLIGHT_COLORS,
        // Supported at runtime; missing from pdf.js's published option types.
        ...({ enableHighlightFloatingButton: editable } as object)
      })
      linkService.setViewer(viewer)
      viewerRef.current = viewer
      findCtl.current = findController
      eventBusRef.current = eventBus

      eventBus.on('pagesinit', () => {
        viewer.currentScaleValue = 'page-width'
        // Opened from a highlight: go straight to its page.
        if (source.kind === 'file' && source.page && source.page > 1) {
          viewer.currentPageNumber = source.page
        }
      })
      eventBus.on('pagechanging', (e: { pageNumber: number }) => setPage(e.pageNumber))
      // A stroke or note in progress is not in annotationStorage until committed; the
      // editor's undo stack is the earliest sign that there is something to save.
      eventBus.on(
        'annotationeditorstateschanged',
        (e: { details: { hasSomethingToUndo?: boolean } }) => {
          if (e.details.hasSomethingToUndo) {
            dirtyRef.current = true
            setDirty(true)
          }
        }
      )
      eventBus.on('scalechanging', (e: { scale: number }) => setScale(e.scale))
      eventBus.on(
        'updatefindmatchescount',
        (e: { matchesCount: { current: number; total: number } }) => setMatches(e.matchesCount)
      )
      eventBus.on(
        'updatefindcontrolstate',
        (e: { matchesCount: { current: number; total: number } }) => setMatches(e.matchesCount)
      )

      try {
        const data =
          source.kind === 'file'
            ? await api.readPdf(source.fileId)
            : await api.readInboxPdf(source.path)
        const task = pdfjsLib.getDocument({ data, ...PDF_ASSETS })
        destroy = () => void task.destroy()
        const doc = await task.promise
        if (cancelled) return
        docRef.current = doc
        // Change hooks exist at runtime but are typed as null in pdf.js's declarations.
        const storage = doc.annotationStorage as unknown as {
          onSetModified: () => void
          onResetModified: () => void
        }
        storage.onSetModified = () => {
          dirtyRef.current = true
          setDirty(true)
        }
        storage.onResetModified = () => {
          dirtyRef.current = false
          setDirty(false)
        }
        viewer.setDocument(doc)
        linkService.setDocument(doc)
        setPages(doc.numPages)
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      }
    })()
    return () => {
      cancelled = true
      viewerRef.current = null
      const doc = docRef.current
      docRef.current = null
      // Leaving with unsaved annotations: save them before the document is released.
      if (doc && dirtyRef.current && fileId !== null) {
        void doc
          .saveDocument()
          .then((bytes) => api.saveAnnotations(fileId, bytes))
          .finally(() => destroy?.())
      } else {
        destroy?.()
      }
    }
    // sourceKey identifies the document; `source` itself is a fresh object per render.
  }, [sourceKey])

  const find = (again: boolean, previous = false) => {
    eventBusRef.current?.dispatch('find', {
      source: null,
      type: again ? 'again' : '',
      query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: previous,
      matchDiacritics: false
    })
  }

  const save = useCallback(async () => {
    const doc = docRef.current
    const drawing = tool !== AnnotationEditorType.NONE
    if (!doc || fileId === null || (!dirtyRef.current && !drawing)) return
    setSaving(true)
    try {
      // Leaving the tool commits whatever is being drawn or typed into the document.
      const v = viewerRef.current
      if (v && tool !== AnnotationEditorType.NONE) {
        v.annotationEditorMode = { mode: AnnotationEditorType.NONE }
        setTool(AnnotationEditorType.NONE)
      }
      await api.saveAnnotations(fileId, await doc.saveDocument())
      doc.annotationStorage.resetModified()
      dirtyRef.current = false
      setDirty(false)
    } catch (err) {
      toast('error', `Could not save annotations: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }, [fileId, toast, tool])

  const chooseTool = (mode: number) => {
    const v = viewerRef.current
    if (!v) return
    try {
      v.annotationEditorMode = { mode }
      setTool(mode)
    } catch {
      // The editor layer is not ready until the first page has rendered.
    }
  }

  const zoom = (factor: number) => {
    const v = viewerRef.current
    if (v) v.currentScale = Math.min(4, Math.max(0.3, v.currentScale * factor))
  }

  // Keyboard: Escape leaves the reader; the find box keeps its own Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = document.activeElement
      if (e.key === 'Escape' && typing instanceof HTMLInputElement && typing !== findRef.current) {
        // Leaves the page box or the panel's filter first, not the reader.
        typing.blur()
        return
      }
      if (e.key === 'Escape' && document.activeElement !== findRef.current) {
        // Escape first leaves an annotation tool; only then the reader.
        if (tool !== AnnotationEditorType.NONE) chooseTool(AnnotationEditorType.NONE)
        else onClose()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        zoom(1.15)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === '-') {
        e.preventDefault()
        zoom(1 / 1.15)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // chooseTool only touches refs and state setters.
  }, [onClose, save, tool])

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Reader">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-raised px-2">
        <IconButton label="Back to library (Esc)" onClick={onClose}>
          <ArrowLeft size={15} />
        </IconButton>
        <h1 className="min-w-0 flex-1 truncate font-serif text-[14px] font-semibold" title={title}>
          {title}
        </h1>

        <div className="flex items-center gap-1 text-[12px] text-fg-2 tabular-nums">
          <input
            aria-label="Page number"
            value={page}
            onChange={(e) => {
              const n = Number(e.target.value)
              if (viewerRef.current && n >= 1 && n <= pages) viewerRef.current.currentPageNumber = n
              setPage(n || page)
            }}
            className="h-6 w-9 rounded border border-line bg-input text-center text-[12px] outline-none focus:border-accent"
          />
          <span>/ {pages || '–'}</span>
        </div>

        <div className="mx-1 h-5 w-px bg-line" />
        <IconButton label="Zoom out" onClick={() => zoom(1 / 1.15)}>
          <Minus size={14} />
        </IconButton>
        <span className="w-10 text-center text-[12px] text-fg-2 tabular-nums">
          {Math.round(scale * 100)}%
        </span>
        <IconButton label="Zoom in" onClick={() => zoom(1.15)}>
          <Plus size={14} />
        </IconButton>
        <IconButton
          label="Fit width"
          onClick={() => viewerRef.current && (viewerRef.current.currentScaleValue = 'page-width')}
        >
          <MoveHorizontal size={14} />
        </IconButton>

        <div className="mx-1 h-5 w-px bg-line" />
        <label className="relative flex items-center">
          <Search size={13} className="pointer-events-none absolute left-2 text-fg-3" />
          <input
            ref={findRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') find(true, e.shiftKey)
              if (e.key === 'Escape') {
                setQuery('')
                setMatches(null)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            onKeyUp={(e) => (e.key.length === 1 || e.key === 'Backspace' ? find(false) : undefined)}
            placeholder="Find in paper"
            aria-label="Find in paper"
            className="h-7 w-44 rounded-md border border-line bg-input pr-2 pl-7 text-[12px] outline-none placeholder:text-fg-3 focus:border-accent"
          />
        </label>
        {query && matches && (
          <span className="text-[11px] text-fg-3 tabular-nums">
            {matches.total ? `${matches.current} of ${matches.total}` : 'None'}
          </span>
        )}
        <IconButton label="Previous match" onClick={() => find(true, true)} disabled={!query}>
          <ChevronUp size={14} />
        </IconButton>
        <IconButton label="Next match" onClick={() => find(true)} disabled={!query}>
          <ChevronDown size={14} />
        </IconButton>
        {editable && (
          <>
            <div className="mx-1 h-5 w-px bg-line" />
            <div role="toolbar" aria-label="Annotation tools" className="flex items-center gap-0.5">
              {TOOLS.map((t) => (
                <IconButton
                  key={t.mode}
                  label={t.label}
                  aria-pressed={tool === t.mode}
                  onClick={() => chooseTool(t.mode)}
                  className={tool === t.mode ? 'bg-accent-soft text-accent' : ''}
                >
                  <t.icon size={14} />
                </IconButton>
              ))}
            </div>
            <IconButton
              label={dirty ? 'Save annotations (⌘S)' : 'Annotations saved'}
              onClick={() => void save()}
              disabled={!dirty || saving}
              className={dirty ? 'text-accent' : ''}
            >
              <Save size={14} />
            </IconButton>
            {dirty && <span className="text-[11px] text-fg-3">Unsaved</span>}
          </>
        )}
        <div className="mx-1 h-5 w-px bg-line" />
        {source.kind === 'file' && (
          <>
            <IconButton
              label={
                showRelated ? 'Hide references and citations' : 'Show references and citations'
              }
              aria-pressed={showRelated}
              onClick={() => void useStore.getState().setPrefs({ readerRelated: !showRelated })}
              className={showRelated ? 'bg-accent-soft text-accent' : ''}
            >
              <Library size={14} />
            </IconButton>
            <IconButton label="Share" onClick={() => void api.shareFile(source.fileId)}>
              <Share size={14} />
            </IconButton>
            <IconButton
              label="Open in default app"
              onClick={() => void api.openFile(source.fileId)}
            >
              <ExternalLink size={14} />
            </IconButton>
          </>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="relative min-h-0 min-w-0 flex-1">
          {error && (
            <div className="absolute inset-0 z-10 flex items-center justify-center p-8 text-center text-[13px] text-danger">
              This PDF could not be displayed: {error}
            </div>
          )}
          <div
            ref={containerRef}
            className="pdf-scroll"
            onClickCapture={(e) => {
              // Links inside the PDF open in the browser, never inside the app.
              const a = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null
              if (a && /^https?:/i.test(a.href)) {
                e.preventDefault()
                e.stopPropagation()
                void api.openUrl(a.href)
              }
            }}
          >
            <div className="pdfViewer" />
          </div>
        </div>
        {showRelated && paper && (
          <aside
            aria-label="Beside the paper"
            className="flex w-[360px] shrink-0 flex-col overflow-y-auto border-l border-line bg-raised px-4 py-3"
          >
            {bibcode && hasToken ? (
              <RelatedPanel
                key={paper.row.id}
                paperId={paper.row.id}
                bibcode={bibcode}
                label={paper.row.title ?? bibcode}
                onOpenInLibrary={(id) =>
                  // Read the cited paper in place when it has a PDF; else show it in the list.
                  void api.getPaper(id).then((d) => {
                    const s = useStore.getState()
                    if (d?.files[0])
                      s.openReader({ kind: 'file', paperId: id, fileId: d.files[0].id })
                    else {
                      s.closeReader()
                      s.setView({ kind: 'all' })
                      s.select(id)
                    }
                  })
                }
              />
            ) : (
              <p className="text-[12.5px] leading-relaxed text-fg-3">
                {hasToken
                  ? 'References and citations come from ADS. Look this paper up first so it has an ADS bibcode.'
                  : 'References and citations come from ADS. Add an ADS token in Settings to see them.'}
              </p>
            )}
          </aside>
        )}
      </div>
    </section>
  )
}
