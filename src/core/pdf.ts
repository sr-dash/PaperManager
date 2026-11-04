import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

/** Cap on stored full text per paper; enough for any article, bounded for scanned books. */
const MAX_FULLTEXT_CHARS = 400_000

export interface PdfText {
  pageCount: number
  /** Document-info fields worth searching for identifiers (Title, Subject, Keywords, DOI…). */
  info: string
  infoTitle?: string | undefined
  firstPage: string
  fulltext: string
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export async function looksLikePdf(path: string): Promise<boolean> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(1024)
    const { bytesRead } = await fh.read(buf, 0, 1024, 0)
    // The header may be preceded by junk bytes; readers accept it within the first 1 KB.
    return buf.subarray(0, bytesRead).includes('%PDF-')
  } finally {
    await fh.close()
  }
}

export async function readPdfText(path: string): Promise<PdfText> {
  return withPdf(path, async (doc, info) => {
    const pages: string[] = []
    let length = 0
    for (let n = 1; n <= doc.numPages && length < MAX_FULLTEXT_CHARS; n++) {
      const { text } = await pageText(doc, n)
      pages.push(text)
      length += text.length
    }
    return {
      pageCount: doc.numPages,
      ...info,
      firstPage: pages[0] ?? '',
      fulltext: pages.join('\n').slice(0, MAX_FULLTEXT_CHARS)
    }
  })
}

export interface PdfSample {
  pageCount: number
  info: string
  infoTitle?: string | undefined
  firstPage: string
  /** Text of the first few pages (including the first). */
  opening: string
  /** Text of the last page, where a reference list usually ends. */
  closing: string
  /** The largest-type line on page 1: usually the title of an article. */
  headline?: string | undefined
}

/** A cheap look at a PDF for triage: a few pages from each end, never the whole text. */
export async function readPdfSample(path: string, openingPages = 2): Promise<PdfSample> {
  return withPdf(path, async (doc, info) => {
    const opening: string[] = []
    let headline: string | undefined
    for (let n = 1; n <= Math.min(openingPages, doc.numPages); n++) {
      const p = await pageText(doc, n)
      opening.push(p.text)
      if (n === 1) headline = p.headline
    }
    const closing = doc.numPages > openingPages ? (await pageText(doc, doc.numPages)).text : ''
    return {
      pageCount: doc.numPages,
      ...info,
      firstPage: opening[0] ?? '',
      opening: opening.join('\n'),
      closing,
      headline
    }
  })
}

type PdfDoc = Awaited<ReturnType<typeof getDocument>['promise']>

async function withPdf<T>(
  path: string,
  fn: (doc: PdfDoc, info: { info: string; infoTitle?: string | undefined }) => Promise<T>
): Promise<T> {
  const data = new Uint8Array(await readFile(path))
  const task = getDocument({ data, verbosity: 0 })
  try {
    const doc = await task.promise
    const { info } = (await doc.getMetadata()) as unknown as { info: Record<string, unknown> }
    const infoText = Object.entries(info)
      .filter(
        ([k, v]) => typeof v === 'string' && !/^(PDFFormatVersion|Creator|Producer|.*Date)$/.test(k)
      )
      .map(([, v]) => v as string)
      .join('\n')
    const title = typeof info.Title === 'string' ? info.Title.trim() : undefined
    return await fn(doc, { info: infoText, infoTitle: title || undefined })
  } finally {
    await task.destroy()
  }
}

async function pageText(doc: PdfDoc, n: number): Promise<{ text: string; headline?: string }> {
  const page = await doc.getPage(n)
  try {
    const content = await page.getTextContent()
    const items = content.items.filter((i): i is Extract<typeof i, { str: string }> => 'str' in i)
    const text = items
      .map((i) => i.str + (i.hasEOL ? '\n' : ' '))
      .join('')
      .replace(/[ \t]+/g, ' ')
    // Title guess: the runs set in the largest type (height ≈ font size), in reading order.
    const sized = items.filter((i) => i.str.trim() && i.height > 0)
    const max = Math.max(0, ...sized.map((i) => i.height))
    const headline = sized
      .filter((i) => i.height >= max * 0.92)
      .map((i) => i.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      // Some layouts set the "Abstract" heading as large as the title; stop there.
      .replace(/\s+(ABSTRACT|Abstract)\b.*$/, '')
      .trim()
      .slice(0, 300)
    return { text, headline: headline || undefined }
  } finally {
    page.cleanup()
  }
}

/** A highlight, note or drawing found inside a PDF. */
export interface PdfAnnotation {
  page: number
  kind: 'highlight' | 'underline' | 'strikeout' | 'note' | 'text' | 'drawing'
  color?: string | undefined
  /** The words under a highlight/underline, or the text of a note. */
  text?: string | undefined
  /** A comment attached to the annotation (its popup text). */
  comment?: string | undefined
  /** Distance from the top of the page, 0–1, for ordering within a page. */
  y: number
}

const KINDS: Record<string, PdfAnnotation['kind']> = {
  Highlight: 'highlight',
  Underline: 'underline',
  StrikeOut: 'strikeout',
  Squiggly: 'underline',
  Text: 'note',
  FreeText: 'text',
  Ink: 'drawing'
}

interface RawAnnotation {
  subtype: string
  rect?: number[]
  quadPoints?: ArrayLike<number> | null
  color?: ArrayLike<number> | null
  contentsObj?: { str?: string }
  textContent?: string[]
}

/** Every annotation of the kinds people make while reading, in page order. */
export async function readPdfAnnotations(path: string): Promise<PdfAnnotation[]> {
  return withPdf(path, async (doc) => {
    const out: PdfAnnotation[] = []
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n)
      try {
        const raw = (await page.getAnnotations()) as RawAnnotation[]
        const found = raw.filter((a) => KINDS[a.subtype])
        if (!found.length) continue
        const [, , , top] = page.view as [number, number, number, number]
        const needsText = found.some((a) => a.quadPoints && a.quadPoints.length >= 8)
        const items = needsText ? await textItems(page) : []
        for (const a of found) {
          const kind = KINDS[a.subtype]!
          const comment = a.contentsObj?.str?.trim() || undefined
          const quads = a.quadPoints && a.quadPoints.length >= 8 ? quadBoxes(a.quadPoints) : []
          // For notes the words are the annotation itself, not a comment on something else.
          const isNote = kind === 'text' || kind === 'note'
          const text = isNote
            ? (a.textContent?.join(' ') || comment)?.trim()
            : quads.length
              ? textUnder(items, quads)
              : undefined
          const yTop = quads.length ? Math.max(...quads.map((q) => q.y1)) : (a.rect?.[3] ?? top)
          out.push({
            page: n,
            kind,
            color: a.color && a.color.length >= 3 ? hex(a.color) : undefined,
            text: text || undefined,
            comment: isNote ? undefined : comment,
            y: top ? Math.min(1, Math.max(0, 1 - yTop / top)) : 0
          })
        }
      } finally {
        page.cleanup()
      }
    }
    return out.sort((a, b) => a.page - b.page || a.y - b.y)
  })
}

interface Box {
  x0: number
  y0: number
  x1: number
  y1: number
}

function quadBoxes(q: ArrayLike<number>): Box[] {
  const boxes: Box[] = []
  for (let i = 0; i + 7 < q.length; i += 8) {
    const xs = [q[i]!, q[i + 2]!, q[i + 4]!, q[i + 6]!]
    const ys = [q[i + 1]!, q[i + 3]!, q[i + 5]!, q[i + 7]!]
    boxes.push({
      x0: Math.min(...xs),
      x1: Math.max(...xs),
      y0: Math.min(...ys),
      y1: Math.max(...ys)
    })
  }
  return boxes
}

interface TextRun {
  str: string
  x: number
  y: number
  w: number
  h: number
}

async function textItems(page: {
  getTextContent: () => Promise<{ items: unknown[] }>
}): Promise<TextRun[]> {
  const content = await page.getTextContent()
  return (
    content.items as { str?: string; transform?: number[]; width?: number; height?: number }[]
  )
    .filter((i) => i.str && i.transform)
    .map((i) => ({
      str: i.str!,
      x: i.transform![4]!,
      y: i.transform![5]!,
      w: i.width ?? 0,
      h: i.height ?? 0
    }))
}

/**
 * The words under a highlight. A highlight stores only its shape; the words are the
 * parts of text runs whose middle line falls inside a quad, cut by horizontal overlap.
 */
function textUnder(runs: TextRun[], quads: Box[]): string {
  const parts: string[] = []
  for (const q of quads) {
    const line: string[] = []
    for (const r of runs) {
      const mid = r.y + r.h * 0.35
      if (mid < q.y0 || mid > q.y1 || r.w <= 0) continue
      const from = Math.max(q.x0, r.x)
      const to = Math.min(q.x1, r.x + r.w)
      if (to <= from) continue
      const a = Math.round(((from - r.x) / r.w) * r.str.length)
      const b = Math.round(((to - r.x) / r.w) * r.str.length)
      line.push(r.str.slice(a, b))
    }
    parts.push(line.join(''))
  }
  return parts
    .join(' ')
    .replace(/-\s+(?=[a-z])/g, '') // re-join words hyphenated across lines
    .replace(/\s+/g, ' ')
    .trim()
}

function hex(c: ArrayLike<number>): string {
  const scale = Math.max(c[0]!, c[1]!, c[2]!) <= 1 ? 255 : 1
  return (
    '#' +
    [c[0]!, c[1]!, c[2]!]
      .map((v) =>
        Math.round(v * scale)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  )
}
