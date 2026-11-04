import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Library } from '../src/core/library.js'
import type { Resolver } from '../src/core/metadata/resolver.js'
import type { Identifier, ResolvedMetadata } from '../src/core/types.js'
import { makePdf, type FixtureAnnotation } from './pdf-fixture.js'

export { makePdf }

export interface Sandbox {
  dir: string
  lib: Library
  /** Write a PDF into the sandbox's source area and return its path. */
  pdf(
    name: string,
    pages: string[][],
    info?: Record<string, string>,
    annotations?: FixtureAnnotation[]
  ): string
  cleanup(): void
}

export function sandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'pm-test-'))
  const lib = Library.open(join(dir, 'library'))
  return {
    dir,
    lib,
    pdf(name, pages, info, annotations) {
      const p = join(dir, name)
      writeFileSync(p, makePdf(pages, info, annotations))
      return p
    },
    cleanup() {
      lib.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

/** A resolver backed by a lookup table, recording the identifiers it was asked about. */
export function tableResolver(table: Record<string, ResolvedMetadata>) {
  const calls: Identifier[][] = []
  const resolver: Resolver = async (ids) => {
    calls.push([...ids])
    for (const id of ids) {
      const hit = table[`${id.kind}:${id.value}`]
      if (hit) return { resolved: hit, errors: [] }
    }
    return { resolved: null, errors: [] }
  }
  return { resolver, calls }
}

export const DASH_2024: ResolvedMetadata = {
  source: 'ads',
  metadata: {
    bibcode: '2024ApJ...975..288D',
    title:
      'Ensemble Kalman Filter Data Assimilation into the Surface Flux Transport Model to Infer Surface Flows',
    authors: [
      { family: 'Dash', given: 'Soumyaranjan' },
      { family: 'DeRosa', given: 'Marc L.' }
    ],
    year: 2024,
    journal: 'The Astrophysical Journal',
    journalAbbrev: 'ApJ',
    volume: '975',
    page: '288',
    doi: '10.3847/1538-4357/ad7d0f',
    arxivId: '2409.09000',
    abstract: 'We assimilate synthetic magnetograms to infer meridional flow.'
  }
}
