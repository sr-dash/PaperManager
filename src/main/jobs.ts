/**
 * Background work: keeping the annotation index current, working out where older PDFs
 * came from (publisher or arXiv), running ADS watches, looking for published versions of
 * preprints, and a daily database snapshot. Each job is
 * single-flight (a second request while one runs just waits for it) and never throws
 * into the app.
 */
import { staleAnnotationFiles, storeAnnotations } from '../core/annotations.js'
import { backupIfDue } from '../core/backup.js'
import {
  findPublishedVersions,
  listWatches,
  runWatch,
  type PublishedVersion
} from '../core/discover.js'
import type { Library } from '../core/library.js'
import type { FileOrigin } from '../core/origin.js'
import type { PdfAnnotation } from '../core/pdf.js'
import type { StatusInfo } from '../shared/ipc.js'
import { PdfWorker } from './pdfWorker.js'

const HOUR = 3_600_000

export class Jobs {
  private readonly worker = new PdfWorker()
  private timers: ReturnType<typeof setTimeout>[] = []
  private indexing: Promise<void> | null = null
  private indexAgain = false
  private watching: Promise<{ found: number; errors: string[] }> | null = null
  private publishing: Promise<PublishedVersion[]> | null = null
  private indexProgress: { done: number; total: number } | null = null
  private classifyProgress: { done: number; total: number } | null = null

  constructor(
    private readonly lib: Library,
    private readonly token: () => Promise<string | undefined>,
    private readonly notify: (what: 'library' | 'discover' | 'status') => void
  ) {}

  status(): StatusInfo {
    return {
      indexing: this.indexProgress,
      classifying: this.classifyProgress,
      checkingAds: this.watchesRunning,
      lastVerify: this.lib.getSetting<StatusInfo['lastVerify']>('verify.last', undefined)
    }
  }

  get watchesRunning(): boolean {
    return this.watching !== null || this.publishing !== null
  }

  start(): void {
    try {
      backupIfDue(this.lib)
    } catch (err) {
      console.error('backup failed', err)
    }
    void this.indexAnnotations()
    // Give startup a moment before reaching out to ADS; then every six hours.
    this.timers.push(setTimeout(() => void this.periodic(), 20_000))
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    this.worker.stop()
  }

  private async periodic(): Promise<void> {
    await this.runWatches().catch(() => {})
    const last = this.lib.getSetting<string | null>('published.checkedAt', null)
    if (!last || Date.now() - Date.parse(last) > 24 * HOUR)
      await this.checkPublished().catch(() => {})
    this.timers.push(setTimeout(() => void this.periodic(), 6 * HOUR))
  }

  /** Bring the annotation index up to date; call after any file changes. */
  indexAnnotations(): Promise<void> {
    if (this.indexing) {
      this.indexAgain = true
      return this.indexing
    }
    // The lock is released in a .finally chained *after* assignment: with nothing to index
    // the body finishes synchronously, and a finally inside it would run before the
    // assignment, leaving the lock held forever.
    this.indexing = (async () => {
      do {
        this.indexAgain = false
        let changed = false
        const stale = staleAnnotationFiles(this.lib)
        for (const [i, f] of stale.entries()) {
          this.report('index', i, stale.length)
          const anns = await this.worker
            .run<PdfAnnotation[]>('annotations', f.path)
            .catch(() => [] as PdfAnnotation[])
          if (storeAnnotations(this.lib, f.id, f.sha256, anns) && anns.length) changed = true
        }
        this.report('index', stale.length, stale.length)
        if (await this.classifyOrigins()) changed = true
        if (changed) this.notify('library')
      } while (this.indexAgain)
    })().finally(() => {
      this.indexing = null
      this.indexProgress = this.classifyProgress = null
      this.notify('status')
    })
    return this.indexing
  }

  /**
   * Work out where older files came from, then re-name each affected paper's files so
   * the journal version is the main one. Returns whether anything changed.
   */
  private async classifyOrigins(): Promise<boolean> {
    const todo = this.lib.filesWithoutOrigin()
    const papers = new Set<number>()
    for (const [i, f] of todo.entries()) {
      this.report('classify', i, todo.length)
      const origin = await this.worker
        .run<FileOrigin>('origin', f.path)
        .catch(() => 'unknown' as FileOrigin)
      this.lib.setFileOrigin(f.id, origin)
      papers.add(f.paperId)
    }
    this.report('classify', todo.length, todo.length)
    for (const p of papers) await this.lib.normalizeFileNames(p).catch(() => {})
    return todo.length > 0
  }

  /** Progress for the status bar, sent at most every few files to keep IPC quiet. */
  private report(kind: 'index' | 'classify', done: number, total: number): void {
    const value = done < total ? { done, total } : null
    if (kind === 'index') this.indexProgress = value
    else this.classifyProgress = value
    if (done % 5 === 0 || done >= total) this.notify('status')
  }

  runWatches(): Promise<{ found: number; errors: string[] }> {
    this.watching ??= (async () => {
      this.notify('discover')
      this.notify('status')
      const token = await this.token()
      const errors: string[] = []
      let found = 0
      if (!token) return { found, errors: ['No ADS token'] }
      for (const w of listWatches(this.lib)) {
        try {
          found += await runWatch(this.lib, w.id, { fetch: globalThis.fetch, token })
        } catch (err) {
          errors.push(`${w.name}: ${(err as Error).message}`)
        }
      }
      return { found, errors }
    })().finally(() => {
      this.watching = null
      this.notify('discover')
      this.notify('status')
    })
    return this.watching
  }

  checkPublished(): Promise<PublishedVersion[]> {
    this.publishing ??= (async () => {
      this.notify('discover')
      const token = await this.token()
      if (!token) return []
      const found = await findPublishedVersions(this.lib, { fetch: globalThis.fetch, token })
      this.lib.setSetting('published.results', found)
      this.lib.setSetting('published.checkedAt', new Date().toISOString())
      return found
    })().finally(() => {
      this.publishing = null
      this.notify('discover')
    })
    return this.publishing
  }

  publishedResults(): PublishedVersion[] {
    // Drop entries that no longer apply (already adopted or removed).
    return this.lib.getSetting<PublishedVersion[]>('published.results', []).filter((p) => {
      const row = this.lib.getPaper(p.paperId)
      return row && row.bibcode !== p.bibcode
    })
  }
}
