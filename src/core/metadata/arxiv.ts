import type { Metadata } from '../types.js'
import { decodeEntities, getText, splitName, type Fetch } from './http.js'

export async function arxivLookup(fetch: Fetch, arxivId: string): Promise<Metadata | null> {
  const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`
  return parseArxivAtom(await getText(fetch, url))
}

/** Parse the single `<entry>` of an arXiv Atom response. The feed format is small and stable. */
export function parseArxivAtom(xml: string): Metadata | null {
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(xml)?.[1]
  if (!entry) return null
  const tag = (name: string) => {
    const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry)?.[1]
    return m === undefined ? undefined : decodeEntities(m).replace(/\s+/g, ' ').trim()
  }
  const idUrl = tag('id')
  const arxivId = idUrl && /abs\/(.+?)(?:v\d+)?$/.exec(idUrl)?.[1]
  // arXiv answers unknown ids with an entry titled "Error".
  if (!arxivId || tag('title') === 'Error') return null

  const published = tag('published')
  const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g)].map((m) =>
    splitName(decodeEntities(m[1]!))
  )
  return {
    arxivId,
    title: tag('title'),
    abstract: tag('summary'),
    authors,
    year: published ? Number(published.slice(0, 4)) : undefined,
    pubDate: published?.slice(0, 10),
    doi: tag('arxiv:doi')?.toLowerCase(),
    entryType: 'preprint'
  }
}
