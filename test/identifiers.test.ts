import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  bibcodeFromAdsUrl,
  decodeReference,
  encodeReference,
  extractIdentifiers,
  findArxivIds,
  findDois,
  identifiersFromFilename,
  isBibcode,
  normalizeDoi,
  plausibleTitle,
  referenceFromFilename
} from '../src/core/identifiers.js'

describe('DOIs', () => {
  it('finds DOIs in running text and trims prose punctuation', () => {
    expect(findDois('see https://doi.org/10.3847/1538-4357/ad7d0f. Received 2024')).toEqual([
      '10.3847/1538-4357/ad7d0f'
    ])
    expect(findDois('(doi:10.1051/0004-6361/202038091);')).toEqual(['10.1051/0004-6361/202038091'])
  })

  it('keeps balanced parentheses that belong to the DOI', () => {
    expect(normalizeDoi('10.1016/0038-0938(87)90001-2')).toBe('10.1016/0038-0938(87)90001-2')
    expect(normalizeDoi('10.1016/0038-0938(87)90001-2).')).toBe('10.1016/0038-0938(87)90001-2')
  })

  it('lower-cases and strips resolver prefixes', () => {
    expect(normalizeDoi('https://dx.doi.org/10.1029/2014GL061077')).toBe('10.1029/2014gl061077')
  })
})

describe('arXiv ids', () => {
  it('finds new- and old-style ids, dropping version suffixes', () => {
    expect(findArxivIds('arXiv:2303.01209v2 [astro-ph.SR] 2 Mar 2023')).toEqual(['2303.01209'])
    expect(findArxivIds('arXiv: astro-ph/0601001v1')).toEqual(['astro-ph/0601001'])
  })

  it('reads ids from arXiv-style filenames', () => {
    expect(identifiersFromFilename('1910.08110.pdf')).toEqual([
      { kind: 'arxiv', value: '1910.08110', origin: 'filename' }
    ])
    expect(identifiersFromFilename('2409.09000v3.pdf')[0]?.value).toBe('2409.09000')
  })
})

describe('bibcodes', () => {
  it('recognises ADS bibcodes, including in filenames', () => {
    expect(isBibcode('2024ApJ...975..288D')).toBe(true)
    expect(isBibcode('1987A&A...180..241S')).toBe(true)
    expect(isBibcode('2019ApJ...870L..18F')).toBe(true)
    expect(isBibcode('Dash_2024_ApJ_975_28')).toBe(false)
    expect(identifiersFromFilename('1987A&A...180..241S.pdf')).toEqual([
      { kind: 'bibcode', value: '1987A&A...180..241S', origin: 'filename' }
    ])
  })

  it('pulls the bibcode out of ADS URLs, encoded or not', () => {
    expect(
      bibcodeFromAdsUrl('https://ui.adsabs.harvard.edu/abs/2024SciA...10.1604S/abstract')
    ).toBe('2024SciA...10.1604S')
    expect(
      bibcodeFromAdsUrl('https://ui.adsabs.harvard.edu/abs/1987A%26A...180..241S/abstract')
    ).toBe('1987A&A...180..241S')
    expect(bibcodeFromAdsUrl('https://example.com/abs/2024SciA...10.1604S')).toBeUndefined()
  })
})

describe('extractIdentifiers', () => {
  it('ranks hints, then filename, then PDF info, then first page, without duplicates', () => {
    const ids = extractIdentifiers({
      filename: '1910.08110.pdf',
      pdfInfo: 'doi:10.1000/info',
      firstPage: 'doi:10.1000/page arXiv:1910.08110 doi:10.1000/info',
      hints: [{ kind: 'bibcode', value: '2019ApJ...870L..18F', origin: 'hint' }]
    })
    expect(ids.map((i) => `${i.kind}:${i.value}:${i.origin}`)).toEqual([
      'bibcode:2019ApJ...870L..18F:hint',
      'arxiv:1910.08110:filename',
      'doi:10.1000/info:pdf-info',
      'doi:10.1000/page:first-page'
    ])
  })

  it('adds a plausible PDF title as the last candidate', () => {
    const ids = extractIdentifiers({
      filename: 'x.pdf',
      firstPage: 'doi:10.1000/page',
      infoTitle: '  Mapping the Sun’s coronal   magnetic field '
    })
    expect(ids.at(-1)).toEqual({
      kind: 'title',
      value: 'Mapping the Sun’s coronal magnetic field',
      origin: 'pdf-info'
    })
  })

  it('ignores titles that are file names or placeholders', () => {
    for (const t of [
      'Schad_2024_sciadv',
      'Microsoft Word - draft v3',
      'main.tex',
      'untitled document here'
    ]) {
      expect(plausibleTitle(t)).toBeUndefined()
    }
  })

  it('never throws on arbitrary text', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.string(), (filename, info, page) => {
        const ids = extractIdentifiers({ filename, pdfInfo: info, firstPage: page })
        for (const id of ids) expect(id.value.length).toBeGreaterThan(0)
      })
    )
  })
})

describe('citations and DOIs in file names', () => {
  const ref = (name: string) => referenceFromFilename(name)

  it('reads Family_Year_Journal_Volume_Page names, ignoring copy suffixes', () => {
    expect(ref('Parnell_2008_ApJ_675_1656.pdf')).toEqual({
      family: 'Parnell',
      year: 2008,
      bibstem: 'ApJ',
      volume: '675',
      page: '1656'
    })
    expect(ref('Schrijver_2002_ApJ_577_1006 (1).pdf')).toMatchObject({
      volume: '577',
      page: '1006'
    })
    expect(ref('Schrijver_2001_ApJ_547_475-2.pdf')).toMatchObject({ volume: '547', page: '475' })
    expect(ref('Lin_2000_ApJ_541_L83.pdf')).toMatchObject({ page: 'L83' })
    expect(ref('Hebbur_Dayananda_2025_ApJ_987_39.pdf')).toMatchObject({
      family: 'Hebbur Dayananda'
    })
  })

  it('reads short names only when the journal is recognised', () => {
    expect(ref('Parnell2002MNRAS.pdf')).toEqual({
      family: 'Parnell',
      year: 2002,
      bibstem: 'MNRAS',
      volume: undefined,
      page: undefined
    })
    expect(ref('Isik_2018AA.pdf')).toMatchObject({ bibstem: 'A&A' })
    expect(ref('Fisk2003JGR.pdf')).toMatchObject({ bibstem: 'JGRA' })
    expect(ref('Hagenaar_2008_ApJ.pdf')).toMatchObject({ family: 'Hagenaar', year: 2008 })
    expect(ref('Yeates_2009_draft.pdf')).toBeUndefined()
    expect(ref('Solar_Eclipse_2024_and_Coronal_Memory.pdf')).toBeUndefined()
  })

  it('round-trips through the identifier encoding', () => {
    const r = ref('Lin_2000_ApJ_541_L83.pdf')!
    expect(decodeReference(encodeReference(r))).toEqual(r)
  })

  it('turns publisher download names into DOIs', () => {
    const doi = (name: string) => identifiersFromFilename(name)[0]
    expect(doi('science.ado2993 (1).pdf')).toEqual({
      kind: 'doi',
      value: '10.1126/science.ado2993',
      origin: 'filename'
    })
    expect(doi('sciadv.adq1604.pdf')?.value).toBe('10.1126/sciadv.adq1604')
    expect(doi('annurev-astro-041122-031043.pdf')?.value).toBe(
      '10.1146/annurev-astro-041122-031043'
    )
    expect(doi('s11207-022-02094-2.pdf')?.value).toBe('10.1007/s11207-022-02094-2')
    expect(doi('s41550-025-02564-0.pdf')?.value).toBe('10.1038/s41550-025-02564-0')
    expect(doi('aa47536-23.pdf')?.value).toBe('10.1051/0004-6361/202347536')
    expect(doi('sciadv.adq1604_sm.pdf')).toBeUndefined()
  })

  it('ranks a file-name citation below identifiers printed in the PDF', () => {
    const ids = extractIdentifiers({
      filename: 'Parnell_2008_ApJ_675_1656.pdf',
      firstPage: 'doi:10.1086/527285'
    })
    expect(ids.map((i) => i.kind)).toEqual(['doi', 'reference'])
  })
})
