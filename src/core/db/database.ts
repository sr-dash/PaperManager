import { DatabaseSync } from 'node:sqlite'
import { LATEST_VERSION, MIGRATIONS, type Migration } from './migrations.js'

export type Db = DatabaseSync

export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number
  ) {
    super(
      `Library schema version ${found} is newer than this build supports (${supported}). ` +
        'Update PaperManager before opening this library.'
    )
  }
}

export function openDatabase(path: string, migrations: readonly Migration[] = MIGRATIONS): Db {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA busy_timeout = 5000')
  try {
    migrate(db, migrations)
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

export function schemaVersion(db: Db): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  return row.user_version
}

export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): number {
  const latest = migrations.at(-1)?.version ?? LATEST_VERSION
  const current = schemaVersion(db)
  if (current > latest) throw new SchemaTooNewError(current, latest)

  for (const m of migrations) {
    if (m.version <= current) continue
    transaction(db, () => {
      db.exec(m.sql)
      // PRAGMA cannot take a bound parameter; version is a trusted integer.
      db.exec(`PRAGMA user_version = ${Math.trunc(m.version)}`)
    })
  }
  return schemaVersion(db)
}

/** Run `fn` in a transaction. Nested calls join the outer transaction via savepoints. */
export function transaction<T>(db: Db, fn: () => T): T {
  const nested = db.isTransaction
  const sp = `sp_${Math.random().toString(36).slice(2)}`
  db.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec(nested ? `RELEASE ${sp}` : 'COMMIT')
    return result
  } catch (err) {
    db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK')
    throw err
  }
}
