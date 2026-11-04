/**
 * pdf.js in the renderer. `pdf_viewer.mjs` reads `globalThis.pdfjsLib` when it is
 * evaluated, so the core library must be installed first; hence the dynamic import.
 */
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl
;(globalThis as { pdfjsLib?: typeof pdfjsLib }).pdfjsLib = pdfjsLib

export { pdfjsLib }

export async function loadViewer() {
  return import('pdfjs-dist/web/pdf_viewer.mjs')
}

// Served from the renderer's public folder (see electron.vite.config.ts).
const base = new URL('./pdfjs/', document.baseURI).href
export const PDF_ASSETS = {
  cMapUrl: `${base}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${base}standard_fonts/`,
  wasmUrl: `${base}wasm/`
}
