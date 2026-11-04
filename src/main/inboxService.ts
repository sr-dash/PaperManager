import { watch, type FSWatcher } from 'node:fs'
import { Inbox, type Inspection } from '../core/inbox.js'
import type { Library } from '../core/library.js'
import { PdfWorker } from './pdfWorker.js'

/**
 * Keeps the inbox current: an initial scan, then a debounced rescan whenever a
 * watched folder changes. Scans never overlap; a change during a scan queues one more.
 */
export class InboxService {
  readonly inbox: Inbox
  private readonly worker = new PdfWorker()
  private watchers: FSWatcher[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private running: Promise<void> | null = null
  private again = false
  progress: { done: number; total: number } | null = null

  constructor(
    lib: Library,
    defaultFolders: string[],
    private readonly notify: (event: 'changed' | 'progress') => void
  ) {
    this.inbox = new Inbox(lib, defaultFolders)
  }

  start(): void {
    this.rewatch()
    void this.rescan()
  }

  stop(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    this.worker.stop()
  }

  /** Call after the folder list changes. */
  rewatch(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    for (const folder of this.inbox.folders()) {
      try {
        this.watchers.push(
          watch(folder, (_event, name) => {
            if (!name || name.toLowerCase().endsWith('.pdf')) this.schedule()
          })
        )
      } catch {
        // Folder missing or unreadable: it simply contributes nothing until it exists.
      }
    }
  }

  rescan(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          let sinceNotify = 0
          await this.inbox.scan({
            inspect: (path) => this.inspect(path),
            onProgress: (p) => {
              this.progress = p.done < p.total ? p : null
              this.notify('progress')
            },
            // Show results as they arrive during a long first scan.
            onItem: () => {
              if (++sinceNotify >= 15) {
                sinceNotify = 0
                this.notify('changed')
              }
            }
          })
          this.progress = null
          this.notify('changed')
        } while (this.again)
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  private schedule(): void {
    // Downloads arrive in bursts and are often renamed on completion; let it settle.
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.rescan(), 1500)
  }

  private inspect(path: string): Promise<Inspection> {
    return this.worker.run<Inspection>('inspect', path)
  }
}
