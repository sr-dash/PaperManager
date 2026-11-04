import { describe, expect, it } from 'vitest'
import { adsDocToMetadata, adsQuery } from '../src/core/metadata/ads.js'
import { parseArxivAtom } from '../src/core/metadata/arxiv.js'
import { crossrefToMetadata } from '../src/core/metadata/crossref.js'
import { splitName, type Fetch } from '../src/core/metadata/http.js'
import { createResolver } from '../src/core/metadata/resolver.js'

describe('ADS', () => {
  it('maps a search document, taking the journal abbreviation from the bibcode', () => {
    const m = adsDocToMetadata({
      bibcode: '2024SciA...10.1604S',
      title: ['Mapping the Sun&#39;s coronal magnetic field using the Zeeman effect'],
      author: ['Schad, Thomas A.', 'Petrie, Gordon J. D.'],
      year: '2024',
      pub: 'Science Advances',
      volume: '10',
      page: ['eadq1604'],
      doi: ['10.1126/sciadv.adq1604'],
      identifier: ['2024SciA...10.1604S', 'arXiv:2409.01234', '10.1126/sciadv.adq1604'],
      doctype: 'article'
    })
    expect(m).toMatchObject({
      title: "Mapping the Sun's coronal magnetic field using the Zeeman effect",
      authors: [
        { family: 'Schad', given: 'Thomas A.' },
        { family: 'Petrie', given: 'Gordon J. D.' }
      ],
      year: 2024,
      journalAbbrev: 'SciA',
      page: 'eadq1604',
      arxivId: '2409.01234'
    })
  })

  it('builds field queries per identifier kind', () => {
    expect(adsQuery({ kind: 'arxiv', value: '1910.08110', origin: 'filename' })).toBe(
      'identifier:"arXiv:1910.08110"'
    )
  })
})

describe('Crossref', () => {
  it('maps a work and strips JATS markup', () => {
    const m = crossrefToMetadata({
      DOI: '10.1029/2014GL061077',
      type: 'journal-article',
      title: ['Forecasting the <i>next</i> solar cycle'],
      author: [{ family: 'Dikpati', given: 'Mausumi' }, { name: 'The Consortium' }],
      'container-title': ['Geophysical Research Letters'],
      'short-container-title': ['Geophys. Res. Lett.'],
      volume: '41',
      page: '5361-5369',
      abstract: '<jats:p>Cycle 25 &amp; beyond.</jats:p>',
      published: { 'date-parts': [[2014, 8, 5]] }
    })
    expect(m).toMatchObject({
      doi: '10.1029/2014gl061077',
      title: 'Forecasting the next solar cycle',
      authors: [{ family: 'Dikpati', given: 'Mausumi' }, { family: 'The Consortium' }],
      year: 2014,
      pubDate: '2014-08-05',
      page: '5361',
      abstract: 'Cycle 25 & beyond.',
      entryType: 'article'
    })
  })
})

describe('arXiv', () => {
  const feed = (entry: string) => `<?xml version="1.0"?><feed>${entry}</feed>`

  it('parses an entry', () => {
    const m = parseArxivAtom(
      feed(`<entry>
        <id>http://arxiv.org/abs/1910.08110v2</id>
        <published>2019-10-17T18:00:00Z</published>
        <title>Validation of the Alfv&#233;n Wave
          Solar Atmosphere Model</title>
        <summary>We validate AWSoM.</summary>
        <author><name>Bart van der Holst</name></author>
        <author><name>Judit Szente</name></author>
        <arxiv:doi>10.3847/1538-4357/ab4c4b</arxiv:doi>
      </entry>`)
    )
    expect(m).toMatchObject({
      arxivId: '1910.08110',
      title: 'Validation of the Alfvén Wave Solar Atmosphere Model',
      year: 2019,
      doi: '10.3847/1538-4357/ab4c4b',
      authors: [
        { family: 'van der Holst', given: 'Bart' },
        { family: 'Szente', given: 'Judit' }
      ]
    })
  })

  it('treats the error entry and an empty feed as not found', () => {
    expect(parseArxivAtom(feed(''))).toBeNull()
    expect(
      parseArxivAtom(
        feed('<entry><id>http://arxiv.org/api/errors#x</id><title>Error</title></entry>')
      )
    ).toBeNull()
  })
})

describe('splitName', () => {
  it('handles both name orders', () => {
    expect(splitName('DeRosa, Marc L.')).toEqual({ family: 'DeRosa', given: 'Marc L.' })
    expect(splitName('Marc L. DeRosa')).toEqual({ family: 'DeRosa', given: 'Marc L.' })
    expect(splitName('Plato')).toEqual({ family: 'Plato' })
  })
})

describe('createResolver', () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('uses Crossref for DOIs when no ADS token is set', async () => {
    const urls: string[] = []
    const fetch: Fetch = async (input) => {
      urls.push(String(input))
      return json({ message: { DOI: '10.1/x', title: ['T'], author: [{ family: 'A' }] } })
    }
    const { resolved } = await createResolver({ fetch })([
      { kind: 'bibcode', value: '2024ApJ...975..288D', origin: 'hint' },
      { kind: 'doi', value: '10.1/x', origin: 'first-page' }
    ])
    expect(resolved?.source).toBe('crossref')
    expect(urls).toEqual(['https://api.crossref.org/works/10.1%2Fx'])
  })

  it('prefers ADS when a token is set, and reports failures without throwing', async () => {
    const fetch: Fetch = async (input) => {
      const url = String(input)
      if (url.includes('/search/query')) return json({}, 503)
      return json({ message: { DOI: '10.1/x', title: ['T'], author: [] } })
    }
    const result = await createResolver({ fetch, adsToken: 't' })([
      { kind: 'doi', value: '10.1/x', origin: 'first-page' }
    ])
    expect(result.resolved?.source).toBe('crossref')
    expect(result.errors).toEqual(['ads: HTTP 503 from api.adsabs.harvard.edu'])
  })

  it('accepts an ADS title match only when the title is exactly the same', async () => {
    const adsReturning =
      (title: string): Fetch =>
      async (input) =>
        String(input).includes('/export/')
          ? json({ export: '@ARTICLE{x}' })
          : json({
              response: { numFound: 1, docs: [{ bibcode: '2024SciA...10.1604S', title: [title] }] }
            })
    const id = {
      kind: 'title',
      value: 'Mapping the Sun’s coronal magnetic field',
      origin: 'pdf-info'
    } as const

    const exact = await createResolver({
      fetch: adsReturning("Mapping the Sun's Coronal Magnetic Field"),
      adsToken: 't'
    })([id])
    expect(exact.resolved?.metadata.bibcode).toBe('2024SciA...10.1604S')

    const near = await createResolver({
      fetch: adsReturning('Mapping the coronal magnetic field of the Sun'),
      adsToken: 't'
    })([id])
    expect(near.resolved).toBeNull()
  })

  it('looks up file-name citations by volume and page, then checks the first author', async () => {
    const queries: string[] = []
    const adsWith =
      (first: string): Fetch =>
      async (input) => {
        const url = new URL(String(input))
        if (url.pathname.endsWith('/export/bibtex')) return json({ export: '@ARTICLE{x}' })
        queries.push(url.searchParams.get('q')!)
        return json({
          response: { numFound: 1, docs: [{ bibcode: '2000ApJ...541L..83L', author: [first] }] }
        })
      }
    const id = { kind: 'reference', value: 'Lin|2000|ApJ|541|L83', origin: 'filename' } as const
    const hit = await createResolver({ fetch: adsWith('Lin, J.'), adsToken: 't' })([id])
    expect(hit.resolved?.metadata.bibcode).toBe('2000ApJ...541L..83L')
    expect(queries[0]).toBe('year:2000 bibstem:"ApJL" volume:541 page:"L83"')

    const wrongAuthor = await createResolver({ fetch: adsWith('Forbes, T. G.'), adsToken: 't' })([
      id
    ])
    expect(wrongAuthor.resolved).toBeNull()
  })

  it('queries by author when a citation has no volume and page', () => {
    expect(adsQuery({ kind: 'reference', value: 'Parnell|2002|MNRAS||', origin: 'filename' })).toBe(
      'year:2002 bibstem:"MNRAS" author:"^Parnell"'
    )
  })

  it('never sends titles to Crossref or arXiv', async () => {
    const urls: string[] = []
    const fetch: Fetch = async (input) => (urls.push(String(input)), json({}, 404))
    await createResolver({ fetch })([
      { kind: 'title', value: 'Some long paper title', origin: 'pdf-info' }
    ])
    expect(urls).toEqual([])
  })

  it('treats a Crossref 404 as not found rather than an error', async () => {
    const fetch: Fetch = async () => json({}, 404)
    const result = await createResolver({ fetch })([
      { kind: 'doi', value: '10.1/missing', origin: 'hint' }
    ])
    expect(result).toEqual({ resolved: null, errors: [] })
  })
})
