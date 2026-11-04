/**
 * End-to-end: adding by identifier, reading status and stars, collections, the highlights
 * index, ADS references and watches, manuscripts and settings, against a local fake ADS.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makePdf } from '../test/pdf-fixture.js'
import { startFakeAds, type FakeAds, type FakeDoc } from './fake-ads.js'

let dir: string
let ads: FakeAds
let app: ElectronApplication
let win: Page

const EnKF: FakeDoc = {
  bibcode: '2024ApJ...975..288D',
  title: ['Ensemble Kalman Filter Data Assimilation'],
  author: ['Dash, Soumyaranjan', 'DeRosa, Marc L.'],
  year: '2024',
  pub: 'The Astrophysical Journal',
  volume: '975',
  page: ['288'],
  doi: ['10.3847/1538-4357/ad7d0f'],
  identifier: ['arXiv:2409.09000'],
  property: ['REFEREED'],
  abstract: 'We assimilate synthetic magnetograms.'
}
const BABCOCK: FakeDoc = {
  bibcode: '1961ApJ...133..572B',
  title: ['The Topology of the Sun’s Magnetic Field'],
  author: ['Babcock, H. W.'],
  year: '1961',
  pub: 'The Astrophysical Journal'
}
const CITING: FakeDoc = {
  bibcode: '2025SoPh..300...12X',
  title: ['A study that cites the EnKF paper'],
  author: ['Xu, A.'],
  year: '2025',
  pub: 'Solar Physics',
  property: ['REFEREED']
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pm-features-'))
  ads = await startFakeAds({
    search: (q) => {
      if (q.startsWith('references(')) return [BABCOCK]
      if (q.startsWith('citations(')) return [CITING]
      if (q.includes(EnKF.bibcode) || q.includes('2409.09000') || q.includes('ad7d0f'))
        return [EnKF]
      if (q.includes(BABCOCK.bibcode)) return [BABCOCK]
      if (q.includes(CITING.bibcode)) return [CITING]
      return []
    },
    pdfs: {
      [EnKF.bibcode]: makePdf(
        [
          ['Ensemble Kalman Filter Data Assimilation', 'Magnetic flux emerges at the surface.'],
          ['Page two']
        ],
        {},
        [
          {
            page: 0,
            subtype: 'Highlight',
            box: [72, 723, 250, 736],
            color: [1, 1, 0],
            contents: 'key result'
          }
        ]
      ),
      [CITING.bibcode]: makePdf([['A study that cites the EnKF paper']])
    }
  })
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      PM_LIBRARY: join(dir, 'lib'),
      PM_USER_DATA: join(dir, 'ud'),
      PM_INBOX_FOLDERS: join(dir, 'none'),
      PM_TRASH_DIR: join(dir, 'trash'),
      PM_HIDE_WINDOW: '1',
      PM_ADS_API: `${ads.url}/v1`,
      PM_ADS_UI: ads.url,
      ADS_API_TOKEN: 'test-token',
      HOME: dir
    }
  })
  win = await app.firstWindow()
  await win.setViewportSize({ width: 1400, height: 860 })
})

test.afterAll(async () => {
  await app?.close()
  await ads?.close()
  rmSync(dir, { recursive: true, force: true })
})

const rows = () => win.locator('[role=grid] [role=row][data-id]')
const pane = () => win.getByRole('complementary', { name: 'Paper details' })
const nav = (name: RegExp) =>
  win.getByRole('navigation', { name: 'Library' }).getByRole('button', { name })
const paneTab = (name: RegExp) => pane().getByRole('tab', { name })

test('adds a paper by identifier, skipping a publisher login page for the arXiv PDF', async () => {
  await win.getByRole('button', { name: 'Add papers' }).click()
  await win.getByRole('menuitem', { name: 'Add by identifier…' }).click()
  const dialog = win.getByRole('dialog', { name: 'Add papers by identifier' })
  await dialog
    .getByLabel('Identifiers')
    .fill(`https://ui.adsabs.harvard.edu/abs/${EnKF.bibcode}/abstract`)
  await dialog.getByLabel('Tags for added papers').fill('SFT')
  await dialog.getByRole('button', { name: 'Add 1' }).click()
  await expect(dialog.getByRole('list', { name: 'Results' })).toContainText(
    'Added with the arXiv PDF'
  )
  await dialog.getByRole('button', { name: 'Done' }).click()

  await expect(rows()).toHaveCount(1)
  await expect(pane().getByRole('heading', { name: /Ensemble Kalman Filter/ })).toBeVisible()
  // Only an e-print so far: the pane offers the publisher's version.
  await expect(pane().getByRole('note')).toContainText('arXiv version')
  await paneTab(/^Files/).click()
  await expect(pane().getByText('Dash_2024_ApJ_975_288.pdf')).toBeVisible()
  await expect(pane().getByRole('listitem', { name: /^File / })).toContainText('arXiv')
  expect(readdirSync(join(dir, 'lib', 'files'))).toEqual(['Dash_2024_ApJ_975_288.pdf'])
})

test('indexes the highlight that came inside the PDF and jumps to it', async () => {
  await expect(nav(/Highlights\s*1/)).toBeVisible({ timeout: 15_000 })
  await nav(/Highlights/).click()
  const view = win.getByRole('region', { name: 'Highlights and notes' })
  await expect(view).toContainText('key result')
  await expect(view).toContainText('Magnetic flux')
  await view.getByRole('button', { name: /Magnetic flux/ }).click()
  await expect(win.locator('.pdfViewer .page canvas').first()).toBeVisible({ timeout: 15_000 })
  await win.getByRole('button', { name: 'Back to library (Esc)' }).click()
})

test('sets reading status and stars, and filters by them', async () => {
  await nav(/^Library/).click()
  await rows().first().click()
  await pane().getByRole('button', { name: 'Reading status' }).click()
  await win.getByRole('menuitem', { name: 'To read' }).click()
  await pane().getByRole('button', { name: 'Star', exact: true }).click()
  await expect(nav(/To read\s*1/)).toBeVisible()
  await expect(nav(/Starred\s*1/)).toBeVisible()
  await win
    .getByRole('textbox', { name: 'Search', exact: true })
    .fill('is:starred status:to-read year:2024')
  await expect(rows()).toHaveCount(1)
  await win.getByRole('textbox', { name: 'Search', exact: true }).fill('is:starred year:<2000')
  await expect(rows()).toHaveCount(0)
  await win.getByRole('button', { name: 'Clear search' }).click()
})

test('saves a search as a smart collection and keeps a manual one', async () => {
  await win.getByRole('textbox', { name: 'Search', exact: true }).fill('tag:SFT')
  await win.getByRole('button', { name: 'Save as smart collection' }).click()
  const dialog = win.getByRole('dialog', { name: 'New collection' })
  await dialog.getByLabel('Collection name').fill('Flux transport')
  await expect(dialog).toContainText('1 papers match now')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(win.getByRole('heading', { name: 'Flux transport' })).toBeVisible()
  await expect(rows()).toHaveCount(1)
  await expect(win.getByRole('textbox', { name: 'Search', exact: true })).toHaveValue('')

  await win.getByRole('button', { name: 'New collection' }).click()
  const manual = win.getByRole('dialog', { name: 'New collection' })
  await manual.getByLabel('Collection name').fill('Thesis chapter 2')
  await manual.getByRole('button', { name: 'Create' }).click()
  await expect(rows()).toHaveCount(0)
  await nav(/^Library/).click()
  await rows().first().click()
  await paneTab(/^Overview/).click()
  await pane().getByLabel('Add to collection').selectOption({ label: 'Thesis chapter 2' })
  await expect(nav(/Thesis chapter 2\s*1/)).toBeVisible()
})

test('lists references on ADS and adds one; watching citations finds a new paper', async () => {
  await rows().first().click()
  await paneTab(/^Refs & citations/).click()
  // Both lists load as soon as the tab opens.
  await expect(pane().getByRole('tab', { name: /Cited by\s*1/ })).toBeVisible()
  await expect(pane()).toContainText('0 of 1 in your library')
  await pane().getByRole('button', { name: 'Add', exact: true }).click()
  await expect(nav(/^Library\s*2/)).toBeVisible()

  await rows().filter({ hasText: 'Ensemble' }).click()
  await pane().getByRole('button', { name: 'Watch for new citations' }).click()
  await expect(nav(/Discover\s*1/)).toBeVisible({ timeout: 15_000 })
  await nav(/Discover/).click()
  const view = win.getByRole('region', { name: 'Discover' })
  await expect(view).toContainText('A study that cites the EnKF paper')
  await view.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(nav(/^Library\s*3/)).toBeVisible()
  await expect(view).toContainText('Nothing new')
})

test('shows references and citations beside the reader', async () => {
  await nav(/^Library/).click()
  await rows().filter({ hasText: 'Ensemble' }).dblclick()
  const side = win.getByRole('complementary', { name: 'Beside the paper' })
  await expect(side.getByRole('tab', { name: /References\s*1/ })).toBeVisible()
  await expect(side).toContainText('1 of 1 in your library')
  await side.getByRole('tab', { name: /Cited by/ }).click()
  await expect(side).toContainText('A study that cites the EnKF paper')
  await win.getByRole('button', { name: 'Hide references and citations' }).click()
  await expect(side).toBeHidden()
  await win.getByRole('button', { name: 'Show references and citations' }).click()
  await expect(side).toBeVisible()
  await win.getByRole('button', { name: 'Back to library (Esc)' }).click()
})

test('matches a manuscript’s citations and writes its .bib without losing entries', async () => {
  const ms = join(dir, 'CN_Paper')
  mkdirSync(ms)
  writeFileSync(
    join(ms, 'main.tex'),
    String.raw`\citet{${EnKF.bibcode}} and \citep{Leighton69}. \bibliography{refs}`
  )
  writeFileSync(join(ms, 'refs.bib'), '@ARTICLE{Leighton69, title = {Kept verbatim}}\n')
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, ms)
  await win.getByRole('button', { name: 'Add a LaTeX project' }).click()
  const view = win.getByRole('region', { name: 'Manuscript' })
  await expect(view.getByRole('heading', { name: 'CN_Paper' })).toBeVisible()
  await expect(view).toContainText('Only in the .bib')
  await view.getByRole('button', { name: 'Write .bib' }).click()
  await expect(win.getByText(/Wrote 1 from the library, kept 1/)).toBeVisible()
  const bib = readFileSync(join(ms, 'refs.bib'), 'utf8')
  expect(bib).toContain(`{${EnKF.bibcode},`)
  expect(bib).toContain('Kept verbatim')
  expect(existsSync(join(ms, 'refs.bib.bak'))).toBe(true)
})

test('shows settings, and backs up the database on request', async () => {
  await nav(/Settings/).click()
  const view = win.getByRole('region', { name: 'Settings' })
  await expect(view).toContainText('Set, from the ADS_API_TOKEN environment variable')
  await expect(view).toContainText(join(dir, 'lib'))
  await view.getByRole('button', { name: 'Test' }).click()
  await expect(view).toContainText('ADS accepted the token')
  const before = readdirSync(join(dir, 'lib', 'backups')).length
  await view.getByRole('button', { name: 'Back up now' }).click()
  await expect.poll(() => readdirSync(join(dir, 'lib', 'backups')).length).toBe(before + 1)
})

test('keeps the library consistent throughout', async () => {
  await nav(/^Library/).click()
  const issues = await win.evaluate(() =>
    (globalThis as unknown as { pm: { verify: (deep: boolean) => Promise<unknown[]> } }).pm.verify(
      true
    )
  )
  expect(issues).toEqual([])
  expect(ads.queries.some((q) => q.startsWith('references('))).toBe(true)
})
