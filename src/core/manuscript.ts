/**
 * Manuscript bibliographies: read the \cite keys of a LaTeX project, match each to the
 * library, and write the project's .bib from it.
 *
 * Matching, most reliable first: the key is an ADS bibcode of a library paper; the key's
 * entry in the project's existing .bib carries a DOI, ADS link or arXiv id that matches a
 * library paper; the key is the library's own cite key for a paper.
 *
 * Writing never loses anything: entries are rewritten under the manuscript's own keys,
 * keys the library cannot supply keep their existing entry verbatim, uncited entries are
 * kept at the end, and the previous file is saved as `<name>.bib.bak`.
 */
import { existsSync } from 'node:fs'
import { copyFile, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { citeKey, toBibtex } from './bibtex.js'
import { bibcodeFromAdsUrl, isBibcode, normalizeDoi } from './identifiers.js'
import type { Library } from './library.js'
import type { Identifier } from './types.js'

const MAX_DEPTH = 3
const CITE_RE = /\\(?:no)?cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/g
const BIB_RE = /\\(?:bibliography|addbibresource)\s*\{([^}]*)\}/g

export interface BibEntry {
  key: string
  type: string
  fields: Record<string, string>
  raw: string
}

export type KeyStatus = 'library' | 'bib-only' | 'missing'

export interface CitedKey {
  key: string
  status: KeyStatus
  paperId?: number | undefined
  /** An identifier that could fetch this reference from ADS, for keys not in the library. */
  identifier?: Identifier | undefined
}

export interface ManuscriptAnalysis {
  dir: string
  texFiles: string[]
  bibPath: string
  bibExists: boolean
  keys: CitedKey[]
}

export async function findTexFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string, depth: number): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const p = join(d, e.name)
      if (e.isDirectory() && depth < MAX_DEPTH) await walk(p, depth + 1)
      else if (e.isFile() && e.name.endsWith('.tex')) out.push(p)
    }
  }
  await walk(resolve(dir), 0)
  return out.sort()
}

/** Remove LaTeX comments (unescaped % to end of line). */
function stripComments(tex: string): string {
  return tex.replace(/(^|[^\\])%.*$/gm, '$1')
}

/** Cite keys in order of first appearance. */
export function extractCiteKeys(tex: string): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const m of stripComments(tex).matchAll(CITE_RE)) {
    for (const raw of m[1]!.split(',')) {
      const key = raw.trim()
      if (key && key !== '*' && !seen.has(key)) {
        seen.add(key)
        keys.push(key)
      }
    }
  }
  return keys
}

/** Minimal BibTeX reader: entries, keys and top-level fields, keeping each entry's raw text. */
export function parseBib(text: string): BibEntry[] {
  const entries: BibEntry[] = []
  let i = 0
  while ((i = text.indexOf('@', i)) !== -1) {
    const head = /^@(\w+)\s*([{(])/.exec(text.slice(i))
    if (!head) {
      i++
      continue
    }
    const type = head[1]!.toLowerCase()
    const open = i + head[0].length - 1
    const close = matchBracket(text, open)
    if (close === -1) break
    const raw = text.slice(i, close + 1)
    i = close + 1
    if (type === 'comment' || type === 'preamble' || type === 'string') continue
    const body = text.slice(open + 1, close)
    const comma = body.indexOf(',')
    if (comma === -1) continue
    entries.push({
      key: body.slice(0, comma).trim(),
      type,
      fields: parseFields(body.slice(comma + 1)),
      raw
    })
  }
  return entries
}

function matchBracket(s: string, open: number): number {
  const closeCh = s[open] === '(' ? ')' : '}'
  let depth = 0
  for (let j = open; j < s.length; j++) {
    const c = s[j]
    if (c === '{' || c === s[open]) depth++
    else if (c === '}' || c === closeCh) {
      depth--
      if (depth === 0) return j
    }
  }
  return -1
}

function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {}
  let i = 0
  while (i < body.length) {
    const m = /^\s*,?\s*([A-Za-z][\w-]*)\s*=\s*/.exec(body.slice(i))
    if (!m) break
    i += m[0].length
    let value = ''
    if (body[i] === '{') {
      const end = matchBracket(body, i)
      if (end === -1) break
      value = body.slice(i + 1, end)
      i = end + 1
    } else if (body[i] === '"') {
      const end = body.indexOf('"', i + 1)
      if (end === -1) break
      value = body.slice(i + 1, end)
      i = end + 1
    } else {
      const end = body.slice(i).search(/[,\n]/)
      value = body.slice(i, end === -1 ? undefined : i + end).trim()
      i = end === -1 ? body.length : i + end
    }
    fields[m[1]!.toLowerCase()] = value.trim()
  }
  return fields
}

/** Identifiers carried by a BibTeX entry (ADS exports have all three). */
export function entryIdentifiers(e: BibEntry): Identifier[] {
  const ids: Identifier[] = []
  const bib = e.fields.adsurl ? bibcodeFromAdsUrl(e.fields.adsurl) : undefined
  if (bib) ids.push({ kind: 'bibcode', value: bib, origin: 'hint' })
  if (e.fields.doi) ids.push({ kind: 'doi', value: normalizeDoi(e.fields.doi), origin: 'hint' })
  const eprint = e.fields.eprint?.replace(/^arXiv:/i, '')
  if (eprint && /^\d{4}\.\d{4,5}|\//.test(eprint))
    ids.push({ kind: 'arxiv', value: eprint, origin: 'hint' })
  return ids
}

async function locateBib(dir: string, texFiles: string[]): Promise<string> {
  for (const f of texFiles) {
    const tex = stripComments(await readFile(f, 'utf8').catch(() => ''))
    for (const m of tex.matchAll(BIB_RE)) {
      const first = m[1]!.split(',')[0]!.trim()
      if (!first) continue
      const name = first.endsWith('.bib') ? first : `${first}.bib`
      return resolve(dirname(f), name)
    }
  }
  return join(resolve(dir), 'references.bib')
}

export async function analyzeManuscript(lib: Library, dir: string): Promise<ManuscriptAnalysis> {
  const texFiles = await findTexFiles(dir)
  if (!texFiles.length) throw new Error('No .tex files in this folder')
  const keys: string[] = []
  const seen = new Set<string>()
  for (const f of texFiles) {
    for (const k of extractCiteKeys(await readFile(f, 'utf8'))) {
      if (!seen.has(k)) {
        seen.add(k)
        keys.push(k)
      }
    }
  }
  const bibPath = await locateBib(dir, texFiles)
  const bibExists = existsSync(bibPath)
  const existing = new Map(
    (bibExists ? parseBib(await readFile(bibPath, 'utf8')) : []).map((e) => [e.key, e])
  )
  const byCiteKey = libraryCiteKeys(lib)

  const cited: CitedKey[] = keys.map((key) => {
    const entry = existing.get(key)
    const entryIds = entry ? entryIdentifiers(entry) : []
    let paperId: number | undefined
    if (isBibcode(key)) paperId = lib.findByIds({ bibcode: key })
    for (const id of entryIds) {
      if (paperId !== undefined) break
      paperId = lib.findByIds({
        bibcode: id.kind === 'bibcode' ? id.value : undefined,
        doi: id.kind === 'doi' ? id.value : undefined,
        arxivId: id.kind === 'arxiv' ? id.value : undefined
      })
    }
    paperId ??= byCiteKey.get(key)
    if (paperId !== undefined) return { key, status: 'library', paperId }
    const identifier = isBibcode(key)
      ? ({ kind: 'bibcode', value: key, origin: 'hint' } as const)
      : entryIds[0]
    return { key, status: entry ? 'bib-only' : 'missing', identifier }
  })
  return { dir: resolve(dir), texFiles, bibPath, bibExists, keys: cited }
}

function libraryCiteKeys(lib: Library): Map<string, number> {
  const map = new Map<string, number>()
  const ids = lib.db.prepare('SELECT id FROM papers').all() as { id: number }[]
  for (const { id } of ids) map.set(citeKey(lib.metadataOf(id)), id)
  return map
}

/** Give an entry the manuscript's key, whatever key its source used. */
export function rekey(bibtex: string, key: string): string {
  return bibtex.replace(/^(\s*@\w+\s*\{)[^,]*,/, `$1${key},`)
}

export interface WriteResult {
  path: string
  fromLibrary: number
  kept: number
  missing: string[]
  backup?: string | undefined
}

export async function writeManuscriptBib(
  lib: Library,
  analysis: ManuscriptAnalysis
): Promise<WriteResult> {
  const existing = analysis.bibExists ? parseBib(await readFile(analysis.bibPath, 'utf8')) : []
  const byKey = new Map(existing.map((e) => [e.key, e]))
  const out: string[] = [
    `% Bibliography for ${analysis.dir}`,
    `% Written by PaperManager on ${new Date().toISOString().slice(0, 10)} from the library.`,
    '% Cited entries come first, in order of citation; uncited entries are kept at the end.',
    ''
  ]
  let fromLibrary = 0
  let kept = 0
  const missing: string[] = []
  const written = new Set<string>()
  for (const k of analysis.keys) {
    if (k.status === 'library' && k.paperId !== undefined) {
      out.push(rekey(toBibtex(lib.metadataOf(k.paperId)), k.key), '')
      fromLibrary++
    } else if (byKey.has(k.key)) {
      out.push(byKey.get(k.key)!.raw.trim(), '')
      kept++
    } else {
      missing.push(k.key)
      continue
    }
    written.add(k.key)
  }
  const uncited = existing.filter((e) => !written.has(e.key))
  if (uncited.length) {
    out.push('% ── Not cited in the manuscript (kept from the previous file) ──', '')
    for (const e of uncited) out.push(e.raw.trim(), '')
  }

  let backup: string | undefined
  if (analysis.bibExists) {
    backup = `${analysis.bibPath}.bak`
    await copyFile(analysis.bibPath, backup)
  }
  const tmp = `${analysis.bibPath}.pm-tmp`
  await writeFile(tmp, out.join('\n'), 'utf8')
  await rename(tmp, analysis.bibPath)
  return { path: analysis.bibPath, fromLibrary, kept, missing, backup }
}

// ── The list of projects ────────────────────────────────────────────────────

export interface Manuscript {
  id: number
  path: string
  lastSyncedAt: string | null
}

export function listManuscripts(lib: Library): Manuscript[] {
  return lib.db
    .prepare('SELECT id, path, last_synced_at AS lastSyncedAt FROM manuscripts ORDER BY path')
    .all() as unknown as Manuscript[]
}

export function addManuscript(lib: Library, dir: string): number {
  const path = resolve(dir)
  lib.db
    .prepare('INSERT OR IGNORE INTO manuscripts (path, added_at) VALUES (?, ?)')
    .run(path, new Date().toISOString())
  return (lib.db.prepare('SELECT id FROM manuscripts WHERE path = ?').get(path) as { id: number })
    .id
}

export function removeManuscript(lib: Library, id: number): void {
  lib.db.prepare('DELETE FROM manuscripts WHERE id = ?').run(id)
}

export function markSynced(lib: Library, id: number): void {
  lib.db
    .prepare('UPDATE manuscripts SET last_synced_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id)
}
