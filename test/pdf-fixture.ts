/**
 * Build a small, valid PDF whose pages carry the given text lines.
 * Real PDFs are copyrighted and large; this keeps tests hermetic.
 */
/** An annotation to embed: `box` is [x0, y0, x1, y1] in PDF points (origin bottom-left). */
export interface FixtureAnnotation {
  page: number
  subtype: 'Highlight' | 'Text' | 'FreeText' | 'Ink'
  box: [number, number, number, number]
  contents?: string
  color?: [number, number, number]
}

/**
 * Line n (0-based) of a page's text sits at baseline y = 740 - 14n, starting at x = 72,
 * in 11 pt Helvetica: handy for placing highlights over known words in tests.
 */
export function makePdf(
  pages: string[][],
  info: Record<string, string> = {},
  annotations: FixtureAnnotation[] = []
): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`)
  const objects: string[] = []
  const add = (body: string) => objects.push(body) // object number = index + 1

  add('<< /Type /Catalog /Pages 2 0 R >>')
  add('') // pages, filled below
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const kids: number[] = []
  for (const lines of pages) {
    const stream =
      'BT /F1 11 Tf 14 TL 72 740 Td ' + lines.map((l) => `(${esc(l)}) Tj T*`).join(' ') + ' ET'
    add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`)
    const contentRef = objects.length
    const pageIndex = kids.length
    const annotRefs: number[] = []
    for (const a of annotations.filter((x) => x.page === pageIndex)) {
      const [x0, y0, x1, y1] = a.box
      const quad =
        a.subtype === 'Highlight'
          ? ` /QuadPoints [${x0} ${y1} ${x1} ${y1} ${x0} ${y0} ${x1} ${y0}]`
          : ''
      const color = a.color ? ` /C [${a.color.join(' ')}]` : ''
      const contents = a.contents ? ` /Contents (${esc(a.contents)})` : ''
      add(
        `<< /Type /Annot /Subtype /${a.subtype} /Rect [${x0} ${y0} ${x1} ${y1}]${quad}${color}${contents} >>`
      )
      annotRefs.push(objects.length)
    }
    const annots = annotRefs.length
      ? ` /Annots [${annotRefs.map((r) => `${r} 0 R`).join(' ')}]`
      : ''
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentRef} 0 R${annots} >>`
    )
    kids.push(objects.length)
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`
  const infoEntries = Object.entries(info)
  if (infoEntries.length) add(`<< ${infoEntries.map(([k, v]) => `/${k} (${esc(v)})`).join(' ')} >>`)

  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  const infoRef = infoEntries.length ? ` /Info ${objects.length} 0 R` : ''
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${infoRef} >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}
