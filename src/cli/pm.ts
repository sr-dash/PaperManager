/**
 * `pm` — command-line front end to the library core: build, inspect and verify a library.
 *
 *   npm run pm -- <command> [options]
 */
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { schemaVersion } from '../core/db/database.js'
import {
  importLegacyRecords,
  knownLegacyLocations,
  readPythonLibrary,
  readSwiftLibrary
} from '../core/legacy.js'
import { Inbox } from '../core/inbox.js'
import { DEFAULT_LIBRARY_ROOT, Library, NotPdfError } from '../core/library.js'
import { citeTag } from '../core/naming.js'
import { createResolver, findAdsToken, type Resolver } from '../core/metadata/resolver.js'
import type { PaperSummary } from '../core/types.js'

const HELP = `Usage: pm <command> [options]

Commands
  info                         Library location, counts and configuration
  import <path...>             Import PDFs (files, or folders scanned one level deep)
  import-legacy [--dry-run]    Import the earlier Swift and PyQt PaperManager libraries
  list [--tag T] [--unresolved]
  search <words...>            Full-text search over titles, authors, abstracts, tags and text
  show <id>                    Everything recorded about one paper
  resolve [<id...>|--all]      Look up metadata again and rename files canonically
  tag <id> <tag...>            Add tags
  untag <id> <tag...>          Remove tags
  verify [--deep]              Check database against files (--deep re-hashes every file)
  inbox [--add DIR] [--remove DIR] [--all]
                               Scan watched folders and list likely papers not yet filed
                               (--all also lists unsure and other files)
  cite-tags                    Give every paper its FamilyYY tag (automatic for new papers)

Options
  --library <dir>              Library folder (default ${DEFAULT_LIBRARY_ROOT}, or $PM_LIBRARY)
  --offline                    Skip metadata lookups
  --tag <name>                 With import: tag every imported file (repeatable)
`

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      library: { type: 'string' },
      offline: { type: 'boolean', default: false },
      tag: { type: 'string', multiple: true },
      unresolved: { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      deep: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      add: { type: 'string', multiple: true },
      remove: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h', default: false }
    }
  })
  const [command, ...args] = positionals
  if (!command || values.help) {
    process.stdout.write(HELP)
    return command ? 0 : 1
  }

  const root = resolve(values.library ?? process.env.PM_LIBRARY ?? DEFAULT_LIBRARY_ROOT)
  const token = await findAdsToken()
  const resolver: Resolver | undefined = values.offline
    ? undefined
    : createResolver({ adsToken: token })
  const lib = Library.open(root)
  try {
    switch (command) {
      case 'info':
        return info(lib, token)
      case 'import':
        return await importPaths(lib, args, values.tag ?? [], resolver)
      case 'import-legacy':
        return await importLegacy(lib, values['dry-run'], resolver)
      case 'list':
        printPapers(
          lib.listPapers({
            tag: values.tag?.[0],
            status: values.unresolved ? 'unresolved' : undefined
          })
        )
        return 0
      case 'search':
        for (const hit of lib.search(args.join(' '))) {
          printPapers([hit.paper])
          console.log(`        ${hit.snippet.replace(/\s+/g, ' ')}`)
        }
        return 0
      case 'show':
        return show(lib, Number(args[0]))
      case 'resolve':
        return await resolveCmd(lib, args, values.all, resolver)
      case 'tag':
      case 'untag': {
        const id = Number(args[0])
        if (!lib.getPaper(id)) return fail(`No paper with id ${args[0]}`)
        if (command === 'tag') lib.addTags(id, args.slice(1))
        else lib.removeTags(id, args.slice(1))
        printPapers([lib.summary(id)])
        return 0
      }
      case 'verify':
        return await verify(lib, values.deep)
      case 'inbox':
        return await inboxCmd(lib, values.add ?? [], values.remove ?? [], values.all)
      case 'cite-tags': {
        for (const p of lib.listRows()) {
          const tag = citeTag(lib.metadataOf(p.id))
          if (tag && !p.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
            lib.addTags(p.id, [tag])
            console.log(`#${p.id} + ${tag}`)
          }
        }
        return 0
      }
      default:
        return fail(`Unknown command: ${command}\n\n${HELP}`)
    }
  } finally {
    lib.close()
  }
}

function info(lib: Library, token: string | undefined): number {
  const count = (sql: string) => (lib.db.prepare(sql).get() as { n: number }).n
  console.log(`library     ${lib.root}`)
  console.log(`schema      v${schemaVersion(lib.db)}`)
  console.log(`papers      ${count('SELECT count(*) n FROM papers')}`)
  console.log(
    `  resolved  ${count("SELECT count(*) n FROM papers WHERE metadata_status != 'unresolved'")}`
  )
  console.log(`files       ${count('SELECT count(*) n FROM files')}`)
  console.log(`tags        ${count('SELECT count(*) n FROM tags')}`)
  console.log(
    `ADS token   ${token ? 'found' : 'not set (ADS_API_TOKEN or ~/.ads/dev_key); using Crossref/arXiv only'}`
  )
  return 0
}

async function importPaths(lib: Library, paths: string[], tags: string[], resolver?: Resolver) {
  if (!paths.length) return fail('import: give at least one PDF or folder')
  const files: string[] = []
  for (const p of paths) {
    const abs = resolve(p)
    if ((await stat(abs)).isDirectory()) {
      for (const name of (await readdir(abs)).sort()) {
        if (name.toLowerCase().endsWith('.pdf')) files.push(join(abs, name))
      }
    } else {
      files.push(abs)
    }
  }
  let failures = 0
  for (const file of files) {
    try {
      const r = await lib.importPdf(file, { resolver, tags })
      const note = r.errors.length ? `  (${r.errors.join('; ')})` : ''
      console.log(`${r.status.padEnd(9)} #${r.paperId} ${r.relPath}  [${r.metadataStatus}]${note}`)
    } catch (err) {
      failures++
      const msg = err instanceof NotPdfError ? 'not a PDF' : (err as Error).message
      console.log(`skipped   ${file}  (${msg})`)
    }
  }
  return failures ? 2 : 0
}

async function importLegacy(lib: Library, dryRun: boolean, resolver?: Resolver) {
  const locations = knownLegacyLocations(homedir())
  if (!locations.length) return fail('No legacy PaperManager libraries found.')
  for (const loc of locations) {
    const records =
      loc.kind === 'swift' ? await readSwiftLibrary(loc.path) : readPythonLibrary(loc.path)
    console.log(`\n${loc.kind} library: ${loc.path} (${records.length} records)`)
    if (dryRun) {
      for (const r of records)
        console.log(`  ${r.pdfPath}  tags=[${r.tags.join(', ')}]  bibcode=${r.bibcode ?? '-'}`)
      continue
    }
    const report = await importLegacyRecords(lib, loc.path, records, resolver)
    for (const r of report.results)
      console.log(`  ${r.status.padEnd(9)} #${r.paperId} ${r.relPath}  [${r.metadataStatus}]`)
    for (const f of report.failures) console.log(`  failed    ${f.pdfPath}  (${f.error})`)
  }
  return 0
}

async function resolveCmd(lib: Library, args: string[], all: boolean, resolver?: Resolver) {
  if (!resolver) return fail('resolve needs network access; drop --offline')
  const ids = all
    ? lib.listPapers({ status: 'unresolved' }).map((p) => p.id)
    : args.map(Number).filter(Number.isInteger)
  if (!ids.length) return fail('resolve: give paper ids or --all')
  for (const id of ids) {
    const r = await lib.resolvePaper(id, resolver)
    const note = r.errors.length ? `  (${r.errors.join('; ')})` : ''
    console.log(`${r.status.padEnd(9)} #${r.paperId}${note}`)
  }
  return 0
}

function show(lib: Library, id: number): number {
  const paper = lib.getPaper(id)
  if (!paper) return fail(`No paper with id ${id}`)
  const meta = lib.metadataOf(id)
  const s = lib.summary(id)
  console.log(`#${id}  ${meta.title ?? '(untitled)'}`)
  console.log(
    `authors   ${meta.authors.map((a) => [a.family, a.given].filter(Boolean).join(', ')).join('; ') || '-'}`
  )
  console.log(
    `journal   ${[meta.journal, meta.volume, meta.page].filter(Boolean).join(', ') || '-'}  (${meta.year ?? '-'})`
  )
  console.log(
    `ids       bibcode=${meta.bibcode ?? '-'}  doi=${meta.doi ?? '-'}  arXiv=${meta.arxivId ?? '-'}`
  )
  console.log(`status    ${paper.metadata_status} via ${paper.metadata_source ?? '-'}`)
  console.log(`tags      ${s.tags.join(', ') || '-'}`)
  for (const f of s.files) console.log(`file      ${join(lib.root, f)}`)
  return 0
}

async function verify(lib: Library, deep: boolean): Promise<number> {
  const issues = await lib.verify({ deep })
  if (!issues.length) {
    console.log(`OK — database and files agree${deep ? ' (all hashes checked)' : ''}.`)
    return 0
  }
  for (const i of issues) console.log(JSON.stringify(i))
  return 3
}

async function inboxCmd(lib: Library, add: string[], remove: string[], all: boolean) {
  const inbox = new Inbox(lib)
  if (add.length || remove.length) {
    const drop = new Set(remove.map((r) => resolve(r)))
    inbox.setFolders([
      ...inbox.folders().filter((f) => !drop.has(f)),
      ...add.map((a) => resolve(a))
    ])
  }
  console.log(`watching    ${inbox.folders().join(', ')}`)
  const items = await inbox.scan({
    onProgress: (p) =>
      process.stderr.isTTY &&
      p.total > 0 &&
      process.stderr.write(`\rscanning    ${p.done}/${p.total}`)
  })
  if (process.stderr.isTTY) process.stderr.write('\n')
  const pending = items.filter((i) => i.state === 'pending')
  const count = (v: string) => pending.filter((i) => i.verdict === v).length
  console.log(
    `pending     ${count('paper')} likely papers, ${count('maybe')} unsure, ${count('other')} other`
  )
  console.log(
    `filed       ${items.filter((i) => i.state === 'filed').length} already in the library`
  )
  for (const i of pending.filter((i) => all || i.verdict === 'paper')) {
    console.log(`  ${i.verdict.padEnd(5)} ${String(i.score).padStart(5)}  ${i.path}`)
  }
  return 0
}

function printPapers(papers: PaperSummary[]): void {
  for (const p of papers) {
    const who = [p.first_author, p.year].filter(Boolean).join(' ')
    const flag = p.metadata_status === 'unresolved' ? '?' : ' '
    const tags = p.tags.length ? `  {${p.tags.join(', ')}}` : ''
    console.log(`${flag}#${String(p.id).padEnd(5)} ${who.padEnd(18)} ${p.title ?? ''}${tags}`)
  }
}

function fail(message: string): number {
  console.error(message)
  return 1
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: Error) => {
    console.error(err.message)
    process.exit(1)
  }
)
