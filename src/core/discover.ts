/**
 * Discovery through ADS: a paper's references and citations, saved queries ("watches")
 * that collect new results over time, and finding the published version of preprints.
 * Everything here needs an ADS token.
 */
import { transaction } from './db/database.js'
import type { Library } from './library.js'
import { adsList, type AdsListItem } from './metadata/ads.js'
import type { Fetch } from './metadata/http.js'

export interface AdsContext {
  fetch: Fetch
  token: string
}

export interface RelatedItem extends AdsListItem {
  /** The paper's id when it is already in the library. */
  paperId?: number | undefined
}

export function markInLibrary(lib: Library, items: AdsListItem[]): RelatedItem[] {
  return items.map((i) => ({
    ...i,
    paperId: lib.findByIds({ bibcode: i.bibcode, doi: i.doi, arxivId: i.arxivId })
  }))
}

/** What a paper cites, or what cites it, according to ADS. */
export async function related(
  lib: Library,
  paperId: number,
  kind: 'references' | 'citations',
  ctx: AdsContext
): Promise<RelatedItem[]> {
  const bibcode = lib.getPaper(paperId)?.bibcode
  if (!bibcode) throw new Error('This paper has no ADS bibcode; look it up first')
  const items = await adsList(ctx.fetch, ctx.token, `${kind}(bibcode:"${bibcode}")`, {
    rows: 500,
    sort: kind === 'citations' ? 'date desc' : 'first_author asc'
  })
  return markInLibrary(lib, items)
}

// ── Watches ─────────────────────────────────────────────────────────────────

export interface Watch {
  id: number
  name: string
  query: string
  lastRunAt: string | null
  lastError: string | null
  newCount: number
}

export interface WatchHit extends RelatedItem {
  watchId: number
  watchName: string
  foundAt: string
  state: 'new' | 'dismissed' | 'added'
}

/** Ready-made queries for the most common watches. */
export const WATCH_TEMPLATES = {
  citesPaper: (bibcode: string) => `citations(bibcode:"${bibcode}")`,
  citesAuthor: (author: string) => `citations(author:"^${author}")`,
  byAuthor: (author: string) => `author:"${author}"`,
  arxivClass: (cls: string) => `arxiv_class:"${cls}" entdate:[NOW-7DAYS TO NOW]`
}

export function listWatches(lib: Library): Watch[] {
  const rows = lib.db
    .prepare(
      `SELECT w.id, w.name, w.query, w.last_run_at AS lastRunAt, w.last_error AS lastError,
              (SELECT count(*) FROM watch_hits h WHERE h.watch_id = w.id AND h.state = 'new') AS newCount
       FROM watches w ORDER BY w.name COLLATE NOCASE`
    )
    .all() as unknown as Watch[]
  return rows
}

export function createWatch(lib: Library, name: string, query: string): number {
  if (!name.trim() || !query.trim()) throw new Error('A watch needs a name and an ADS query')
  const info = lib.db
    .prepare('INSERT INTO watches (name, query, created_at) VALUES (?, ?, ?)')
    .run(name.trim(), query.trim(), new Date().toISOString())
  return Number(info.lastInsertRowid)
}

export function deleteWatch(lib: Library, id: number): void {
  lib.db.prepare('DELETE FROM watches WHERE id = ?').run(id)
}

/**
 * Run a watch and keep what is new: results not seen before and not already in the
 * library. Returns how many new results it found. Anything dismissed stays dismissed.
 */
export async function runWatch(lib: Library, id: number, ctx: AdsContext): Promise<number> {
  const w = lib.db.prepare('SELECT query, last_run_at FROM watches WHERE id = ?').get(id) as
    { query: string; last_run_at: string | null } | undefined
  if (!w) throw new Error('No such watch')
  const now = new Date().toISOString()
  let items: AdsListItem[]
  try {
    items = await adsList(ctx.fetch, ctx.token, w.query, { rows: 100 })
  } catch (err) {
    lib.db
      .prepare('UPDATE watches SET last_run_at = ?, last_error = ? WHERE id = ?')
      .run(now, (err as Error).message, id)
    throw err
  }
  let added = 0
  transaction(lib.db, () => {
    const insert = lib.db.prepare(
      `INSERT OR IGNORE INTO watch_hits
         (watch_id, bibcode, title, authors, year, pub, doi, arxiv_id, found_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const i of items) {
      if (lib.findByIds({ bibcode: i.bibcode, doi: i.doi, arxivId: i.arxivId }) !== undefined)
        continue
      const r = insert.run(
        id,
        i.bibcode,
        i.title ?? null,
        JSON.stringify(i.authors),
        i.year ?? null,
        i.pub ?? null,
        i.doi ?? null,
        i.arxivId ?? null,
        now,
        'new'
      )
      added += Number(r.changes)
    }
    lib.db
      .prepare('UPDATE watches SET last_run_at = ?, last_error = NULL WHERE id = ?')
      .run(now, id)
  })
  return added
}

export function watchHits(lib: Library, state: WatchHit['state'] = 'new'): WatchHit[] {
  const rows = lib.db
    .prepare(
      `SELECT h.*, w.name AS watch_name FROM watch_hits h JOIN watches w ON w.id = h.watch_id
       WHERE h.state = ? ORDER BY h.found_at DESC, h.year DESC`
    )
    .all(state) as {
    watch_id: number
    watch_name: string
    bibcode: string
    title: string | null
    authors: string
    year: number | null
    pub: string | null
    doi: string | null
    arxiv_id: string | null
    found_at: string
    state: WatchHit['state']
  }[]
  return rows.map((r) => ({
    watchId: r.watch_id,
    watchName: r.watch_name,
    bibcode: r.bibcode,
    title: r.title ?? undefined,
    authors: JSON.parse(r.authors) as string[],
    year: r.year ?? undefined,
    pub: r.pub ?? undefined,
    doi: r.doi ?? undefined,
    arxivId: r.arxiv_id ?? undefined,
    refereed: false,
    foundAt: r.found_at,
    state: r.state,
    paperId: lib.findByIds({
      bibcode: r.bibcode,
      doi: r.doi ?? undefined,
      arxivId: r.arxiv_id ?? undefined
    })
  }))
}

export function setHitState(lib: Library, bibcodes: string[], state: WatchHit['state']): void {
  const update = lib.db.prepare('UPDATE watch_hits SET state = ? WHERE bibcode = ?')
  transaction(lib.db, () => {
    for (const b of bibcodes) update.run(state, b)
  })
}

// ── Preprints ───────────────────────────────────────────────────────────────

export interface PublishedVersion {
  paperId: number
  title: string | null
  arxivId: string
  bibcode: string
  pub?: string | undefined
  year?: number | undefined
}

/** Papers held only as preprints: an arXiv id and no journal volume or journal bibcode. */
export function preprintPapers(
  lib: Library
): { id: number; arxiv_id: string; title: string | null }[] {
  return lib.db
    .prepare(
      `SELECT id, arxiv_id, title FROM papers
       WHERE arxiv_id IS NOT NULL
         AND metadata_status != 'manual'
         AND (bibcode IS NULL OR bibcode LIKE '____arXiv%')
         AND volume IS NULL`
    )
    .all() as { id: number; arxiv_id: string; title: string | null }[]
}

/**
 * Ask ADS whether each preprint has been published. ADS merges a preprint into its
 * journal record, so a lookup by arXiv id returns the journal bibcode once it exists.
 */
export async function findPublishedVersions(
  lib: Library,
  ctx: AdsContext
): Promise<PublishedVersion[]> {
  const out: PublishedVersion[] = []
  for (const p of preprintPapers(lib)) {
    const [hit] = await adsList(ctx.fetch, ctx.token, `identifier:"arXiv:${p.arxiv_id}"`, {
      rows: 1
    }).catch(() => [])
    if (hit && !/arXiv/i.test(hit.bibcode) && hit.refereed) {
      out.push({
        paperId: p.id,
        title: p.title,
        arxivId: p.arxiv_id,
        bibcode: hit.bibcode,
        pub: hit.pub,
        year: hit.year
      })
    }
  }
  return out
}
