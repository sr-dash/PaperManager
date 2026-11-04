/**
 * Database snapshots. The PDFs are ordinary files that Time Machine already covers; the
 * database holds everything typed by hand (tags, notes, collections, edits), so it gets
 * its own consistent snapshots under <library>/backups/.
 */
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Library } from './library.js'

export const BACKUPS_DIR = 'backups'

export function backupDatabase(lib: Library, keep = 14): string {
  const dir = join(lib.root, BACKUPS_DIR)
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:T.]/g, '-').slice(0, 23)
  const path = join(dir, `library-${stamp}.sqlite`)
  // VACUUM INTO writes a consistent, compact copy even while the library is open.
  lib.db.prepare('VACUUM INTO ?').run(path)
  for (const old of listBackups(lib).slice(keep)) rmSync(old.path, { force: true })
  return path
}

export function listBackups(lib: Library): { path: string; at: string; size: number }[] {
  const dir = join(lib.root, BACKUPS_DIR)
  let names: string[] = []
  try {
    names = readdirSync(dir).filter((n) => /^library-.*\.sqlite$/.test(n))
  } catch {
    return []
  }
  return names
    .map((n) => {
      const st = statSync(join(dir, n))
      return { path: join(dir, n), at: st.mtime.toISOString(), size: st.size }
    })
    .sort((a, b) => b.at.localeCompare(a.at))
}

/** Take a snapshot if the newest one is older than `hours`. Returns its path if one was taken. */
export function backupIfDue(lib: Library, hours = 24): string | undefined {
  const last = listBackups(lib)[0]
  if (last && Date.now() - Date.parse(last.at) < hours * 3_600_000) return undefined
  return backupDatabase(lib)
}

/**
 * Sync services copy files one at a time and can capture a SQLite database mid-write
 * or create conflicting copies. Warn when the library lives inside one.
 */
export function syncFolderWarning(root: string): string | undefined {
  const home = homedir()
  const checks: [RegExp | string, string][] = [
    [join(home, 'Library', 'Mobile Documents'), 'iCloud Drive'],
    [join(home, 'Library', 'CloudStorage'), 'a cloud storage provider'],
    [/[/\\]Dropbox([/\\]|$)/, 'Dropbox'],
    [/[/\\]Google Drive([/\\]|$)/, 'Google Drive'],
    [/[/\\]OneDrive[^/\\]*([/\\]|$)/, 'OneDrive'],
    [/[/\\]Box( Sync)?([/\\]|$)/, 'Box']
  ]
  for (const [pattern, name] of checks) {
    const hit = typeof pattern === 'string' ? root.startsWith(pattern) : pattern.test(root)
    if (hit) {
      return `The library is inside ${name}. Syncing a live database can corrupt it; keep the library in a local folder and rely on backups instead.`
    }
  }
  return undefined
}
