/**
 * Is this PDF a research paper? A transparent points system rather than a model:
 * every decision comes with the reasons behind it, so a wrong call is easy to see
 * and the rules easy to adjust. Bump CLASSIFIER_VERSION whenever the rules change,
 * so cached verdicts are recomputed.
 */
import { extractIdentifiers, plausibleTitle } from './identifiers.js'
import type { PdfSample } from './pdf.js'
import type { Identifier, Verdict } from './types.js'

export type { Verdict }

export const CLASSIFIER_VERSION = 3

export interface Classification {
  verdict: Verdict
  score: number
  reasons: string[]
  identifiers: Identifier[]
  /** Best guess at the title; only kept for papers and maybes. */
  title?: string | undefined
}

const PAPER_AT = 4
const MAYBE_AT = 1.5

// Documents that are plainly not literature. Matched on the file name and page 1.
const NOT_LITERATURE =
  /\b(receipt|invoice|ticket|boarding|itinerary|reservation|booking|lease|rental|visa|passport|i-?94|ds-?160|police|insurance|statement|payslip|pay\s?stub|salary|tax|w-?2|1099|marksheet|mark\s?sheet|transcript|certificate|degree|admit\s?card|offer\s?letter|appointment\s?letter|recommendation|signature|application\s?form|advertisement|advt|corrigendum|notice|schedule|agenda|menu|warranty|manual|license\s?plate|cv|resume|résumé|curriculum\s?vitae|biosketch|cover\s?letter)\b/i

// How publishers and archives name downloads: science.abb4462, sciadv.adq1604_sm,
// s11207-025-02549-2 (Springer), aa47536-23 (A&A), BF00912991, 41550_2018_562_MOESM1_ESM,
// and ISBN-style book chapters (978-3-642-87455-0, 1-4020-2415-0_9).
const PUBLISHER_FILENAME =
  /^(science\.|sciadv\.|s\d{5}-\d{3}-\d{4,5}-|aa\d{4,6}-\d{2}|BF\d{5,}|\d{5}_\d{4}_\d+_|nature\d+|ncomms\d+|978-\d|\d-\d{4}-\d{4}-\d)/i

const THESIS = /\b(thesis|dissertation)\b/i

const JOURNAL_MARKS =
  /\b(Astrophysical Journal|Astronomy (&|and) Astrophysics|Solar Physics|Space Science Reviews|Monthly Notices|Nature( Astronomy| Communications)?|Science Advances|Geophysical Research Letters|Journal of Geophysical Research|Living Reviews|Physical Review|Frontiers in|Annual Review|arXiv|Proceedings of|Publications of the Astronomical)\b/

export function classify(sample: PdfSample | undefined, filename: string): Classification {
  const reasons: string[] = []
  let score = 0
  const add = (points: number, reason: string) => {
    score += points
    reasons.push(`${points > 0 ? '+' : ''}${points} ${reason}`)
  }

  const identifiers = extractIdentifiers({
    filename,
    pdfInfo: sample?.info,
    firstPage: sample?.firstPage,
    infoTitle: sample?.infoTitle
  }).filter((i) => i.kind !== 'title')

  const personalName = NOT_LITERATURE.test(filename.replace(/[_.-]+/g, ' '))
  const thesis =
    !personalName && (THESIS.test(filename) || THESIS.test(sample?.firstPage.slice(0, 1500) ?? ''))

  if (!sample) {
    add(-1, 'could not be read')
  } else {
    const opening = sample.opening
    const text = opening.replace(/\s+/g, ' ')

    if (identifiers.some((i) => i.origin === 'filename'))
      add(5, 'named by its identifier or citation')
    else if (PUBLISHER_FILENAME.test(filename)) add(2, 'publisher-style file name')
    if (thesis) add(3, 'a thesis')
    if (identifiers.some((i) => i.origin !== 'filename')) add(3, 'DOI or arXiv id on page 1')
    if (/\bAbstract\b|\bABSTRACT\b|\bSummary\b/.test(opening)) add(1.5, 'has an abstract')
    if (/\b(1\.?\s*)?Introduction\b|\bINTRODUCTION\b/.test(opening)) add(1, 'has an introduction')
    if (/\b(References|REFERENCES|Bibliography|Literature Cited)\b/.test(sample.closing + opening))
      add(1.5, 'has a reference list')
    else if (/\(\d{4}[a-z]?\)|, \d{4}[a-z]?[;)]|et al\.?,? \(?\d{4}/.test(sample.closing))
      add(1, 'ends with citations')
    if (JOURNAL_MARKS.test(text) || JOURNAL_MARKS.test(sample.info)) add(1, 'journal name')
    if (/\bReceived\b.{0,40}\b(accepted|revised)\b/i.test(text)) add(1, 'received/accepted dates')
    if (/\b(Key ?words|Keywords|Subject headings|Unified Astronomy Thesaurus)\b/i.test(text))
      add(0.5, 'keywords')
    if (/\b(University|Institute|Observatory|Laborator(y|ies)|Department of)\b/.test(text))
      add(0.5, 'affiliations')

    if (sample.pageCount <= 1) add(-2.5, 'a single page')
    else if (sample.pageCount === 2) add(-1, 'only two pages')
    else if (sample.pageCount >= 4) add(0.5, `${sample.pageCount} pages`)
    if (text.trim().length < 200) add(-1.5, 'little or no text (a figure or a scan)')
  }

  const firstLines = (sample?.firstPage ?? '').slice(0, 600)
  if (personalName) add(-4, 'file name suggests a personal document')
  // Title pages of theses mention degrees and certificates; that is not a form.
  else if (!thesis && NOT_LITERATURE.test(firstLines))
    add(-2.5, 'page 1 reads like a form or record')

  let verdict: Verdict = score >= PAPER_AT ? 'paper' : score >= MAYBE_AT ? 'maybe' : 'other'
  // A CV lists DOIs and affiliations too; a personal file name caps the verdict at "maybe".
  if (personalName && verdict === 'paper') {
    verdict = 'maybe'
    reasons.push('capped: file name suggests a personal document')
  }
  const title =
    verdict === 'other'
      ? undefined
      : (plausibleTitle(sample?.infoTitle) ?? plausibleTitle(sample?.headline) ?? undefined)
  return { verdict, score: Math.round(score * 10) / 10, reasons, identifiers, title }
}
