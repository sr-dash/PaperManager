/**
 * Schema migrations, applied in order and tracked with `PRAGMA user_version`.
 *
 * Rules that keep existing libraries safe:
 *  - Never edit a migration that has shipped. Add a new one instead.
 *  - Each migration runs inside a single transaction together with its
 *    `user_version` bump, so a crash leaves the library at the previous version.
 */
export interface Migration {
  version: number
  description: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description:
      'Initial schema: papers, authors, files, tags, collections, notes, full-text index',
    sql: /* sql */ `
      CREATE TABLE papers (
        id              INTEGER PRIMARY KEY,
        title           TEXT,
        abstract        TEXT,
        year            INTEGER,
        pub_date        TEXT,
        journal         TEXT,
        journal_abbrev  TEXT,
        volume          TEXT,
        issue           TEXT,
        page            TEXT,
        entry_type      TEXT NOT NULL DEFAULT 'article',
        doi             TEXT UNIQUE COLLATE NOCASE,
        arxiv_id        TEXT UNIQUE,
        bibcode         TEXT UNIQUE,
        metadata_source TEXT CHECK (metadata_source IN ('ads', 'crossref', 'arxiv', 'legacy', 'manual')),
        metadata_status TEXT NOT NULL DEFAULT 'unresolved'
                        CHECK (metadata_status IN ('unresolved', 'resolved', 'manual')),
        bibtex          TEXT,
        added_at        TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      );

      CREATE TABLE authors (
        paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        family   TEXT NOT NULL,
        given    TEXT,
        PRIMARY KEY (paper_id, position)
      );
      CREATE INDEX authors_family ON authors(family COLLATE NOCASE);

      -- One paper can own several files (preprint + published, supplements).
      CREATE TABLE files (
        id            INTEGER PRIMARY KEY,
        paper_id      INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        sha256        TEXT NOT NULL UNIQUE,
        rel_path      TEXT NOT NULL UNIQUE,
        size          INTEGER NOT NULL,
        original_name TEXT,
        added_at      TEXT NOT NULL
      );
      CREATE INDEX files_paper ON files(paper_id);

      CREATE TABLE tags (
        id   INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE
      );
      CREATE TABLE paper_tags (
        paper_id INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (paper_id, tag_id)
      );

      CREATE TABLE collections (
        id        INTEGER PRIMARY KEY,
        name      TEXT NOT NULL,
        parent_id INTEGER REFERENCES collections(id) ON DELETE CASCADE,
        UNIQUE (parent_id, name)
      );
      CREATE TABLE collection_papers (
        collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        paper_id      INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        PRIMARY KEY (collection_id, paper_id)
      );

      CREATE TABLE notes (
        id         INTEGER PRIMARY KEY,
        paper_id   INTEGER NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
        body       TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX notes_paper ON notes(paper_id);

      -- rowid = papers.id. Maintained explicitly by the library layer.
      CREATE VIRTUAL TABLE papers_fts USING fts5(
        title, authors, abstract, tags, fulltext,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
    `
  },
  {
    version: 2,
    description: 'Settings, and the inbox: a scan cache for watched folders and ignored files',
    sql: /* sql */ `
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL -- JSON
      );

      -- One row per PDF seen in a watched folder, reused while size and mtime are unchanged.
      -- Text is never stored: only the verdict, its reasons, and (for likely papers) a title.
      CREATE TABLE inbox_seen (
        path               TEXT PRIMARY KEY,
        size               INTEGER NOT NULL,
        mtime_ms           INTEGER NOT NULL,
        sha256             TEXT NOT NULL,
        verdict            TEXT NOT NULL CHECK (verdict IN ('paper', 'maybe', 'other')),
        score              REAL NOT NULL,
        reasons            TEXT NOT NULL DEFAULT '[]',
        identifiers        TEXT NOT NULL DEFAULT '[]',
        title              TEXT,
        pages              INTEGER,
        classifier_version INTEGER NOT NULL,
        scanned_at         TEXT NOT NULL
      );
      CREATE INDEX inbox_seen_sha ON inbox_seen(sha256);

      -- Dismissed by content, so a renamed or re-downloaded copy stays dismissed.
      CREATE TABLE inbox_ignored (
        sha256     TEXT PRIMARY KEY,
        name       TEXT,
        ignored_at TEXT NOT NULL
      );
    `
  },
  {
    version: 3,
    description: 'Annotated files: remember the fingerprint of the original download',
    sql: /* sql */ `
      -- Set when a file is saved with annotations; the untouched original is kept at
      -- originals/<original_sha256>.pdf, so it can be restored and still counts as a duplicate.
      ALTER TABLE files ADD COLUMN original_sha256 TEXT;
      CREATE INDEX files_original ON files(original_sha256);
    `
  },
  {
    version: 4,
    description:
      'Reading status and stars, smart collections, annotation index, ADS watches, manuscripts',
    sql: /* sql */ `
      ALTER TABLE papers ADD COLUMN reading TEXT CHECK (reading IN ('to-read', 'reading', 'read'));
      ALTER TABLE papers ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;

      -- A collection with a query is "smart": its members are whatever the query matches.
      ALTER TABLE collections ADD COLUMN query TEXT;

      -- Highlights and notes found inside each PDF, rebuilt whenever the file changes.
      ALTER TABLE files ADD COLUMN annotations_sha TEXT;
      CREATE TABLE annotations (
        id      INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
        page    INTEGER NOT NULL,
        kind    TEXT NOT NULL,
        color   TEXT,
        text    TEXT,
        comment TEXT,
        y       REAL
      );
      CREATE INDEX annotations_file ON annotations(file_id);

      -- Saved ADS queries, and what they turned up.
      CREATE TABLE watches (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        query       TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        last_run_at TEXT,
        last_error  TEXT
      );
      CREATE TABLE watch_hits (
        watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
        bibcode  TEXT NOT NULL,
        title    TEXT,
        authors  TEXT,
        year     INTEGER,
        pub      TEXT,
        doi      TEXT,
        arxiv_id TEXT,
        found_at TEXT NOT NULL,
        state    TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new', 'dismissed', 'added')),
        PRIMARY KEY (watch_id, bibcode)
      );

      -- LaTeX projects whose bibliography is kept in step with the library.
      CREATE TABLE manuscripts (
        id             INTEGER PRIMARY KEY,
        path           TEXT NOT NULL UNIQUE,
        added_at       TEXT NOT NULL,
        last_synced_at TEXT
      );
    `
  },
  {
    version: 5,
    description: 'Where each PDF came from: publisher, arXiv, ADS scan, or unknown',
    sql: /* sql */ `
      -- NULL until classified; set on import, or in the background for older files.
      ALTER TABLE files ADD COLUMN origin TEXT
        CHECK (origin IN ('publisher', 'arxiv', 'ads-scan', 'unknown'));
    `
  }
]

export const LATEST_VERSION = MIGRATIONS.at(-1)?.version ?? 0
