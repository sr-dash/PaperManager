import { existsSync, mkdirSync, renameSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { classify } from '../src/core/classify.js'
import { Inbox, inspectPdf } from '../src/core/inbox.js'
import type { PdfSample } from '../src/core/pdf.js'
import { DASH_2024, makePdf, sandbox, tableResolver, type Sandbox } from './helpers.js'

const sample = (over: Partial<PdfSample>): PdfSample => ({
  pageCount: 12,
  info: '',
  firstPage: '',
  opening: '',
  closing: '',
  ...over
})

const PAPER_PAGE_1 = [
  'The Astrophysical Journal, 975:288 (2024)',
  'https://doi.org/10.3847/1538-4357/ad7d0f',
  'Ensemble Kalman Filter Data Assimilation into a Flux Transport Model',
  'Soumyaranjan Dash, Institute for Astronomy, University of Hawaii',
  'Received 2024 May 1; revised 2024 July 2; accepted 2024 July 9',
  'Abstract',
  'We assimilate synthetic magnetograms into a surface flux transport model and more words here.',
  'Unified Astronomy Thesaurus concepts: Solar magnetic fields',
  '1. Introduction',
  'The solar cycle is driven by the emergence and transport of magnetic flux across the surface.'
]
const paperPages = [
  PAPER_PAGE_1,
  ['Methods text'],
  ['Results text'],
  ['References', 'Babcock, H. W. 1961, ApJ, 133, 572']
]

describe('classify', () => {
  it('recognises a journal article and explains why', () => {
    const c = classify(
      sample({
        firstPage: PAPER_PAGE_1.join('\n'),
        opening: PAPER_PAGE_1.join('\n'),
        closing: 'References\nBabcock, H. W. 1961, ApJ, 133, 572'
      }),
      'download.pdf'
    )
    expect(c.verdict).toBe('paper')
    expect(c.reasons).toEqual(
      expect.arrayContaining([
        '+3 DOI or arXiv id on page 1',
        '+1.5 has an abstract',
        '+1.5 has a reference list'
      ])
    )
    expect(c.identifiers[0]).toMatchObject({ kind: 'doi', value: '10.3847/1538-4357/ad7d0f' })
  })

  it('trusts files named by their identifier, even scans without text', () => {
    expect(classify(sample({ pageCount: 9 }), '1987A&A...180..241S.pdf').verdict).toBe('paper')
    expect(classify(sample({ pageCount: 9 }), '2508.11013v1.pdf').verdict).toBe('paper')
  })

  it('rejects figures, receipts and personal records', () => {
    expect(classify(sample({ pageCount: 1, opening: 'x' }), 'null_timeseries.pdf').verdict).toBe(
      'other'
    )
    const receipt = 'Payment receipt\nAmount paid: 120.00\nTransaction id 123'
    expect(
      classify(sample({ pageCount: 1, firstPage: receipt, opening: receipt }), 'x.pdf').verdict
    ).toBe('other')
    const scholarlyish = PAPER_PAGE_1.join('\n')
    expect(
      classify(sample({ firstPage: scholarlyish, opening: scholarlyish }), 'Soumya_CV.pdf').verdict
    ).not.toBe('paper')
  })

  it('treats theses as literature despite degree wording', () => {
    const page =
      'A thesis submitted for the degree of Doctor of Philosophy\nDepartment of Physics\nAbstract\n' +
      'text '.repeat(60)
    expect(
      classify(sample({ pageCount: 180, firstPage: page, opening: page }), 'yeates.pdf').verdict
    ).toBe('paper')
  })

  it('drops the title of anything judged not a paper', () => {
    const c = classify(
      sample({ pageCount: 1, infoTitle: 'Bank statement for March 2026' }),
      'statement.pdf'
    )
    expect(c.verdict).toBe('other')
    expect(c.title).toBeUndefined()
  })
})

describe('Inbox', () => {
  let sb: Sandbox
  let downloads: string
  let inbox: Inbox
  const put = (name: string, pages: string[][], info: Record<string, string> = {}) => {
    const p = join(downloads, name)
    writeFileSync(p, makePdf(pages, info))
    return p
  }

  beforeEach(() => {
    sb = sandbox()
    downloads = join(sb.dir, 'Downloads')
    mkdirSync(downloads)
    inbox = new Inbox(sb.lib, [downloads])
  })
  afterEach(() => sb.cleanup())

  it('classifies what is in the folder and skips non-PDFs and dotfiles', async () => {
    put('article.pdf', paperPages)
    put('plot.pdf', [['']])
    writeFileSync(join(downloads, 'notes.txt'), 'x')
    writeFileSync(join(downloads, '.hidden.pdf'), makePdf([['x']]))
    const items = await inbox.scan()
    expect(items.map((i) => [i.name, i.verdict, i.state])).toEqual(
      expect.arrayContaining([
        ['article.pdf', 'paper', 'pending'],
        ['plot.pdf', 'other', 'pending']
      ])
    )
    expect(items).toHaveLength(2)
  })

  it('only re-inspects files whose size or mtime changed', async () => {
    const p = put('article.pdf', paperPages)
    put('other.pdf', [['x']])
    const inspected: string[] = []
    const spy = async (path: string) => (inspected.push(path), inspectPdf(path))
    await inbox.scan({ inspect: spy })
    expect(inspected).toHaveLength(2)

    inspected.length = 0
    await inbox.scan({ inspect: spy })
    expect(inspected).toEqual([])

    utimesSync(p, new Date(), new Date(Date.now() + 5000))
    await inbox.scan({ inspect: spy })
    expect(inspected).toEqual([p])
  })

  it('forgets files that leave the folder', async () => {
    const p = put('article.pdf', paperPages)
    await inbox.scan()
    renameSync(p, join(sb.dir, 'moved.pdf'))
    expect(await inbox.scan()).toEqual([])
  })

  it('files a paper using identifiers found during the scan, leaving the original', async () => {
    const p = put('download (3).pdf', paperPages)
    await inbox.scan()
    const { resolver, calls } = tableResolver({ 'doi:10.3847/1538-4357/ad7d0f': DASH_2024 })
    const [out] = await inbox.accept([p], { resolver, tags: ['inbox'] })
    expect(out?.result).toMatchObject({
      status: 'imported',
      relPath: 'files/Dash_2024_ApJ_975_288.pdf'
    })
    expect(calls[0]?.[0]).toMatchObject({ kind: 'doi', origin: 'hint' })
    expect(existsSync(p)).toBe(true)
    expect(inbox.item(p)?.state).toBe('filed')
    expect(sb.lib.tagsOf(out!.result!.paperId)).toEqual(['Dash24', 'inbox'])
  })

  it('disposes of originals after filing only when asked to', async () => {
    const p = put('a.pdf', paperPages)
    await inbox.scan()
    const disposed: string[] = []
    inbox.trashAfterFiling = true
    const [out] = await inbox.accept([p], { dispose: async (x) => void disposed.push(x) })
    expect(out?.disposed).toBe(true)
    expect(disposed).toEqual([p])
    expect(inbox.item(p)).toBeUndefined()
  })

  it('refuses paths that are not inbox items', async () => {
    const outside = sb.pdf('elsewhere.pdf', [['x']])
    const [out] = await inbox.accept([outside])
    expect(out).toEqual({ path: outside, error: 'Not in the inbox' })
  })

  it('remembers ignored files by content, across renames', async () => {
    const p = put('ad.pdf', [['Advertisement']])
    await inbox.scan()
    inbox.ignore([p])
    expect(inbox.item(p)?.state).toBe('ignored')
    renameSync(p, join(downloads, 'ad (1).pdf'))
    const items = await inbox.scan()
    expect(items.map((i) => [i.name, i.state])).toEqual([['ad (1).pdf', 'ignored']])
    inbox.unignore([join(downloads, 'ad (1).pdf')])
    expect(inbox.items()[0]?.state).toBe('pending')
  })

  it('cleans up originals already in the library, re-checking their bytes', async () => {
    const same = put('dup.pdf', paperPages)
    await sb.lib.importPdf(same)
    const changed = put('changed.pdf', [['v1']])
    await sb.lib.importPdf(changed)
    await inbox.scan()
    writeFileSync(changed, makePdf([['v2, edited after scanning']])) // cache is now stale
    const disposed: string[] = []
    const n = await inbox.disposeFiled(async (x) => void disposed.push(x))
    expect(n).toBe(1)
    expect(disposed).toEqual([same])
  })

  it('looks in subfolders but never inside the library', async () => {
    mkdirSync(join(downloads, 'Topic', 'Deeper'), { recursive: true })
    put(join('Topic', 'Deeper', 'nested.pdf'), [['A different nested paper'], ...paperPages])
    const inside = new Inbox(sb.lib, [sb.dir]) // a parent of both Downloads and the library
    await sb.lib.importPdf(put('filed.pdf', paperPages))
    const names = (await inside.scan()).map((i) => i.name).sort()
    expect(names).toEqual(['filed.pdf', 'nested.pdf'])
    expect(names.some((n) => n.startsWith('Dash_2024'))).toBe(false)
  })

  it("carries tags and ADS links from an old app's papers.json beside the file", async () => {
    const p = put('4A4D7DC1.pdf', [['no identifiers on this page']])
    writeFileSync(
      join(downloads, 'papers.json'),
      JSON.stringify([
        {
          id: 'x',
          fileName: '4A4D7DC1.pdf',
          title: 't',
          tags: ['corona', 'He1080'],
          adsURLString: 'https://ui.adsabs.harvard.edu/abs/2024ApJ...975..288D/abstract'
        }
      ])
    )
    await inbox.scan()
    const { resolver } = tableResolver({ 'bibcode:2024ApJ...975..288D': DASH_2024 })
    const [out] = await inbox.accept([p], { resolver })
    expect(out?.result?.metadataStatus).toBe('resolved')
    expect(sb.lib.tagsOf(out!.result!.paperId)).toEqual(['corona', 'Dash24', 'He1080'])
  })

  it('stores folder settings and drops cache rows outside them', async () => {
    put('a.pdf', paperPages)
    await inbox.scan()
    const other = join(sb.dir, 'Papers')
    mkdirSync(other)
    inbox.setFolders([other])
    expect(inbox.folders()).toEqual([other])
    expect(inbox.items()).toEqual([])
    expect(new Inbox(sb.lib, [downloads]).folders()).toEqual([other])
  })
})

describe('Inbox duplicates', () => {
  let sb: Sandbox
  beforeEach(() => {
    sb = sandbox()
  })
  afterEach(() => sb.cleanup())

  it('lists identical files once, and cleans up every copy once filed', async () => {
    const a = join(sb.dir, 'A')
    const b = join(sb.dir, 'B')
    mkdirSync(a)
    mkdirSync(b)
    const bytes = makePdf(paperPages)
    writeFileSync(join(a, 'paper.pdf'), bytes)
    writeFileSync(join(a, 'paper (1).pdf'), bytes)
    writeFileSync(join(b, 'Dash_2024.pdf'), bytes)
    const inbox = new Inbox(sb.lib, [a, b])
    const items = await inbox.scan()
    expect(items).toHaveLength(1)
    expect(items[0]!.copies).toHaveLength(2)

    await inbox.accept([join(b, 'Dash_2024.pdf')])
    const disposed: string[] = []
    expect(await inbox.disposeFiled(async (p) => void disposed.push(p))).toBe(3)
    expect(inbox.items()).toEqual([])
  })
})

describe('title guesses', () => {
  it('stop before an Abstract heading set in the same large type', async () => {
    const { readPdfSample } = await import('../src/core/pdf.js')
    const sb = sandbox()
    try {
      const p = sb.pdf('x.pdf', [['FLUX BUDGET OR FLUX CONCENTRATION ABSTRACT The quiet Sun']])
      expect((await readPdfSample(p)).headline).toBe('FLUX BUDGET OR FLUX CONCENTRATION')
    } finally {
      sb.cleanup()
    }
  })
})
