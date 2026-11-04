import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addByIdentifier, fetchPdfFor, parseIdentifierInput } from '../src/core/acquire.js'
import {
  annotationsToMarkdown,
  indexFileAnnotations,
  listAnnotations,
  staleAnnotationFiles
} from '../src/core/annotations.js'
import { backupDatabase, backupIfDue, listBackups, syncFolderWarning } from '../src/core/backup.js'
import {
  addToCollection,
  collectionPaperIds,
  collectionsOf,
  createCollection,
  listCollections
} from '../src/core/collections.js'
import {
  createWatch,
  findPublishedVersions,
  listWatches,
  related,
  runWatch,
  setHitState,
  watchHits
} from '../src/core/discover.js'
import {
  analyzeManuscript,
  extractCiteKeys,
  parseBib,
  rekey,
  writeManuscriptBib
} from '../src/core/manuscript.js'
import type { Fetch } from '../src/core/metadata/http.js'
import { createResolver } from '../src/core/metadata/resolver.js'
import { readPdfAnnotations } from '../src/core/pdf.js'
import { parseQuery, runQuery } from '../src/core/query.js'
import type { ResolvedMetadata } from '../src/core/types.js'
import { DASH_2024, makePdf, sandbox, type Sandbox } from './helpers.js'

let sb: Sandbox
beforeEach(() => {
  sb = sandbox()
})
afterEach(() => sb.cleanup())

const meta = (over: Partial<ResolvedMetadata['metadata']>): ResolvedMetadata => ({
  source: 'ads',
  metadata: { authors: [{ family: 'Doe' }], year: 2020, ...over }
})

// ── A stand-in for ADS ──────────────────────────────────────────────────────

interface FakeDoc {
  bibcode: string
  title?: string[]
  author?: string[]
  year?: string
  pub?: string
  doi?: string[]
  identifier?: string[]
  property?: string[]
  volume?: string
  page?: string[]
}

function fakeAds(opts: {
  search: (q: string) => FakeDoc[]
  pdf?: Record<string, Buffer | 'login'>
}): { fetch: Fetch; urls: string[] } {
  const urls: string[] = []
  const fetch: Fetch = async (input) => {
    const url = new URL(String(input))
    urls.push(url.toString())
    if (url.pathname.endsWith('/search/query')) {
      const docs = opts.search(url.searchParams.get('q')!)
      return Response.json({ response: { numFound: docs.length, docs } })
    }
    if (url.pathname.endsWith('/export/bibtex')) return Response.json({ export: '' })
    const kind = url.pathname.split('/').pop()!
    const body = opts.pdf?.[kind]
    if (body === 'login') return new Response('<html>Sign in</html>', { status: 200 })
    if (body) return new Response(new Uint8Array(body), { status: 200 })
    return new Response('not found', { status: 404 })
  }
  return { fetch, urls }
}

const DASH_DOC: FakeDoc = {
  bibcode: '2024ApJ...975..288D',
  title: ['Ensemble Kalman Filter Data Assimilation'],
  author: ['Dash, Soumyaranjan', 'DeRosa, Marc L.'],
  year: '2024',
  pub: 'The Astrophysical Journal',
  volume: '975',
  page: ['288'],
  doi: ['10.3847/1538-4357/ad7d0f'],
  identifier: ['arXiv:2409.09000'],
  property: ['REFEREED']
}

// ── 3. Query language, reading status, collections ──────────────────────────

describe('query language', () => {
  it('parses filters, quoted values and leftover words', () => {
    expect(
      parseQuery('tag:CryoNIRSP -tag:draft year:>2020 author:"Trujillo Bueno" coronal is:starred')
    ).toMatchObject({
      words: 'coronal',
      tags: ['CryoNIRSP'],
      notTags: ['draft'],
      yearMin: 2021,
      authors: ['Trujillo Bueno'],
      is: ['starred']
    })
    expect(parseQuery('year:2019-2021')).toMatchObject({ yearMin: 2019, yearMax: 2021 })
    expect(parseQuery('foo:bar')).toMatchObject({ words: 'foo:bar' })
  })

  it('combines full text with filters on tags, years, authors, status and stars', () => {
    const a = sb.lib.createPaper(
      meta({
        title: 'Coronal loops',
        year: 2019,
        bibcode: '2019ApJ...800....1A',
        authors: [{ family: 'Alpha' }]
      }),
      { tags: ['corona'] }
    )
    const b = sb.lib.createPaper(
      meta({ title: 'Coronal rain', year: 2023, doi: '10.1/b', authors: [{ family: 'Beta' }] }),
      { tags: ['corona'] }
    )
    const c = sb.lib.createPaper(
      meta({ title: 'Dynamo waves', year: 2023, doi: '10.1/c', authors: [{ family: 'Gamma' }] })
    )
    sb.lib.setStarred(b, true)
    sb.lib.setReading(c, 'to-read')

    const ids = (q: string) =>
      runQuery(sb.lib, q)
        .map((h) => h.id)
        .sort()
    expect(ids('coronal')).toEqual([a, b].sort())
    expect(ids('tag:corona year:>2020')).toEqual([b])
    expect(ids('-tag:corona')).toEqual([c])
    expect(ids('author:alp')).toEqual([a])
    expect(ids('journal:ApJ')).toEqual([a])
    expect(ids('is:starred')).toEqual([b])
    expect(ids('status:to-read')).toEqual([c])
    expect(ids('status:unread').length).toBe(3)
    expect(ids('is:nopdf').length).toBe(3)
    expect(runQuery(sb.lib, 'coronal')[0]?.snippet).toContain('[')
  })

  it('keeps manual and smart collections', () => {
    const a = sb.lib.createPaper(meta({ title: 'One', doi: '10.1/1' }), { tags: ['x'] })
    const b = sb.lib.createPaper(meta({ title: 'Two', doi: '10.1/2' }))
    const manual = createCollection(sb.lib, 'Eclipse review')
    addToCollection(sb.lib, manual, [b, b])
    const smart = createCollection(sb.lib, 'Tagged x', 'tag:x')
    expect(listCollections(sb.lib)).toEqual([
      { id: manual, name: 'Eclipse review', query: null, count: 1 },
      { id: smart, name: 'Tagged x', query: 'tag:x', count: 1 }
    ])
    expect(collectionPaperIds(sb.lib, smart)).toEqual([a])
    expect(collectionsOf(sb.lib, b)).toEqual([{ id: manual, name: 'Eclipse review' }])
    expect(runQuery(sb.lib, 'collection:"eclipse review"').map((h) => h.id)).toEqual([b])
    expect(() => createCollection(sb.lib, 'eclipse REVIEW')).toThrow(/already/)
    expect(() => addToCollection(sb.lib, smart, [b])).toThrow(/smart/)
  })

  it('lists reading status and stars on rows', () => {
    const a = sb.lib.createPaper(meta({ title: 'One', doi: '10.1/1' }))
    sb.lib.setReading(a, 'reading')
    sb.lib.setStarred(a, true)
    expect(sb.lib.listRows()[0]).toMatchObject({ reading: 'reading', starred: true, file_count: 0 })
  })
})

// ── 2. Adding by identifier, fetching PDFs ─────────────────────────────────

describe('adding by identifier', () => {
  it('recognises the forms people paste', () => {
    const p = parseIdentifierInput
    expect(p('https://ui.adsabs.harvard.edu/abs/2024ApJ...975..288D/abstract')).toMatchObject({
      kind: 'bibcode',
      value: '2024ApJ...975..288D'
    })
    expect(p('2024ApJ...975..288D')).toMatchObject({ kind: 'bibcode' })
    expect(p('1987A%26A...180..241S')).toMatchObject({
      kind: 'bibcode',
      value: '1987A&A...180..241S'
    })
    expect(p('https://arxiv.org/abs/2409.09000v2')).toMatchObject({
      kind: 'arxiv',
      value: '2409.09000'
    })
    expect(p('https://arxiv.org/pdf/2409.09000.pdf')).toMatchObject({
      kind: 'arxiv',
      value: '2409.09000'
    })
    expect(p('arXiv:2409.09000')).toMatchObject({ kind: 'arxiv', value: '2409.09000' })
    expect(p('https://doi.org/10.3847/1538-4357/AD7D0F')).toMatchObject({
      kind: 'doi',
      value: '10.3847/1538-4357/ad7d0f'
    })
    expect(p('10.1126/science.ado2993')).toMatchObject({ kind: 'doi' })
    expect(p('coronal loops')).toBeUndefined()
  })

  it('downloads the first real PDF, skipping a publisher login page', async () => {
    const { fetch, urls } = fakeAds({
      search: () => [DASH_DOC],
      pdf: { PUB_PDF: 'login', EPRINT_PDF: makePdf([['Preprint of the paper']]) }
    })
    const resolver = createResolver({ fetch, adsToken: 't' })
    const out = await addByIdentifier(
      sb.lib,
      { kind: 'bibcode', value: DASH_DOC.bibcode, origin: 'hint' },
      { resolver, fetch, tags: ['new'] }
    )
    expect(out).toMatchObject({ status: 'added', pdfSource: 'arXiv' })
    expect(out.notes).toEqual(['publisher: not a PDF (probably a login or landing page)'])
    expect(sb.lib.summary(out.paperId)).toMatchObject({
      bibcode: DASH_DOC.bibcode,
      files: ['files/Dash_2024_ApJ_975_288.pdf'],
      tags: ['Dash24', 'new']
    })
    expect(urls.filter((u) => u.includes('link_gateway'))).toHaveLength(2)
  })

  it('adds the record alone when no PDF can be had, and attaches one later', async () => {
    const noPdf = fakeAds({ search: () => [DASH_DOC] })
    const resolver = createResolver({ fetch: noPdf.fetch, adsToken: 't' })
    const out = await addByIdentifier(
      sb.lib,
      { kind: 'doi', value: '10.3847/1538-4357/ad7d0f', origin: 'hint' },
      { resolver, fetch: noPdf.fetch }
    )
    expect(out.status).toBe('added-without-pdf')
    expect(sb.lib.filesOf(out.paperId)).toEqual([])
    expect(await sb.lib.verify()).toEqual([])

    const withPdf = fakeAds({
      search: () => [DASH_DOC],
      pdf: { ADS_PDF: makePdf([['Scanned article']]) }
    })
    const got = await fetchPdfFor(sb.lib, out.paperId, { fetch: withPdf.fetch })
    expect(got.source).toBe('ADS scan')
    expect(sb.lib.summary(out.paperId).files).toEqual(['files/Dash_2024_ApJ_975_288.pdf'])

    const again = await addByIdentifier(
      sb.lib,
      { kind: 'bibcode', value: DASH_DOC.bibcode, origin: 'hint' },
      { resolver, fetch: noPdf.fetch }
    )
    expect(again).toMatchObject({ status: 'exists', paperId: out.paperId })
  })

  it('attaches a chosen PDF to a chosen paper whatever it contains', async () => {
    const id = sb.lib.createPaper(DASH_2024)
    const r = await sb.lib.importPdf(sb.pdf('unrelated-name.pdf', [['no identifiers']]), {
      attachTo: id
    })
    expect(r).toMatchObject({
      status: 'attached',
      paperId: id,
      relPath: 'files/Dash_2024_ApJ_975_288.pdf'
    })
  })
})

// ── 5–6. ADS discovery ──────────────────────────────────────────────────────

describe('discovery', () => {
  const cited: FakeDoc = {
    bibcode: '1961ApJ...133..572B',
    title: ['The Topology of the Sun’s Magnetic Field'],
    author: ['Babcock, H. W.'],
    year: '1961'
  }
  const citing: FakeDoc = {
    bibcode: '2025SoPh..300....1X',
    title: ['A new study'],
    author: ['Xu, A.'],
    year: '2025',
    property: ['REFEREED']
  }

  it('lists references and citations, marking papers already in the library', async () => {
    const paper = sb.lib.createPaper(DASH_2024)
    const have = sb.lib.createPaper(meta({ bibcode: cited.bibcode, title: 'Babcock' }))
    const { fetch, urls } = fakeAds({
      search: (q) => (q.startsWith('references') ? [cited] : [citing])
    })
    const refs = await related(sb.lib, paper, 'references', { fetch, token: 't' })
    expect(refs).toMatchObject([{ bibcode: cited.bibcode, paperId: have }])
    const cites = await related(sb.lib, paper, 'citations', { fetch, token: 't' })
    expect(cites).toMatchObject([{ bibcode: citing.bibcode, paperId: undefined }])
    expect(decodeURIComponent(urls[0]!)).toContain('references(bibcode:"2024ApJ...975..288D")')
  })

  it('collects new watch results, skipping library papers and anything dismissed', async () => {
    sb.lib.createPaper(meta({ bibcode: cited.bibcode }))
    let results = [cited, citing]
    const { fetch } = fakeAds({ search: () => results })
    const w = createWatch(
      sb.lib,
      'Citing my EnKF paper',
      'citations(bibcode:"2024ApJ...975..288D")'
    )
    expect(await runWatch(sb.lib, w, { fetch, token: 't' })).toBe(1)
    expect(watchHits(sb.lib).map((h) => h.bibcode)).toEqual([citing.bibcode])
    expect(listWatches(sb.lib)[0]).toMatchObject({
      name: 'Citing my EnKF paper',
      newCount: 1,
      lastError: null
    })

    setHitState(sb.lib, [citing.bibcode], 'dismissed')
    const third = { ...citing, bibcode: '2026ApJ...999....1Z' }
    results = [citing, third]
    expect(await runWatch(sb.lib, w, { fetch, token: 't' })).toBe(1)
    expect(watchHits(sb.lib).map((h) => h.bibcode)).toEqual([third.bibcode])
  })

  it('records a failing watch without losing earlier results', async () => {
    const w = createWatch(sb.lib, 'Broken', 'bad query(')
    const failing: Fetch = async () => new Response('bad', { status: 400 })
    await expect(runWatch(sb.lib, w, { fetch: failing, token: 't' })).rejects.toThrow('HTTP 400')
    expect(listWatches(sb.lib)[0]?.lastError).toMatch(/400/)
  })

  it('finds journal versions of preprints', async () => {
    const pre = sb.lib.createPaper({
      source: 'arxiv',
      metadata: {
        authors: [{ family: 'Dash' }],
        year: 2024,
        arxivId: '2409.09000',
        title: 'Preprint'
      }
    })
    sb.lib.createPaper(meta({ arxivId: '2501.00001', doi: '10.1/unpublished' }))
    const { fetch } = fakeAds({
      search: (q) =>
        q.includes('2409.09000') ? [DASH_DOC] : [{ bibcode: '2025arXiv250100001X', year: '2025' }]
    })
    expect(await findPublishedVersions(sb.lib, { fetch, token: 't' })).toEqual([
      {
        paperId: pre,
        title: 'Preprint',
        arxivId: '2409.09000',
        bibcode: DASH_DOC.bibcode,
        pub: 'The Astrophysical Journal',
        year: 2024
      }
    ])
  })
})

// ── 4. Highlights index ─────────────────────────────────────────────────────

describe('annotations', () => {
  // Line 0 is at y=740, line 1 at y=726; Helvetica 11pt is ~5.5pt per character.
  const pages = [
    ['Magnetic flux emerges at the surface.', 'Plage decays slowly over weeks.'],
    ['Second page text.']
  ]
  const annotated = () =>
    makePdf(pages, {}, [
      {
        page: 0,
        subtype: 'Highlight',
        box: [72, 737, 150, 750],
        color: [1, 1, 0],
        contents: 'key point'
      },
      { page: 0, subtype: 'Text', box: [400, 700, 420, 720], contents: 'Check against HMI' },
      { page: 1, subtype: 'Ink', box: [100, 100, 200, 200] }
    ])

  it('reads highlights with the words under them, notes, and drawings', async () => {
    const anns = await readPdfAnnotations(
      sb.pdf('a.pdf', [], {}) && writeTo(sb.dir, 'ann.pdf', annotated())
    )
    expect(anns).toMatchObject([
      { page: 1, kind: 'highlight', color: '#ffff00', comment: 'key point' },
      { page: 1, kind: 'note', text: 'Check against HMI' },
      { page: 2, kind: 'drawing' }
    ])
    expect(anns[0]!.text).toMatch(/^Magnetic flux/)
  })

  it('indexes library files once, re-indexes after a change, and exports Markdown', async () => {
    const r = await sb.lib.importPdf(writeTo(sb.dir, 'ann.pdf', annotated()), {
      resolved: DASH_2024
    })
    const [f] = sb.lib.filesOf(r.paperId)
    expect(staleAnnotationFiles(sb.lib).map((x) => x.id)).toEqual([f!.id])
    await indexFileAnnotations(sb.lib, f!.id)
    expect(staleAnnotationFiles(sb.lib)).toEqual([])
    const items = listAnnotations(sb.lib)
    expect(items.map((a) => a.kind)).toEqual(['highlight', 'note'])
    expect(listAnnotations(sb.lib, { includeDrawings: true })).toHaveLength(3)
    expect(listAnnotations(sb.lib, { search: 'HMI' })).toHaveLength(1)
    expect(sb.lib.listRows()[0]?.annotation_count).toBe(3)

    const md = annotationsToMarkdown(items)
    expect(md).toContain('## Dash 2024: Ensemble Kalman Filter')
    expect(md).toMatch(/- > Magnetic flux.* \(p\. 1\)\n {2}- key point/)

    await sb.lib.saveFileVersion(f!.id, makePdf([['replaced, no annotations']]))
    expect(staleAnnotationFiles(sb.lib)).toHaveLength(1)
    await indexFileAnnotations(sb.lib, f!.id)
    expect(listAnnotations(sb.lib)).toEqual([])
  })
})

// ── 1. Manuscripts ──────────────────────────────────────────────────────────

describe('manuscript bibliography', () => {
  it('reads cite keys from all citation commands, ignoring comments', () => {
    const tex = String.raw`
      As shown by \citet{2024ApJ...975..288D} and \citep[see][p.~3]{Babcock61, 2024ApJ...975..288D}.
      % \cite{commented_out}
      50\% of \citealt*{keyA} and \nocite{keyB}.`
    expect(extractCiteKeys(tex)).toEqual(['2024ApJ...975..288D', 'Babcock61', 'keyA', 'keyB'])
  })

  it('parses BibTeX entries with nested braces and quotes', () => {
    const [e] = parseBib(
      '@ARTICLE{key1,\n  title = {{The {Sun}}},\n  year = 2020,\n  doi = "10.1/x"\n}\n@comment{skip}'
    )
    expect(e).toMatchObject({
      key: 'key1',
      type: 'article',
      fields: { title: '{The {Sun}}', year: '2020', doi: '10.1/x' }
    })
    expect(rekey('@ARTICLE{2024ApJ...975..288D,\n  x = {1}\n}', 'Dash24')).toBe(
      '@ARTICLE{Dash24,\n  x = {1}\n}'
    )
  })

  it('matches keys to the library and rewrites the .bib without losing anything', async () => {
    const dash = sb.lib.createPaper(DASH_2024)
    const babcock = sb.lib.createPaper(
      meta({
        doi: '10.1086/147060',
        title: 'Babcock',
        authors: [{ family: 'Babcock' }],
        year: 1961
      })
    )
    const dir = join(sb.dir, 'CN_Paper')
    mkdirSync(join(dir, 'sections'), { recursive: true })
    writeFileSync(join(dir, 'main.tex'), String.raw`\input{sections/intro}\bibliography{citations}`)
    writeFileSync(
      join(dir, 'sections', 'intro.tex'),
      String.raw`\cite{2024ApJ...975..288D,Babcock61,Leighton69,Unknown99}`
    )
    writeFileSync(
      join(dir, 'citations.bib'),
      '@ARTICLE{Babcock61, doi = {10.1086/147060}, title = {old}}\n' +
        '@ARTICLE{Leighton69, title = {Kept as is}, adsurl = {https://ui.adsabs.harvard.edu/abs/1969ApJ...156....1L}}\n' +
        '@MISC{Uncited, title = {Also kept}}\n'
    )
    const a = await analyzeManuscript(sb.lib, dir)
    expect(a.bibPath).toBe(join(dir, 'citations.bib'))
    expect(a.keys).toEqual([
      { key: '2024ApJ...975..288D', status: 'library', paperId: dash },
      { key: 'Babcock61', status: 'library', paperId: babcock },
      {
        key: 'Leighton69',
        status: 'bib-only',
        identifier: { kind: 'bibcode', value: '1969ApJ...156....1L', origin: 'hint' }
      },
      { key: 'Unknown99', status: 'missing', identifier: undefined }
    ])

    const w = await writeManuscriptBib(sb.lib, a)
    expect(w).toMatchObject({ fromLibrary: 2, kept: 1, missing: ['Unknown99'] })
    const bib = readFileSync(a.bibPath, 'utf8')
    const keys = parseBib(bib).map((e) => e.key)
    expect(keys).toEqual(['2024ApJ...975..288D', 'Babcock61', 'Leighton69', 'Uncited'])
    expect(bib).toContain('Kept as is')
    expect(parseBib(bib).find((e) => e.key === 'Babcock61')!.fields.doi).toBe('10.1086/147060')
    expect(readFileSync(`${a.bibPath}.bak`, 'utf8')).toContain('title = {old}')
  })

  it('finds cite keys of library papers by their generated key too', async () => {
    const id = sb.lib.createPaper({
      source: 'manual',
      metadata: { title: 'Flux Budget', authors: [{ family: 'Chatzistergos' }], year: 2022 }
    })
    const dir = join(sb.dir, 'P')
    mkdirSync(dir)
    writeFileSync(join(dir, 'p.tex'), String.raw`\cite{Chatzistergos2022Flux}`)
    const a = await analyzeManuscript(sb.lib, dir)
    expect(a.keys[0]).toMatchObject({ status: 'library', paperId: id })
    expect(a.bibPath).toBe(join(dir, 'references.bib'))
  })
})

// ── 7. Backups ──────────────────────────────────────────────────────────────

describe('backups', () => {
  it('snapshots the database, keeps a bounded number, and only when due', () => {
    sb.lib.createPaper(DASH_2024)
    const first = backupDatabase(sb.lib)
    expect(existsSync(first)).toBe(true)
    expect(backupIfDue(sb.lib)).toBeUndefined()
    expect(listBackups(sb.lib)).toHaveLength(1)
  })

  it('warns about sync folders', () => {
    expect(syncFolderWarning('/Users/x/Dropbox/Papers')).toMatch(/Dropbox/)
    expect(syncFolderWarning('/Users/x/Documents/PaperManager')).toBeUndefined()
  })
})

function writeTo(dir: string, name: string, bytes: Buffer): string {
  const p = join(dir, name)
  writeFileSync(p, bytes)
  return p
}
