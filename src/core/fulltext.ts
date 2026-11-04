/**
 * Getting the PDF for a paper known only by its metadata. Candidates, best first:
 * the publisher's PDF and the arXiv e-print through ADS's link gateway, then ADS's own
 * scans (which is how most papers from before ~1997 are available), then arXiv directly.
 * A candidate only counts if what comes back is really a PDF: publishers often answer
 * with a login page instead.
 */
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ADS_UI } from './metadata/ads.js'
import { USER_AGENT, type Fetch } from './metadata/http.js'
import { canonicalStem } from './naming.js'
import type { Metadata } from './types.js'

const MAX_BYTES = 200 * 1024 * 1024

export function pdfCandidates(m: Metadata): { source: string; url: string }[] {
  const out: { source: string; url: string }[] = []
  if (m.bibcode) {
    const gw = (kind: string) => `${ADS_UI}/link_gateway/${encodeURIComponent(m.bibcode!)}/${kind}`
    out.push({ source: 'publisher', url: gw('PUB_PDF') })
    out.push({ source: 'arXiv', url: gw('EPRINT_PDF') })
    out.push({ source: 'ADS scan', url: gw('ADS_PDF') })
  }
  if (m.arxivId) out.push({ source: 'arXiv', url: `https://arxiv.org/pdf/${m.arxivId}` })
  return out
}

export interface Download {
  /** Temporary file; call `cleanup` when done with it. */
  path: string
  source: string
  cleanup: () => Promise<void>
}

/** Try each candidate until one yields a real PDF. Returns null if none does. */
export async function downloadPdf(
  m: Metadata,
  fetch: Fetch,
  log: (msg: string) => void = () => {},
  only?: 'publisher'
): Promise<Download | null> {
  const dir = await mkdtemp(join(tmpdir(), 'pm-download-'))
  const path = join(dir, `${canonicalStem(m) ?? 'download'}.pdf`)
  const cleanup = () => rm(dir, { recursive: true, force: true })
  for (const c of pdfCandidates(m).filter((x) => !only || x.source === only)) {
    try {
      const res = await fetch(c.url, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/pdf,*/*;q=0.5' },
        redirect: 'follow',
        signal: AbortSignal.timeout(60_000)
      })
      if (!res.ok || !res.body) {
        log(`${c.source}: HTTP ${res.status}`)
        continue
      }
      const length = Number(res.headers.get('content-length') ?? 0)
      if (length > MAX_BYTES) {
        log(`${c.source}: too large`)
        continue
      }
      await pipeline(Readable.fromWeb(res.body as never), createWriteStream(path))
      if (await isPdf(path)) return { path, source: c.source, cleanup }
      log(`${c.source}: not a PDF (probably a login or landing page)`)
    } catch (err) {
      log(`${c.source}: ${(err as Error).message}`)
    }
  }
  await cleanup()
  return null
}

async function isPdf(path: string): Promise<boolean> {
  const { open } = await import('node:fs/promises')
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(1024)
    const { bytesRead } = await fh.read(buf, 0, 1024, 0)
    return buf.subarray(0, bytesRead).includes('%PDF-')
  } finally {
    await fh.close()
  }
}
