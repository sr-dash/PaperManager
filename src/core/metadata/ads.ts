import { parseBibcode } from '../naming.js'
import { decodeReference } from '../identifiers.js'
import type { Identifier, Metadata } from '../types.js'
import { decodeEntities, getJson, splitName, type Fetch } from './http.js'

// Overridable so tests can point the app at a local stand-in for ADS.
export const ADS_API = process.env.PM_ADS_API ?? 'https://api.adsabs.harvard.edu/v1'
export const ADS_UI = process.env.PM_ADS_UI ?? 'https://ui.adsabs.harvard.edu'
const API = ADS_API
const FIELDS = [
  'bibcode',
  'title',
  'author',
  'year',
  'pubdate',
  'pub',
  'volume',
  'issue',
  'page',
  'doi',
  'identifier',
  'abstract',
  'doctype'
].join(',')

export interface AdsDoc {
  bibcode: string
  title?: string[]
  author?: string[]
  year?: string
  pubdate?: string
  pub?: string
  volume?: string
  issue?: string
  page?: string[]
  doi?: string[]
  identifier?: string[]
  abstract?: string
  doctype?: string
}

interface AdsSearchResponse {
  response: { numFound: number; docs: AdsDoc[] }
}

export function adsQuery(id: Identifier): string {
  switch (id.kind) {
    case 'bibcode':
      return `bibcode:"${id.value}"`
    case 'doi':
      return `doi:"${id.value}"`
    case 'arxiv':
      return `identifier:"arXiv:${id.value}"`
    case 'reference': {
      const r = decodeReference(id.value)
      // Letters are their own ADS journal: ApJ 541, L83 is bibstem ApJL.
      const bibstem = r.bibstem === 'ApJ' && r.page && /^L/i.test(r.page) ? 'ApJL' : r.bibstem
      const parts = [`year:${r.year}`]
      if (bibstem) parts.push(`bibstem:"${bibstem}"`)
      if (r.volume) parts.push(`volume:${r.volume}`)
      if (r.page) parts.push(`page:"${r.page}"`)
      // Volume and page pin the paper; the author is then checked, not queried, because
      // ADS matches multi-word family names poorly ("Hebbur Dayananda").
      if (!(r.volume && r.page)) parts.push(`author:"^${r.family}"`)
      return parts.join(' ')
    }
    case 'title': {
      // Word search, not a phrase: typographic quotes and dashes break ADS phrase matching.
      // Precision comes from the exact comparison in adsLookup.
      const words = normalizeTitle(id.value)
        .split(' ')
        .filter((w) => w.length > 2)
      return `title:(${words.join(' ')})`
    }
  }
}

export async function adsLookup(
  fetch: Fetch,
  token: string,
  id: Identifier
): Promise<Metadata | null> {
  const rows = id.kind === 'title' || id.kind === 'reference' ? '10' : '2'
  const params = new URLSearchParams({ q: adsQuery(id), fl: FIELDS, rows })
  const auth = { Authorization: `Bearer ${token}` }
  const body = await getJson<AdsSearchResponse>(fetch, `${API}/search/query?${params}`, auth)
  let docs = body.response.docs
  if (id.kind === 'reference') {
    const want = squash(decodeReference(id.value).family)
    docs = docs.filter((d) => squash(splitName(d.author?.[0] ?? '').family).startsWith(want))
  }
  if (id.kind === 'title') {
    const want = normalizeTitle(id.value)
    docs = docs.filter((d) => normalizeTitle(decodeEntities(d.title?.[0] ?? '')) === want)
  }
  // Ambiguous matches are left for manual review rather than guessed at.
  if (docs.length !== 1) return null
  const meta = adsDocToMetadata(docs[0]!)
  meta.bibtex = await adsBibtex(fetch, token, meta.bibcode!).catch(() => undefined)
  return meta
}

async function adsBibtex(fetch: Fetch, token: string, bibcode: string): Promise<string> {
  const body = await getJson<{ export: string }>(
    fetch,
    `${API}/export/bibtex`,
    { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    { method: 'POST', body: JSON.stringify({ bibcode: [bibcode] }) }
  )
  return body.export.trim()
}

/** Family names compared loosely: no case, accents, spaces or punctuation. */
function squash(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z]/g, '')
    .toLowerCase()
}

export function normalizeTitle(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[’'`]s\b/gi, '') // possessives: ADS indexes "Sun’s" as "sun"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function adsDocToMetadata(doc: AdsDoc): Metadata {
  const bib = parseBibcode(doc.bibcode)
  const arxiv = doc.identifier
    ?.map((x) => /^arXiv:(.+)$/i.exec(x)?.[1])
    .find((x): x is string => !!x)
  const year = Number(doc.year ?? bib.year)
  return {
    bibcode: doc.bibcode,
    title: doc.title?.[0] && decodeEntities(doc.title[0]),
    authors: (doc.author ?? []).map(splitName),
    abstract: doc.abstract && decodeEntities(doc.abstract),
    year: Number.isFinite(year) ? year : undefined,
    pubDate: doc.pubdate,
    journal: doc.pub,
    journalAbbrev: bib.journal,
    volume: doc.volume,
    issue: doc.issue,
    page: doc.page?.[0],
    doi: doc.doi?.[0]?.toLowerCase(),
    arxivId: arxiv,
    entryType: doc.doctype
  }
}

/** One row of an ADS result list: enough to show it and to add it later. */
export interface AdsListItem {
  bibcode: string
  title?: string | undefined
  authors: string[]
  year?: number | undefined
  pub?: string | undefined
  doi?: string | undefined
  arxivId?: string | undefined
  refereed: boolean
}

interface AdsListDoc {
  bibcode: string
  title?: string[]
  author?: string[]
  year?: string
  pub?: string
  doi?: string[]
  identifier?: string[]
  property?: string[]
}

/** Run an ADS query and return a short list, newest first unless `sort` says otherwise. */
export async function adsList(
  fetch: Fetch,
  token: string,
  q: string,
  opts: { rows?: number; sort?: string } = {}
): Promise<AdsListItem[]> {
  const params = new URLSearchParams({
    q,
    fl: 'bibcode,title,author,year,pub,doi,identifier,property',
    rows: String(opts.rows ?? 50),
    sort: opts.sort ?? 'date desc'
  })
  const body = await getJson<{ response: { docs: AdsListDoc[] } }>(
    fetch,
    `${API}/search/query?${params}`,
    { Authorization: `Bearer ${token}` }
  )
  return body.response.docs.map((d) => ({
    bibcode: d.bibcode,
    title: d.title?.[0] && decodeEntities(d.title[0]),
    authors: (d.author ?? []).slice(0, 4),
    year: d.year ? Number(d.year) : undefined,
    pub: d.pub,
    doi: d.doi?.[0]?.toLowerCase(),
    arxivId: d.identifier?.map((x) => /^arXiv:(.+)$/i.exec(x)?.[1]).find((x): x is string => !!x),
    refereed: d.property?.includes('REFEREED') ?? false
  }))
}
