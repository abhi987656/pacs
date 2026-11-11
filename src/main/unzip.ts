// Unpacks ZIP archives (a study downloaded from a PACS web portal, or sent by e-mail / WhatsApp)
// into a temporary folder, so their DICOM files can be imported like any other folder.
// Entries are read one at a time straight from the file, so even very big ZIPs need little memory.

import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import * as yauzl from 'yauzl'
import { isLikelyNonDicom } from './dicom'

/** Limits against broken or malicious archives ("zip bombs"). */
export const MAX_ZIP_ENTRIES = 300_000
export const MAX_ZIP_BYTES = 100 * 1024 ** 3

/** A problem with the archive itself, worded for the user. */
export class ZipError extends Error {}

export interface UnzipProgress {
  done: number
  total: number
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // decodeStrings: false – yauzl would reject the whole archive for one odd name such as
    // "../x.dcm"; names are decoded below and never used as paths (files are written flat).
    yauzl.open(path, { lazyEntries: true, autoClose: true, decodeStrings: false, validateEntrySizes: true }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error('cannot open'))
      else resolve(zip)
    })
  })
}

/** The entry's name as the ZIP tool meant it (UTF-8 flag, Unicode extra field, or the DOS code page). */
function decodeName(entry: yauzl.Entry, raw: Buffer): string {
  const lowLevel = (yauzl as unknown as { getFileNameLowLevel?: (flag: number, name: Buffer, extra: unknown, strict: boolean) => string }).getFileNameLowLevel
  try {
    if (lowLevel) return lowLevel(entry.generalPurposeBitFlag, raw, entry.extraFields, false)
  } catch {
    /* fall through */
  }
  return raw.toString('latin1')
}

/** "series 2/IM 0001.dcm" -> "000042_IM_0001.dcm" (flat: no folders, nothing outside `destDir`). */
function safeName(entryName: string, index: number): string {
  const base = basename(entryName.replace(/\\/g, '/')).replace(/[^\w.\-]+/g, '_').replace(/^\.+/, '').slice(-80)
  return `${String(index).padStart(6, '0')}_${base || 'file'}`
}

/**
 * Extracts the files of `zipPath` that could be DICOM (and ZIPs inside it) into `destDir`.
 * Returns how many files were written.
 */
export async function unzipTo(
  zipPath: string,
  destDir: string,
  onProgress: (p: UnzipProgress) => void,
  isCancelled: () => boolean
): Promise<number> {
  const name = basename(zipPath)
  let zip: yauzl.ZipFile
  try {
    zip = await openZip(zipPath)
  } catch (e) {
    throw new ZipError(`${name} could not be opened as a ZIP file (${(e as Error).message}). It may be damaged or incomplete.`)
  }
  const total = zip.entryCount
  if (total > MAX_ZIP_ENTRIES) {
    zip.close()
    throw new ZipError(`${name} has too many files (${total}).`)
  }
  await mkdir(destDir, { recursive: true })

  return new Promise<number>((resolve, reject) => {
    let done = 0
    let written = 0
    let encrypted = 0
    let bytes = 0
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      try {
        zip.close()
      } catch {
        /* already closed */
      }
      if (err) reject(err)
      else if (encrypted && !written) {
        reject(new ZipError(`${name} is password-protected. Extract it first (for example with 7-Zip), then import the folder.`))
      } else resolve(written)
    }
    const next = () => {
      onProgress({ done, total })
      if (isCancelled()) finish()
      else zip.readEntry()
    }
    zip.on('error', (e: Error) => finish(new ZipError(`${name} is damaged: ${e.message}`)))
    zip.on('end', () => finish())
    zip.on('entry', (entry: yauzl.Entry) => {
      done++
      const raw = entry.fileName as unknown as Buffer
      const decoded = Buffer.isBuffer(raw) ? decodeName(entry, raw) : String(raw)
      const path = decoded.replace(/\\/g, '/')
      const file = path.split('/').pop() ?? ''
      const isDir = path.endsWith('/')
      const junk = /(^|\/)__MACOSX\//.test(path) || file.startsWith('._') || file === '.DS_Store'
      const isZip = file.toLowerCase().endsWith('.zip')
      if (isDir || junk || (!isZip && isLikelyNonDicom(file))) return next()
      if (entry.isEncrypted()) {
        encrypted++
        return next()
      }
      bytes += entry.uncompressedSize
      if (bytes > MAX_ZIP_BYTES) return finish(new ZipError(`${name} unpacks to more than ${MAX_ZIP_BYTES / 1024 ** 3} GB.`))
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return finish(new ZipError(`${name}: ${file} could not be read (${err?.message ?? 'no data'}).`))
        pipeline(stream, createWriteStream(join(destDir, safeName(path, done)))).then(
          () => {
            written++
            next()
          },
          (e: Error) => finish(/ENOSPC/.test(e.message) ? new ZipError('The disk is full.') : new ZipError(`${name}: ${file}: ${e.message}`))
        )
      })
    })
    zip.readEntry()
  })
}
