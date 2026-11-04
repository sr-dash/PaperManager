/**
 * Importers for libraries kept by the earlier PaperManager apps:
 *  - macOS/SwiftUI: a folder holding `papers.json` and the PDFs (renamed to UUIDs).
 *  - Linux/PyQt6:   `db/papers.db` (SQLite) next to a `papers/` folder.
 *
 * Their hand-entered fields become `legacy` fallback metadata, used only when
 * the PDF cannot be resolved against ADS/Crossref/arXiv.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { bibcodeFromAdsUrl } from './identifiers.js'
import type { ImportResult, Library } from './library.js'
import { decodeEntities, splitName } from './metadata/http.js'
import type { Resolver } from './metadata/resolver.js'
import type { Identifier, Metadata } from './types.js'

export interface LegacyRecord {
  pdfPath: string
  tags: string[]
  addedAt?: string | undefined
  bibcode?: string | undefined
  fallback: Metadata
}

export interface LegacyImportReport {
  source: string
  results: (ImportResult & { pdfPath: string })[]
  failures: { pdfPath: string; error: string }[]
}

// Seconds between 1970-01-01 and 2001-01-01, the Foundation `Date` reference.
const APPLE_EPOCH_OFFSET = 978_307_200

interface SwiftPaper {
  id: string
  fileName: string
  title: string
  tags?: string[]
  modifiedDate?: number
  adsURLString?: string | null
  firstAuthor?: string | null
  journal?: string | null
  year?: string | null
  bibTitle?: string | null
}

export async function readSwiftLibrary(dir: string): Promise<LegacyRecord[]> {
  const papers = JSON.parse(await readFile(join(dir, 'papers.json'), 'utf8')) as SwiftPaper[]
  return papers.map((p) => {
    const year = p.year ? /\d{4}/.exec(p.year)?.[0] : undefined
    return {
      pdfPath: join(dir, p.fileName),
      tags: p.tags ?? [],
      addedAt:
        p.modifiedDate === undefined
          ? undefined
          : new Date((p.modifiedDate + APPLE_EPOCH_OFFSET) * 1000).toISOString(),
      bibcode: p.adsURLString ? bibcodeFromAdsUrl(p.adsURLString) : undefined,
      fallback: {
        title: p.bibTitle ? decodeEntities(p.bibTitle) : p.title,
        authors: p.firstAuthor ? [splitName(p.firstAuthor)] : [],
        journal: p.journal ?? undefined,
        year: year ? Number(year) : undefined
      }
    }
  })
}

export function readPythonLibrary(dbPath: string): LegacyRecord[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const papers = db
      .prepare('SELECT id, filename, path, bib_info, date_added FROM papers ORDER BY id')
      .all() as {
      id: number
      filename: string
      path: string
      bib_info: string | null
      date_added: string
    }[]
    const tagRows = db.prepare('SELECT paper_id, tag FROM tags').all() as {
      paper_id: number
      tag: string
    }[]
    // Copies of the app's folder kept absolute paths to the original; look beside the db too.
    const sibling = join(dirname(dirname(dbPath)), 'papers')
    return papers.map((p) => {
      const bib = parsePythonBibInfo(p.bib_info ?? '')
      const pdfPath = existsSync(p.path) ? p.path : join(sibling, p.filename)
      return {
        pdfPath,
        tags: [...new Set(tagRows.filter((t) => t.paper_id === p.id).map((t) => t.tag))],
        addedAt: toIso(p.date_added),
        bibcode: bib.bibcode,
        fallback: {
          title: bib.title ?? p.filename.replace(/\.pdf$/i, ''),
          authors: bib.authors.map(splitName),
          journal: bib.journal,
          year: bib.year
        }
      }
    })
  } finally {
    db.close()
  }
}

/** Parse the emoji-sectioned text the PyQt app stored in `bib_info`. */
export function parsePythonBibInfo(text: string) {
  const section = (label: string) =>
    new RegExp(`${label}[^\\n]*:\\s*\\n([\\s\\S]*?)(?=\\n\\s*\\n\\S|$)`).exec(text)?.[1]?.trim()
  const title = section('Title')
  const authors = (section('Authors') ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*-\s*/, '').trim())
    .filter(Boolean)
  const journal = section('Journal')
  const published = section('Published')
  const url = section('URL')
  const year = published && /\d{4}/.exec(published)?.[0]
  return {
    title: title && title !== 'N/A' ? title : undefined,
    authors,
    journal: journal && journal !== 'N/A' ? journal : undefined,
    year: year ? Number(year) : undefined,
    bibcode: url ? bibcodeFromAdsUrl(url) : undefined
  }
}

export async function importLegacyRecords(
  lib: Library,
  source: string,
  records: LegacyRecord[],
  resolver?: Resolver
): Promise<LegacyImportReport> {
  const report: LegacyImportReport = { source, results: [], failures: [] }
  for (const r of records) {
    if (!existsSync(r.pdfPath)) {
      report.failures.push({ pdfPath: r.pdfPath, error: 'file not found' })
      continue
    }
    const hints: Identifier[] = r.bibcode
      ? [{ kind: 'bibcode', value: r.bibcode, origin: 'hint' }]
      : []
    const hasFallback = !!(r.fallback.title || r.fallback.authors.length)
    try {
      const result = await lib.importPdf(r.pdfPath, {
        resolver,
        hints,
        tags: r.tags,
        addedAt: r.addedAt,
        fallback: hasFallback
          ? { source: 'legacy', metadata: { ...r.fallback, bibcode: r.bibcode } }
          : undefined
      })
      report.results.push({ ...result, pdfPath: r.pdfPath })
    } catch (err) {
      report.failures.push({ pdfPath: r.pdfPath, error: (err as Error).message })
    }
  }
  return report
}

/** Every legacy library this machine is known to hold, in the order they were created. */
export function knownLegacyLocations(home: string): { kind: 'swift' | 'python'; path: string }[] {
  const candidates: { kind: 'swift' | 'python'; path: string }[] = [
    { kind: 'python', path: join(home, 'Downloads/PaperManager/db/papers.db') },
    { kind: 'python', path: join(home, 'Downloads/PaperManager_source/db/papers.db') },
    { kind: 'python', path: join(home, 'Downloads/PaperManager_Ubuntu2004/db/papers.db') },
    { kind: 'python', path: join(home, 'PaperManager/db/papers.db') },
    {
      kind: 'swift',
      path: join(home, 'Library/Containers/ifa.PaperManager/Data/Documents/PaperManagerPapers')
    },
    { kind: 'swift', path: join(home, 'Documents/PaperManagerPapers') }
  ]
  return candidates.filter((c) =>
    c.kind === 'swift' ? existsSync(join(c.path, 'papers.json')) : existsSync(c.path)
  )
}

function toIso(s: string): string | undefined {
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}
