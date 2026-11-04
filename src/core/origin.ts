/**
 * Where a PDF came from: the journal's typeset version, an arXiv e-print, or ADS's scan
 * of an old article. It decides which file a paper opens by default, and lets the app
 * offer to swap arXiv versions for publisher ones.
 */
import { findDois } from './identifiers.js'

export type FileOrigin = 'publisher' | 'arxiv' | 'ads-scan' | 'unknown'

// arXiv stamps every PDF it generates in the left margin of page 1:
// "arXiv:2409.09000v2 [astro-ph.SR] 17 Sep 2024". Journals and authors never print
// that exact shape, so it identifies an arXiv-built PDF reliably.
const ARXIV_STAMP =
  /arXiv:\s*(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})v\d+\s*\[[a-z-]+(?:\.[A-Za-z-]+)?\]/

/** Best guess from the text of page 1 and the PDF's document info. */
export function detectOrigin(firstPage: string | undefined, info?: string): FileOrigin {
  const page = firstPage ?? ''
  if (ARXIV_STAMP.test(page)) return 'arxiv'
  if (findDois(page).length || (info && findDois(info).length)) return 'publisher'
  return 'unknown'
}

/** How a download source maps to an origin. */
export function originOfSource(source: string | undefined): FileOrigin | undefined {
  if (source === 'publisher') return 'publisher'
  if (source === 'arXiv') return 'arxiv'
  if (source === 'ADS scan') return 'ads-scan'
  return undefined
}

/** Which file a paper opens first: the journal version, then scans, then e-prints. */
export const ORIGIN_RANK: Record<FileOrigin, number> = {
  publisher: 0,
  'ads-scan': 1,
  unknown: 2,
  arxiv: 3
}

export const ORIGIN_LABEL: Record<FileOrigin, string> = {
  publisher: 'Publisher',
  arxiv: 'arXiv',
  'ads-scan': 'ADS scan',
  unknown: 'PDF'
}
