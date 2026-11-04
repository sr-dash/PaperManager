/**
 * A small local stand-in for the ADS API and link gateway, so end-to-end tests exercise
 * the real network code paths without touching the real service.
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeDoc {
  bibcode: string
  title?: string[]
  author?: string[]
  year?: string
  pub?: string
  volume?: string
  page?: string[]
  doi?: string[]
  identifier?: string[]
  property?: string[]
  abstract?: string
}

export interface FakeAds {
  url: string
  queries: string[]
  close: () => Promise<void>
}

export async function startFakeAds(opts: {
  search: (q: string) => FakeDoc[]
  pdfs: Record<string, Buffer>
}): Promise<FakeAds> {
  const queries: string[] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/v1/search/query') {
      const q = url.searchParams.get('q') ?? ''
      queries.push(q)
      const docs = opts.search(q)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ response: { numFound: docs.length, docs } }))
      return
    }
    if (url.pathname === '/v1/export/bibtex') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ export: '' }))
      return
    }
    const gw = /^\/link_gateway\/([^/]+)\/(\w+)$/.exec(url.pathname)
    if (gw) {
      const bibcode = decodeURIComponent(gw[1]!)
      if (gw[2] === 'PUB_PDF') {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html>Please sign in</html>')
        return
      }
      const pdf = gw[2] === 'EPRINT_PDF' ? opts.pdfs[bibcode] : undefined
      if (pdf) {
        res.writeHead(200, { 'Content-Type': 'application/pdf' })
        res.end(pdf)
        return
      }
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    queries,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}
