/**
 * The library's query language, shared by the search box and smart collections.
 *
 *   coronal magnetometry            full text (prefix-matched, all words required)
 *   tag:CryoNIRSP  -tag:draft       has / lacks a tag
 *   author:Schad                    any author's family name starts with this
 *   journal:ApJ                     journal abbreviation or name contains this
 *   year:2024  year:>2020  year:2019-2021  year:<=2010
 *   status:to-read | reading | read | unread | review
 *   is:starred | annotated | noted | nopdf | preprint (only an arXiv PDF)
 *   collection:"Eclipse review"     members of a (manual) collection
 *
 * Values with spaces go in double quotes. Unknown keys are treated as ordinary words.
 */
import type { Library } from './library.js'
import { toFtsQuery } from './library.js'

export interface ParsedQuery {
  words: string
  tags: string[]
  notTags: string[]
  authors: string[]
  journals: string[]
  yearMin?: number
  yearMax?: number
  status: string[]
  is: string[]
  collections: string[]
}

const TOKEN = /(-?)(\w+):"([^"]*)"|(-?)(\w+):(\S+)|"([^"]*)"|(\S+)/g

export function parseQuery(input: string): ParsedQuery {
  const q: ParsedQuery = {
    words: '',
    tags: [],
    notTags: [],
    authors: [],
    journals: [],
    status: [],
    is: [],
    collections: []
  }
  const words: string[] = []
  for (const m of input.matchAll(TOKEN)) {
    const neg = m[1] || m[4]
    const key = (m[2] ?? m[5])?.toLowerCase()
    const value = m[3] ?? m[6]
    if (key === undefined || value === undefined) {
      words.push(m[7] ?? m[8] ?? '')
      continue
    }
    switch (key) {
      case 'tag':
        ;(neg ? q.notTags : q.tags).push(value)
        break
      case 'author':
        q.authors.push(value)
        break
      case 'journal':
        q.journals.push(value)
        break
      case 'status':
        q.status.push(value.toLowerCase())
        break
      case 'is':
        q.is.push(value.toLowerCase())
        break
      case 'collection':
        q.collections.push(value)
        break
      case 'year': {
        const range = /^(\d{4})-(\d{4})$/.exec(value)
        const cmp = /^(>=|<=|>|<)?(\d{4})$/.exec(value)
        if (range) {
          q.yearMin = Number(range[1])
          q.yearMax = Number(range[2])
        } else if (cmp) {
          const y = Number(cmp[2])
          if (cmp[1] === '>') q.yearMin = y + 1
          else if (cmp[1] === '>=') q.yearMin = y
          else if (cmp[1] === '<') q.yearMax = y - 1
          else if (cmp[1] === '<=') q.yearMax = y
          else q.yearMin = q.yearMax = y
        } else words.push(m[0])
        break
      }
      default:
        words.push(m[0])
    }
  }
  q.words = words.join(' ').trim()
  return q
}

export function isEmptyQuery(q: ParsedQuery): boolean {
  return (
    !q.words &&
    !q.tags.length &&
    !q.notTags.length &&
    !q.authors.length &&
    !q.journals.length &&
    q.yearMin === undefined &&
    q.yearMax === undefined &&
    !q.status.length &&
    !q.is.length &&
    !q.collections.length
  )
}

export interface QueryHit {
  id: number
  snippet?: string | undefined
}

/** Papers matching a query: by relevance when it has words, otherwise newest first. */
export function runQuery(lib: Library, input: string, limit = 5000): QueryHit[] {
  const q = parseQuery(input)
  const where: string[] = []
  const params: (string | number)[] = []

  for (const t of q.tags) {
    where.push(
      'EXISTS (SELECT 1 FROM paper_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.paper_id = p.id AND t.name = ?)'
    )
    params.push(t)
  }
  for (const t of q.notTags) {
    where.push(
      'NOT EXISTS (SELECT 1 FROM paper_tags pt JOIN tags t ON t.id = pt.tag_id WHERE pt.paper_id = p.id AND t.name = ?)'
    )
    params.push(t)
  }
  for (const a of q.authors) {
    where.push(
      "EXISTS (SELECT 1 FROM authors au WHERE au.paper_id = p.id AND au.family LIKE ? ESCAPE '\\')"
    )
    params.push(`${escapeLike(a)}%`)
  }
  for (const j of q.journals) {
    where.push(
      "(p.journal_abbrev LIKE ? ESCAPE '\\' OR p.journal LIKE ? ESCAPE '\\' OR p.bibcode LIKE ? ESCAPE '\\')"
    )
    params.push(`${escapeLike(j)}%`, `%${escapeLike(j)}%`, `____${escapeLike(j)}%`)
  }
  if (q.yearMin !== undefined) {
    where.push('p.year >= ?')
    params.push(q.yearMin)
  }
  if (q.yearMax !== undefined) {
    where.push('p.year <= ?')
    params.push(q.yearMax)
  }
  for (const s of q.status) {
    if (s === 'unread') where.push("(p.reading IS NULL OR p.reading = 'to-read')")
    else if (s === 'review') where.push("p.metadata_status = 'unresolved'")
    else {
      where.push('p.reading = ?')
      params.push(s)
    }
  }
  for (const flag of q.is) {
    if (flag === 'starred') where.push('p.starred = 1')
    else if (flag === 'noted')
      where.push("EXISTS (SELECT 1 FROM notes n WHERE n.paper_id = p.id AND n.body != '')")
    else if (flag === 'preprint')
      where.push(
        `EXISTS (SELECT 1 FROM files f WHERE f.paper_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM files f WHERE f.paper_id = p.id
                         AND coalesce(f.origin, 'unknown') != 'arxiv')`
      )
    else if (flag === 'nopdf')
      where.push('NOT EXISTS (SELECT 1 FROM files f WHERE f.paper_id = p.id)')
    else if (flag === 'annotated')
      where.push(
        'EXISTS (SELECT 1 FROM annotations an JOIN files f ON f.id = an.file_id WHERE f.paper_id = p.id)'
      )
  }
  for (const c of q.collections) {
    where.push(
      `p.id IN (SELECT cp.paper_id FROM collection_papers cp JOIN collections c ON c.id = cp.collection_id
                WHERE c.name = ? COLLATE NOCASE)`
    )
    params.push(c)
  }

  const fts = toFtsQuery(q.words)
  const filter = where.length ? `AND ${where.join(' AND ')}` : ''
  const sql = fts
    ? `SELECT p.id, snippet(papers_fts, -1, '[', ']', '…', 12) AS snippet
       FROM papers_fts JOIN papers p ON p.id = papers_fts.rowid
       WHERE papers_fts MATCH ? ${filter}
       ORDER BY bm25(papers_fts, 10.0, 5.0, 3.0, 5.0, 1.0)
       LIMIT ?`
    : `SELECT p.id, NULL AS snippet FROM papers p
       WHERE 1 = 1 ${filter}
       ORDER BY p.added_at DESC, p.id DESC
       LIMIT ?`
  const args = fts ? [fts, ...params, limit] : [...params, limit]
  const rows = lib.db.prepare(sql).all(...args) as { id: number; snippet: string | null }[]
  return rows.map((r) => ({ id: r.id, snippet: r.snippet ?? undefined }))
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}
