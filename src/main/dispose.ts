import { shell } from 'electron'
import { existsSync } from 'node:fs'
import { mkdir, rename } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** Removed files go to the OS Trash; tests point PM_TRASH_DIR at a scratch folder instead. */
export async function disposeFile(path: string): Promise<void> {
  const dir = process.env.PM_TRASH_DIR
  if (!dir) return shell.trashItem(path)
  await mkdir(dir, { recursive: true })
  let target = join(dir, basename(path))
  if (existsSync(target)) target = join(dir, `${Date.now()}-${basename(path)}`)
  await rename(path, target)
}
