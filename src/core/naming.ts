import type { Metadata } from './types.js'

export interface BibcodeParts {
  year: number
  journal: string
  volume?: string | undefined
  qualifier?: string | undefined
  page?: string | undefined
}

/** Split an ADS bibcode (`2024ApJ...975..288D`) into its fixed-width fields. */
export function parseBibcode(bibcode: string): BibcodeParts {
  const dots = (s: string) => s.replace(/\./g, '')
  return {
    year: Number(bibcode.slice(0, 4)),
    journal: dots(bibcode.slice(4, 9)),
    volume: dots(bibcode.slice(9, 13)) || undefined,
    qualifier: dots(bibcode.slice(13, 14)) || undefined,
    page: dots(bibcode.slice(14, 18)) || undefined
  }
}

/** Reduce arbitrary text to a filesystem-safe ASCII token: `Hoeksema`, `AA`, `L18`. */
export function sanitizeToken(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, '')
    .replace(/^-+|-+$/g, '')
}

/**
 * The library's naming convention, matching how the files were named by hand:
 * `Family_Year_Journal_Volume_Page`, e.g. `Dash_2024_ApJ_975_288`.
 * Missing parts are dropped rather than replaced with placeholders.
 */
export function canonicalStem(meta: Metadata): string | undefined {
  const bib = meta.bibcode ? parseBibcode(meta.bibcode) : undefined
  const family = meta.authors[0]?.family
  const year = meta.year ?? bib?.year
  const journal = meta.journalAbbrev ?? bib?.journal ?? (meta.arxivId ? 'arXiv' : undefined)
  const volume = meta.volume ?? bib?.volume
  let page = meta.page ?? bib?.page
  if (page && bib?.qualifier && !page.startsWith(bib.qualifier)) page = bib.qualifier + page
  const tail = meta.arxivId && !meta.volume && !bib?.volume ? meta.arxivId : undefined

  const parts = [family, year?.toString(), journal, volume, page]
    .map((p) => (p ? sanitizeToken(p) : ''))
    .filter(Boolean)
  // arXiv ids keep their dot: `2409.09000` reads better than `240909000`.
  if (!page && tail) parts.push(tail.replace(/[^A-Za-z0-9.-]+/g, ''))
  // An author and a year are the minimum for a name that means something.
  if (!family || !year || parts.length < 2) return undefined
  return truncate(parts.join('_'))
}

/**
 * The short tag a paper gets automatically, matching the habit in the older libraries:
 * first author's family name and two-digit year, e.g. `Schad24`, `Dash24`, `Lekshmi25`.
 */
export function citeTag(meta: Metadata): string | undefined {
  const family = meta.authors[0]?.family
  const year = meta.year ?? (meta.bibcode ? parseBibcode(meta.bibcode).year : undefined)
  if (!family || !year) return undefined
  const name = sanitizeToken(family.replace(/\s+/g, ''))
  return name ? `${name}${String(year % 100).padStart(2, '0')}` : undefined
}

/** Fallback when no metadata is available: keep the original name, made safe. */
export function fallbackStem(originalName: string): string {
  const stem = originalName.replace(/\.pdf$/i, '')
  const safe = stem
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
  return truncate(safe || 'untitled')
}

/** Pick `stem.pdf`, or `stem-b.pdf`, `stem-c.pdf`… when taken (mirrors 2024a/2024b citations). */
export function uniqueFilename(stem: string, taken: (name: string) => boolean): string {
  if (!taken(`${stem}.pdf`)) return `${stem}.pdf`
  for (let i = 1; ; i++) {
    const name = `${stem}-${suffix(i)}.pdf`
    if (!taken(name)) return name
  }
}

function suffix(i: number): string {
  // 1 → b, 2 → c, … 25 → z, 26 → ba …
  let n = i
  let s = ''
  do {
    s = String.fromCharCode(97 + (n % 26)) + s
    n = Math.floor(n / 26)
  } while (n > 0)
  return s
}

function truncate(s: string): string {
  return s.length > 120 ? s.slice(0, 120) : s
}
