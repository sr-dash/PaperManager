import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  migrate,
  openDatabase,
  SchemaTooNewError,
  schemaVersion,
  transaction
} from '../src/core/db/database.js'
import { LATEST_VERSION, MIGRATIONS } from '../src/core/db/migrations.js'

const dirs: string[] = []
const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-db-'))
  dirs.push(dir)
  return join(dir, 'library.sqlite')
}
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('migrations', () => {
  it('brings a fresh database to the latest version', () => {
    const db = openDatabase(tempDb())
    expect(schemaVersion(db)).toBe(LATEST_VERSION)
    db.close()
  })

  it('is idempotent across reopenings', () => {
    const path = tempDb()
    openDatabase(path).close()
    const db = openDatabase(path)
    expect(schemaVersion(db)).toBe(LATEST_VERSION)
    db.close()
  })

  it('refuses to open a library written by a newer build', () => {
    const path = tempDb()
    const db = openDatabase(path)
    db.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`)
    db.close()
    expect(() => openDatabase(path)).toThrow(SchemaTooNewError)
  })

  it('applies later migrations on top of existing data', () => {
    const path = tempDb()
    const db = openDatabase(path)
    db.prepare("INSERT INTO papers (title, added_at, updated_at) VALUES ('kept', 'x', 'x')").run()
    const next = [
      ...MIGRATIONS,
      {
        version: LATEST_VERSION + 1,
        description: 'test',
        sql: 'ALTER TABLE papers ADD COLUMN rating INTEGER'
      }
    ]
    expect(migrate(db, next)).toBe(LATEST_VERSION + 1)
    expect(db.prepare('SELECT title, rating FROM papers').get()).toEqual({
      title: 'kept',
      rating: null
    })
    db.close()
  })

  it('leaves the version untouched when a migration fails', () => {
    const path = tempDb()
    const db = openDatabase(path)
    const broken = [
      ...MIGRATIONS,
      {
        version: LATEST_VERSION + 1,
        description: 'bad',
        sql: 'CREATE TABLE t (a); SELECT nope FROM nowhere'
      }
    ]
    expect(() => migrate(db, broken)).toThrow()
    expect(schemaVersion(db)).toBe(LATEST_VERSION)
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 't'").get()).toBeUndefined()
    db.close()
  })

  it('enforces foreign keys', () => {
    const db = openDatabase(tempDb())
    expect(() =>
      db
        .prepare(
          "INSERT INTO files (paper_id, sha256, rel_path, size, added_at) VALUES (99, 'h', 'f', 1, 'x')"
        )
        .run()
    ).toThrow(/FOREIGN KEY/)
    db.close()
  })
})

describe('transaction', () => {
  it('rolls back a nested failure without losing the outer work', () => {
    const db = openDatabase(tempDb())
    transaction(db, () => {
      db.prepare("INSERT INTO tags (name) VALUES ('outer')").run()
      expect(() =>
        transaction(db, () => {
          db.prepare("INSERT INTO tags (name) VALUES ('inner')").run()
          throw new Error('boom')
        })
      ).toThrow('boom')
    })
    const names = (db.prepare('SELECT name FROM tags').all() as { name: string }[]).map(
      (r) => r.name
    )
    expect(names).toEqual(['outer'])
    db.close()
  })
})
