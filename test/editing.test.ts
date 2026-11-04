import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { citeKey, toBibtex } from '../src/core/bibtex.js'
import { DASH_2024, sandbox, tableResolver, type Sandbox } from './helpers.js'

let sb: Sandbox
beforeEach(() => {
  sb = sandbox()
})
afterEach(() => sb.cleanup())

describe('listRows', () => {
  it('returns one flat row per paper with tags, counts and note flag', async () => {
    const { resolver } = tableResolver({ 'doi:10.3847/1538-4357/ad7d0f': DASH_2024 })
    const a = await sb.lib.importPdf(sb.pdf('a.pdf', [['doi:10.3847/1538-4357/ad7d0f']]), {
      resolver,
      tags: ['b, with comma', 'A']
    })
    await sb.lib.importPdf(sb.pdf('b.pdf', [['other']]))
    sb.lib.setNote(a.paperId, 'read section 3')

    const rows = sb.lib.listRows()
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.id === a.paperId)).toMatchObject({
      first_author: 'Dash',
      author_count: 2,
      file_count: 1,
      tags: ['A', 'b, with comma', 'Dash24'],
      has_note: true,
      journal_abbrev: 'ApJ'
    })
    expect(sb.lib.tagCounts()).toEqual([
      { name: 'A', count: 1 },
      { name: 'b, with comma', count: 1 },
      { name: 'Dash24', count: 1 }
    ])
  })
})

describe('notes', () => {
  it('stores one editable note per paper', async () => {
    const r = await sb.lib.importPdf(sb.pdf('a.pdf', [['x']]))
    expect(sb.lib.getNote(r.paperId)).toBe('')
    sb.lib.setNote(r.paperId, 'first')
    sb.lib.setNote(r.paperId, 'second')
    expect(sb.lib.getNote(r.paperId)).toBe('second')
    expect(sb.lib.db.prepare('SELECT count(*) n FROM notes').get()).toEqual({ n: 1 })
  })
})

describe('setManualMetadata', () => {
  it('locks the record, renames files, and is skipped by later lookups', async () => {
    const r = await sb.lib.importPdf(sb.pdf('scan.pdf', [['doi:10.3847/1538-4357/ad7d0f']]))
    await sb.lib.setManualMetadata(r.paperId, {
      title: 'Hand entered',
      authors: [{ family: 'Kuhn', given: 'Jeff' }],
      year: 1999,
      journalAbbrev: 'SoPh'
    })
    expect(sb.lib.summary(r.paperId)).toMatchObject({
      metadata_status: 'manual',
      metadata_source: 'manual',
      files: ['files/Kuhn_1999_SoPh.pdf']
    })
    const { resolver, calls } = tableResolver({ 'doi:10.3847/1538-4357/ad7d0f': DASH_2024 })
    expect((await sb.lib.resolvePaper(r.paperId, resolver)).status).toBe('unchanged')
    expect(calls).toHaveLength(0)

    sb.lib.unlockMetadata(r.paperId)
    expect((await sb.lib.resolvePaper(r.paperId, resolver)).status).toBe('resolved')
  })

  it('refuses an identifier that belongs to another paper', async () => {
    const { resolver } = tableResolver({ 'doi:10.3847/1538-4357/ad7d0f': DASH_2024 })
    await sb.lib.importPdf(sb.pdf('a.pdf', [['doi:10.3847/1538-4357/ad7d0f']]), { resolver })
    const b = await sb.lib.importPdf(sb.pdf('b.pdf', [['other']]))
    await expect(
      sb.lib.setManualMetadata(b.paperId, { authors: [], doi: '10.3847/1538-4357/ad7d0f' })
    ).rejects.toThrow(/already has/)
  })
})

describe('automatic cite tags', () => {
  it('can be switched off, and follow hand edits', async () => {
    sb.lib.autoCiteTags = false
    const { resolver } = tableResolver({ 'doi:10.3847/1538-4357/ad7d0f': DASH_2024 })
    const r = await sb.lib.importPdf(sb.pdf('a.pdf', [['doi:10.3847/1538-4357/ad7d0f']]), {
      resolver
    })
    expect(sb.lib.tagsOf(r.paperId)).toEqual([])
    sb.lib.autoCiteTags = true
    await sb.lib.setManualMetadata(r.paperId, { authors: [{ family: 'Kuhn' }], year: 1999 })
    expect(sb.lib.tagsOf(r.paperId)).toEqual(['Kuhn99'])
  })
})

describe('removePaper', () => {
  it('drops records first, then disposes of the files', async () => {
    const r = await sb.lib.importPdf(sb.pdf('a.pdf', [['bye']]), { tags: ['only-here'] })
    const disposed: string[] = []
    await sb.lib.removePaper(r.paperId, async (p) => {
      expect(sb.lib.getPaper(r.paperId)).toBeUndefined()
      disposed.push(p)
    })
    expect(disposed).toEqual([join(sb.lib.root, r.relPath)])
    expect(existsSync(disposed[0]!)).toBe(true) // disposal is the caller's job
    expect(sb.lib.search('bye')).toEqual([])
    expect(sb.lib.tagCounts()).toEqual([])
  })
})

describe('BibTeX', () => {
  it('uses the ADS export verbatim when stored', () => {
    expect(toBibtex({ authors: [], bibtex: ' @ARTICLE{2024ApJ...975..288D,\n}\n' })).toBe(
      '@ARTICLE{2024ApJ...975..288D,\n}'
    )
  })

  it('builds an entry from fields otherwise, escaping TeX specials', () => {
    const bib = toBibtex({
      title: 'Flux & Flows_in 100% of cases',
      authors: [
        { family: 'van Ballegooijen', given: 'A. A.' },
        { family: 'Dash', given: 'S.' }
      ],
      year: 2020,
      journal: 'A&A',
      volume: '642',
      page: 'A1',
      doi: '10.1051/x'
    })
    expect(bib).toContain('@article{vanBallegooijen2020Flux,')
    expect(bib).toContain('author        = {{van Ballegooijen}, A. A. and Dash, S.}')
    expect(bib).toContain('title         = {{Flux \\& Flows\\_in 100\\% of cases}}')
    expect(bib).toContain('journal       = {A\\&A}')
  })

  it('prefers the bibcode as key, and marks preprints as misc', () => {
    expect(citeKey({ authors: [], bibcode: '2024ApJ...975..288D' })).toBe('2024ApJ...975..288D')
    expect(toBibtex({ authors: [{ family: 'X' }], year: 2024, arxivId: '2409.1' })).toMatch(
      /^@misc\{/
    )
  })

  it('exports several papers at once', async () => {
    const a = await sb.lib.importPdf(sb.pdf('a.pdf', [['a']]))
    const b = await sb.lib.importPdf(sb.pdf('b.pdf', [['b']]))
    expect(sb.lib.exportBibtex([a.paperId, b.paperId]).match(/^@/gm)).toHaveLength(2)
  })
})
