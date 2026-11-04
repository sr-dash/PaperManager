import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectOrigin } from '../src/core/origin.js'
import { runQuery } from '../src/core/query.js'
import { DASH_2024, makePdf, sandbox, type Sandbox } from './helpers.js'

let sb: Sandbox
beforeEach(() => {
  sb = sandbox()
})
afterEach(() => sb.cleanup())

const STAMP = 'arXiv:2409.09000v2 [astro-ph.SR] 17 Sep 2024'
const preprint = () =>
  sb.pdf(`pre-${Math.random()}.pdf`, [[STAMP, 'Ensemble Kalman filter (preprint)']])
const published = () =>
  sb.pdf(`pub-${Math.random()}.pdf`, [
    [
      'The Astrophysical Journal',
      'https://doi.org/10.3847/1538-4357/ad7d0f',
      'Ensemble Kalman filter'
    ]
  ])
// A stand-in for the Trash that really moves files out, as the app does.
const trash = () => {
  const gone: string[] = []
  return {
    gone,
    dispose: async (p: string) => {
      mkdirSync(join(sb.dir, 'trash'), { recursive: true })
      renameSync(p, join(sb.dir, 'trash', `${gone.length}-${basename(p)}`))
      gone.push(p)
    }
  }
}

describe('file origins', () => {
  it('recognises arXiv stamps, publisher DOIs, and neither', () => {
    expect(detectOrigin(`${STAMP}\nTitle`)).toBe('arxiv')
    expect(detectOrigin('arXiv:2409.09000 is mentioned in passing, doi:10.1086/345678')).toBe(
      'publisher'
    )
    expect(detectOrigin('Old scanned article with no identifiers')).toBe('unknown')
    expect(detectOrigin('', 'doi:10.1086/12345')).toBe('publisher')
  })

  it('are recorded on import and order the files: publisher first, e-print last', async () => {
    const a = await sb.lib.importPdf(preprint(), { resolved: DASH_2024 })
    await sb.lib.importPdf(published(), { attachTo: a.paperId })
    const files = sb.lib.filesOf(a.paperId)
    expect(files.map((f) => [f.origin, f.rel_path])).toEqual([
      ['publisher', 'files/Dash_2024_ApJ_975_288.pdf'],
      ['arxiv', 'files/Dash_2024_ApJ_975_288-b.pdf']
    ])
    expect(sb.lib.listRows()[0]?.pdf_origin).toBe('publisher')
    expect(await sb.lib.verify({ deep: true })).toEqual([])
  })
})

describe('replacing a file', () => {
  it('swaps an arXiv PDF for a downloaded journal PDF under the canonical name', async () => {
    const a = await sb.lib.importPdf(preprint(), { resolved: DASH_2024 })
    const [old] = sb.lib.filesOf(a.paperId)
    const src = published()
    const t = trash()
    const r = await sb.lib.replaceFile(old!.id, src, t.dispose)
    expect(r.relPath).toBe('files/Dash_2024_ApJ_975_288.pdf')
    const files = sb.lib.filesOf(a.paperId)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ origin: 'publisher', original_name: src.split('/').pop() })
    expect(readFileSync(join(sb.lib.root, r.relPath))).toEqual(readFileSync(src))
    expect(t.gone).toHaveLength(1)
    expect(existsSync(src)).toBe(true) // the download itself is left alone
    expect(await sb.lib.verify({ deep: true })).toEqual([])
  })

  it('refuses the same bytes, non-PDFs, and PDFs filed under another paper', async () => {
    const a = await sb.lib.importPdf(preprint(), { resolved: DASH_2024 })
    const [old] = sb.lib.filesOf(a.paperId)
    const t = trash()
    const same = join(sb.dir, 'same.pdf')
    writeFileSync(same, readFileSync(join(sb.lib.root, old!.rel_path)))
    await expect(sb.lib.replaceFile(old!.id, same, t.dispose)).rejects.toThrow(/same file/)
    const html = join(sb.dir, 'login.pdf')
    writeFileSync(html, '<html>Sign in</html>')
    await expect(sb.lib.replaceFile(old!.id, html, t.dispose)).rejects.toThrow(/Not a PDF/)
    const other = await sb.lib.importPdf(sb.pdf('other.pdf', [['another paper']]))
    const otherFile = join(sb.lib.root, other.relPath)
    await expect(sb.lib.replaceFile(old!.id, otherFile, t.dispose)).rejects.toThrow(/another paper/)
    expect(t.gone).toEqual([])
  })

  it('renames the remaining files when one is removed', async () => {
    const a = await sb.lib.importPdf(published(), { resolved: DASH_2024 })
    await sb.lib.importPdf(preprint(), { attachTo: a.paperId })
    const [pub] = sb.lib.filesOf(a.paperId)
    await sb.lib.removeFile(pub!.id, trash().dispose)
    expect(sb.lib.filesOf(a.paperId).map((f) => f.rel_path)).toEqual([
      'files/Dash_2024_ApJ_975_288.pdf'
    ])
    expect(await sb.lib.verify()).toEqual([])
  })
})

describe('publisher PDFs replacing preprints', () => {
  it('drop the arXiv PDF when a publisher PDF of the same paper arrives', async () => {
    const a = await sb.lib.importPdf(preprint(), { resolved: DASH_2024 })
    const t = trash()
    const r = await sb.lib.importPdf(published(), {
      resolved: DASH_2024,
      replacePreprints: t.dispose
    })
    expect(r).toMatchObject({
      status: 'attached',
      paperId: a.paperId,
      relPath: 'files/Dash_2024_ApJ_975_288.pdf'
    })
    expect(r.replaced).toHaveLength(1)
    expect(t.gone).toHaveLength(1)
    expect(sb.lib.filesOf(a.paperId).map((f) => f.origin)).toEqual(['publisher'])
  })

  it('keep an e-print that carries annotations', async () => {
    const annotated = sb.pdf('annotated.pdf', [[STAMP, 'Text']], {}, [
      { page: 0, subtype: 'Highlight', box: [72, 737, 150, 750] }
    ])
    const a = await sb.lib.importPdf(annotated, { resolved: DASH_2024 })
    const t = trash()
    const r = await sb.lib.importPdf(published(), {
      resolved: DASH_2024,
      replacePreprints: t.dispose
    })
    expect(r.replaced).toEqual([])
    expect(sb.lib.filesOf(a.paperId).map((f) => f.origin)).toEqual(['publisher', 'arxiv'])
  })

  it('leave everything alone without the option', async () => {
    const a = await sb.lib.importPdf(preprint(), { resolved: DASH_2024 })
    await sb.lib.importPdf(published(), { resolved: DASH_2024 })
    expect(sb.lib.filesOf(a.paperId)).toHaveLength(2)
  })

  it('are findable: is:preprint lists papers with only an arXiv PDF', async () => {
    const a = await sb.lib.importPdf(preprint(), { resolved: DASH_2024 })
    await sb.lib.importPdf(sb.pdf('x.pdf', [['doi:10.1/other', 'Other paper']]))
    expect(runQuery(sb.lib, 'is:preprint').map((h) => h.id)).toEqual([a.paperId])
  })
})
