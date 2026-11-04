import { useState, type ReactNode } from 'react'
import type { Metadata } from '../../../shared/ipc'
import { authorsToText, textToAuthors } from '../lib/format'
import { Button, Dialog, inputClass } from './ui'

/** Hand-edit a paper's details. Saving marks it "edited by hand" so lookups leave it alone. */
export function MetadataDialog({
  metadata,
  onClose,
  onSave
}: {
  metadata: Metadata
  onClose: () => void
  onSave: (m: Metadata) => void
}) {
  const [f, setF] = useState({
    title: metadata.title ?? '',
    authors: authorsToText(metadata.authors),
    year: metadata.year?.toString() ?? '',
    journal: metadata.journal ?? '',
    journalAbbrev: metadata.journalAbbrev ?? '',
    volume: metadata.volume ?? '',
    page: metadata.page ?? '',
    doi: metadata.doi ?? '',
    bibcode: metadata.bibcode ?? '',
    arxivId: metadata.arxivId ?? '',
    abstract: metadata.abstract ?? ''
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((prev) => ({ ...prev, [k]: e.target.value }))
  const opt = (s: string) => s.trim() || undefined
  const yearOk = !f.year.trim() || /^\d{4}$/.test(f.year.trim())

  const save = () =>
    onSave({
      ...metadata,
      title: opt(f.title),
      authors: textToAuthors(f.authors),
      year: f.year.trim() ? Number(f.year) : undefined,
      journal: opt(f.journal),
      journalAbbrev: opt(f.journalAbbrev),
      volume: opt(f.volume),
      page: opt(f.page),
      doi: opt(f.doi)?.toLowerCase(),
      bibcode: opt(f.bibcode),
      arxivId: opt(f.arxivId),
      abstract: opt(f.abstract)
    })

  return (
    <Dialog
      title="Edit details"
      onClose={onClose}
      width={600}
      footer={
        <>
          <span className="mr-auto self-center text-[11px] text-fg-3">
            Saved details are kept even if the paper is looked up again.
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!yearOk}>
            Save
          </Button>
        </>
      }
    >
      <form
        className="grid grid-cols-6 gap-x-3 gap-y-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (yearOk) save()
        }}
      >
        <Field label="Title" span={6}>
          <textarea rows={2} value={f.title} onChange={set('title')} className={inputClass} />
        </Field>
        <Field label="Authors" hint="One per line: Family, Given" span={6}>
          <textarea
            rows={4}
            value={f.authors}
            onChange={set('authors')}
            className={`${inputClass} font-mono text-[12px]`}
          />
        </Field>
        <Field label="Year" span={1}>
          <input
            value={f.year}
            onChange={set('year')}
            className={`${inputClass} ${yearOk ? '' : 'border-danger'}`}
            inputMode="numeric"
          />
        </Field>
        <Field label="Journal" span={3}>
          <input value={f.journal} onChange={set('journal')} className={inputClass} />
        </Field>
        <Field label="Abbrev." hint="Used in file names" span={2}>
          <input value={f.journalAbbrev} onChange={set('journalAbbrev')} className={inputClass} />
        </Field>
        <Field label="Volume" span={2}>
          <input value={f.volume} onChange={set('volume')} className={inputClass} />
        </Field>
        <Field label="Page" span={2}>
          <input value={f.page} onChange={set('page')} className={inputClass} />
        </Field>
        <Field label="arXiv" span={2}>
          <input
            value={f.arxivId}
            onChange={set('arxivId')}
            className={`${inputClass} font-mono text-[12px]`}
          />
        </Field>
        <Field label="DOI" span={3}>
          <input
            value={f.doi}
            onChange={set('doi')}
            className={`${inputClass} font-mono text-[12px]`}
          />
        </Field>
        <Field label="ADS bibcode" span={3}>
          <input
            value={f.bibcode}
            onChange={set('bibcode')}
            className={`${inputClass} font-mono text-[12px]`}
            maxLength={19}
          />
        </Field>
        <Field label="Abstract" span={6}>
          <textarea rows={4} value={f.abstract} onChange={set('abstract')} className={inputClass} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  )
}

function Field({
  label,
  hint,
  span,
  children
}: {
  label: string
  hint?: string
  span: number
  children: ReactNode
}) {
  return (
    <label className="flex flex-col gap-1" style={{ gridColumn: `span ${span} / span ${span}` }}>
      <span className="flex items-baseline justify-between text-[11px] font-semibold text-fg-2">
        {label}
        {hint && <span className="font-normal text-fg-3">{hint}</span>}
      </span>
      {children}
    </label>
  )
}
