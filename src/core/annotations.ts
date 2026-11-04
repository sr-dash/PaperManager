/**
 * The annotation index: highlights, notes and drawings found inside each library PDF,
 * kept in the database so they can be listed, searched and exported across the library.
 * The PDF stays the source of truth; the index is rebuilt whenever a file's bytes change.
 */
import { join } from 'node:path'
import { transaction } from './db/database.js'
import type { Library } from './library.js'
import { readPdfAnnotations, type PdfAnnotation } from './pdf.js'

export interface IndexedAnnotation extends PdfAnnotation {
  id: number
  fileId: number
  paperId: number
  paperTitle: string | null
  citeLabel: string
}

/** Files whose index is missing or was built from different bytes. */
export function staleAnnotationFiles(lib: Library): { id: number; path: string; sha256: string }[] {
  const rows = lib.db
    .prepare(
      `SELECT id, rel_path, sha256 FROM files
       WHERE annotations_sha IS NULL OR annotations_sha != sha256`
    )
    .all() as { id: number; rel_path: string; sha256: string }[]
  return rows.map((r) => ({ id: r.id, path: join(lib.root, r.rel_path), sha256: r.sha256 }))
}

/** Store what was read from a file, if the file has not changed since it was read. */
export function storeAnnotations(
  lib: Library,
  fileId: number,
  sha256: string,
  anns: PdfAnnotation[]
): boolean {
  return transaction(lib.db, () => {
    const cur = lib.db.prepare('SELECT sha256 FROM files WHERE id = ?').get(fileId) as
      { sha256: string } | undefined
    if (!cur || cur.sha256 !== sha256) return false
    lib.db.prepare('DELETE FROM annotations WHERE file_id = ?').run(fileId)
    const insert = lib.db.prepare(
      'INSERT INTO annotations (file_id, page, kind, color, text, comment, y) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    for (const a of anns) {
      insert.run(fileId, a.page, a.kind, a.color ?? null, a.text ?? null, a.comment ?? null, a.y)
    }
    lib.db.prepare('UPDATE files SET annotations_sha = ? WHERE id = ?').run(sha256, fileId)
    return true
  })
}

/** Read and store one file's annotations now. */
export async function indexFileAnnotations(lib: Library, fileId: number): Promise<void> {
  const f = staleAnnotationFiles(lib).find((x) => x.id === fileId)
  if (!f) return
  const anns = await readPdfAnnotations(f.path).catch(() => [])
  storeAnnotations(lib, f.id, f.sha256, anns)
}

export function listAnnotations(
  lib: Library,
  opts: { paperId?: number; search?: string; includeDrawings?: boolean } = {}
): IndexedAnnotation[] {
  const where: string[] = []
  const params: (string | number)[] = []
  if (opts.paperId !== undefined) {
    where.push('f.paper_id = ?')
    params.push(opts.paperId)
  }
  if (!opts.includeDrawings) where.push("a.kind != 'drawing'")
  if (opts.search?.trim()) {
    where.push(
      "(a.text LIKE ? ESCAPE '\\' OR a.comment LIKE ? ESCAPE '\\' OR p.title LIKE ? ESCAPE '\\')"
    )
    const like = `%${opts.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    params.push(like, like, like)
  }
  const rows = lib.db
    .prepare(
      `SELECT a.id, a.file_id, f.paper_id, a.page, a.kind, a.color, a.text, a.comment, a.y,
              p.title, p.year,
              (SELECT family FROM authors au WHERE au.paper_id = p.id ORDER BY position LIMIT 1) AS family
       FROM annotations a JOIN files f ON f.id = a.file_id JOIN papers p ON p.id = f.paper_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY p.added_at DESC, f.paper_id, a.page, a.y`
    )
    .all(...params) as {
    id: number
    file_id: number
    paper_id: number
    page: number
    kind: PdfAnnotation['kind']
    color: string | null
    text: string | null
    comment: string | null
    y: number
    title: string | null
    year: number | null
    family: string | null
  }[]
  return rows.map((r) => ({
    id: r.id,
    fileId: r.file_id,
    paperId: r.paper_id,
    page: r.page,
    kind: r.kind,
    color: r.color ?? undefined,
    text: r.text ?? undefined,
    comment: r.comment ?? undefined,
    y: r.y,
    paperTitle: r.title,
    citeLabel: [r.family, r.year].filter(Boolean).join(' ') || `#${r.paper_id}`
  }))
}

/** Markdown for notes or a literature review: grouped by paper, quotes with page numbers. */
export function annotationsToMarkdown(items: IndexedAnnotation[]): string {
  const out: string[] = []
  let current: number | undefined
  for (const a of items) {
    if (a.paperId !== current) {
      current = a.paperId
      out.push(`${out.length ? '\n' : ''}## ${a.citeLabel}: ${a.paperTitle ?? 'Untitled'}\n`)
    }
    const where = `(p. ${a.page})`
    if (a.kind === 'drawing') out.push(`- *Drawing* ${where}`)
    else if (a.kind === 'note' || a.kind === 'text')
      out.push(`- **Note:** ${a.text ?? a.comment ?? ''} ${where}`)
    else {
      out.push(`- > ${a.text ?? '(highlight)'} ${where}`)
      if (a.comment) out.push(`  - ${a.comment}`)
    }
  }
  return out.join('\n') + '\n'
}
