/**
 * The inbox: PDFs sitting in watched folders (by default ~/Downloads) that are not in
 * the library yet. Each is fingerprinted and classified once; the result is cached
 * against its size and modification time, so rescans after the first cost a `stat`.
 *
 * Nothing here moves or deletes a file on its own. Filing copies into the library;
 * removing originals afterwards is an explicit, opt-in step done by the caller's
 * `dispose` (the app moves them to the Trash).
 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { CLASSIFIER_VERSION, classify } from './classify.js'
import { transaction } from './db/database.js'
import { readSwiftLibrary, type LegacyRecord } from './legacy.js'
import type { ImportResult, Library } from './library.js'
import type { Resolver } from './metadata/resolver.js'
import { readPdfSample, sha256File } from './pdf.js'
import type { Identifier, InboxItem, Inspection, Verdict } from './types.js'

export type { InboxItem, Inspection }

export const DEFAULT_INBOX_FOLDERS = [join(homedir(), 'Downloads')]

export interface ScanProgress {
  done: number
  total: number
}

export interface AcceptOutcome {
  path: string
  result?: ImportResult
  error?: string
  disposed?: boolean
}

/** Fingerprint and classify one PDF. Pure with respect to the library, so it can run in a worker. */
export async function inspectPdf(path: string): Promise<Inspection> {
  const st = await stat(path)
  const [sha256, sample] = await Promise.all([
    sha256File(path),
    readPdfSample(path).catch(() => undefined)
  ])
  const c = classify(sample, basename(path))
  return {
    size: st.size,
    mtimeMs: Math.trunc(st.mtimeMs),
    sha256,
    pages: sample?.pageCount,
    ...c
  }
}

interface SeenRow {
  path: string
  size: number
  mtime_ms: number
  sha256: string
  verdict: Verdict
  score: number
  reasons: string
  identifiers: string
  title: string | null
  pages: number | null
  classifier_version: number
}

/** How deep below a watched folder to look. Deep enough for topic folders, not whole disks. */
const MAX_DEPTH = 4

export class Inbox {
  private readonly legacyCache = new Map<string, LegacyRecord[]>()

  constructor(
    private readonly lib: Library,
    private readonly defaultFolders: string[] = DEFAULT_INBOX_FOLDERS
  ) {}

  folders(): string[] {
    return this.lib.getSetting<string[]>('inbox.folders', this.defaultFolders)
  }

  setFolders(folders: string[]): void {
    this.lib.setSetting('inbox.folders', [...new Set(folders.map((f) => resolve(f)))])
    this.forgetOutside()
  }

  get trashAfterFiling(): boolean {
    return this.lib.getSetting('inbox.trashAfterFiling', false)
  }

  set trashAfterFiling(on: boolean) {
    this.lib.setSetting('inbox.trashAfterFiling', on)
  }

  /**
   * Bring the cache up to date with the folders. New or changed PDFs are inspected
   * (by `inspect`, which the app runs off the main thread); unchanged ones are reused.
   */
  async scan(
    opts: {
      inspect?: (path: string) => Promise<Inspection>
      onProgress?: (p: ScanProgress) => void
      onItem?: () => void
    } = {}
  ): Promise<InboxItem[]> {
    const inspect = opts.inspect ?? inspectPdf
    const present = await this.listPdfs()
    this.forgetMissing(new Set(present))

    const stale: string[] = []
    const cached = this.cacheByPath()
    for (const path of present) {
      const st = await stat(path).catch(() => undefined)
      if (!st) continue
      const row = cached.get(path)
      const fresh =
        row &&
        row.size === st.size &&
        row.mtime_ms === Math.trunc(st.mtimeMs) &&
        row.classifier_version === CLASSIFIER_VERSION
      if (!fresh) stale.push(path)
    }

    for (const [i, path] of stale.entries()) {
      opts.onProgress?.({ done: i, total: stale.length })
      try {
        this.remember(path, await inspect(path))
        opts.onItem?.()
      } catch {
        // Vanished or unreadable mid-scan (e.g. still downloading); the next scan retries.
      }
    }
    opts.onProgress?.({ done: stale.length, total: stale.length })
    return this.items()
  }

  /**
   * Every distinct PDF with its state, most recently modified first. Identical files in
   * several places are one item: the most recent path, with the others as `copies`.
   */
  items(): InboxItem[] {
    const ignored = new Set(
      (this.lib.db.prepare('SELECT sha256 FROM inbox_ignored').all() as { sha256: string }[]).map(
        (r) => r.sha256
      )
    )
    const rows = this.lib.db
      .prepare('SELECT * FROM inbox_seen ORDER BY mtime_ms DESC, path')
      .all() as unknown as SeenRow[]
    const byHash = new Map<string, InboxItem>()
    for (const r of rows) {
      const seen = byHash.get(r.sha256)
      if (seen) {
        seen.copies.push(r.path)
        continue
      }
      const paperId = this.lib.paperIdForHash(r.sha256)
      byHash.set(r.sha256, {
        path: r.path,
        name: basename(r.path),
        size: r.size,
        mtimeMs: r.mtime_ms,
        sha256: r.sha256,
        pages: r.pages ?? undefined,
        verdict: r.verdict,
        score: r.score,
        reasons: JSON.parse(r.reasons) as string[],
        identifiers: JSON.parse(r.identifiers) as Identifier[],
        title: r.title ?? undefined,
        state: paperId !== undefined ? 'filed' : ignored.has(r.sha256) ? 'ignored' : 'pending',
        paperId,
        copies: []
      })
    }
    return [...byHash.values()]
  }

  /** The cached item at `path`: the only way the app lets a path reach the importer or reader. */
  item(path: string): InboxItem | undefined {
    return this.items().find((i) => i.path === path || i.copies.includes(path))
  }

  ignore(paths: string[]): void {
    const now = new Date().toISOString()
    transaction(this.lib.db, () => {
      const insert = this.lib.db.prepare(
        'INSERT OR IGNORE INTO inbox_ignored (sha256, name, ignored_at) VALUES (?, ?, ?)'
      )
      for (const p of paths) {
        const item = this.item(p)
        if (item) insert.run(item.sha256, item.name, now)
      }
    })
  }

  unignore(paths: string[]): void {
    const del = this.lib.db.prepare('DELETE FROM inbox_ignored WHERE sha256 = ?')
    for (const p of paths) {
      const item = this.item(p)
      if (item) del.run(item.sha256)
    }
  }

  /**
   * File PDFs into the library, using identifiers found during the scan as hints.
   * With `trashAfterFiling` on and a `dispose` given, each original is handed to
   * `dispose` once its copy is safely in the library.
   */
  async accept(
    paths: string[],
    opts: {
      resolver?: Resolver | undefined
      tags?: string[]
      dispose?: (path: string) => Promise<void>
      /** Let a publisher PDF take the place of the paper's arXiv PDF (see Library.importPdf). */
      replacePreprints?: (absPath: string) => Promise<void>
      onProgress?: (p: ScanProgress & { current: string | null }) => void
    } = {}
  ): Promise<AcceptOutcome[]> {
    const outcomes: AcceptOutcome[] = []
    for (const [i, path] of paths.entries()) {
      opts.onProgress?.({ done: i, total: paths.length, current: basename(path) })
      const item = this.item(path)
      if (!item) {
        outcomes.push({ path, error: 'Not in the inbox' })
        continue
      }
      try {
        const legacy = await this.legacyHints(path)
        const result = await this.lib.importPdf(path, {
          resolver: opts.resolver,
          tags: [...(opts.tags ?? []), ...legacy.tags],
          hints: [
            ...legacy.hints,
            ...item.identifiers.map((id) => ({ ...id, origin: 'hint' as const }))
          ],
          replacePreprints: opts.replacePreprints
        })
        const outcome: AcceptOutcome = { path, result }
        if (this.trashAfterFiling && opts.dispose) {
          await opts.dispose(path)
          this.forget(path)
          outcome.disposed = true
        }
        outcomes.push(outcome)
      } catch (err) {
        outcomes.push({ path, error: (err as Error).message })
      }
    }
    opts.onProgress?.({ done: paths.length, total: paths.length, current: null })
    return outcomes
  }

  /** Dispose of originals (every copy) whose exact bytes are already in the library. Returns how many. */
  async disposeFiled(dispose: (path: string) => Promise<void>): Promise<number> {
    let n = 0
    for (const item of this.items().filter((i) => i.state === 'filed')) {
      for (const path of [item.path, ...item.copies]) {
        // Re-check the bytes: the cache may predate an edit to the file.
        if ((await sha256File(path).catch(() => undefined)) !== item.sha256) continue
        await dispose(path)
        this.forget(path)
        n++
      }
    }
    return n
  }

  /** PDFs in the watched folders and their subfolders, never inside the library itself. */
  private async listPdfs(): Promise<string[]> {
    const out = new Set<string>()
    const libraryRoot = resolve(this.lib.root)
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (dir === libraryRoot || dir.startsWith(libraryRoot + sep)) return
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const path = join(dir, e.name)
        if (e.isDirectory() && depth < MAX_DEPTH) await walk(path, depth + 1)
        else if (e.isFile() && e.name.toLowerCase().endsWith('.pdf')) out.add(path)
      }
    }
    for (const folder of this.folders()) await walk(resolve(folder), 0)
    return [...out]
  }

  /**
   * Tags and ADS link recorded for this file by the old macOS app, when the PDF sits in
   * one of its library folders (a `papers.json` beside it).
   */
  private async legacyHints(path: string): Promise<{ tags: string[]; hints: Identifier[] }> {
    const dir = dirname(path)
    let records = this.legacyCache.get(dir)
    if (!records) {
      records = await readSwiftLibrary(dir).catch(() => [])
      this.legacyCache.set(dir, records)
    }
    const rec = records.find((r) => r.pdfPath === path)
    return {
      tags: rec?.tags ?? [],
      hints: rec?.bibcode ? [{ kind: 'bibcode', value: rec.bibcode, origin: 'hint' }] : []
    }
  }

  private remember(path: string, i: Inspection): void {
    this.lib.db
      .prepare(
        `INSERT INTO inbox_seen (path, size, mtime_ms, sha256, verdict, score, reasons,
                                 identifiers, title, pages, classifier_version, scanned_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           size = excluded.size, mtime_ms = excluded.mtime_ms, sha256 = excluded.sha256,
           verdict = excluded.verdict, score = excluded.score, reasons = excluded.reasons,
           identifiers = excluded.identifiers, title = excluded.title, pages = excluded.pages,
           classifier_version = excluded.classifier_version, scanned_at = excluded.scanned_at`
      )
      .run(
        path,
        i.size,
        i.mtimeMs,
        i.sha256,
        i.verdict,
        i.score,
        JSON.stringify(i.reasons),
        JSON.stringify(i.identifiers),
        i.verdict === 'other' ? null : (i.title ?? null),
        i.pages ?? null,
        CLASSIFIER_VERSION,
        new Date().toISOString()
      )
  }

  private cacheByPath(): Map<string, SeenRow> {
    const rows = this.lib.db.prepare('SELECT * FROM inbox_seen').all() as unknown as SeenRow[]
    return new Map(rows.map((r) => [r.path, r]))
  }

  private forget(path: string): void {
    this.lib.db.prepare('DELETE FROM inbox_seen WHERE path = ?').run(path)
  }

  private forgetMissing(present: Set<string>): void {
    for (const path of this.cacheByPath().keys()) if (!present.has(path)) this.forget(path)
  }

  private forgetOutside(): void {
    const folders = this.folders()
    for (const path of this.cacheByPath().keys()) {
      if (!folders.some((f) => path.startsWith(f.endsWith('/') ? f : f + '/'))) this.forget(path)
    }
  }
}
