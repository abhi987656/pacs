import * as dicomParser from 'dicom-parser'
import { open } from 'node:fs/promises'
import { TextDecoder } from 'node:util'
import { formatPersonName } from '@shared/format'

export const DICOMDIR_SOP_CLASS = '1.2.840.10008.1.3.10'

// Extensions that are certainly not DICOM (CD/DVD viewers ship thousands of these).
const NON_DICOM_EXT = new Set([
  '.exe', '.dll', '.sys', '.ocx', '.msi', '.cab', '.bat', '.cmd', '.com', '.inf', '.ini', '.cfg',
  '.txt', '.htm', '.html', '.css', '.js', '.json', '.xml', '.xsl', '.pdf', '.doc', '.docx', '.rtf',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.tif', '.tiff', '.svg', '.zip', '.rar', '.7z',
  '.jar', '.class', '.log', '.chm', '.hlp', '.lnk', '.url', '.db', '.mp4', '.avi', '.wmv', '.mp3',
  '.ttf', '.otf', '.woff', '.woff2', '.manifest', '.config', '.pak', '.bin', '.dat', '.lic', '.md'
])

export function isLikelyNonDicom(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  const slash = Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\'))
  const name = lower.slice(slash + 1)
  if (name === 'dicomdir' || name === 'autorun.inf' || name === 'thumbs.db' || name === 'desktop.ini') return true
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return false
  return NON_DICOM_EXT.has(name.slice(dot))
}

export interface ParsedHeader {
  sopClass: string
  sopUid: string
  studyUid: string
  seriesUid: string
  patientId: string
  patientName: string
  patientNameRaw: string
  birthDate: string
  sex: string
  age: string
  studyDate: string
  studyTime: string
  studyDescription: string
  accession: string
  referring: string
  institution: string
  bodyPart: string
  modality: string
  seriesNumber: number | null
  seriesDescription: string
  instanceNumber: number | null
  frames: number
  ipp: string
  iop: string
  sliceLocation: number | null
  forUid: string
  rows: number
  cols: number
}

const CHARSET_MAP: Record<string, string> = {
  'ISO_IR 192': 'utf-8',
  'ISO_IR 100': 'latin1',
  'ISO 2022 IR 100': 'latin1',
  'ISO_IR 101': 'iso-8859-2',
  'ISO_IR 109': 'iso-8859-3',
  'ISO_IR 110': 'iso-8859-4',
  'ISO_IR 144': 'iso-8859-5',
  'ISO_IR 127': 'iso-8859-6',
  'ISO_IR 126': 'iso-8859-7',
  'ISO_IR 138': 'iso-8859-8',
  'ISO_IR 148': 'iso-8859-9',
  'ISO_IR 166': 'windows-874',
  'ISO_IR 13': 'shift_jis',
  GB18030: 'gb18030',
  GBK: 'gbk'
}

function makeDecoder(charset: string): TextDecoder {
  // Specific Character Set can be multi-valued; use the last (most specific) entry.
  const parts = charset.split('\\').map((s) => s.trim()).filter(Boolean)
  const key = parts[parts.length - 1] ?? ''
  const label = CHARSET_MAP[key] ?? 'latin1'
  try {
    return new TextDecoder(label)
  } catch {
    return new TextDecoder('latin1')
  }
}

function readText(ds: dicomParser.DataSet, tag: string, decoder: TextDecoder): string {
  const el = ds.elements[tag]
  if (!el || !el.length) return ''
  const bytes = ds.byteArray.subarray(el.dataOffset, el.dataOffset + el.length)
  return decoder
    .decode(bytes)
    .replace(/[\u0000]+$/g, '')
    .trim()
}

function readAscii(ds: dicomParser.DataSet, tag: string): string {
  const v = ds.string(tag)
  return v ? v.replace(/\u0000/g, '').trim() : ''
}

function readInt(ds: dicomParser.DataSet, tag: string): number | null {
  const v = readAscii(ds, tag)
  if (!v) return null
  const n = parseInt(v.split('\\')[0], 10)
  return Number.isFinite(n) ? n : null
}

function readFloat(ds: dicomParser.DataSet, tag: string): number | null {
  const v = readAscii(ds, tag)
  if (!v) return null
  const n = parseFloat(v.split('\\')[0])
  return Number.isFinite(n) ? n : null
}

function readUS(ds: dicomParser.DataSet, tag: string): number {
  const el = ds.elements[tag]
  if (!el || el.length < 2) return 0
  return ds.uint16(tag) ?? 0
}

function parseBytes(bytes: Uint8Array): dicomParser.DataSet {
  const hasPrefix =
    bytes.length > 132 && bytes[128] === 0x44 && bytes[129] === 0x49 && bytes[130] === 0x43 && bytes[131] === 0x4d
  if (hasPrefix) {
    return dicomParser.parseDicom(bytes, { untilTag: 'x7fe00010' })
  }
  // Some old/CD files have no 128-byte preamble: assume implicit VR little endian.
  if (bytes.length > 8 && bytes[0] === 0x08 && bytes[1] === 0x00) {
    return dicomParser.parseDicom(bytes, { untilTag: 'x7fe00010', TransferSyntaxUID: '1.2.840.10008.1.2' })
  }
  throw new Error('not a DICOM file')
}

async function readBytes(filePath: string, maxBytes: number): Promise<{ bytes: Uint8Array; size: number }> {
  const fh = await open(filePath, 'r')
  try {
    const { size } = await fh.stat()
    const len = Math.min(size, maxBytes)
    const buf = Buffer.alloc(len)
    await fh.read(buf, 0, len, 0)
    return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), size }
  } finally {
    await fh.close()
  }
}

/** Reads and parses the DICOM header of a file. Returns null if the file is not DICOM. */
export async function readDicomHeader(filePath: string): Promise<ParsedHeader | null> {
  let { bytes, size } = await readBytes(filePath, 256 * 1024)
  if (size < 132) return null
  let ds: dicomParser.DataSet
  try {
    ds = parseBytes(bytes)
  } catch (e) {
    if (String(e).includes('not a DICOM file')) return null
    if (size <= bytes.length) return null
    // Header bigger than our first read (large private tags): read the whole file.
    try {
      ;({ bytes, size } = await readBytes(filePath, size))
      ds = parseBytes(bytes)
    } catch {
      return null
    }
  }

  const decoder = makeDecoder(readAscii(ds, 'x00080005'))
  const sopClass = readAscii(ds, 'x00080016') || readAscii(ds, 'x00020002')
  const sopUid = readAscii(ds, 'x00080018') || readAscii(ds, 'x00020003')
  const nameRaw = readText(ds, 'x00100010', decoder)
  const frames = readInt(ds, 'x00280008') ?? 1

  return {
    sopClass,
    sopUid,
    studyUid: readAscii(ds, 'x0020000d'),
    seriesUid: readAscii(ds, 'x0020000e'),
    patientId: readText(ds, 'x00100020', decoder),
    patientName: formatPersonName(nameRaw),
    patientNameRaw: nameRaw,
    birthDate: readAscii(ds, 'x00100030'),
    sex: readAscii(ds, 'x00100040').toUpperCase(),
    age: readAscii(ds, 'x00101010'),
    studyDate: readAscii(ds, 'x00080020') || readAscii(ds, 'x00080021') || readAscii(ds, 'x00080022'),
    studyTime: readAscii(ds, 'x00080030') || readAscii(ds, 'x00080031'),
    studyDescription: readText(ds, 'x00081030', decoder),
    accession: readText(ds, 'x00080050', decoder),
    referring: formatPersonName(readText(ds, 'x00080090', decoder)),
    institution: readText(ds, 'x00080080', decoder),
    bodyPart: readAscii(ds, 'x00180015'),
    modality: readAscii(ds, 'x00080060').toUpperCase(),
    seriesNumber: readInt(ds, 'x00200011'),
    seriesDescription: readText(ds, 'x0008103e', decoder),
    instanceNumber: readInt(ds, 'x00200013'),
    frames: frames > 0 ? frames : 1,
    ipp: readAscii(ds, 'x00200032'),
    iop: readAscii(ds, 'x00200037'),
    sliceLocation: readFloat(ds, 'x00201041'),
    forUid: readAscii(ds, 'x00200052'),
    rows: readUS(ds, 'x00280010'),
    cols: readUS(ds, 'x00280011')
  }
}
