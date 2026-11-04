import { useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { Button, Dialog, inputClass } from './ui'

/** Add papers by pasting identifiers: one per line, any mix of DOI, arXiv, bibcode or links. */
export function AddPaperDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('')
  const [tags, setTags] = useState('')
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState<{ tone: 'ok' | 'warn' | 'error'; text: string }[]>([])
  const toast = useStore((s) => s.toast)

  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  const add = async () => {
    setBusy(true)
    setLog([])
    const tagList = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    let lastId: number | undefined
    for (const line of lines) {
      try {
        const r = await api.addByIdentifier(line, tagList)
        lastId = r.paperId
        const what =
          r.status === 'added'
            ? `Added with the ${r.pdfSource} PDF`
            : r.status === 'added-without-pdf'
              ? 'Added without a PDF (none could be downloaded; attach one later)'
              : r.pdfSource
                ? `Already in the library; fetched its ${r.pdfSource} PDF`
                : 'Already in the library'
        setLog((l) => [
          ...l,
          { tone: r.status === 'added-without-pdf' ? 'warn' : 'ok', text: `${line}: ${what}` }
        ])
      } catch (err) {
        const msg = (err as Error).message.replace(
          /^Error invoking remote method '[^']+': (Error: )?/,
          ''
        )
        setLog((l) => [...l, { tone: 'error', text: `${line}: ${msg}` }])
      }
    }
    setBusy(false)
    if (lastId !== undefined) {
      useStore.getState().setView({ kind: 'all' })
      useStore.getState().select(lastId)
      toast(
        'success',
        `Processed ${lines.length} ${lines.length === 1 ? 'identifier' : 'identifiers'}.`
      )
    }
  }

  return (
    <Dialog
      title="Add papers by identifier"
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button onClick={onClose}>{log.length ? 'Done' : 'Cancel'}</Button>
          <Button variant="primary" onClick={() => void add()} disabled={busy || !lines.length}>
            {busy ? 'Adding…' : `Add ${lines.length || ''}`.trim()}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-fg-2">
            Identifiers, one per line: DOI, arXiv id, ADS bibcode, or an ADS, arXiv or doi.org link
          </span>
          <textarea
            rows={6}
            value={text}
            onChange={(e) => setText(e.target.value)}
            aria-label="Identifiers"
            placeholder={
              '2024ApJ...975..288D\nhttps://arxiv.org/abs/2409.09000\n10.1126/science.ado2993'
            }
            className={`${inputClass} font-mono text-[12px]`}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-fg-2">
            Tags (optional, comma separated)
          </span>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className={inputClass}
            aria-label="Tags for added papers"
          />
        </label>
        <p className="text-[11.5px] leading-relaxed text-fg-3">
          Details come from ADS (or Crossref/arXiv). The PDF is fetched from the publisher when your
          network has access, otherwise from arXiv or ADS's scans of older papers.
        </p>
        {log.length > 0 && (
          <ul
            className="flex flex-col gap-1 rounded-md border border-line bg-bg p-2 font-mono text-[11.5px]"
            aria-label="Results"
          >
            {log.map((l, i) => (
              <li
                key={i}
                className={
                  l.tone === 'error' ? 'text-danger' : l.tone === 'warn' ? 'text-warn' : 'text-ok'
                }
              >
                {l.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  )
}
