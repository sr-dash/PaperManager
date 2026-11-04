import type { Metadata } from '../types.js'
import { getJson, HttpError, stripTags, type Fetch } from './http.js'

export interface CrossrefWork {
  DOI: string
  type?: string
  title?: string[]
  author?: { family?: string; given?: string; name?: string }[]
  'container-title'?: string[]
  'short-container-title'?: string[]
  volume?: string
  issue?: string
  page?: string
  'article-number'?: string
  abstract?: string
  published?: { 'date-parts'?: number[][] }
  issued?: { 'date-parts'?: number[][] }
}

export async function crossrefLookup(fetch: Fetch, doi: string): Promise<Metadata | null> {
  try {
    const url = `https://api.crossref.org/works/${encodeURIComponent(doi)}`
    const body = await getJson<{ message: CrossrefWork }>(fetch, url)
    return crossrefToMetadata(body.message)
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null
    throw err
  }
}

export function crossrefToMetadata(w: CrossrefWork): Metadata {
  const parts = (w.published ?? w.issued)?.['date-parts']?.[0]
  const year = parts?.[0]
  return {
    doi: w.DOI.toLowerCase(),
    title: w.title?.[0] && stripTags(w.title[0]),
    authors: (w.author ?? [])
      .map((a) => ({ family: a.family ?? a.name ?? '', given: a.given }))
      .filter((a) => a.family),
    abstract: w.abstract && stripTags(w.abstract),
    year,
    pubDate: parts?.map((n) => String(n).padStart(2, '0')).join('-'),
    journal: w['container-title']?.[0],
    journalAbbrev: w['short-container-title']?.[0],
    volume: w.volume,
    issue: w.issue,
    page: w.page?.split('-')[0] ?? w['article-number'],
    entryType: w.type === 'journal-article' ? 'article' : w.type
  }
}
