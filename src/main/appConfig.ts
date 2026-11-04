/**
 * Settings that belong to this installation rather than to a library: where the library
 * is, and the ADS token. Kept in Electron's userData folder. The token is encrypted with
 * the OS keychain (safeStorage) and never written in plain text.
 */
import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_LIBRARY_ROOT } from '../core/library.js'
import { findAdsToken } from '../core/metadata/resolver.js'
import type { TokenSource } from '../shared/ipc.js'

interface Config {
  libraryRoot?: string
  adsToken?: string // base64 of safeStorage-encrypted bytes
}

const configPath = () => join(app.getPath('userData'), 'config.json')

function load(): Config {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as Config
  } catch {
    return {}
  }
}

function save(c: Config): void {
  writeFileSync(configPath(), JSON.stringify(c, null, 2))
}

/** PM_LIBRARY wins (tests, alternative libraries), then the chosen folder, then the default. */
export function libraryRoot(): { root: string; fromEnv: boolean } {
  if (process.env.PM_LIBRARY) return { root: process.env.PM_LIBRARY, fromEnv: true }
  return { root: load().libraryRoot ?? DEFAULT_LIBRARY_ROOT, fromEnv: false }
}

export function setLibraryRoot(root: string): void {
  save({ ...load(), libraryRoot: root })
}

function storedToken(): string | undefined {
  const enc = load().adsToken
  if (!enc || !safeStorage.isEncryptionAvailable()) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64')) || undefined
  } catch {
    return undefined
  }
}

export function setStoredToken(token: string | null): void {
  const c = load()
  if (!token?.trim()) delete c.adsToken
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure storage is not available')
    c.adsToken = safeStorage.encryptString(token.trim()).toString('base64')
  }
  save(c)
}

/** The token to use, and where it came from: environment, the app's own store, or ~/.ads/dev_key. */
export async function adsToken(): Promise<{ token?: string | undefined; source: TokenSource }> {
  const env = process.env.ADS_API_TOKEN ?? process.env.ADS_DEV_KEY
  if (env?.trim()) return { token: env.trim(), source: 'env' }
  // An explicitly empty variable (as in tests) means "no token", not "look elsewhere".
  if (env !== undefined) return { source: null }
  const stored = storedToken()
  if (stored) return { token: stored, source: 'app' }
  const file = await findAdsToken({})
  return file ? { token: file, source: 'file' } : { source: null }
}
