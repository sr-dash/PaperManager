import type { Identifier } from './types.js'

// DOI suffixes may contain almost anything; we stop at whitespace and quotes,
// then trim punctuation that is far more likely to be prose than part of the DOI.
const DOI_RE = /\b(10\.\d{4,9}\/[^\s"'<>]+)/gi
const TRAILING_JUNK_RE = /[.,;:)\]}>]+$/

// arXiv new-style (0704.0001 onward) and old-style (hep-th/9901001) identifiers.
const ARXIV_NEW_RE = /\barXiv:\s*(\d{4}\.\d{4,5})(?:v\d+)?\b/gi
const ARXIV_OLD_RE = /\barXiv:\s*([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?\b/gi
const ARXIV_FILENAME_RE = /^(\d{4}\.\d{4,5})(?:v\d+)?$/

// ADS bibcode: YYYY + journal(5) + volume(4) + qualifier(1) + page(4) + initial(1).
const BIBCODE_RE = /^\d{4}[A-Za-z&.]{5}[\dA-Za-z.]{4}[A-Za-z.][\d.A-Za-z]{4}[A-Z.]$/
const ADS_URL_RE = /adsabs\.harvard\.edu\/abs\/([^/?#\s]+)/i

export function normalizeDoi(raw: string): string {
  let doi = raw.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '')
  // Balanced trailing parens are part of some DOIs (e.g. Elsevier); only trim unbalanced ones.
  while (TRAILING_JUNK_RE.test(doi)) {
    const last = doi.at(-1)
    if (last === ')' && count(doi, '(') >= count(doi, ')')) break
    doi = doi.slice(0, -1)
  }
  return doi.toLowerCase()
}

export function isBibcode(s: string): boolean {
  return s.length === 19 && BIBCODE_RE.test(s)
}

export function bibcodeFromAdsUrl(url: string): string | undefined {
  const m = ADS_URL_RE.exec(url)
  let code: string | undefined
  try {
    code = m?.[1] && decodeURIComponent(m[1])
  } catch {
    return undefined // malformed percent-encoding
  }
  return code && isBibcode(code) ? code : undefined
}

export function findDois(text: string): string[] {
  return unique([...text.matchAll(DOI_RE)].map((m) => normalizeDoi(m[1]!)))
}

export function findArxivIds(text: string): string[] {
  const ids = [...text.matchAll(ARXIV_NEW_RE), ...text.matchAll(ARXIV_OLD_RE)].map((m) => m[1]!)
  return unique(ids)
}

/** " (1)" from browsers and "_1" from some sync tools; never part of an identifier. */
function stripCopySuffix(stem: string): string {
  return stem.replace(/(?: \(\d+\)|_\d)$/, '')
}

// Publisher download names that are a DOI suffix in disguise.
const DOI_FROM_NAME: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^(science|sciadv)\.([a-z]{2,4}\d{4})$/i, (m) => `10.1126/${m[1]}.${m[2]}`],
  [/^(annurev-[a-z]+-\d{6}-\d{6})$/i, (m) => `10.1146/${m[1]}`],
  [/^(s1\d{4}-\d{3}-\d{5}-[\dx])$/i, (m) => `10.1007/${m[1]}`], // Springer journals
  [/^(s41\d{3}-\d{3}-\d{5}-[\dx])$/i, (m) => `10.1038/${m[1]}`], // Nature journals
  [/^aa(\d{5})-(\d{2})$/i, (m) => `10.1051/0004-6361/20${m[2]}${m[1]}`] // A&A manuscripts
]

/** Identifiers encoded in a file's basename, e.g. `1910.08110.pdf` or `1987A&A...180..241S.pdf`. */
export function identifiersFromFilename(basename: string): Identifier[] {
  const raw = basename.replace(/\.pdf$/i, '')
  const stem = stripCopySuffix(raw)
  if (isBibcode(stem)) return [{ kind: 'bibcode', value: stem, origin: 'filename' }]
  const arxiv = ARXIV_FILENAME_RE.exec(stem)
  if (arxiv) return [{ kind: 'arxiv', value: arxiv[1]!, origin: 'filename' }]
  for (const [re, toDoi] of DOI_FROM_NAME) {
    const m = re.exec(stem)
    if (m) return [{ kind: 'doi', value: toDoi(m).toLowerCase(), origin: 'filename' }]
  }
  return []
}

// File names people give papers:
//   Family_Year_Journal_Volume_Page   Parnell_2008_ApJ_675_1656, Lin_2000_ApJ_541_L83
//   Family_Year_Journal / FamilyYearJournal   Hagenaar_2008_ApJ, Parnell2002MNRAS, Isik_2018AA
const REF_FULL =
  /^([A-Za-z][A-Za-z'-]*(?:_[A-Z][A-Za-z'-]+)?)_((?:18|19|20)\d{2})_([A-Za-z&]+)_(\d+)_([A-Za-z]?\d+)(?:-\d)?$/
const REF_SHORT = /^([A-Za-z][A-Za-z'-]*)_?((?:18|19|20)\d{2})_?([A-Za-z&]{2,})$/

// Common hand-written journal abbreviations → ADS bibstems.
const BIBSTEMS: Record<string, string> = {
  apj: 'ApJ',
  apjl: 'ApJL',
  apjs: 'ApJS',
  aj: 'AJ',
  aa: 'A&A',
  'a&a': 'A&A',
  aanda: 'A&A',
  mnras: 'MNRAS',
  solphy: 'SoPh',
  soph: 'SoPh',
  jgr: 'JGRA',
  jgra: 'JGRA',
  grl: 'GeoRL',
  georl: 'GeoRL',
  natcomm: 'NatCo',
  natco: 'NatCo',
  natas: 'NatAs',
  natastron: 'NatAs',
  nature: 'Natur',
  natur: 'Natur',
  sci: 'Sci',
  science: 'Sci',
  sciadv: 'SciA',
  scia: 'SciA',
  ssrv: 'SSRv',
  ssr: 'SSRv',
  lrsp: 'LRSP',
  araa: 'ARA&A',
  phrvl: 'PhRvL',
  prl: 'PhRvL',
  frass: 'FrASS',
  apss: 'Ap&SS',
  pasj: 'PASJ',
  pasp: 'PASP'
}

export interface Reference {
  family: string
  year: number
  bibstem?: string | undefined
  volume?: string | undefined
  page?: string | undefined
}

export function referenceFromFilename(basename: string): Reference | undefined {
  const stem = stripCopySuffix(basename.replace(/\.pdf$/i, ''))
  const full = REF_FULL.exec(stem)
  const m = full ?? REF_SHORT.exec(stem)
  if (!m) return undefined
  const journal = m[3]!
  const bibstem = BIBSTEMS[journal.toLowerCase()]
  // A short name must end in a journal we recognise, or "Yeates_2009_draft" would count.
  if (!full && !bibstem) return undefined
  return {
    family: m[1]!.replace(/_/g, ' '),
    year: Number(m[2]),
    bibstem: bibstem ?? journal,
    volume: full ? m[4] : undefined,
    page: full ? m[5] : undefined
  }
}

export function encodeReference(r: Reference): string {
  return [r.family, r.year, r.bibstem ?? '', r.volume ?? '', r.page ?? ''].join('|')
}

export function decodeReference(value: string): Reference {
  const [family = '', year = '', bibstem, volume, page] = value.split('|')
  return {
    family,
    year: Number(year),
    bibstem: bibstem || undefined,
    volume: volume || undefined,
    page: page || undefined
  }
}

export interface ExtractionInput {
  filename: string
  /** Concatenated PDF document-info strings (Title, Subject, Keywords, XMP). */
  pdfInfo?: string
  /** Text of the first page only. Later pages hold reference lists full of other papers' DOIs. */
  firstPage?: string
  hints?: Identifier[]
  /** The PDF's own Title field; tried last, and only if it looks like a real title. */
  infoTitle?: string | undefined
}

/**
 * Candidate identifiers for a paper, most trustworthy first.
 * Callers try them in order and stop at the first that resolves.
 */
export function extractIdentifiers(input: ExtractionInput): Identifier[] {
  const out: Identifier[] = [...(input.hints ?? [])]
  out.push(...identifiersFromFilename(input.filename))
  if (input.pdfInfo) {
    out.push(...findDois(input.pdfInfo).map((value) => id('doi', value, 'pdf-info')))
    out.push(...findArxivIds(input.pdfInfo).map((value) => id('arxiv', value, 'pdf-info')))
  }
  if (input.firstPage) {
    out.push(...findDois(input.firstPage).map((value) => id('doi', value, 'first-page')))
    out.push(...findArxivIds(input.firstPage).map((value) => id('arxiv', value, 'first-page')))
  }
  // A citation in the file name ranks below identifiers printed in the PDF itself.
  const ref = referenceFromFilename(input.filename)
  if (ref) out.push(id('reference', encodeReference(ref), 'filename'))
  const title = plausibleTitle(input.infoTitle)
  if (title) out.push(id('title', title, 'pdf-info'))
  const seen = new Set<string>()
  return out.filter((x) => {
    const key = `${x.kind}:${x.value.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * A PDF Title field worth trusting: several words, not a file name or a word-processor
 * placeholder. Journals set it properly; LaTeX and Word output often does not.
 */
export function plausibleTitle(title: string | undefined): string | undefined {
  const t = title?.replace(/\s+/g, ' ').trim()
  if (!t || t.length < 12 || t.split(' ').length < 3) return undefined
  if (/^(untitled|microsoft word|document\d*|main|arxiv)\b/i.test(t)) return undefined
  if (/\.(tex|dvi|docx?|pdf)$/i.test(t)) return undefined
  return t
}

function id(kind: Identifier['kind'], value: string, origin: Identifier['origin']): Identifier {
  return { kind, value, origin }
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)]
}

function count(s: string, ch: string): number {
  return s.split(ch).length - 1
}
