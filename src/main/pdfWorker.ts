import { Worker } from 'node:worker_threads'
import workerPath from './scanWorker?modulePath'

/** A lazily started worker thread running scanWorker, with request/response matching. */
export class PdfWorker {
  private worker: Worker | null = null
  private pending = new Map<number, (r: { result?: unknown; error?: string }) => void>()
  private seq = 0

  run<T>(type: 'inspect' | 'annotations' | 'origin', path: string): Promise<T> {
    if (!this.worker) {
      this.worker = new Worker(workerPath)
      this.worker.on('message', (msg: { id: number; result?: unknown; error?: string }) => {
        this.pending.get(msg.id)?.(msg)
        this.pending.delete(msg.id)
      })
      this.worker.on('error', () => {
        for (const resolve of this.pending.values()) resolve({ error: 'PDF worker failed' })
        this.pending.clear()
        this.worker = null
      })
    }
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, (r) => (r.error ? reject(new Error(r.error)) : resolve(r.result as T)))
      this.worker!.postMessage({ id, path, type })
    })
  }

  stop(): void {
    void this.worker?.terminate()
    this.worker = null
  }
}
