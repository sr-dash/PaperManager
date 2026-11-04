/**
 * Collections: named groups of papers. A manual collection lists its papers; a smart
 * collection stores a query (see query.ts) and contains whatever matches it right now.
 */
import { transaction } from './db/database.js'
import type { Library } from './library.js'
import { runQuery } from './query.js'

export interface Collection {
  id: number
  name: string
  query: string | null
  count: number
}

export function listCollections(lib: Library): Collection[] {
  const rows = lib.db
    .prepare(
      `SELECT c.id, c.name, c.query,
              (SELECT count(*) FROM collection_papers cp WHERE cp.collection_id = c.id) AS count
       FROM collections c ORDER BY c.name COLLATE NOCASE`
    )
    .all() as { id: number; name: string; query: string | null; count: number }[]
  return rows.map((r) => ({ ...r, count: r.query ? runQuery(lib, r.query).length : r.count }))
}

export function createCollection(lib: Library, name: string, query?: string): number {
  const clean = name.trim()
  if (!clean) throw new Error('A collection needs a name')
  const taken = lib.db.prepare('SELECT 1 FROM collections WHERE name = ? COLLATE NOCASE').get(clean)
  if (taken) throw new Error(`There is already a collection called “${clean}”`)
  const info = lib.db
    .prepare('INSERT INTO collections (name, query) VALUES (?, ?)')
    .run(clean, query?.trim() || null)
  return Number(info.lastInsertRowid)
}

export function updateCollection(
  lib: Library,
  id: number,
  changes: { name?: string; query?: string | null }
): void {
  if (changes.name !== undefined) {
    const clean = changes.name.trim()
    if (!clean) throw new Error('A collection needs a name')
    const taken = lib.db
      .prepare('SELECT 1 FROM collections WHERE name = ? COLLATE NOCASE AND id != ?')
      .get(clean, id)
    if (taken) throw new Error(`There is already a collection called “${clean}”`)
    lib.db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(clean, id)
  }
  if (changes.query !== undefined) {
    lib.db
      .prepare('UPDATE collections SET query = ? WHERE id = ?')
      .run(changes.query?.trim() || null, id)
  }
}

export function deleteCollection(lib: Library, id: number): void {
  lib.db.prepare('DELETE FROM collections WHERE id = ?').run(id)
}

export function addToCollection(lib: Library, id: number, paperIds: number[]): void {
  const c = lib.db.prepare('SELECT query FROM collections WHERE id = ?').get(id) as
    { query: string | null } | undefined
  if (!c) throw new Error('No such collection')
  if (c.query) throw new Error('Papers join a smart collection by matching its query')
  transaction(lib.db, () => {
    const insert = lib.db.prepare(
      'INSERT OR IGNORE INTO collection_papers (collection_id, paper_id) VALUES (?, ?)'
    )
    for (const p of paperIds) insert.run(id, p)
  })
}

export function removeFromCollection(lib: Library, id: number, paperIds: number[]): void {
  const del = lib.db.prepare(
    'DELETE FROM collection_papers WHERE collection_id = ? AND paper_id = ?'
  )
  for (const p of paperIds) del.run(id, p)
}

/** Members in display order: smart collections by the query's order, manual ones newest first. */
export function collectionPaperIds(lib: Library, id: number): number[] {
  const c = lib.db.prepare('SELECT query FROM collections WHERE id = ?').get(id) as
    { query: string | null } | undefined
  if (!c) return []
  if (c.query) return runQuery(lib, c.query).map((h) => h.id)
  const rows = lib.db
    .prepare(
      `SELECT cp.paper_id AS id FROM collection_papers cp JOIN papers p ON p.id = cp.paper_id
       WHERE cp.collection_id = ? ORDER BY p.added_at DESC`
    )
    .all(id) as { id: number }[]
  return rows.map((r) => r.id)
}

/** Manual collections a paper belongs to. */
export function collectionsOf(lib: Library, paperId: number): { id: number; name: string }[] {
  return lib.db
    .prepare(
      `SELECT c.id, c.name FROM collections c JOIN collection_papers cp ON cp.collection_id = c.id
       WHERE cp.paper_id = ? ORDER BY c.name COLLATE NOCASE`
    )
    .all(paperId) as { id: number; name: string }[]
}
