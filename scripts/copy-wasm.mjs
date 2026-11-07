// Copies the WASM image decoders used by the DICOM image loader into the renderer's
// public folder, so they can be served at /wasm/<file> in dev and in the packaged app.
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'src', 'renderer', 'public', 'wasm')
mkdirSync(outDir, { recursive: true })

const files = [
  ['@cornerstonejs/codec-charls/dist/charlswasm_decode.wasm', 'charlswasm_decode.wasm'],
  ['@cornerstonejs/codec-libjpeg-turbo-8bit/dist/libjpegturbowasm_decode.wasm', 'libjpegturbowasm_decode.wasm'],
  ['@cornerstonejs/codec-openjpeg/dist/openjpegwasm_decode.wasm', 'openjpegwasm_decode.wasm'],
  ['@cornerstonejs/codec-openjph/dist/openjphjs.wasm', 'openjphjs.wasm'],
  ['@cornerstonejs/codec-libjxl/dist/jpegxlwasm_decode.wasm', 'jpegxlwasm_decode.wasm']
]

let copied = 0
for (const [src, name] of files) {
  const from = join(root, 'node_modules', src)
  if (!existsSync(from)) {
    console.warn(`[copy-wasm] missing ${src} (skipped)`)
    continue
  }
  copyFileSync(from, join(outDir, name))
  copied++
}
console.log(`[copy-wasm] copied ${copied} decoder(s) to ${outDir}`)
