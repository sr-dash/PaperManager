/**
 * End-to-end: annotating a library paper in the reader, saving the annotations into
 * the PDF, and restoring the original.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makePdf } from '../test/pdf-fixture.js'

let dir: string
let app: ElectronApplication
let win: Page
let src: string

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pm-annot-'))
  mkdirSync(join(dir, 'src'))
  src = join(dir, 'src', 'paper.pdf')
  writeFileSync(
    src,
    makePdf([['Annotate this paragraph about coronal loops.'], ['Page two']], {
      Title: 'A paper to annotate'
    })
  )
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
      src
    ],
    { stdio: 'pipe' }
  )
  app = await electron.launch({
    args: ['out/main/index.js'],
    env: {
      ...process.env,
      PM_LIBRARY: join(dir, 'lib'),
      PM_USER_DATA: join(dir, 'ud'),
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

// The reader's annotation tools (the sidebar also has a "Highlights" entry).
const tool = (name: string) =>
  win.getByRole('toolbar', { name: 'Annotation tools' }).getByRole('button', { name, exact: true })

const libraryPdf = () => {
  const name = readdirSync(join(dir, 'lib', 'files')).find((n) => n.endsWith('.pdf'))!
  return readFileSync(join(dir, 'lib', 'files', name))
}

test('draws on a page, saves into the PDF, and keeps the original', async () => {
  const before = libraryPdf()
  await win.locator('[role=grid] [role=row][data-id]').first().dblclick()
  const page = win.locator('.pdfViewer .page').first()
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 15_000 })

  await tool('Draw').click()
  await expect(tool('Draw')).toHaveAttribute('aria-pressed', 'true')
  const box = (await page.boundingBox())!
  await win.mouse.move(box.x + 120, box.y + 200)
  await win.mouse.down()
  for (let i = 1; i <= 10; i++)
    await win.mouse.move(box.x + 120 + i * 20, box.y + 200 + (i % 2) * 15)
  await win.mouse.up()

  await win.keyboard.press('Escape') // leaves the pen (committing the stroke), stays in the reader
  await expect(tool('Select')).toHaveAttribute('aria-pressed', 'true')
  await expect(win.getByText('Unsaved')).toBeVisible()
  await win.keyboard.press('ControlOrMeta+s')
  await expect(win.getByText('Unsaved')).toBeHidden()

  const after = libraryPdf()
  expect(after.equals(before)).toBe(false)
  expect(after.toString('latin1')).toMatch(/\/Subtype\s*\/Ink/)
  expect(readdirSync(join(dir, 'lib', 'originals'))).toHaveLength(1)

  // The untouched download is still recognised.
  const outcomes = await win.evaluate(
    (p) =>
      (
        globalThis as unknown as {
          pm: { importPaths: (x: string[]) => Promise<{ status: string }[]> }
        }
      ).pm.importPaths(p),
    [src]
  )
  expect(outcomes[0]?.status).toBe('duplicate')
})

test('highlights selected text', async () => {
  await tool('Highlight').click()
  const span = win.locator('.textLayer span', { hasText: 'coronal loops' }).first()
  const box = (await span.boundingBox())!
  await win.mouse.move(box.x + 2, box.y + box.height / 2)
  await win.mouse.down()
  await win.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 8 })
  await win.mouse.up()
  await expect(win.locator('.highlightEditor').first()).toBeVisible()
  await win.keyboard.press('ControlOrMeta+s')
  await expect(win.getByText('Unsaved')).toBeHidden()
  await expect.poll(() => libraryPdf().toString('latin1')).toMatch(/\/Subtype\s*\/Highlight/)
})

test('restores the original from the details pane', async () => {
  await win.keyboard.press('Escape') // back to the library
  await win.locator('[role=grid] [role=row][data-id]').first().click()
  const pane = win.getByRole('complementary', { name: 'Paper details' })
  await pane.getByRole('tab', { name: /^Files/ }).click()
  await expect(pane.getByText('Has your annotations')).toBeVisible()
  win.once('dialog', (d) => void d.accept())
  await pane.getByRole('button', { name: 'File actions' }).click()
  await win.getByRole('menuitem', { name: /Restore the original/ }).click()
  await expect(pane.getByText('Has your annotations')).toBeHidden()
  expect(libraryPdf().toString('latin1')).not.toMatch(/\/Subtype\s*\/(Ink|Highlight)/)
  expect(
    existsSync(join(dir, 'lib', 'originals')) && readdirSync(join(dir, 'lib', 'originals'))
  ).toEqual([])
})
