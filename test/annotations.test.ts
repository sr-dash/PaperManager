import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makePdf, sandbox, type Sandbox } from './helpers.js'

let sb: Sandbox
beforeEach(() => {
  sb = sandbox()
})
afterEach(() => sb.cleanup())

const fileOf = (paperId: number) => sb.lib.filesOf(paperId)[0]!

describe('annotated versions', () => {
  it('keeps the original once, replaces the file, and still recognises the download', async () => {
    const src = sb.pdf('paper.pdf', [['original text']])
    const r = await sb.lib.importPdf(src)
    const f = fileOf(r.paperId)
    const annotated = makePdf([['original text'], ['with highlights']])

    await sb.lib.saveFileVersion(f.id, annotated)
    const after = fileOf(r.paperId)
    expect(readFileSync(join(sb.lib.root, after.rel_path))).toEqual(annotated)
    expect(after.original_sha256).toBe(f.sha256)
    expect(existsSync(join(sb.lib.root, 'originals', `${f.sha256}.pdf`))).toBe(true)

    // A second save keeps the first original, not the intermediate version.
    await sb.lib.saveFileVersion(f.id, makePdf([['v3']]))
    expect(fileOf(r.paperId).original_sha256).toBe(f.sha256)

    // Re-importing the untouched download is still a duplicate of this paper.
    const again = await sb.lib.importPdf(src)
    expect(again).toMatchObject({ status: 'duplicate', paperId: r.paperId })
    expect(sb.lib.paperIdForHash(f.sha256)).toBe(r.paperId)
    expect(await sb.lib.verify({ deep: true })).toEqual([])
  })

  it('restores the original and drops the kept copy', async () => {
    const r = await sb.lib.importPdf(sb.pdf('paper.pdf', [['original']]))
    const f = fileOf(r.paperId)
    const originalBytes = readFileSync(join(sb.lib.root, f.rel_path))
    await sb.lib.saveFileVersion(f.id, makePdf([['annotated']]))
    await sb.lib.restoreOriginal(f.id)
    const after = fileOf(r.paperId)
    expect(after).toMatchObject({ sha256: f.sha256, original_sha256: null, size: f.size })
    expect(readFileSync(join(sb.lib.root, after.rel_path))).toEqual(originalBytes)
    expect(existsSync(join(sb.lib.root, 'originals', `${f.sha256}.pdf`))).toBe(false)
    expect(await sb.lib.verify({ deep: true })).toEqual([])
  })

  it('rejects non-PDF bytes and contents belonging to another file', async () => {
    const a = await sb.lib.importPdf(sb.pdf('a.pdf', [['a']]))
    const b = await sb.lib.importPdf(sb.pdf('b.pdf', [['b']]))
    await expect(
      sb.lib.saveFileVersion(fileOf(a.paperId).id, new TextEncoder().encode('<html>'))
    ).rejects.toThrow('Not a PDF')
    const bBytes = readFileSync(join(sb.lib.root, b.relPath))
    await expect(sb.lib.saveFileVersion(fileOf(a.paperId).id, bBytes)).rejects.toThrow(
      /already has/
    )
  })

  it('reports a missing kept original', async () => {
    const r = await sb.lib.importPdf(sb.pdf('a.pdf', [['a']]))
    const f = fileOf(r.paperId)
    await sb.lib.saveFileVersion(f.id, makePdf([['a2']]))
    const { rmSync } = await import('node:fs')
    rmSync(join(sb.lib.root, 'originals', `${f.sha256}.pdf`))
    expect(await sb.lib.verify()).toEqual([
      { kind: 'missing-original', relPath: f.rel_path, sha256: f.sha256 }
    ])
  })
})

describe('removeFile', () => {
  it('removes one of several files, with its kept original, but never the last', async () => {
    const r = await sb.lib.importPdf(sb.pdf('a.pdf', [['shared title'], ['v1']]), {
      fallback: {
        source: 'legacy',
        metadata: { authors: [{ family: 'Yang' }], year: 2024, doi: '10.1/x' }
      }
    })
    const second = await sb.lib.importPdf(sb.pdf('b.pdf', [['a second copy']]), {
      fallback: {
        source: 'legacy',
        metadata: { authors: [{ family: 'Yang' }], year: 2024, doi: '10.1/x' }
      }
    })
    expect(second.status).toBe('attached')
    const [first, extra] = sb.lib.filesOf(r.paperId)
    await sb.lib.saveFileVersion(extra!.id, makePdf([['annotated copy']]))

    const disposed: string[] = []
    await sb.lib.removeFile(extra!.id, async (p) => void disposed.push(p))
    expect(sb.lib.filesOf(r.paperId).map((f) => f.id)).toEqual([first!.id])
    expect(disposed).toEqual([
      join(sb.lib.root, extra!.rel_path),
      join(sb.lib.root, 'originals', `${extra!.sha256}.pdf`)
    ])
    await expect(sb.lib.removeFile(first!.id, async () => {})).rejects.toThrow(/only file/)
  })
})
