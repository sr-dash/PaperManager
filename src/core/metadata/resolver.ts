import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Identifier, Metadata, MetadataSource, ResolvedMetadata } from '../types.js'
import { adsLookup } from './ads.js'
import { arxivLookup } from './arxiv.js'
import { crossrefLookup } from './crossref.js'
import type { Fetch } from './http.js'

export interface ResolveResult {
  resolved: ResolvedMetadata | null
  /** Network or API failures, as opposed to "no such record". Non-empty means retry later. */
  errors: string[]
}

export type Resolver = (ids: readonly Identifier[]) => Promise<ResolveResult>

export interface ResolverOptions {
  fetch?: Fetch
  adsToken?: string | undefined
}

/**
 * Try each identifier in order. ADS is authoritative for astronomy when a token
 * is available; Crossref (DOI) and arXiv are public fallbacks.
 */
export function createResolver({ fetch = globalThis.fetch, adsToken }: ResolverOptions): Resolver {
  return async (ids) => {
    const errors: string[] = []
    const attempt = async (source: MetadataSource, run: () => Promise<Metadata | null>) => {
      try {
        const metadata = await run()
        return metadata ? { source, metadata } : null
      } catch (err) {
        errors.push(`${source}: ${(err as Error).message}`)
        return null
      }
    }

    for (const id of ids) {
      if (adsToken) {
        const hit = await attempt('ads', () => adsLookup(fetch, adsToken, id))
        if (hit) return { resolved: hit, errors }
      }
      if (id.kind === 'doi') {
        const hit = await attempt('crossref', () => crossrefLookup(fetch, id.value))
        if (hit) return { resolved: hit, errors }
      }
      if (id.kind === 'arxiv') {
        const hit = await attempt('arxiv', () => arxivLookup(fetch, id.value))
        if (hit) return { resolved: hit, errors }
      }
    }
    return { resolved: null, errors }
  }
}

/** ADS token from `ADS_API_TOKEN`, else `~/.ads/dev_key`. */
export async function findAdsToken(env = process.env): Promise<string | undefined> {
  const fromEnv = env.ADS_API_TOKEN ?? env.ADS_DEV_KEY
  if (fromEnv?.trim()) return fromEnv.trim()
  try {
    const key = (await readFile(join(homedir(), '.ads', 'dev_key'), 'utf8')).trim()
    return key || undefined
  } catch {
    return undefined
  }
}
