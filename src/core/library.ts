import { constants, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { openDatabase, transaction, type Db } from './db/database.js'
import { toBibtex } from './bibtex.js'
import { extractIdentifiers, plausibleTitle } from './identifiers.js'
import type { Resolver } from './metadata/resolver.js'
import { canonicalStem, citeTag, fallbackStem, uniqueFilename } from './naming.js'
import { detectOrigin, type FileOrigin } from './origin.js'
import { looksLikePdf, readPdfAnnotations, readPdfText, sha256File, type PdfText } from './pdf.js'
import type {
  Identifier,
  Issue,
  Metadata,
  MetadataSource,
  PaperListRow,
  PaperRow,
  ReadingStatus,
  PaperSummary,
  ResolvedMetadata
} from './types.js'

export type { Issue }

export const DEFAULT_LIBRARY_ROOT = join(homedir(), 'Documents', 'PaperManager')
const DB_NAME = 'library.sqlite'
const FILES_DIR = 'files'
const INCOMING_PREFIX = '.incoming-'
const ORIGINALS_DIR = 'originals'

export class NotPdfError extends Error {
  constructor(readonly path: string) {
    super(`Not a PDF: ${path}`)
  }
}

export interface ImportOptions {
  resolver?: Resolver | undefined
  /** Identifiers known from outside the PDF (e.g. a legacy record's ADS link). Tried first. */
  hints?: Identifier[]
  tags?: string[]
  /** Metadata to fall back on when nothing resolves, e.g. fields typed into an older app. */
  fallback?: ResolvedMetadata
  /** Metadata already known to be right (e.g. the record a download came from). Skips lookups. */
  resolved?: ResolvedMetadata
  /** File the PDF under this paper, whatever its contents say. */
  attachTo?: number
  /** Where the PDF came from, when known (e.g. which download succeeded). Else detected. */
  origin?: FileOrigin
  /**
   * When a publisher PDF joins a paper that has arXiv PDFs, hand those to this function
   * (the app moves them to the Trash). Annotated e-prints are always kept.
   */
  replacePreprints?: (absPath: string) => Promise<void>
  /** Re-index the paper's full text from this file (used when it replaces the main one). */
  refreshText?: boolean
  addedAt?: string
}

export interface ImportResult {
  /** `attached`: new file for a paper already in the library (e.g. published version of a preprint). */
  status: 'imported' | 'duplicate' | 'attached'
  paperId: number
  relPath: string
  metadataStatus: PaperRow['metadata_status']
  identifiers: Identifier[]
  errors: string[]
  /** File names of arXiv PDFs this import replaced. */
  replaced?: string[]
}

export interface SearchHit {
  paper: PaperSummary
  snippet: string
}

export class Library {
  private constructor(
    readonly root: string,
    readonly db: Db
  ) {}

  static open(root: string = DEFAULT_LIBRARY_ROOT): Library {
    mkdirSync(join(root, FILES_DIR), { recursive: true })
    return new Library(root, openDatabase(join(root, DB_NAME)))
  }

  get filesDir(): string {
    return join(this.root, FILES_DIR)
  }

  close(): void {
    this.db.close()
  }

  // ── Import ────────────────────────────────────────────────────────────────

  /**
   * Copy a PDF into the library. The source file is never modified or removed.
   *
   * Ordering keeps the library consistent under crashes: the file is copied under
   * a temporary name, renamed into place, and only then recorded in the database.
   * A crash can leave an untracked file (reported by `verify`), never a record
   * pointing at a missing file.
   */
  async importPdf(src: string, opts: ImportOptions = {}): Promise<ImportResult> {
    if (!(await looksLikePdf(src))) throw new NotPdfError(src)
    const sha256 = await sha256File(src)

    const existing = this.db
      .prepare('SELECT paper_id, rel_path FROM files WHERE sha256 = ? OR original_sha256 = ?')
      .get(sha256, sha256) as { paper_id: number; rel_path: string } | undefined
    if (existing) return this.importDuplicate(existing.paper_id, sha256, opts)

    const errors: string[] = []
    const text = await readPdfText(src).catch((err: Error) => {
      errors.push(`pdf: ${err.message}`)
      return undefined
    })
    const identifiers = extractIdentifiers({
      filename: basename(src),
      pdfInfo: text?.info,
      firstPage: text?.firstPage,
      infoTitle: text?.infoTitle,
      hints: opts.hints
    })

    let resolved: ResolvedMetadata | null = opts.resolved ?? null
    if (!resolved && opts.resolver && identifiers.length) {
      const result = await opts.resolver(identifiers)
      resolved = result.resolved
      errors.push(...result.errors)
    }
    const chosen = resolved ?? opts.fallback ?? null
    const owner = opts.attachTo ?? (chosen ? this.findPaperByIds(chosen.metadata) : undefined)

    const stem =
      (opts.attachTo !== undefined && canonicalStem(this.metadataOf(opts.attachTo))) ||
      (chosen && canonicalStem(chosen.metadata)) ||
      fallbackStem(basename(src))
    const relPath = await this.placeFile(src, sha256, stem)
    const size = (await stat(src)).size
    const now = new Date().toISOString()
    const addedAt = opts.addedAt ?? now
    const origin = opts.origin ?? detectOrigin(text?.firstPage, text?.info)

    try {
      const paperId = transaction(this.db, () => {
        const id =
          owner ??
          this.insertPaper(chosen, resolved ? 'resolved' : 'unresolved', addedAt, now, text, src)
        this.db
          .prepare(
            `INSERT INTO files (paper_id, sha256, rel_path, size, original_name, added_at, origin)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(id, sha256, relPath, size, basename(src), addedAt, origin)
        if (opts.tags?.length) this.addTags(id, opts.tags)
        this.reindex(id, owner === undefined || opts.refreshText ? text?.fulltext : undefined)
        if (owner === undefined && chosen) this.applyCiteTag(id)
        return id
      })
      let finalPath = relPath
      let replaced: string[] | undefined
      if (owner !== undefined) {
        if (origin === 'publisher' && opts.replacePreprints) {
          replaced = await this.dropPreprints(paperId, opts.replacePreprints)
          if (replaced.length) this.reindex(paperId, text?.fulltext)
        }
        await this.normalizeFileNames(paperId)
        finalPath = (
          this.db.prepare('SELECT rel_path FROM files WHERE sha256 = ?').get(sha256) as {
            rel_path: string
          }
        ).rel_path
      }
      return {
        status: owner === undefined ? 'imported' : 'attached',
        paperId,
        relPath: finalPath,
        metadataStatus: this.getPaper(paperId)!.metadata_status,
        identifiers,
        errors,
        replaced
      }
    } catch (err) {
      await unlink(join(this.root, relPath)).catch(() => {})
      throw err
    }
  }

  /**
   * The same bytes are already in the library. Merge tags, and let whatever this
   * import knows (e.g. a legacy ADS link) improve a record that is still unresolved.
   */
  private async importDuplicate(
    paperId: number,
    sha256: string,
    opts: ImportOptions
  ): Promise<ImportResult> {
    if (opts.tags?.length) this.addTags(paperId, opts.tags)
    const errors: string[] = []
    let id = paperId
    if (this.getPaper(id)!.metadata_status === 'unresolved') {
      if (opts.resolver && opts.hints?.length) {
        const r = await this.resolvePaper(id, opts.resolver, opts.hints)
        id = r.paperId
        errors.push(...r.errors)
      }
      const paper = this.getPaper(id)!
      if (
        opts.fallback &&
        paper.metadata_status === 'unresolved' &&
        (paper.metadata_source === null || paper.metadata_source === 'legacy') &&
        richness(opts.fallback.metadata) > richness(this.metadataOf(id))
      ) {
        transaction(this.db, () => {
          this.writeMetadata(id, opts.fallback!.metadata, opts.fallback!.source, 'unresolved')
          this.reindex(id)
          this.applyCiteTag(id)
        })
        await this.renameFiles(id)
      }
    }
    const file = this.db
      .prepare('SELECT rel_path FROM files WHERE sha256 = ? OR original_sha256 = ?')
      .get(sha256, sha256) as { rel_path: string }
    return {
      status: 'duplicate',
      paperId: id,
      relPath: file.rel_path,
      metadataStatus: this.getPaper(id)!.metadata_status,
      identifiers: [],
      errors
    }
  }

  private async placeFile(src: string, sha256: string, stem: string): Promise<string> {
    const incoming = join(this.filesDir, `${INCOMING_PREFIX}${sha256}.pdf`)
    await copyFile(src, incoming, constants.COPYFILE_EXCL).catch(async (err) => {
      // A leftover from an interrupted import of this same content is safe to replace.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      await copyFile(src, incoming)
    })
    const name = uniqueFilename(stem, (n) => this.nameTaken(n))
    await rename(incoming, join(this.filesDir, name))
    return `${FILES_DIR}/${name}`
  }

  private nameTaken(name: string): boolean {
    // Case-insensitive: the default macOS filesystem is.
    const inDb = this.db
      .prepare('SELECT 1 FROM files WHERE rel_path = ? COLLATE NOCASE')
      .get(`${FILES_DIR}/${name}`)
    return !!inDb || existsSync(join(this.filesDir, name))
  }

  private insertPaper(
    chosen: ResolvedMetadata | null,
    status: PaperRow['metadata_status'],
    addedAt: string,
    now: string,
    text: PdfText | undefined,
    src: string
  ): number {
    const info = this.db
      .prepare('INSERT INTO papers (added_at, updated_at) VALUES (?, ?)')
      .run(addedAt, now)
    const id = Number(info.lastInsertRowid)
    if (chosen) {
      this.writeMetadata(id, chosen.metadata, chosen.source, status)
    } else {
      const title = plausibleTitle(text?.infoTitle) ?? basename(src).replace(/\.pdf$/i, '')
      this.db.prepare('UPDATE papers SET title = ? WHERE id = ?').run(title, id)
    }
    return id
  }

  private writeMetadata(
    paperId: number,
    m: Metadata,
    source: MetadataSource,
    status: PaperRow['metadata_status']
  ): void {
    this.db
      .prepare(
        `UPDATE papers SET
           title = :title, abstract = :abstract, year = :year, pub_date = :pubDate,
           journal = :journal, journal_abbrev = :journalAbbrev, volume = :volume,
           issue = :issue, page = :page, entry_type = :entryType, doi = :doi,
           arxiv_id = :arxivId, bibcode = :bibcode, bibtex = :bibtex,
           metadata_source = :source, metadata_status = :status, updated_at = :now
         WHERE id = :id`
      )
      .run({
        title: m.title ?? null,
        abstract: m.abstract ?? null,
        year: m.year ?? null,
        pubDate: m.pubDate ?? null,
        journal: m.journal ?? null,
        journalAbbrev: m.journalAbbrev ?? null,
        volume: m.volume ?? null,
        issue: m.issue ?? null,
        page: m.page ?? null,
        entryType: m.entryType ?? 'article',
        doi: m.doi ?? null,
        arxivId: m.arxivId ?? null,
        bibcode: m.bibcode ?? null,
        bibtex: m.bibtex ?? null,
        source,
        status,
        now: new Date().toISOString(),
        id: paperId
      })
    this.db.prepare('DELETE FROM authors WHERE paper_id = ?').run(paperId)
    const insert = this.db.prepare(
      'INSERT INTO authors (paper_id, position, family, given) VALUES (?, ?, ?, ?)'
    )
    m.authors.forEach((a, i) => insert.run(paperId, i, a.family, a.given ?? null))
  }

  /**
   * Add a paper from metadata alone, e.g. a reference whose PDF could not be fetched.
   * A file can be attached later. Returns the existing paper if the work is already here.
   */
  createPaper(resolved: ResolvedMetadata, opts: { tags?: string[] } = {}): number {
    const existing = this.findPaperByIds(resolved.metadata)
    if (existing !== undefined) {
      if (opts.tags?.length) this.addTags(existing, opts.tags)
      return existing
    }
    return transaction(this.db, () => {
      const now = new Date().toISOString()
      const id = this.insertPaper(resolved, 'resolved', now, now, undefined, '')
      if (opts.tags?.length) this.addTags(id, opts.tags)
      this.reindex(id)
      this.applyCiteTag(id)
      return id
    })
  }

  /** The paper holding this work, matched by DOI, bibcode or arXiv id. */
  findByIds(m: Pick<Metadata, 'doi' | 'bibcode' | 'arxivId'>): number | undefined {
    return this.findPaperByIds({ authors: [], ...m })
  }

  setReading(paperId: number, reading: ReadingStatus | null): void {
    this.db
      .prepare('UPDATE papers SET reading = ?, updated_at = ? WHERE id = ?')
      .run(reading, new Date().toISOString(), paperId)
  }

  setStarred(paperId: number, starred: boolean): void {
    this.db.prepare('UPDATE papers SET starred = ? WHERE id = ?').run(starred ? 1 : 0, paperId)
  }

  private findPaperByIds(m: Metadata): number | undefined {
    const row = this.db
      .prepare(
        `SELECT id FROM papers
         WHERE (:doi IS NOT NULL AND doi = :doi)
            OR (:bibcode IS NOT NULL AND bibcode = :bibcode)
            OR (:arxiv IS NOT NULL AND arxiv_id = :arxiv)
         ORDER BY id LIMIT 1`
      )
      .get({ doi: m.doi ?? null, bibcode: m.bibcode ?? null, arxiv: m.arxivId ?? null }) as
      { id: number } | undefined
    return row?.id
  }

  // ── Metadata refresh ──────────────────────────────────────────────────────

  /**
   * Look a paper up again (e.g. once an ADS token is configured) and rename its
   * files to the canonical scheme. Papers edited by hand (`manual`) are left alone.
   * If the result identifies a paper already in the library, the two are merged.
   */
  async resolvePaper(
    paperId: number,
    resolver: Resolver,
    extraIds: Identifier[] = []
  ): Promise<{ status: 'resolved' | 'merged' | 'unchanged'; paperId: number; errors: string[] }> {
    const paper = this.getPaper(paperId)
    if (!paper) throw new Error(`No paper with id ${paperId}`)
    if (paper.metadata_status === 'manual') return { status: 'unchanged', paperId, errors: [] }

    const ids: Identifier[] = [...extraIds]
    if (paper.bibcode) ids.push({ kind: 'bibcode', value: paper.bibcode, origin: 'hint' })
    if (paper.doi) ids.push({ kind: 'doi', value: paper.doi, origin: 'hint' })
    if (paper.arxiv_id) ids.push({ kind: 'arxiv', value: paper.arxiv_id, origin: 'hint' })
    for (const f of this.filesOf(paperId)) {
      const text = await readPdfText(join(this.root, f.rel_path)).catch(() => undefined)
      ids.push(
        ...extractIdentifiers({
          filename: f.original_name ?? basename(f.rel_path),
          pdfInfo: text?.info,
          firstPage: text?.firstPage,
          infoTitle: text?.infoTitle
        })
      )
    }
    // Printed identifiers first; file-name citations and titles are the last resort.
    const weak = (i: Identifier) => i.kind === 'title' || i.kind === 'reference'
    const ordered = [...ids.filter((i) => !weak(i)), ...ids.filter(weak)]
    const { resolved, errors } = await resolver(dedupeIds(ordered))
    if (!resolved) return { status: 'unchanged', paperId, errors }

    const other = this.findPaperByIds(resolved.metadata)
    const target = other !== undefined && other !== paperId ? other : paperId
    transaction(this.db, () => {
      if (target !== paperId) this.mergeInto(paperId, target)
      this.writeMetadata(target, resolved.metadata, resolved.source, 'resolved')
      this.reindex(target)
      this.applyCiteTag(target)
    })
    await this.renameFiles(target)
    return { status: target === paperId ? 'resolved' : 'merged', paperId: target, errors }
  }

  private mergeInto(from: number, to: number): void {
    this.db.prepare('UPDATE files SET paper_id = ? WHERE paper_id = ?').run(to, from)
    this.db.prepare('UPDATE notes SET paper_id = ? WHERE paper_id = ?').run(to, from)
    this.db
      .prepare(
        'INSERT OR IGNORE INTO paper_tags SELECT ?, tag_id FROM paper_tags WHERE paper_id = ?'
      )
      .run(to, from)
    this.db
      .prepare(
        `INSERT OR IGNORE INTO collection_papers
         SELECT collection_id, ? FROM collection_papers WHERE paper_id = ?`
      )
      .run(to, from)
    this.db.prepare('DELETE FROM papers_fts WHERE rowid = ?').run(from)
    this.db.prepare('DELETE FROM papers WHERE id = ?').run(from)
  }

  private async renameFiles(paperId: number): Promise<void> {
    await this.normalizeFileNames(paperId)
  }

  /**
   * Give a paper's files their canonical names in display order: the preferred file
   * (publisher first) gets `Stem.pdf`, the others `Stem-b.pdf`, `Stem-c.pdf`…
   * Files that must move are first parked under temporary names so that two files can
   * swap names; each step renames on disk and then updates the record, so a crash
   * leaves every record pointing at an existing file.
   */
  async normalizeFileNames(paperId: number): Promise<void> {
    const stem = canonicalStem(this.metadataOf(paperId))
    if (!stem) return
    const files = this.filesOf(paperId)
    const own = new Set(files.map((f) => basename(f.rel_path).toLowerCase()))
    const assigned = new Set<string>()
    const takenByOthers = (n: string) => !own.has(n.toLowerCase()) && this.nameTaken(n)
    const wanted = files.map((f) => {
      const name = uniqueFilename(stem, (n) => takenByOthers(n) || assigned.has(n.toLowerCase()))
      assigned.add(name.toLowerCase())
      return { f, name }
    })
    const moving = wanted.filter((w) => basename(w.f.rel_path) !== w.name)
    if (!moving.length) return
    const move = async (id: number, fromRel: string, toName: string) => {
      const from = join(this.root, fromRel)
      const to = join(this.filesDir, toName)
      await rename(from, to)
      try {
        this.db
          .prepare('UPDATE files SET rel_path = ? WHERE id = ?')
          .run(`${FILES_DIR}/${toName}`, id)
      } catch (err) {
        await rename(to, from)
        throw err
      }
    }
    const parked: { id: number; rel: string; name: string }[] = []
    for (const w of moving) {
      const tmp = `.renaming-${w.f.id}.pdf`
      await move(w.f.id, w.f.rel_path, tmp)
      parked.push({ id: w.f.id, rel: `${FILES_DIR}/${tmp}`, name: w.name })
    }
    for (const p of parked) await move(p.id, p.rel, p.name)
  }

  /** Move a paper's arXiv PDFs out (keeping any you have annotated). Returns their names. */
  private async dropPreprints(
    paperId: number,
    dispose: (absPath: string) => Promise<void>
  ): Promise<string[]> {
    const gone: string[] = []
    const files = this.filesOf(paperId)
    if (!files.some((f) => f.origin === 'publisher')) return gone
    for (const f of files.filter((x) => x.origin === 'arxiv')) {
      if (f.original_sha256) continue // annotated in the app
      const abs = join(this.root, f.rel_path)
      const anns = await readPdfAnnotations(abs).catch(() => [])
      if (anns.length) continue // annotated in another PDF reader
      this.db.prepare('DELETE FROM files WHERE id = ?').run(f.id)
      await dispose(abs)
      gone.push(basename(f.rel_path))
    }
    return gone
  }

  /**
   * Swap a file for another PDF of the same paper, typically the journal version you
   * downloaded through your institution in place of an arXiv e-print. The new file is
   * filed under the paper and named canonically; the old one (and any kept original)
   * goes to `dispose`. Returns the new file's id.
   */
  async replaceFile(
    fileId: number,
    src: string,
    dispose: (absPath: string) => Promise<void>
  ): Promise<{ fileId: number; relPath: string }> {
    const old = this.db
      .prepare('SELECT paper_id, rel_path, sha256, original_sha256 FROM files WHERE id = ?')
      .get(fileId) as
      | { paper_id: number; rel_path: string; sha256: string; original_sha256: string | null }
      | undefined
    if (!old) throw new Error(`No file with id ${fileId}`)
    if (!(await looksLikePdf(src))) throw new NotPdfError(src)
    const sha = await sha256File(src)
    if (sha === old.sha256 || sha === old.original_sha256) {
      throw new Error('That is the same file that is already here')
    }
    const holder = this.db
      .prepare('SELECT id, paper_id FROM files WHERE sha256 = ? OR original_sha256 = ?')
      .get(sha, sha) as { id: number; paper_id: number } | undefined
    if (holder && holder.paper_id !== old.paper_id) {
      throw new Error(`That PDF is already filed under another paper (#${holder.paper_id})`)
    }
    let newId = holder?.id
    if (newId === undefined) {
      await this.importPdf(src, { attachTo: old.paper_id, refreshText: true })
      newId = (this.db.prepare('SELECT id FROM files WHERE sha256 = ?').get(sha) as { id: number })
        .id
    }
    // Attaching renames files (the new one may take the old one's name), so look the
    // old file's path up again rather than trusting the one read above.
    const oldNow = this.db.prepare('SELECT rel_path FROM files WHERE id = ?').get(fileId) as {
      rel_path: string
    }
    this.db.prepare('DELETE FROM files WHERE id = ?').run(fileId)
    await dispose(join(this.root, oldNow.rel_path))
    if (old.original_sha256) {
      const kept = this.originalPath(old.original_sha256)
      if (await stat(kept).catch(() => undefined)) await dispose(kept)
    }
    await this.normalizeFileNames(old.paper_id)
    const rel = (
      this.db.prepare('SELECT rel_path FROM files WHERE id = ?').get(newId) as {
        rel_path: string
      }
    ).rel_path
    return { fileId: newId, relPath: rel }
  }

  setFileOrigin(fileId: number, origin: FileOrigin): void {
    this.db.prepare('UPDATE files SET origin = ? WHERE id = ?').run(origin, fileId)
  }

  /** Files whose origin has not been worked out yet (imported before schema v5). */
  filesWithoutOrigin(): { id: number; path: string; paperId: number }[] {
    const rows = this.db
      .prepare('SELECT id, rel_path, paper_id FROM files WHERE origin IS NULL')
      .all() as { id: number; rel_path: string; paper_id: number }[]
    return rows.map((r) => ({ id: r.id, path: join(this.root, r.rel_path), paperId: r.paper_id }))
  }

  // ── Tags ──────────────────────────────────────────────────────────────────

  /** Whether papers automatically get a `FamilyYY` tag once their author and year are known. */
  get autoCiteTags(): boolean {
    return this.getSetting('library.citeTags', true)
  }

  set autoCiteTags(on: boolean) {
    this.setSetting('library.citeTags', on)
  }

  private applyCiteTag(paperId: number): void {
    if (!this.autoCiteTags) return
    const tag = citeTag(this.metadataOf(paperId))
    if (tag) this.addTags(paperId, [tag])
  }

  addTags(paperId: number, tags: string[]): void {
    transaction(this.db, () => {
      const upsert = this.db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT DO NOTHING')
      const link = this.db.prepare(
        `INSERT OR IGNORE INTO paper_tags (paper_id, tag_id)
         SELECT ?, id FROM tags WHERE name = ?`
      )
      for (const raw of tags) {
        const tag = raw.trim()
        if (!tag) continue
        upsert.run(tag)
        link.run(paperId, tag)
      }
      this.reindex(paperId)
    })
  }

  removeTags(paperId: number, tags: string[]): void {
    transaction(this.db, () => {
      const unlinkTag = this.db.prepare(
        'DELETE FROM paper_tags WHERE paper_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)'
      )
      for (const tag of tags) unlinkTag.run(paperId, tag.trim())
      this.db.exec('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM paper_tags)')
      this.reindex(paperId)
    })
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  getPaper(id: number): PaperRow | undefined {
    return this.db.prepare('SELECT * FROM papers WHERE id = ?').get(id) as PaperRow | undefined
  }

  listPapers(opts: { tag?: string; status?: PaperRow['metadata_status'] } = {}): PaperSummary[] {
    const rows = this.db
      .prepare(
        `SELECT p.id FROM papers p
         WHERE (:tag IS NULL OR EXISTS (
                  SELECT 1 FROM paper_tags pt JOIN tags t ON t.id = pt.tag_id
                  WHERE pt.paper_id = p.id AND t.name = :tag))
           AND (:status IS NULL OR p.metadata_status = :status)
         ORDER BY p.year DESC NULLS LAST, p.id`
      )
      .all({ tag: opts.tag ?? null, status: opts.status ?? null }) as { id: number }[]
    return rows.map((r) => this.summary(r.id))
  }

  /** Every paper as one flat row, in a single query — what a list view needs, and no more. */
  listRows(): PaperListRow[] {
    const rows = this.db
      .prepare(
        `SELECT p.id, p.title, p.year, p.journal, p.journal_abbrev, p.volume, p.page,
                p.doi, p.bibcode, p.arxiv_id, p.metadata_status, p.metadata_source,
                p.added_at, p.updated_at,
                (SELECT family FROM authors a WHERE a.paper_id = p.id ORDER BY position LIMIT 1)
                  AS first_author,
                (SELECT count(*) FROM authors a WHERE a.paper_id = p.id) AS author_count,
                (SELECT count(*) FROM files f WHERE f.paper_id = p.id) AS file_count,
                (SELECT group_concat(name, char(31)) FROM (
                   SELECT t.name FROM tags t JOIN paper_tags pt ON pt.tag_id = t.id
                   WHERE pt.paper_id = p.id ORDER BY t.name COLLATE NOCASE)) AS tag_list,
                EXISTS (SELECT 1 FROM notes n WHERE n.paper_id = p.id AND n.body != '') AS has_note,
                p.reading, p.starred,
                (SELECT f.origin FROM files f WHERE f.paper_id = p.id
                 ORDER BY CASE f.origin WHEN 'publisher' THEN 0 WHEN 'ads-scan' THEN 1
                                        WHEN 'arxiv' THEN 3 ELSE 2 END LIMIT 1) AS pdf_origin,
                (SELECT count(*) FROM annotations an JOIN files f ON f.id = an.file_id
                 WHERE f.paper_id = p.id) AS annotation_count
         FROM papers p
         ORDER BY p.added_at DESC, p.id DESC`
      )
      .all() as (Omit<PaperListRow, 'tags' | 'has_note' | 'starred'> & {
      tag_list: string | null
      has_note: number
      starred: number
    })[]
    return rows.map(({ tag_list, has_note, starred, ...r }) => ({
      ...r,
      tags: tag_list ? tag_list.split('\x1f') : [],
      has_note: has_note === 1,
      starred: starred === 1
    }))
  }

  tagCounts(): { name: string; count: number }[] {
    return this.db
      .prepare(
        `SELECT t.name, count(pt.paper_id) AS count FROM tags t
         JOIN paper_tags pt ON pt.tag_id = t.id
         GROUP BY t.id ORDER BY t.name COLLATE NOCASE`
      )
      .all() as { name: string; count: number }[]
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined
    if (!row) return fallback
    try {
      return JSON.parse(row.value) as T
    } catch {
      return fallback
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      )
      .run(key, JSON.stringify(value))
  }

  /** The paper holding a file with these bytes, if any. */
  paperIdForHash(sha256: string): number | undefined {
    const row = this.db
      .prepare('SELECT paper_id FROM files WHERE sha256 = ? OR original_sha256 = ?')
      .get(sha256, sha256) as { paper_id: number } | undefined
    return row?.paper_id
  }

  // ── Notes ─────────────────────────────────────────────────────────────────

  /** One free-text note per paper (the table allows more; the app uses one). */
  getNote(paperId: number): string {
    const row = this.db
      .prepare('SELECT body FROM notes WHERE paper_id = ? ORDER BY id LIMIT 1')
      .get(paperId) as { body: string } | undefined
    return row?.body ?? ''
  }

  setNote(paperId: number, body: string): void {
    transaction(this.db, () => {
      const now = new Date().toISOString()
      const row = this.db
        .prepare('SELECT id FROM notes WHERE paper_id = ? ORDER BY id LIMIT 1')
        .get(paperId) as { id: number } | undefined
      if (row) {
        this.db
          .prepare('UPDATE notes SET body = ?, updated_at = ? WHERE id = ?')
          .run(body, now, row.id)
      } else {
        this.db
          .prepare('INSERT INTO notes (paper_id, body, created_at, updated_at) VALUES (?, ?, ?, ?)')
          .run(paperId, body, now, now)
      }
    })
  }

  // ── Editing and removal ───────────────────────────────────────────────────

  /**
   * Replace a paper's metadata by hand. The paper is marked `manual`, so later lookups
   * leave it alone, and its files are renamed to match.
   */
  async setManualMetadata(paperId: number, m: Metadata): Promise<void> {
    const clash = this.findPaperByIds(m)
    if (clash !== undefined && clash !== paperId) {
      throw new Error(`Paper #${clash} already has this DOI, bibcode or arXiv id`)
    }
    transaction(this.db, () => {
      this.writeMetadata(paperId, { ...m, bibtex: undefined }, 'manual', 'manual')
      this.reindex(paperId)
      this.applyCiteTag(paperId)
    })
    await this.renameFiles(paperId)
  }

  /** Hand a manually edited paper back to automatic lookups. */
  unlockMetadata(paperId: number): void {
    this.db
      .prepare(
        `UPDATE papers SET metadata_status = 'unresolved', updated_at = ?
         WHERE id = ? AND metadata_status = 'manual'`
      )
      .run(new Date().toISOString(), paperId)
  }

  /**
   * Remove a paper's records, then hand each of its files to `disposeFile` (the app moves
   * them to the Trash). Records go first: if disposal fails the file is left untracked,
   * which `verify` reports, rather than a record pointing at nothing.
   */
  async removePaper(
    paperId: number,
    disposeFile: (absPath: string) => Promise<void>
  ): Promise<void> {
    const files = this.filesOf(paperId).map((f) => join(this.root, f.rel_path))
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM papers_fts WHERE rowid = ?').run(paperId)
      this.db.prepare('DELETE FROM papers WHERE id = ?').run(paperId)
      this.db.exec('DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM paper_tags)')
    })
    for (const f of files) await disposeFile(f)
  }

  // ── Annotated versions ────────────────────────────────────────────────────

  /**
   * Replace a file's contents, e.g. with a copy carrying the reader's highlights.
   * The first time, the untouched original is kept at `originals/<sha256>.pdf`.
   * The new bytes are written beside the file and renamed over it, so a crash leaves
   * either the old or the new file, never half of one.
   */
  async saveFileVersion(
    fileId: number,
    bytes: Uint8Array
  ): Promise<{ sha256: string; size: number }> {
    if (!Buffer.from(bytes.subarray(0, 1024)).includes('%PDF-')) throw new Error('Not a PDF')
    const f = this.fileRow(fileId)
    const abs = join(this.root, f.rel_path)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (sha256 === f.sha256) return { sha256, size: f.size }
    const clash = this.db
      .prepare('SELECT id FROM files WHERE (sha256 = ? OR original_sha256 = ?) AND id != ?')
      .get(sha256, sha256, fileId)
    if (clash) throw new Error('Another file in the library already has these exact contents')

    if (!f.original_sha256) {
      await mkdir(join(this.root, ORIGINALS_DIR), { recursive: true })
      await copyFile(abs, this.originalPath(f.sha256), constants.COPYFILE_EXCL).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      })
    }
    const tmp = join(this.filesDir, `${INCOMING_PREFIX}save-${fileId}.pdf`)
    await writeFile(tmp, bytes)
    await rename(tmp, abs)
    this.db
      .prepare(
        'UPDATE files SET sha256 = ?, size = ?, original_sha256 = COALESCE(original_sha256, ?) WHERE id = ?'
      )
      .run(sha256, bytes.byteLength, f.sha256, fileId)
    return { sha256, size: bytes.byteLength }
  }

  /** Throw away saved annotations: put the original back and forget the kept copy. */
  async restoreOriginal(fileId: number): Promise<void> {
    const f = this.fileRow(fileId)
    if (!f.original_sha256) return
    const kept = this.originalPath(f.original_sha256)
    const tmp = join(this.filesDir, `${INCOMING_PREFIX}restore-${fileId}.pdf`)
    await copyFile(kept, tmp)
    const size = (await stat(tmp)).size
    await rename(tmp, join(this.root, f.rel_path))
    this.db
      .prepare(
        'UPDATE files SET sha256 = original_sha256, size = ?, original_sha256 = NULL WHERE id = ?'
      )
      .run(size, fileId)
    await unlink(kept).catch(() => {})
  }

  private fileRow(fileId: number) {
    const f = this.db
      .prepare('SELECT rel_path, sha256, size, original_sha256 FROM files WHERE id = ?')
      .get(fileId) as
      { rel_path: string; sha256: string; size: number; original_sha256: string | null } | undefined
    if (!f) throw new Error(`No file with id ${fileId}`)
    return f
  }

  private originalPath(sha256: string): string {
    return join(this.root, ORIGINALS_DIR, `${sha256}.pdf`)
  }

  /**
   * Remove one file from a paper that has others (a redundant copy, a stale preprint).
   * The last file cannot go this way; remove the paper instead. As with removePaper,
   * the record goes first, then the file (and any kept original) is handed to `disposeFile`.
   */
  async removeFile(fileId: number, disposeFile: (absPath: string) => Promise<void>): Promise<void> {
    const f = this.db
      .prepare('SELECT paper_id, rel_path, original_sha256 FROM files WHERE id = ?')
      .get(fileId) as
      { paper_id: number; rel_path: string; original_sha256: string | null } | undefined
    if (!f) throw new Error(`No file with id ${fileId}`)
    if (this.filesOf(f.paper_id).length < 2) {
      throw new Error('This is the paper’s only file; remove the paper instead')
    }
    this.db.prepare('DELETE FROM files WHERE id = ?').run(fileId)
    await disposeFile(join(this.root, f.rel_path))
    if (f.original_sha256) {
      const kept = this.originalPath(f.original_sha256)
      if (await stat(kept).catch(() => undefined)) await disposeFile(kept)
    }
    await this.normalizeFileNames(f.paper_id)
  }

  exportBibtex(paperIds: number[]): string {
    return paperIds.map((id) => toBibtex(this.metadataOf(id))).join('\n\n') + '\n'
  }

  /** Full-text search. Plain words are ANDed and prefix-matched; ranking favours titles and authors. */
  search(query: string, limit = 50): SearchHit[] {
    const match = toFtsQuery(query)
    if (!match) return []
    const rows = this.db
      .prepare(
        `SELECT rowid AS id,
                snippet(papers_fts, -1, '[', ']', '…', 12) AS snippet
         FROM papers_fts
         WHERE papers_fts MATCH ?
         ORDER BY bm25(papers_fts, 10.0, 5.0, 3.0, 5.0, 1.0)
         LIMIT ?`
      )
      .all(match, limit) as { id: number; snippet: string }[]
    return rows.map((r) => ({ paper: this.summary(r.id), snippet: r.snippet }))
  }

  summary(id: number): PaperSummary {
    const paper = this.getPaper(id)
    if (!paper) throw new Error(`No paper with id ${id}`)
    const first = this.db
      .prepare('SELECT family FROM authors WHERE paper_id = ? ORDER BY position LIMIT 1')
      .get(id) as { family: string } | undefined
    return {
      ...paper,
      first_author: first?.family ?? null,
      tags: this.tagsOf(id),
      files: this.filesOf(id).map((f) => f.rel_path)
    }
  }

  tagsOf(paperId: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT t.name FROM tags t JOIN paper_tags pt ON pt.tag_id = t.id
         WHERE pt.paper_id = ? ORDER BY t.name COLLATE NOCASE`
      )
      .all(paperId) as { name: string }[]
    return rows.map((r) => r.name)
  }

  filesOf(paperId: number) {
    return this.db
      .prepare(
        `SELECT id, rel_path, sha256, size, original_name, original_sha256, origin
         FROM files WHERE paper_id = ?
         ORDER BY CASE origin WHEN 'publisher' THEN 0 WHEN 'ads-scan' THEN 1
                              WHEN 'arxiv' THEN 3 ELSE 2 END, id`
      )
      .all(paperId) as {
      id: number
      rel_path: string
      sha256: string
      size: number
      original_name: string | null
      original_sha256: string | null
      origin: FileOrigin | null
    }[]
  }

  metadataOf(paperId: number): Metadata {
    const p = this.db.prepare('SELECT * FROM papers WHERE id = ?').get(paperId) as Record<
      string,
      string | number | null
    >
    const authors = this.db
      .prepare('SELECT family, given FROM authors WHERE paper_id = ? ORDER BY position')
      .all(paperId) as { family: string; given: string | null }[]
    const s = (k: string) => (p[k] == null ? undefined : String(p[k]))
    return {
      title: s('title'),
      abstract: s('abstract'),
      year: p.year == null ? undefined : Number(p.year),
      pubDate: s('pub_date'),
      journal: s('journal'),
      journalAbbrev: s('journal_abbrev'),
      volume: s('volume'),
      issue: s('issue'),
      page: s('page'),
      entryType: s('entry_type'),
      doi: s('doi'),
      arxivId: s('arxiv_id'),
      bibcode: s('bibcode'),
      bibtex: s('bibtex'),
      authors: authors.map((a) => ({ family: a.family, given: a.given ?? undefined }))
    }
  }

  // ── Integrity ─────────────────────────────────────────────────────────────

  /** Compare the database with the files folder. `deep` re-hashes every file. */
  async verify({ deep = false } = {}): Promise<Issue[]> {
    const issues: Issue[] = []
    const files = this.db.prepare('SELECT paper_id, rel_path, sha256, size FROM files').all() as {
      paper_id: number
      rel_path: string
      sha256: string
      size: number
    }[]
    const tracked = new Set(files.map((f) => f.rel_path.toLowerCase()))

    for (const f of files) {
      const abs = join(this.root, f.rel_path)
      const st = await stat(abs).catch(() => undefined)
      if (!st) {
        issues.push({ kind: 'missing-file', relPath: f.rel_path, paperId: f.paper_id })
      } else if (st.size !== f.size) {
        issues.push({
          kind: 'size-mismatch',
          relPath: f.rel_path,
          expected: f.size,
          actual: st.size
        })
      } else if (deep && (await sha256File(abs)) !== f.sha256) {
        issues.push({ kind: 'hash-mismatch', relPath: f.rel_path })
      }
    }
    for (const name of await readdir(this.filesDir)) {
      if (name === '.DS_Store' || name.startsWith('._')) continue
      const rel = `${FILES_DIR}/${name}`
      if (!tracked.has(rel.toLowerCase())) issues.push({ kind: 'untracked-file', relPath: rel })
    }
    const annotated = this.db
      .prepare('SELECT rel_path, original_sha256 FROM files WHERE original_sha256 IS NOT NULL')
      .all() as { rel_path: string; original_sha256: string }[]
    for (const a of annotated) {
      if (!(await stat(this.originalPath(a.original_sha256)).catch(() => undefined))) {
        issues.push({ kind: 'missing-original', relPath: a.rel_path, sha256: a.original_sha256 })
      }
    }
    return issues
  }

  // ── Full-text index ───────────────────────────────────────────────────────

  /** Rewrite a paper's FTS row. `fulltext` defaults to what is already indexed. */
  private reindex(paperId: number, fulltext?: string): void {
    const prev = this.db.prepare('SELECT fulltext FROM papers_fts WHERE rowid = ?').get(paperId) as
      { fulltext: string | null } | undefined
    const p = this.getPaper(paperId)!
    const abstract = this.db.prepare('SELECT abstract FROM papers WHERE id = ?').get(paperId) as {
      abstract: string | null
    }
    const authors = this.db
      .prepare('SELECT family, given FROM authors WHERE paper_id = ? ORDER BY position')
      .all(paperId) as { family: string; given: string | null }[]
    this.db.prepare('DELETE FROM papers_fts WHERE rowid = ?').run(paperId)
    this.db
      .prepare(
        'INSERT INTO papers_fts (rowid, title, authors, abstract, tags, fulltext) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        paperId,
        p.title ?? '',
        authors.map((a) => [a.given, a.family].filter(Boolean).join(' ')).join('; '),
        abstract.abstract ?? '',
        this.tagsOf(paperId).join(' '),
        fulltext ?? prev?.fulltext ?? ''
      )
  }
}

export function toFtsQuery(input: string): string {
  const terms = input.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? []
  return terms.map((t) => `"${t.replace(/"/g, '')}"*`).join(' ')
}

/** How much a record says; used to pick the better of two sets of legacy fields. */
function richness(m: Metadata): number {
  const fields = [m.title, m.journal, m.year, m.volume, m.page, m.doi, m.bibcode, m.arxivId]
  return fields.filter((f) => f !== undefined && f !== '').length + m.authors.length
}

function dedupeIds(ids: Identifier[]): Identifier[] {
  const seen = new Set<string>()
  return ids.filter((x) => {
    const key = `${x.kind}:${x.value.toLowerCase()}`
    return seen.has(key) ? false : (seen.add(key), true)
  })
}
