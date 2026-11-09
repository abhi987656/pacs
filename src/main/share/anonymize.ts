// Removing patient identity from a shared case. DICOM values are overwritten IN PLACE with values
// of the same length (padded with spaces), so the file stays valid DICOM, the image data is not
// touched, and the files can be patched on the fly while they are sent (no copies on disk).

import type * as dicomParser from 'dicom-parser'
import { parseBytes, readBytes } from '../dicom'

export interface Patch {
  offset: number
  bytes: Buffer
}

/** Tags blanked (or replaced) when a case is anonymized – the identifying ones of the DICOM basic profile. */
const BLANK_TAGS = new Set([
  'x00100030', // birth date
  'x00100032', // birth time
  'x00101000', // other patient IDs
  'x00101001', // other patient names
  'x00101040', // address
  'x00101060', // mother's birth name
  'x00102154', // telephone numbers
  'x001021b0', // additional patient history
  'x00104000', // patient comments
  'x00080050', // accession number (PG No)
  'x00080080', // institution name
  'x00080081', // institution address
  'x00080090', // referring physician
  'x00080092', // referring physician address
  'x00080094', // referring physician telephone
  'x00081040', // department
  'x00081048', // physicians of record
  'x00081050', // performing physician
  'x00081060', // reading physician
  'x00081070', // operators
  'x00321032', // requesting physician
  'x00380010', // admission ID
  'x00401001', // requested procedure ID
  'x00402016', // placer order number
  'x00402017' // filler order number
])

function fit(value: string, length: number): Buffer {
  const b = Buffer.alloc(length, 0x20)
  b.write(value.slice(0, length), 0, 'latin1')
  return b
}

export const ANON_NAME = 'ANONYMOUS'

export interface Anonymized {
  patches: Patch[]
  /** Room the file had for the new name / ID (values are cut to fit, the file keeps its layout). */
  nameLength: number
  idLength: number
}

function collect(ds: dicomParser.DataSet, pseudoId: string, out: Anonymized, top: boolean): void {
  for (const [tag, el] of Object.entries(ds.elements)) {
    if (el.items) {
      for (const item of el.items) if (item.dataSet) collect(item.dataSet, pseudoId, out, false)
      continue
    }
    if (!el.length || el.length > 0xffff || el.dataOffset == null) continue
    const t = tag.toLowerCase()
    if (t === 'x00100010') {
      out.patches.push({ offset: el.dataOffset, bytes: fit(ANON_NAME, el.length) })
      if (top) out.nameLength = el.length
    } else if (t === 'x00100020') {
      out.patches.push({ offset: el.dataOffset, bytes: fit(pseudoId, el.length) })
      if (top) out.idLength = el.length
    } else if (BLANK_TAGS.has(t)) out.patches.push({ offset: el.dataOffset, bytes: fit('', el.length) })
  }
}

/** Byte patches that anonymize one DICOM file. Throws for files that can't be anonymized safely. */
export async function anonymizePatches(filePath: string, pseudoId: string): Promise<Anonymized> {
  let { bytes, size } = await readBytes(filePath, 2 * 1024 * 1024)
  let ds: dicomParser.DataSet
  try {
    ds = parseBytes(bytes)
  } catch (e) {
    if (bytes.length >= size) throw e
    ;({ bytes } = await readBytes(filePath, size))
    ds = parseBytes(bytes)
  }
  const ts = ds.string('x00020010') ?? ''
  if (ts === '1.2.840.10008.1.2.1.99') throw new Error('Deflate-compressed DICOM cannot be anonymized')
  const out: Anonymized = { patches: [], nameLength: 0, idLength: 0 }
  collect(ds, pseudoId, out, true)
  out.patches.sort((a, b) => a.offset - b.offset)
  return out
}

/** Applies the patches that overlap `buf`, which holds the file bytes starting at `fileOffset`. */
export function applyPatches(buf: Buffer, fileOffset: number, patches: Patch[] | undefined): void {
  if (!patches) return
  const end = fileOffset + buf.length
  for (const p of patches) {
    const pEnd = p.offset + p.bytes.length
    if (pEnd <= fileOffset || p.offset >= end) continue
    const from = Math.max(p.offset, fileOffset)
    const to = Math.min(pEnd, end)
    p.bytes.copy(buf, from - fileOffset, from - p.offset, to - p.offset)
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Removes the patient's name / IDs if they were typed into the report or clinical notes. */
export function scrubText(text: string, identifiers: string[]): string {
  let out = text
  for (const id of identifiers) {
    const v = id.trim()
    if (v.length < 3) continue
    out = out.replace(new RegExp(escapeRe(v), 'gi'), '[removed]')
    // Names are often written in another order ("RAM KUMAR" vs "KUMAR RAM").
    const parts = v.split(/[\s^,]+/).filter((p) => p.length >= 3)
    if (parts.length > 1) for (const p of parts) out = out.replace(new RegExp(`\\b${escapeRe(p)}\\b`, 'gi'), '[removed]')
  }
  return out
}

/** Like scrubText, but only touches the text between HTML tags (never the tags themselves). */
export function scrubHtml(html: string, identifiers: string[]): string {
  return html
    .split(/(<[^>]*>)/)
    .map((part) => (part.startsWith('<') ? part : scrubText(part, identifiers)))
    .join('')
}
