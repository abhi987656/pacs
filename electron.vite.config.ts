import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// The dev server injects inline scripts (React refresh), which the production CSP blocks.
const stripCspInDev = (): Plugin => ({
  name: 'strip-csp-in-dev',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace(/<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/, '')
})

// Which software is built (PACS_EDITION=master for the master software) and the Supabase project
// it signs in to (public URL + anon key; empty = no sign-in). Set by the build (GitHub secrets).
const edition = process.env.PACS_EDITION === 'master' ? 'master' : 'user'
const accessDefines = {
  __PACS_EDITION__: JSON.stringify(edition),
  __SUPABASE_URL__: JSON.stringify((process.env.SUPABASE_URL ?? '').trim()),
  __SUPABASE_ANON_KEY__: JSON.stringify((process.env.SUPABASE_ANON_KEY ?? '').trim())
}

export default defineConfig({
  main: {
    define: accessDefines,
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // Runs in a utility process: speech model download + recognition.
          speechWorker: resolve('src/main/speechWorker.ts')
        },
        // node:sqlite is built into Electron's Node runtime; never bundle it.
        external: ['node:sqlite', 'electron']
      }
    },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  preload: {
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    }
  },
  renderer: {
    plugins: [react(), stripCspInDev()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        // Hunspell dictionaries for the spell checker (imported as text with ?raw)
        '@dict-gb': resolve('node_modules/dictionary-en-gb'),
        '@dict-us': resolve('node_modules/dictionary-en')
      }
    },
    // The DICOM image loader ships web workers and WASM codecs that must not be pre-bundled.
    optimizeDeps: {
      exclude: ['@cornerstonejs/dicom-image-loader'],
      include: ['dicom-parser']
    },
    worker: {
      format: 'es'
    },
    build: {
      target: 'esnext',
      chunkSizeWarningLimit: 8000,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          viewer: resolve('src/renderer/viewer.html')
        }
      }
    }
  }
})
