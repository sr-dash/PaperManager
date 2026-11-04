import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  canonicalStem,
  citeTag,
  fallbackStem,
  parseBibcode,
  sanitizeToken,
  uniqueFilename
} from '../src/core/naming.js'

describe('parseBibcode', () => {
  it('splits the fixed-width fields', () => {
    expect(parseBibcode('2024ApJ...975..288D')).toEqual({
      year: 2024,
      journal: 'ApJ',
      volume: '975',
      qualifier: undefined,
      page: '288'
    })
    expect(parseBibcode('2019ApJ...870L..18F')).toMatchObject({
      volume: '870',
      qualifier: 'L',
      page: '18'
    })
  })
})

describe('canonicalStem', () => {
  it('reproduces the hand-made convention', () => {
    expect(canonicalStem({ authors: [{ family: 'Dash' }], bibcode: '2024ApJ...975..288D' })).toBe(
      'Dash_2024_ApJ_975_288'
    )
    expect(
      canonicalStem({
        authors: [{ family: 'Cheung' }],
        year: 2012,
        journalAbbrev: 'ApJ',
        volume: '757',
        page: '147'
      })
    ).toBe('Cheung_2012_ApJ_757_147')
  })

  it('keeps letter-page qualifiers and folds diacritics and symbols', () => {
    expect(canonicalStem({ authors: [{ family: 'Fan' }], bibcode: '2019ApJ...870L..18F' })).toBe(
      'Fan_2019_ApJ_870_L18'
    )
    expect(
      canonicalStem({ authors: [{ family: 'Schrijver' }], bibcode: '1987A&A...180..241S' })
    ).toBe('Schrijver_1987_AA_180_241')
    expect(canonicalStem({ authors: [{ family: 'Ramírez-Ávila' }], year: 2020 })).toBe(
      'Ramirez-Avila_2020'
    )
  })

  it('names preprints by arXiv id', () => {
    expect(
      canonicalStem({ authors: [{ family: 'Dash' }], year: 2024, arxivId: '2409.09000' })
    ).toBe('Dash_2024_arXiv_2409.09000')
  })

  it('declines to name a paper without an author and a year', () => {
    expect(canonicalStem({ authors: [], year: 2024 })).toBeUndefined()
    expect(canonicalStem({ authors: [{ family: 'Dash' }] })).toBeUndefined()
  })
})

describe('citeTag', () => {
  it('follows the FamilyYY habit of the old libraries', () => {
    expect(citeTag({ authors: [{ family: 'Schad' }], year: 2024 })).toBe('Schad24')
    expect(citeTag({ authors: [{ family: 'Hebbur Dayananda' }], year: 2025 })).toBe(
      'HebburDayananda25'
    )
    expect(citeTag({ authors: [{ family: 'Schrijver' }], bibcode: '2002ApJ...577.1006S' })).toBe(
      'Schrijver02'
    )
    expect(citeTag({ authors: [{ family: 'Ramírez' }], year: 2009 })).toBe('Ramirez09')
    expect(citeTag({ authors: [], year: 2024 })).toBeUndefined()
  })
})

describe('file names', () => {
  it('always produces safe, non-empty names', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(fallbackStem(s)).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$|^untitled$/)
        expect(sanitizeToken(s)).toMatch(/^[A-Za-z0-9-]*$/)
      })
    )
  })

  it('suffixes collisions b, c, … like 2024a/2024b citations', () => {
    const taken = new Set(['Dash_2024.pdf', 'Dash_2024-b.pdf'])
    expect(uniqueFilename('Dash_2024', (n) => taken.has(n))).toBe('Dash_2024-c.pdf')
    expect(uniqueFilename('Other', (n) => taken.has(n))).toBe('Other.pdf')
  })

  it('never returns a taken name', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), (n) => {
        const taken = new Set<string>()
        for (let i = 0; i < n; i++) taken.add(uniqueFilename('x', (name) => taken.has(name)))
        expect(taken.size).toBe(n)
      })
    )
  })
})
