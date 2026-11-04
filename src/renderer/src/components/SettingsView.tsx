import { AlertTriangle, FolderOpen, KeyRound, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { AppSettings } from '../../../shared/ipc'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { Button, inputClass } from './ui'

const cleanError = (err: unknown) =>
  (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const SOURCE: Record<string, string> = {
  env: 'from the ADS_API_TOKEN environment variable',
  app: 'saved in PaperManager (encrypted with your keychain)',
  file: 'from ~/.ads/dev_key'
}

export function SettingsView() {
  const toast = useStore((s) => s.toast)
  const [s, setS] = useState<AppSettings | null>(null)
  const [token, setToken] = useState('')
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)

  const load = useCallback(async () => setS(await api.getSettings()), [])
  useEffect(() => {
    void load()
  }, [load])

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn()
      if (done) toast('success', done)
    } catch (err) {
      toast('error', cleanError(err))
    } finally {
      await load()
    }
  }

  if (!s) return <section className="flex-1" aria-label="Settings" />

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg" aria-label="Settings">
      <div className="flex h-11 shrink-0 items-center border-b border-line px-4">
        <h1 className="text-[14px] font-bold">Settings</h1>
        <span className="ml-auto text-[11px] text-fg-3">
          PaperManager {s.version} · library format v{s.schemaVersion}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-[720px] flex-col gap-6">
          <Section title="Library" icon={<FolderOpen size={15} />}>
            <Row label="Folder">
              <span className="font-mono text-[12px]">{s.libraryRoot}</span>
            </Row>
            {s.syncWarning && (
              <p className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-[12px] text-warn">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {s.syncWarning}
              </p>
            )}
            <div className="flex gap-2">
              <Button onClick={() => void api.revealPath(s.libraryRoot)}>Show in Finder</Button>
              <Button
                disabled={s.libraryFromEnv}
                title={s.libraryFromEnv ? 'Set by PM_LIBRARY' : undefined}
                onClick={() => {
                  if (
                    window.confirm(
                      'Switch to another library folder? PaperManager restarts to open it. This library is left as it is.'
                    )
                  ) {
                    void run(() => api.chooseLibraryFolder())
                  }
                }}
              >
                Use another folder…
              </Button>
            </div>
          </Section>

          <Section title="ADS" icon={<KeyRound size={15} />}>
            <p className="text-[12.5px] text-fg-2">
              An ADS API token enables lookups by bibcode, references and citations, Discover, and
              journal versions of preprints. Get one at ui.adsabs.harvard.edu → Account → Settings →
              API Token.
            </p>
            <Row label="Token">
              {s.adsTokenSource ? (
                <span className="text-[12.5px] text-ok">Set, {SOURCE[s.adsTokenSource]}</span>
              ) : (
                <span className="text-[12.5px] text-warn">Not set</span>
              )}
            </Row>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  await api.setAdsToken(token)
                  setToken('')
                }, 'Token saved.')
              }}
            >
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="Paste a token to save it in PaperManager"
                aria-label="ADS token"
                autoComplete="off"
                className={`${inputClass} flex-1 font-mono text-[12px]`}
                disabled={s.adsTokenSource === 'env'}
              />
              <Button type="submit" variant="primary" disabled={!token.trim()}>
                Save
              </Button>
              <Button
                onClick={() => void api.testAdsToken().then(setTest)}
                disabled={!s.adsTokenSource}
              >
                Test
              </Button>
              {s.adsTokenSource === 'app' && (
                <Button
                  variant="danger"
                  onClick={() => void run(() => api.setAdsToken(null), 'Token removed.')}
                >
                  Remove
                </Button>
              )}
            </form>
            {test && (
              <p className={`text-[12px] ${test.ok ? 'text-ok' : 'text-danger'}`}>{test.message}</p>
            )}
          </Section>

          <Section title="Filing" icon={<ShieldCheck size={15} />}>
            <Toggle
              checked={s.citeTags}
              onChange={(on) => void run(() => api.setCiteTags(on))}
              label="Tag new papers with their first author and year (e.g. Schad24)"
            />
            <Toggle
              checked={s.trashAfterFiling}
              onChange={(on) => void run(() => api.setTrashAfterFiling(on))}
              label="Move originals to the Trash after adding them from the Inbox"
            />
            <Row label="Inbox watches">
              <span className="font-mono text-[12px]">
                {s.inboxFolders.map((f) => f.replace(/^\/Users\/[^/]+/, '~')).join(', ') ||
                  'nothing'}
              </span>
            </Row>
            <p className="text-[11.5px] text-fg-3">
              Add or remove watched folders at the bottom of the Inbox.
            </p>
          </Section>

          <Section title="Backups" icon={<ShieldCheck size={15} />}>
            <p className="text-[12.5px] text-fg-2">
              The database (tags, notes, collections, edits) is snapshotted daily; the last 14 are
              kept. The PDFs are ordinary files, so Time Machine backs them up like any other.
            </p>
            <Row label="Latest">
              <span className="text-[12.5px]">
                {s.backups.last ? new Date(s.backups.last).toLocaleString() : 'none yet'} (
                {s.backups.count} kept)
              </span>
            </Row>
            <div className="flex gap-2">
              <Button onClick={() => void run(() => api.backupNow(), 'Snapshot taken.')}>
                Back up now
              </Button>
              <Button
                onClick={() => void api.revealPath(s.backups.dir)}
                disabled={!s.backups.count}
              >
                Show backups
              </Button>
            </div>
          </Section>
        </div>
      </div>
    </section>
  )
}

function Section({
  title,
  icon,
  children
}: {
  title: string
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-2.5 rounded-lg border border-line bg-raised p-4">
      <h2 className="flex items-center gap-2 text-[13px] font-bold">
        <span className="text-accent">{icon}</span>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <span className="w-28 shrink-0 text-[12px] text-fg-3">{label}</span>
      <span className="min-w-0 break-all">{children}</span>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (on: boolean) => void
  label: string
}) {
  return (
    <label className="flex items-center gap-2 text-[12.5px]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  )
}
