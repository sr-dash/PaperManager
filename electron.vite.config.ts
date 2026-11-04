import { cpSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

/**
 * pdf.js needs its character maps, standard fonts and wasm decoders at runtime.
 * They are copied from the installed package into the renderer's public folder
 * (git-ignored) so dev and packaged builds serve the exact installed version.
 */
function pdfjsAssets(): Plugin {
  return {
    name: 'pdfjs-assets',
    buildStart() {
      const from = resolve('node_modules/pdfjs-dist')
      const to = resolve('src/renderer/public/pdfjs')
      for (const dir of ['cmaps', 'standard_fonts', 'wasm']) {
        if (existsSync(`${from}/${dir}`))
          cpSync(`${from}/${dir}`, `${to}/${dir}`, { recursive: true })
      }
    }
  }
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } }
    }
  },
  preload: {
    // A sandboxed preload must be CommonJS, even though the package is ESM.
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: { '@renderer': resolve('src/renderer/src') }
    },
    build: {
      rollupOptions: { input: { index: resolve('src/renderer/index.html') } }
    },
    plugins: [pdfjsAssets(), react(), tailwindcss()]
  }
})
