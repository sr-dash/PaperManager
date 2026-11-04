/**
 * Worker thread for CPU-bound PDF work: inbox inspections and reading annotations.
 * Parsing PDFs with pdf.js here keeps the main process (and so every IPC call from the
 * window) responsive.
 */
import { parentPort } from 'node:worker_threads'
import { inspectPdf } from '../core/inbox.js'
import { detectOrigin } from '../core/origin.js'
import { readPdfAnnotations, readPdfSample } from '../core/pdf.js'

type Task = { id: number; path: string; type?: 'inspect' | 'annotations' | 'origin' }

parentPort?.on('message', async (msg: Task) => {
  try {
    const result =
      msg.type === 'annotations'
        ? await readPdfAnnotations(msg.path)
        : msg.type === 'origin'
          ? await readPdfSample(msg.path, 1).then((s) => detectOrigin(s.firstPage, s.info))
          : await inspectPdf(msg.path)
    parentPort?.postMessage({ id: msg.id, result })
  } catch (err) {
    parentPort?.postMessage({ id: msg.id, error: (err as Error).message })
  }
})
