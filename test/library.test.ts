import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Library, NotPdfError, toFtsQuery } from '../src/core/library.js'
import { readPdfText } from '../src/core/pdf.js'
import type { ResolvedMetadata } from '../src/core/types.js'
import { DASH_2024, sandbox, tableResolver, type Sandbox } from './helpers.js'

let sb: Sandbox
beforeEach(() => {
  sb = sandbox()
})
afterEach(() => sb.cleanup())

const DASH_PAGE = [
  'Ensemble Kalman Filter Data Assimilation into the Surface Flux Transport Model',
  'Soumyaranjan Dash, Marc L. DeRosa',
  'https://doi.org/10.3847/1538-4357/ad7d0f'
]

describe('the PDF fixture', () => {
  it('is readable by pdf.js', async () => {
    const path = sb.pdf('x.pdf', [['hello world'], ['second page']], { Title: 'Fixture' })
    const text = await readPdfText(path)
    expect(text.pageCount).toBe(2)
    expect(text.firstPage).toContain('hello world')
    expect(text.fulltext).toContain('second page')
    expect(text.infoTitle).toBe('Fixture')
  })
})

describe('importPdf', () => {
  it('copies the file under its canonical name and records the paper', async () => {
    const src = sb.pdf('download (3).pdf', [DASH_PAGE])
    const { resolver, calls } = tableResolver({ 'doi:10.3847/1538-4357/ad7d0f': DASH_2024 })

    const r = await sb.lib.importPdf(src, { resolver, tags: ['SFT', 'EnKF'] })

    expect(r).toMatchObject({
      status: 'imported',
      relPath: 'files/Dash_2024_ApJ_975_288.pdf',
      metadataStatus: 'resolved'
    })
    expect(calls[0]?.[0]).toMatchObject({ kind: 'doi', origin: 'first-page' })
    expect(readFileSync(join(sb.lib.root, r.relPath))).toEqual(readFileSync(src))
    expect(existsSync(src)).toBe(true) // source untouched

    const s = sb.lib.summary(r.paperId)
    expect(s).toMatchObject({ first_author: 'Dash', year: 2024, bibcode: '2024ApJ...975..288D' })
    expect(s.tags).toEqual(['Dash24', 'EnKF', 'SFT'])
  })

  it('recognises identical content as a duplicate and merges its tags', async () => {
    const a = sb.pdf('a.pdf', [DASH_PAGE])
    const b = sb.pdf('b-copy.pdf', [DASH_PAGE])
    const first = await sb.lib.importPdf(a, { tags: ['one'] })
    const second = await sb.lib.importPdf(b, { tags: ['two'] })
    expect(second).toMatchObject({
      status: 'duplicate',
      paperId: first.paperId,
      relPath: first.relPath
    })
    expect(sb.lib.tagsOf(first.paperId)).toEqual(['one', 'two'])
    expect(sb.lib.listPapers()).toHaveLength(1)
  })

  it('lets a duplicate import carrying a hint resolve a still-unresolved paper', async () => {
    const src = sb.pdf('4A4D7DC1.pdf', [['no ids on this page']])
    const first = await sb.lib.importPdf(src, { tags: ['a'] })
    expect(first.metadataStatus).toBe('unresolved')

    const { resolver } = tableResolver({ 'bibcode:2024ApJ...975..288D': DASH_2024 })
    const again = await sb.lib.importPdf(src, {
      resolver,
      tags: ['b'],
      hints: [{ kind: 'bibcode', value: '2024ApJ...975..288D', origin: 'hint' }]
    })
    expect(again).toMatchObject({
      status: 'duplicate',
      paperId: first.paperId,
      metadataStatus: 'resolved',
      relPath: 'files/Dash_2024_ApJ_975_288.pdf'
    })
    expect(sb.lib.summary(first.paperId).tags).toEqual(['a', 'b', 'Dash24'])
    expect(await sb.lib.verify()).toEqual([])
  })

  it('replaces thin legacy fields with richer ones from a later duplicate', async () => {
    const src = sb.pdf('x.pdf', [['text']])
    const thin: ResolvedMetadata = { source: 'legacy', metadata: { title: 'x', authors: [] } }
    const rich: ResolvedMetadata = {
      source: 'legacy',
      metadata: {
        title: 'Real title',
        authors: [{ family: 'Schad' }],
        year: 2024,
        journal: 'Sci. Adv.'
      }
    }
    const r = await sb.lib.importPdf(src, { fallback: thin })
    await sb.lib.importPdf(src, { fallback: rich })
    expect(sb.lib.summary(r.paperId)).toMatchObject({
      title: 'Real title',
      files: ['files/Schad_2024.pdf']
    })
    await sb.lib.importPdf(src, { fallback: thin }) // never downgrades
    expect(sb.lib.getPaper(r.paperId)?.title).toBe('Real title')
  })

  it('attaches a different file of the same work (e.g. the preprint) to the existing paper', async () => {
    const { resolver } = tableResolver({
      'doi:10.3847/1538-4357/ad7d0f': DASH_2024,
      'arxiv:2409.09000': DASH_2024
    })
    const published = await sb.lib.importPdf(sb.pdf('pub.pdf', [DASH_PAGE]), { resolver })
    const preprint = await sb.lib.importPdf(
      sb.pdf('pre.pdf', [['arXiv:2409.09000v1 [astro-ph.SR]', 'Preprint text']]),
      { resolver }
    )
    expect(preprint).toMatchObject({ status: 'attached', paperId: published.paperId })
    expect(preprint.relPath).toBe('files/Dash_2024_ApJ_975_288-b.pdf')
    expect(sb.lib.summary(published.paperId).files).toHaveLength(2)
  })

  it('keeps unresolvable papers, named after the original file and titled from the PDF', async () => {
    const src = sb.pdf('Notes on things (draft).pdf', [['no identifiers here']], {
      Title: 'A Treatise on Coronal Loops'
    })
    const r = await sb.lib.importPdf(src, { resolver: tableResolver({}).resolver })
    expect(r).toMatchObject({
      relPath: 'files/Notes_on_things_draft.pdf',
      metadataStatus: 'unresolved'
    })
    expect(sb.lib.getPaper(r.paperId)?.title).toBe('A Treatise on Coronal Loops')
  })

  it('uses fallback metadata when nothing resolves', async () => {
    const r = await sb.lib.importPdf(sb.pdf('x.pdf', [['text']]), {
      fallback: {
        source: 'legacy',
        metadata: { title: 'Legacy', authors: [{ family: 'Cheung' }], year: 2012 }
      }
    })
    expect(r).toMatchObject({ relPath: 'files/Cheung_2012.pdf', metadataStatus: 'unresolved' })
    expect(sb.lib.getPaper(r.paperId)).toMatchObject({ title: 'Legacy', metadata_source: 'legacy' })
  })

  it('rejects files that are not PDFs', async () => {
    const p = join(sb.dir, 'fake.pdf')
    writeFileSync(p, '<html>not a pdf</html>')
    await expect(sb.lib.importPdf(p)).rejects.toBeInstanceOf(NotPdfError)
  })

  it('still imports PDFs that pdf.js cannot parse, reporting the problem', async () => {
    const p = join(sb.dir, 'broken.pdf')
    writeFileSync(p, '%PDF-1.4\ngarbage with no xref')
    const r = await sb.lib.importPdf(p)
    expect(r.status).toBe('imported')
    expect(r.errors.join()).toMatch(/^pdf:/)
  })
})

describe('resolvePaper', () => {
  it('fills metadata later and renames the file canonically', async () => {
    const r = await sb.lib.importPdf(sb.pdf('scan.pdf', [DASH_PAGE]))
    expect(r.metadataStatus).toBe('unresolved')

    const { resolver } = tableResolver({ 'doi:10.3847/1538-4357/ad7d0f': DASH_2024 })
    const out = await sb.lib.resolvePaper(r.paperId, resolver)

    expect(out.status).toBe('resolved')
    const s = sb.lib.summary(r.paperId)
    expect(s.files).toEqual(['files/Dash_2024_ApJ_975_288.pdf'])
    expect(existsSync(join(sb.lib.root, s.files[0]!))).toBe(true)
    expect(existsSync(join(sb.lib.root, r.relPath))).toBe(false)
    expect(await sb.lib.verify()).toEqual([])
  })

  it('merges into an existing paper when the lookup reveals a duplicate', async () => {
    const { resolver } = tableResolver({ 'doi:10.3847/1538-4357/ad7d0f': DASH_2024 })
    const known = await sb.lib.importPdf(sb.pdf('pub.pdf', [DASH_PAGE]), { resolver })
    const loose = await sb.lib.importPdf(sb.pdf('other.pdf', [[...DASH_PAGE, 'extra']]), {
      tags: ['keep-me']
    })
    const out = await sb.lib.resolvePaper(loose.paperId, resolver)
    expect(out).toMatchObject({ status: 'merged', paperId: known.paperId })
    expect(sb.lib.getPaper(loose.paperId)).toBeUndefined()
    expect(sb.lib.summary(known.paperId).tags).toEqual(['Dash24', 'keep-me'])
    expect(sb.lib.summary(known.paperId).files).toHaveLength(2)
  })
})

describe('search', () => {
  it('finds papers by title, author, tag and body text, ranking title matches first', async () => {
    const { resolver } = tableResolver({ 'doi:10.3847/1538-4357/ad7d0f': DASH_2024 })
    const dash = await sb.lib.importPdf(sb.pdf('a.pdf', [DASH_PAGE, ['meridional circulation']]), {
      resolver,
      tags: ['assimilation']
    })
    const other = await sb.lib.importPdf(
      sb.pdf('b.pdf', [['Coronal loops'], ['we mention a Kalman filter in passing']])
    )

    expect(sb.lib.search('kalman').map((h) => h.paper.id)).toEqual([dash.paperId, other.paperId])
    expect(sb.lib.search('DeRosa').map((h) => h.paper.id)).toEqual([dash.paperId])
    expect(sb.lib.search('meridion').map((h) => h.paper.id)).toEqual([dash.paperId])
    expect(sb.lib.search('assimilation')[0]?.paper.id).toBe(dash.paperId)
    expect(sb.lib.search('   ')).toEqual([])
  })

  it('tolerates FTS syntax characters in user input', () => {
    expect(toFtsQuery('flux "transport" AND (NEAR* -x')).toBe(
      '"flux"* "transport"* "AND"* "NEAR"* "x"*'
    )
    expect(() => sb.lib.search('") OR *')).not.toThrow()
  })

  it('reflects tag changes', async () => {
    const r = await sb.lib.importPdf(sb.pdf('a.pdf', [['text']]))
    sb.lib.addTags(r.paperId, ['CryoNIRSP'])
    expect(sb.lib.search('cryonirsp')).toHaveLength(1)
    sb.lib.removeTags(r.paperId, ['CryoNIRSP'])
    expect(sb.lib.search('cryonirsp')).toHaveLength(0)
    expect(sb.lib.db.prepare('SELECT count(*) n FROM tags').get()).toEqual({ n: 0 })
  })
})

describe('verify', () => {
  it('reports missing, altered and untracked files', async () => {
    const a = await sb.lib.importPdf(sb.pdf('a.pdf', [['alpha']]))
    const b = await sb.lib.importPdf(sb.pdf('b.pdf', [['beta']]))
    expect(await sb.lib.verify({ deep: true })).toEqual([])

    renameSync(join(sb.lib.root, a.relPath), join(sb.lib.filesDir, 'moved.pdf'))
    const bPath = join(sb.lib.root, b.relPath)
    const bytes = readFileSync(bPath)
    bytes[bytes.length - 2] = 0x20
    writeFileSync(bPath, bytes)

    const issues = await sb.lib.verify({ deep: true })
    expect(issues).toEqual(
      expect.arrayContaining([
        { kind: 'missing-file', relPath: a.relPath, paperId: a.paperId },
        { kind: 'hash-mismatch', relPath: b.relPath },
        { kind: 'untracked-file', relPath: 'files/moved.pdf' }
      ])
    )
  })

  it('persists across handles', async () => {
    const r = await sb.lib.importPdf(sb.pdf('a.pdf', [['persist me']]), { tags: ['t'] })
    const second = Library.open(sb.lib.root)
    try {
      expect(second.summary(r.paperId).tags).toEqual(['t'])
      expect(second.search('persist')).toHaveLength(1)
    } finally {
      second.close()
    }
  })
})
