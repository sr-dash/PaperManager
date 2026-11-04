import type { Author } from '../../../core/types'

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 ** 2).toFixed(1)} MB`
}

/** "Dash, DeRosa & Dikpati" / "Dash et al." — how a citation reads, not a full list. */
export function shortAuthors(first: string | null, count: number): string {
  if (!first) return '—'
  if (count <= 1) return first
  return `${first} et al.`
}

export function authorLine(authors: Author[], max = 12): string {
  const names = authors.map((a) => (a.given ? `${a.given} ${a.family}` : a.family))
  if (names.length <= max) return names.join(', ')
  return `${names.slice(0, max).join(', ')}, and ${names.length - max} more`
}

/** "Family, Given" per line ⇄ Author[] — the editing format for the metadata dialog. */
export function authorsToText(authors: Author[]): string {
  return authors.map((a) => (a.given ? `${a.family}, ${a.given}` : a.family)).join('\n')
}

export function textToAuthors(text: string): Author[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(',')
      if (i < 0) return { family: l }
      const given = l.slice(i + 1).trim()
      return { family: l.slice(0, i).trim(), ...(given ? { given } : {}) }
    })
}

export function relativeDate(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000)
  if (days < 1) return 'today'
  if (days < 2) return 'yesterday'
  if (days < 30) return `${days} days ago`
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

/** FTS snippets mark matches with [ and ]; split them for highlighting. */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  const parts: { text: string; hit: boolean }[] = []
  const re = /\[([^\]]*)\]/g
  let last = 0
  for (const m of snippet.matchAll(re)) {
    if (m.index! > last) parts.push({ text: snippet.slice(last, m.index), hit: false })
    parts.push({ text: m[1]!, hit: true })
    last = m.index! + m[0].length
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), hit: false })
  return parts.map((p) => ({ ...p, text: p.text.replace(/\s+/g, ' ') }))
}

/** "Yang_2024_Sci_386_76-c.pdf" → "Yang_2024_S…76-c.pdf": keeps the end, where copies differ. */
export function middleEllipsis(s: string, max = 30): string {
  if (s.length <= max) return s
  const tail = Math.ceil((max - 1) * 0.55)
  return `${s.slice(0, max - 1 - tail)}…${s.slice(-tail)}`
}
