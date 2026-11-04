/**
 * End-to-end: the inbox watching a scratch "Downloads" folder. Offline: filing works
 * without metadata lookups, and papers land in "Needs review".
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makePdf } from '../test/pdf-fixture.js'

let dir: string
let downloads: string
let app: ElectronApplication
let win: Page

const PAPER = [
  [
    'The Astrophysical Journal',
    'https://doi.org/10.3847/1538-4357/ad7d0f',
    'Surface Flux Transport with Ensemble Data Assimilation',
    'Institute for Astronomy, University of Hawaii',
    'Received 2024 May 1; accepted 2024 July 9',
    'Abstract',
    'We assimilate synthetic magnetograms into a surface flux transport model.',
    '1. Introduction',
    'The solar cycle is driven by the emergence and transport of magnetic flux.'
  ],
  ['Methods'],
  ['Results'],
  ['References', 'Babcock, H. W. 1961, ApJ, 133, 572']
]

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pm-inbox-'))
  downloads = join(dir, 'Downloads')
  mkdirSync(downloads)
  writeFileSync(
    join(downloads, 'download (3).pdf'),
    makePdf(PAPER, { Title: 'Surface Flux Transport with Ensemble Data Assimilation' })
  )
  writeFileSync(join(downloads, 'null_timeseries.pdf'), makePdf([['']]))
  writeFileSync(
    join(downloads, 'receipt (3).pdf'),
    makePdf([['Payment receipt', 'Amount paid 120.00']])
  )
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      PM_LIBRARY: join(dir, 'lib'),
      PM_USER_DATA: join(dir, 'userdata'),
      PM_INBOX_FOLDERS: downloads,
      PM_TRASH_DIR: join(dir, 'trash'),
      PM_HIDE_WINDOW: '1',
      ADS_API_TOKEN: '',
      HOME: dir
    }
  })
  win = await app.firstWindow()
  await win.setViewportSize({ width: 1320, height: 820 })
})

test.afterAll(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
})

const files = () => win.getByRole('list', { name: 'Inbox files' }).getByRole('listitem')
const tab = (name: RegExp) => win.getByRole('tab', { name })

test('scans the folder and sorts papers from everything else', async () => {
  await expect(win.getByRole('button', { name: /Inbox\s*1/ })).toBeVisible({ timeout: 20_000 })
  await win.getByRole('button', { name: /Inbox/ }).click()
  await expect(tab(/Likely papers\s*1/)).toBeVisible()
  await expect(tab(/Not papers\s*2/)).toBeVisible()
  await expect(files()).toHaveCount(1)
  await expect(files().first()).toContainText(
    'Surface Flux Transport with Ensemble Data Assimilation'
  )
  await expect(files().first()).toContainText('DOI')
})

test('explains a verdict and previews the file', async () => {
  await files().first().getByRole('button', { name: 'Why this verdict?' }).click()
  await expect(files().first()).toContainText('+3 DOI or arXiv id on page 1')
  await files().first().getByRole('button', { name: 'Preview' }).click()
  await expect(win.locator('.pdfViewer .page canvas').first()).toBeVisible({ timeout: 15_000 })
  await win.getByRole('button', { name: 'Back to library (Esc)' }).click()
  await expect(tab(/Likely papers/)).toBeVisible()
})

test('files a paper with tags and leaves the original in place', async () => {
  await files().first().getByRole('checkbox').check()
  await win.getByLabel('Tags for filed papers').fill('SFT, inbox')
  await win.getByRole('button', { name: 'Add 1 to library' }).click()
  await expect(tab(/Already filed\s*1/)).toBeVisible()
  await expect(tab(/Likely papers\s*0/)).toBeVisible()
  expect(existsSync(join(downloads, 'download (3).pdf'))).toBe(true)
  await expect(win.getByRole('button', { name: /^Library\s*1/ })).toBeVisible()
  await expect(win.getByRole('button', { name: /Browse tags\s*2/ })).toBeVisible()
})

test('ignores a file and can restore it', async () => {
  await tab(/Not papers/).click()
  await files()
    .filter({ hasText: 'receipt (3).pdf' })
    .getByRole('button', { name: 'Ignore' })
    .click()
  await expect(tab(/Ignored\s*1/)).toBeVisible()
  await tab(/Ignored/).click()
  await files().first().getByRole('button', { name: 'Restore' }).click()
  await expect(tab(/Ignored\s*0/)).toBeVisible()
})

test('notices new downloads while running', async () => {
  writeFileSync(
    join(downloads, '2508.11013v1.pdf'),
    makePdf([['A preprint'], ['More'], ['Even more'], ['References']])
  )
  await expect(tab(/Likely papers\s*1/)).toBeVisible({ timeout: 15_000 })
})

test('cleans up originals already in the library, into the trash', async () => {
  win.once('dialog', (d) => void d.accept())
  await win.getByRole('button', { name: /Clean up 1 already filed/ }).click()
  await expect(tab(/Already filed\s*0/)).toBeVisible()
  expect(existsSync(join(downloads, 'download (3).pdf'))).toBe(false)
  expect(existsSync(join(dir, 'trash', 'download (3).pdf'))).toBe(true)
})
