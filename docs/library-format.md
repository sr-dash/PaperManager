# Library format (schema v5)

A PaperManager library is a folder. Everything the app knows lives in it, so it
can be backed up, synced or inspected with ordinary tools.

```text
PaperManager/
├── library.sqlite        # records (plus -wal / -shm while open)
├── originals/            # untouched downloads of files you have annotated, by SHA-256
│   └── 3f2a….pdf
├── backups/              # daily snapshots of library.sqlite (the last 14)
└── files/
    ├── Dash_2024_ApJ_975_288.pdf
    ├── Dash_2024_ApJ_975_288-b.pdf     # second file of the same paper, or a name collision
    └── …
```

## Invariants

These hold after every completed operation, and `pm verify` checks them.

1. Every `files` row names an existing file under `files/`, with the recorded size.
   With `--deep`, its SHA-256 also matches.
2. Every PDF under `files/` has a `files` row.
3. No two `files` rows share a SHA-256 or a path (paths compared case-insensitively).
4. `papers.doi`, `papers.bibcode` and `papers.arxiv_id` are each unique when set.
   One work is one paper, however many files it has.
5. For every `files` row with `original_sha256` set, `originals/<original_sha256>.pdf`
   exists and holds the file as first imported. `pm verify` checks this too.
6. A paper may have no file: it was added from its record alone because no PDF could
   be fetched. Attaching one later makes it an ordinary paper.
7. Deleting a paper cascades to its authors, files rows, tags, notes and collection links.
   The library layer removes its `papers_fts` row. Removing the PDFs themselves is a separate, explicit step.

## Versioning

`PRAGMA user_version` holds the schema version. Migrations in
`src/core/db/migrations.ts` are append-only and run inside one transaction each.
A build that finds a version newer than it knows refuses to open the library
rather than risk writing to it.

## Tables

| Table                              | Purpose                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `papers`                           | One row per work. Bibliographic fields and identifiers, plus `metadata_source`: `ads`, `crossref`, `arxiv`, `legacy` or `manual`. Also `metadata_status`: `unresolved`, `resolved` or `manual`, where `manual` papers are never overwritten by lookups. Also `bibtex`, the ADS export when available. Since v4: `reading` (`to-read`, `reading` or `read`) and `starred`. |
| `authors`                          | Ordered `(paper_id, position)` with `family` and `given` names.                                                                                                                                                                                                                                                                                                           |
| `files`                            | The PDFs: `sha256`, `rel_path` (always `files/<name>.pdf`), `size`, `original_name`, `added_at`. Since v3 there is also `original_sha256`, the fingerprint of the download before annotations were saved into it. Since v5, `origin`: `publisher`, `arxiv`, `ads-scan` or `unknown` (NULL until classified).                                                              |
| `tags`, `paper_tags`               | Tags, which are unique ignoring case.                                                                                                                                                                                                                                                                                                                                     |
| `collections`, `collection_papers` | Collections and their papers. Since v4, a collection with a `query` is smart: its papers are whatever the query matches, and `collection_papers` is unused for it.                                                                                                                                                                                                        |
| `notes`                            | Free-text notes per paper.                                                                                                                                                                                                                                                                                                                                                |
| `settings`                         | Key/value preferences stored with the library, JSON-encoded: watched folders (`inbox.folders`), whether to move originals to the Trash after filing (`inbox.trashAfterFiling`), and automatic cite tags (`library.citeTags`). Added in v2.                                                                                                                                |
| `inbox_seen`                       | Scan cache for PDFs in watched folders: path, size, mtime, SHA-256, verdict, score, reasons, identifiers, page count and classifier version. A title is kept only for likely or possible papers; extracted text is never stored. Derived data, safe to delete. Added in v2.                                                                                               |
| `inbox_ignored`                    | Files dismissed from the inbox, keyed by SHA-256 so renamed or re-downloaded copies stay dismissed. Added in v2.                                                                                                                                                                                                                                                          |
| `annotations`                      | Index of the highlights, notes and drawings inside each PDF: file, page, kind, colour, the highlighted words, and any comment. The PDFs stay the source of truth. `files.annotations_sha` records which bytes the index was built from, and a file is re-read whenever its bytes change. Derived data, safe to delete. Added in v4.                                       |
| `watches`, `watch_hits`            | Saved ADS queries and the results they found, each `new`, `dismissed` or `added`. Added in v4.                                                                                                                                                                                                                                                                            |
| `manuscripts`                      | LaTeX project folders whose bibliography is kept in step with the library. Added in v4.                                                                                                                                                                                                                                                                                   |
| `papers_fts`                       | FTS5 index keyed by `rowid = papers.id`, over title, authors, abstract, tags and the extracted text. It is derived data and can be rebuilt.                                                                                                                                                                                                                               |

Timestamps are ISO-8601 UTC strings.

## File naming

`Family_Year_Journal_Volume_Page.pdf`:

- The journal abbreviation comes from the ADS bibcode (`ApJ`, `AA`, `SciA`, `GeoRL`).
- A letter-page qualifier is kept (`French_2019_ApJ_887_L34`).
- A preprint with no journal is named `Family_Year_arXiv_2409.09000`.
- Diacritics are folded to ASCII, and characters outside `[A-Za-z0-9-]` are dropped.
- A paper without both an author and a year keeps a sanitised form of its original file name.
- Files are renamed when `pm resolve` improves a record's metadata.
- A paper with several files names them in origin order (publisher, ADS scan, unknown,
  arXiv): the first gets the plain name, the rest `-b`, `-c` and so on. Names are
  recomputed whenever a file is added, replaced or removed, so the publisher copy always
  holds the plain name.

## Tags added automatically

When a paper's first author and year are known, whether at import, from the Inbox, from a
later lookup, or after a hand edit, it gets a `FamilyYY` tag: `Schad24`, `Dash24`,
`HebburDayananda25`. This follows the convention of the earlier libraries, and the
`library.citeTags` setting turns it off. Files filed from a folder holding an old
PaperManager `papers.json` also bring along the tags and ADS link recorded there.

## Annotations

Highlights, text notes and drawings made in the reader are saved into the PDF itself as
standard PDF annotations. They therefore show up in any PDF reader the file is opened in or sent to.

- **The first save** keeps the untouched original under `originals/`.
- **Every save** writes the new version beside the file and renames it into place.
- **Duplicates:** re-importing the original download is still recognised as a duplicate,
  because the importer and the inbox match both `sha256` and `original_sha256`.
- **Restore original** puts the kept copy back and removes it from `originals/`.

## Settings outside the library

Two things belong to the installation rather than to a library. Both live in the app's
own `config.json` in Electron's user-data folder:

- which library folder to open;
- the ADS token, encrypted with the operating system keychain (`safeStorage`), never
  stored in plain text.
