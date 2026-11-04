import { Check, CircleAlert, Loader2, Rows3, Rows4 } from 'lucide-react'
import { relativeDate } from '../lib/format'
import { useStore } from '../lib/store'

/** One quiet line at the bottom: what runs in the background, and the last library check. */
export function StatusBar({ onVerify }: { onVerify: () => void }) {
  const status = useStore((s) => s.status)
  const importing = useStore((s) => s.importing)
  const scanning = useStore((s) => s.inbox?.scanning ?? null)
  const density = useStore((s) => s.prefs.density)
  const setPrefs = useStore((s) => s.setPrefs)

  const busy = [
    importing &&
      importing.done < importing.total &&
      `Adding ${importing.done + 1} of ${importing.total}`,
    scanning && `Scanning inbox folders ${scanning.done} of ${scanning.total}`,
    status?.classifying &&
      `Checking where PDFs came from ${status.classifying.done} of ${status.classifying.total}`,
    status?.indexing && `Indexing highlights ${status.indexing.done} of ${status.indexing.total}`,
    status?.checkingAds && 'Checking ADS'
  ].filter(Boolean) as string[]

  const last = status?.lastVerify
  return (
    <footer
      aria-label="Status"
      className="flex h-7 shrink-0 items-center gap-4 border-t border-line bg-sidebar px-3 text-[11.5px] text-fg-3"
    >
      <span className="flex min-w-0 items-center gap-1.5" aria-live="polite">
        {busy.length ? (
          <>
            <Loader2 size={12} className="shrink-0 animate-spin" />
            <span className="truncate">{busy.join(' · ')}</span>
          </>
        ) : (
          'Ready'
        )}
      </span>
      <button
        type="button"
        onClick={onVerify}
        title="Check every file against the library now"
        className="ml-auto flex shrink-0 items-center gap-1 hover:text-fg"
      >
        {last && last.issues > 0 ? (
          <CircleAlert size={12} className="text-warn" />
        ) : (
          <Check size={12} className={last ? 'text-ok' : ''} />
        )}
        {last
          ? `Verified ${relativeDate(last.at)}${last.issues ? `, ${last.issues} issues` : ''}`
          : 'Verify library'}
      </button>
      <button
        type="button"
        onClick={() => setPrefs({ density: density === 'compact' ? 'comfortable' : 'compact' })}
        title={density === 'compact' ? 'Use comfortable rows' : 'Use compact rows'}
        aria-label={density === 'compact' ? 'Use comfortable rows' : 'Use compact rows'}
        className="flex shrink-0 items-center hover:text-fg"
      >
        {density === 'compact' ? <Rows3 size={13} /> : <Rows4 size={13} />}
      </button>
    </footer>
  )
}
