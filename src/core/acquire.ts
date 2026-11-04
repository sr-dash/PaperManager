/**
 * Adding a paper by identifier: paste a DOI, arXiv id, bibcode or ADS/arXiv/DOI link,
 * get the record and (when it can be had) the PDF.
 */
import { downloadPdf } from './fulltext.js'
import { originOfSource } from './origin.js'
import { bibcodeFromAdsUrl, isBibcode, normalizeDoi } from './identifiers.js'
import type { Library } from './library.js'
import type { Fetch } from './metadata/http.js'
import type { Resolver } from './metadata/resolver.js'
import type { Identifier } from './types.js'

/** Recognise what the user pasted. Returns undefined when it is none of the known forms. */
export function parseIdentifierInput(input: string): Identifier | undefined {
  const s = input.trim()
  if (!s) return undefined
  const origin = 'hint' as const
  const bib = bibcodeFromAdsUrl(s)
  if (bib) return { kind: 'bibcode', value: bib, origin }
  const decoded = safeDecode(s)
  if (isBibcode(decoded)) return { kind: 'bibcode', value: decoded, origin }
  const arxivUrl = /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:v\d+)?(?:\.pdf)?(?:[?#].*)?$/i.exec(s)
  if (arxivUrl) return { kind: 'arxiv', value: arxivUrl[1]!, origin }
  const arxiv = /^(?:arxiv:\s*)?(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?$/i.exec(s)
  if (arxiv) return { kind: 'arxiv', value: arxiv[1]!, origin }
  const doi = /(?:doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+)/i.exec(s)
  if (doi) return { kind: 'doi', value: normalizeDoi(doi[1]!), origin }
  return undefined
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export interface AddOutcome {
  status: 'added' | 'added-without-pdf' | 'exists'
  paperId: number
  /** Where the PDF came from, when one was fetched. */
  pdfSource?: string | undefined
  notes: string[]
}

export async function addByIdentifier(
  lib: Library,
  id: Identifier,
  opts: { resolver: Resolver; fetch?: Fetch; tags?: string[] }
): Promise<AddOutcome> {
  const fetch = opts.fetch ?? globalThis.fetch
  const { resolved, errors } = await opts.resolver([id])
  if (!resolved) {
    throw new Error(
      errors.length ? `Lookup failed: ${errors[0]}` : 'No record found for this identifier'
    )
  }
  const existing = lib.findByIds(resolved.metadata)
  if (existing !== undefined) {
    if (opts.tags?.length) lib.addTags(existing, opts.tags)
    // Already here, perhaps without a PDF: try to fill that gap.
    if (lib.filesOf(existing).length === 0) {
      const got = await fetchPdfFor(lib, existing, { fetch })
      return { status: 'exists', paperId: existing, pdfSource: got.source, notes: got.notes }
    }
    return { status: 'exists', paperId: existing, notes: [] }
  }

  const notes: string[] = []
  const dl = await downloadPdf(resolved.metadata, fetch, (m) => notes.push(m))
  if (!dl) {
    const paperId = lib.createPaper(resolved, { tags: opts.tags })
    return { status: 'added-without-pdf', paperId, notes }
  }
  try {
    const r = await lib.importPdf(dl.path, {
      resolved,
      tags: opts.tags,
      origin: originOfSource(dl.source)
    })
    return { status: 'added', paperId: r.paperId, pdfSource: dl.source, notes }
  } finally {
    await dl.cleanup()
  }
}

/**
 * Fetch and attach a PDF for a paper already in the library. With `only: 'publisher'`
 * just the journal's copy is tried (it downloads when your network has access, as on a
 * university network). With `replacePreprints`, a publisher PDF that arrives takes the
 * place of the paper's arXiv PDFs.
 */
export async function fetchPdfFor(
  lib: Library,
  paperId: number,
  opts: {
    fetch?: Fetch
    only?: 'publisher'
    replacePreprints?: (absPath: string) => Promise<void>
  } = {}
): Promise<{ source?: string | undefined; notes: string[]; replaced?: string[] | undefined }> {
  const notes: string[] = []
  const meta = lib.metadataOf(paperId)
  const dl = await downloadPdf(
    meta,
    opts.fetch ?? globalThis.fetch,
    (m) => notes.push(m),
    opts.only
  )
  if (!dl) return { notes }
  try {
    const r = await lib.importPdf(dl.path, {
      attachTo: paperId,
      origin: originOfSource(dl.source),
      replacePreprints: opts.replacePreprints,
      refreshText: true
    })
    if (r.status === 'duplicate') notes.push('that PDF was already attached')
    return { source: dl.source, notes, replaced: r.replaced }
  } finally {
    await dl.cleanup()
  }
}
