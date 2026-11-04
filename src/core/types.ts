export interface Author {
  family: string
  given?: string | undefined
}

/** Bibliographic record as produced by a metadata source or entered by hand. */
export interface Metadata {
  title?: string | undefined
  authors: Author[]
  abstract?: string | undefined
  year?: number | undefined
  pubDate?: string | undefined
  journal?: string | undefined
  journalAbbrev?: string | undefined
  volume?: string | undefined
  issue?: string | undefined
  page?: string | undefined
  entryType?: string | undefined
  doi?: string | undefined
  arxivId?: string | undefined
  bibcode?: string | undefined
  bibtex?: string | undefined
}

export type MetadataSource = 'ads' | 'crossref' | 'arxiv' | 'legacy' | 'manual'

export interface ResolvedMetadata {
  source: MetadataSource
  metadata: Metadata
}

/**
 * `reference` is a citation read from a file name (`Parnell_2008_ApJ_675_1656`), encoded
 * as `family|year|journal|volume|page`. It and `title` are matched against ADS only, and
 * only accepted on a single, checked match.
 */
export type IdentifierKind = 'bibcode' | 'doi' | 'arxiv' | 'reference' | 'title'

export interface Identifier {
  kind: IdentifierKind
  value: string
  /** Where it was found; used for ranking and diagnostics. */
  origin: 'hint' | 'filename' | 'pdf-info' | 'first-page'
}

export interface PaperRow {
  id: number
  title: string | null
  year: number | null
  journal: string | null
  journal_abbrev: string | null
  volume: string | null
  page: string | null
  doi: string | null
  arxiv_id: string | null
  bibcode: string | null
  metadata_source: MetadataSource | null
  metadata_status: 'unresolved' | 'resolved' | 'manual'
  added_at: string
  updated_at: string
  reading: ReadingStatus | null
  starred: number
}

export interface PaperSummary extends PaperRow {
  first_author: string | null
  tags: string[]
  files: string[]
}

/** Flat row for list views; see `Library.listRows`. */
export interface PaperListRow {
  id: number
  title: string | null
  year: number | null
  journal: string | null
  journal_abbrev: string | null
  volume: string | null
  page: string | null
  doi: string | null
  bibcode: string | null
  arxiv_id: string | null
  metadata_status: PaperRow['metadata_status']
  metadata_source: MetadataSource | null
  added_at: string
  updated_at: string
  first_author: string | null
  author_count: number
  file_count: number
  tags: string[]
  has_note: boolean
  reading: ReadingStatus | null
  starred: boolean
  annotation_count: number
  /** Origin of the file the paper opens with (publisher before scans before e-prints). */
  pdf_origin: 'publisher' | 'arxiv' | 'ads-scan' | 'unknown' | null
}

export type ReadingStatus = 'to-read' | 'reading' | 'read'

/** A disagreement between the database and the files folder; see `Library.verify`. */
export type Issue =
  | { kind: 'missing-file'; relPath: string; paperId: number }
  | { kind: 'size-mismatch'; relPath: string; expected: number; actual: number }
  | { kind: 'hash-mismatch'; relPath: string }
  | { kind: 'untracked-file'; relPath: string }
  | { kind: 'missing-original'; relPath: string; sha256: string }

/** Triage verdict for a PDF in a watched folder; see `classify`. */
export type Verdict = 'paper' | 'maybe' | 'other'

/** What the inbox learns about a PDF: fingerprint and verdict, never its text. */
export interface Inspection {
  size: number
  mtimeMs: number
  sha256: string
  pages?: number | undefined
  verdict: Verdict
  score: number
  reasons: string[]
  identifiers: Identifier[]
  title?: string | undefined
}

export interface InboxItem extends Inspection {
  path: string
  name: string
  /** `filed`: these exact bytes are already in the library. */
  state: 'pending' | 'ignored' | 'filed'
  paperId?: number | undefined
  /** Other paths holding the same bytes (the same download saved twice, or in two folders). */
  copies: string[]
}
