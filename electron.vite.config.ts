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

export default defineConfig({
  main: {
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
      alias: { '@shared': resolve('src/shared') }
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
