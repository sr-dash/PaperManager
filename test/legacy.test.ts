import { mkdirSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  importLegacyRecords,
  parsePythonBibInfo,
  readPythonLibrary,
  readSwiftLibrary
} from '../src/core/legacy.js'
import { DASH_2024, makePdf, sandbox, tableResolver, type Sandbox } from './helpers.js'

let sb: Sandbox
beforeEach(() => {
  sb = sandbox()
})
afterEach(() => sb.cleanup())

// Exactly the layout ads_fetcher.py produced.
const PY_BIB_INFO = [
  '📄 Title:\nEnsemble Kalman Filter Data Assimilation',
  '\n👨‍🔬 Authors (2):\n- Dash, Soumyaranjan\n- DeRosa, Marc L.',
  '\n📘 Journal:\nThe Astrophysical Journal',
  '\n🗓 Published:\n11/2024',
  '\n🔗 URL:\nhttps://ui.adsabs.harvard.edu/abs/2024ApJ...975..288D/abstract'
].join('\n\n')

describe('PyQt library', () => {
  it('parses the emoji-sectioned bib_info text', () => {
    expect(parsePythonBibInfo(PY_BIB_INFO)).toEqual({
      title: 'Ensemble Kalman Filter Data Assimilation',
      authors: ['Dash, Soumyaranjan', 'DeRosa, Marc L.'],
      journal: 'The Astrophysical Journal',
      year: 2024,
      bibcode: '2024ApJ...975..288D'
    })
    expect(parsePythonBibInfo('')).toEqual({
      title: undefined,
      authors: [],
      journal: undefined,
      year: undefined,
      bibcode: undefined
    })
  })

  it('reads papers and de-duplicated tags, finding PDFs beside a moved database', () => {
    const root = join(sb.dir, 'PaperManager_copy')
    mkdirSync(join(root, 'db'), { recursive: true })
    mkdirSync(join(root, 'papers'))
    writeFileSync(join(root, 'papers', 'Dash_2024_ApJ_975_288.pdf'), makePdf([['x']]))
    const db = new DatabaseSync(join(root, 'db', 'papers.db'))
    db.exec(`CREATE TABLE papers (id INTEGER PRIMARY KEY, filename TEXT, path TEXT, bib_info TEXT, date_added TEXT);
             CREATE TABLE tags (paper_id INTEGER, tag TEXT);`)
    db.prepare('INSERT INTO papers VALUES (1, ?, ?, ?, ?)').run(
      'Dash_2024_ApJ_975_288.pdf',
      '/elsewhere/papers/Dash_2024_ApJ_975_288.pdf',
      PY_BIB_INFO,
      '2025-06-27T12:49:42.232831'
    )
    db.exec("INSERT INTO tags VALUES (1, 'SFT'), (1, 'SFT'), (1, 'Dash24')")
    db.close()

    const [rec] = readPythonLibrary(join(root, 'db', 'papers.db'))
    expect(rec).toMatchObject({
      pdfPath: join(root, 'papers', 'Dash_2024_ApJ_975_288.pdf'),
      tags: ['SFT', 'Dash24'],
      bibcode: '2024ApJ...975..288D',
      fallback: { title: 'Ensemble Kalman Filter Data Assimilation', year: 2024 }
    })
    expect(rec?.addedAt).toMatch(/^2025-06-2\dT/)
  })
})

describe('Swift library', () => {
  it('reads papers.json, decoding HTML entities and Apple reference dates', async () => {
    const dir = join(sb.dir, 'PaperManagerPapers')
    mkdirSync(dir)
    writeFileSync(
      join(dir, 'papers.json'),
      JSON.stringify([
        {
          id: 'A',
          fileName: 'A.pdf',
          title: 'Schad_2024_sciadv',
          tags: ['Schad24', 'CryoNIRSP'],
          modifiedDate: 748475553.77,
          adsURLString: 'https://ui.adsabs.harvard.edu/abs/2024SciA...10.1604S/abstract',
          firstAuthor: 'Schad, Thomas A.',
          journal: 'Science Advances',
          year: '09/2024',
          bibTitle: 'Mapping the Sun&#39;s coronal magnetic field'
        },
        { id: 'B', fileName: 'B.pdf', title: 'untagged', tags: [] }
      ])
    )
    const [a, b] = await readSwiftLibrary(dir)
    expect(a).toMatchObject({
      pdfPath: join(dir, 'A.pdf'),
      tags: ['Schad24', 'CryoNIRSP'],
      bibcode: '2024SciA...10.1604S',
      addedAt: '2024-09-19T21:52:33.770Z',
      fallback: {
        title: "Mapping the Sun's coronal magnetic field",
        authors: [{ family: 'Schad', given: 'Thomas A.' }],
        year: 2024
      }
    })
    expect(b).toMatchObject({ bibcode: undefined, fallback: { title: 'untagged', authors: [] } })
  })
})

describe('importLegacyRecords', () => {
  it('resolves via the legacy bibcode, keeps tags and dates, and reports missing files', async () => {
    const pdf = sb.pdf('4A4D7DC1.pdf', [['no ids on this page']])
    const { resolver, calls } = tableResolver({ 'bibcode:2024ApJ...975..288D': DASH_2024 })
    const report = await importLegacyRecords(
      sb.lib,
      'test',
      [
        {
          pdfPath: pdf,
          tags: ['SFT'],
          addedAt: '2025-06-27T12:49:42.000Z',
          bibcode: '2024ApJ...975..288D',
          fallback: { title: 'ignored when resolved', authors: [] }
        },
        { pdfPath: join(sb.dir, 'gone.pdf'), tags: [], fallback: { authors: [] } }
      ],
      resolver
    )
    expect(calls[0]?.[0]).toEqual({ kind: 'bibcode', value: '2024ApJ...975..288D', origin: 'hint' })
    expect(report.results[0]).toMatchObject({
      status: 'imported',
      relPath: 'files/Dash_2024_ApJ_975_288.pdf',
      metadataStatus: 'resolved'
    })
    expect(report.failures).toEqual([
      { pdfPath: join(sb.dir, 'gone.pdf'), error: 'file not found' }
    ])
    const paper = sb.lib.summary(report.results[0]!.paperId)
    expect(paper).toMatchObject({
      added_at: '2025-06-27T12:49:42.000Z',
      tags: ['Dash24', 'SFT']
    })
  })
})
