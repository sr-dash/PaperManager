import { sanitizeToken } from './naming.js'
import type { Metadata } from './types.js'

/**
 * BibTeX for a paper. The ADS export is used verbatim when present: its keys are
 * bibcodes, which is what AAS-journal manuscripts cite. Otherwise an entry is built
 * from the stored fields, keyed by the bibcode or `FamilyYear` + first title word.
 */
export function toBibtex(m: Metadata): string {
  if (m.bibtex?.trim()) return m.bibtex.trim()

  const fields: [string, string | undefined][] = [
    ['author', m.authors.map(formatAuthor).join(' and ') || undefined],
    ['title', m.title && `{${escapeTex(m.title)}}`],
    ['journal', m.journal && escapeTex(m.journal)],
    ['year', m.year?.toString()],
    ['volume', m.volume],
    ['number', m.issue],
    ['pages', m.page],
    ['doi', m.doi],
    ['eprint', m.arxivId],
    ['archivePrefix', m.arxivId ? 'arXiv' : undefined],
    ['adsurl', m.bibcode && `https://ui.adsabs.harvard.edu/abs/${m.bibcode}`]
  ]
  const body = fields
    .filter((f): f is [string, string] => !!f[1])
    .map(([k, v]) => `  ${k.padEnd(13)} = {${v}}`)
    .join(',\n')
  return `@${entryType(m)}{${citeKey(m)},\n${body}\n}`
}

export function citeKey(m: Metadata): string {
  if (m.bibcode) return m.bibcode
  const family = sanitizeToken(m.authors[0]?.family ?? 'Anon')
  const word = (m.title ?? '')
    .split(/\s+/)
    .map(sanitizeToken)
    .find((w) => w.length > 3 && !/^(the|and|with|from|into|using)$/i.test(w))
  return `${family}${m.year ?? ''}${word ?? ''}`
}

function entryType(m: Metadata): string {
  if (m.entryType === 'preprint' || (!m.journal && m.arxivId)) return 'misc'
  if (m.entryType === 'inproceedings' || m.entryType === 'abstract') return 'inproceedings'
  if (m.entryType === 'book') return 'book'
  return 'article'
}

function formatAuthor(a: { family: string; given?: string | undefined }): string {
  const family = /\s/.test(a.family) ? `{${a.family}}` : a.family
  return escapeTex(a.given ? `${family}, ${a.given}` : family)
}

function escapeTex(s: string): string {
  return s.replace(/([&%$#_])/g, '\\$1')
}
