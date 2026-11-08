import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Builds the Android app's screens (src/mobile) into out-mobile/, which Capacitor packs into the APK.
export default defineConfig({
  root: resolve(import.meta.dirname, 'src/mobile'),
  base: './',
  publicDir: resolve(import.meta.dirname, 'src/mobile/public'),
  plugins: [react()],
  resolve: {
    alias: { '@shared': resolve(import.meta.dirname, 'src/shared') }
  },
  build: {
    outDir: resolve(import.meta.dirname, 'out-mobile'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000
  },
  server: { port: 5199, strictPort: true },
  preview: { port: 5198, strictPort: true }
})
