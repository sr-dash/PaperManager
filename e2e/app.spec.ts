/**
 * End-to-end: the built app (`out/`) against a throwaway library made with the CLI.
 * Offline throughout: imports use --offline and the app has no ADS token here.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makePdf } from '../test/pdf-fixture.js'

let dir: string
let app: ElectronApplication
let win: Page

const pdf = (name: string, title: string, lines: string[]) => {
  const p = join(dir, 'src', name)
  writeFileSync(
    p,
    makePdf([[title, ...lines], ['Second page mentions meridional circulation']], { Title: title })
  )
  return p
}

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pm-e2e-'))
  execFileSync('mkdir', ['-p', join(dir, 'src')])
  const files = [
    pdf('flux.pdf', 'Surface flux transport with data assimilation', [
      'An ensemble Kalman filter study'
    ]),
    pdf('zeeman.pdf', 'Coronal magnetometry from Zeeman polarimetry', ['Spectropolarimetric maps']),
    pdf('dynamo.pdf', 'Babcock Leighton dynamo reconstructions', ['Meridional flow speed'])
  ]
  execFileSync(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      '--import',
      'tsx',
      'src/cli/pm.ts',
      'import',
      '--offline',
      '--library',
      join(dir, 'lib'),
      '--tag',
      'Solar',
      ...files
    ],
    { stdio: 'pipe', env: { ...process.env, ADS_API_TOKEN: '' } }
  )
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      PM_LIBRARY: join(dir, 'lib'),
      PM_USER_DATA: join(dir, 'userdata'),
      PM_HIDE_WINDOW: '1',
      PM_TRASH_DIR: join(dir, 'trash'),
      ADS_API_TOKEN: '',
      HOME: dir // keeps ~/.ads/dev_key out of the test
    }
  })
  win = await app.firstWindow()
  await win.setViewportSize({ width: 1320, height: 820 })
})

test.afterAll(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
})

const rows = () => win.locator('[role=grid] [role=row][data-id]')
const nav = (name: RegExp) =>
  win.getByRole('navigation', { name: 'Library' }).getByRole('button', { name })
const pane = () => win.getByRole('complementary', { name: 'Paper details' })
const paneTab = (name: RegExp) => pane().getByRole('tab', { name })

test('lists the library, with offline imports flagged for review', async () => {
  await expect(rows()).toHaveCount(3)
  await expect(win.getByRole('button', { name: /Needs review\s*3/ })).toBeVisible()
  await expect(win.getByText(/Add an ADS token in Settings/)).toBeVisible()
})

test('browses tags and pins one to the sidebar', async () => {
  await nav(/Browse tags/).click()
  const tags = win.getByRole('region', { name: 'Tags' })
  await expect(tags.getByRole('button', { name: /^Solar\s*3$/ })).toBeVisible()
  await tags.getByRole('button', { name: 'Pin Solar' }).click()
  await expect(nav(/^Solar\s*3$/)).toBeVisible()
  await nav(/^Library/).click()
  await expect(rows()).toHaveCount(3)
})

test('searches full text and highlights matches', async () => {
  await win.getByRole('textbox', { name: 'Search', exact: true }).fill('zeeman')
  await expect(rows()).toHaveCount(1)
  await expect(rows().first().locator('mark')).toContainText(/zeeman/i)
  await win.getByRole('textbox', { name: 'Search', exact: true }).fill('meridional')
  await expect(rows()).toHaveCount(3)
  await win.getByLabel('Clear search').click()
  await expect(rows()).toHaveCount(3)
})

test('edits tags and notes from the detail pane', async () => {
  await rows().filter({ hasText: 'Coronal magnetometry' }).click()
  const pane = win.getByRole('complementary', { name: 'Paper details' })
  await expect(
    pane.getByRole('heading', { name: 'Coronal magnetometry from Zeeman polarimetry' })
  ).toBeVisible()

  await pane.getByLabel('Add tag').fill('CryoNIRSP')
  await pane.getByLabel('Add tag').press('Enter')
  await expect(pane.getByRole('button', { name: 'Remove tag CryoNIRSP' })).toBeVisible()

  await paneTab(/^Notes/).click()
  await pane.getByLabel('Note').fill('Compare with DKIST maps')
  await pane.getByLabel('Note').blur()
  await rows().filter({ hasText: 'Babcock' }).click()
  await rows().filter({ hasText: 'Coronal magnetometry' }).click()
  await expect(pane.getByLabel('Note')).toHaveValue('Compare with DKIST maps')
})

test('hand-edited details rename the file and clear the review flag', async () => {
  await rows().filter({ hasText: 'Babcock' }).click()
  const pane = win.getByRole('complementary', { name: 'Paper details' })
  await pane.getByRole('button', { name: 'More actions' }).click()
  await win.getByRole('menuitem', { name: 'Edit details…' }).click()
  const dialog = win.getByRole('dialog', { name: 'Edit details' })
  await dialog.getByLabel('Authors').fill('Dikpati, Mausumi\nGilman, Peter')
  await dialog.getByLabel('Year').fill('2014')
  await dialog.getByLabel('Abbrev.').fill('GeoRL')
  await dialog.getByRole('button', { name: 'Save' }).click()

  await expect(pane.getByText('Edited by hand')).toBeVisible()
  await paneTab(/^Files/).click()
  await expect(pane.getByText('Dikpati_2014_GeoRL.pdf')).toBeVisible()
  expect(readdirSync(join(dir, 'lib', 'files'))).toContain('Dikpati_2014_GeoRL.pdf')
  await expect(win.getByRole('button', { name: /Needs review\s*2/ })).toBeVisible()
})

test('replaces a PDF with a downloaded one, keeping the library name', async () => {
  const journal = pdf('journal.pdf', 'Babcock Leighton dynamo reconstructions', [
    'The journal version, downloaded through a library login'
  ])
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, journal)
  await rows().filter({ hasText: 'Babcock' }).click()
  await pane().getByRole('button', { name: 'Replace…' }).click()
  await expect(win.getByText(/Replaced\. Now Dikpati_2014_GeoRL\.pdf/)).toBeVisible()
  await expect(pane().getByText('Dikpati_2014_GeoRL.pdf')).toBeVisible()
  const files = join(dir, 'lib', 'files')
  expect(readdirSync(files).filter((f) => f.startsWith('Dikpati'))).toEqual([
    'Dikpati_2014_GeoRL.pdf'
  ])
  expect(readFileSync(join(files, 'Dikpati_2014_GeoRL.pdf')).equals(readFileSync(journal))).toBe(
    true
  )
  expect(readdirSync(join(dir, 'trash')).some((f) => f.startsWith('Dikpati_2014_GeoRL'))).toBe(true)
})

test('opens the reader and finds text in the PDF', async () => {
  await rows().filter({ hasText: 'Surface flux' }).dblclick()
  await expect(win.locator('.pdfViewer .page canvas').first()).toBeVisible({ timeout: 15_000 })
  await expect(win.getByRole('textbox', { name: 'Page number' })).toHaveValue('1')
  await win.getByLabel('Find in paper').fill('Kalman')
  await win.getByLabel('Find in paper').press('Enter')
  await expect(win.getByText(/1 of 1/)).toBeVisible()
  await win.keyboard.press('Escape') // leaves the find box
  await win.keyboard.press('Escape') // leaves the reader
  await expect(rows()).toHaveCount(3)
})

test('imports through the bridge and reports duplicates', async () => {
  const again = join(dir, 'src', 'flux.pdf')
  const fresh = pdf('new.pdf', 'A fourth paper on coronal loops', ['text'])
  const outcomes = await win.evaluate(
    (paths) =>
      (
        globalThis as unknown as {
          pm: { importPaths: (p: string[]) => Promise<{ status: string }[]> }
        }
      ).pm.importPaths(paths),
    [again, fresh]
  )
  expect(outcomes.map((o) => o.status)).toEqual(['duplicate', 'imported'])
  await expect(rows()).toHaveCount(4)
})

test('removes a paper and moves its file to the trash', async () => {
  await rows().filter({ hasText: 'fourth paper' }).click()
  win.once('dialog', (d) => void d.accept())
  const pane = win.getByRole('complementary', { name: 'Paper details' })
  await expect(pane.getByRole('heading', { name: /fourth paper/ })).toBeVisible()
  await paneTab(/^Files/).click()
  const file = await pane.locator('li button.font-mono').innerText()
  await pane.getByRole('button', { name: 'More actions' }).click()
  await win.getByRole('menuitem', { name: 'Remove from library' }).click()
  await expect(rows()).toHaveCount(3)
  expect(existsSync(join(dir, 'lib', 'files', file))).toBe(false)
  expect(existsSync(join(dir, 'trash', file))).toBe(true)
})

test('verifies the library as consistent', async () => {
  await win.getByRole('button', { name: 'Verify library' }).click()
  await expect(win.getByRole('dialog', { name: 'Library check' })).toContainText(
    'Everything is consistent'
  )
})

test('jumps and runs commands from the command palette', async () => {
  await win.keyboard.press('Escape')
  await expect(win.getByRole('dialog', { name: 'Library check' })).toBeHidden()
  await win.keyboard.press('ControlOrMeta+k')
  const palette = win.getByRole('dialog', { name: 'Command palette' })
  await palette.getByLabel('Command').fill('coronal magnet')
  await palette.getByRole('option', { name: /Coronal magnetometry/ }).click()
  await expect(pane().getByRole('heading', { name: /Coronal magnetometry/ })).toBeVisible()
  await win.keyboard.press('ControlOrMeta+k')
  await palette.getByLabel('Command').fill('compact rows')
  await palette.getByLabel('Command').press('Enter')
  await expect(palette).toBeHidden()
  await expect(win.locator('html')).toHaveAttribute('data-density', 'compact')
})
