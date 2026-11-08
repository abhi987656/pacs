// Report export to Word (.docx) and plain text. Pure JavaScript (no DOM), so the same code runs
// in the PC's main process and in the phone app, and both produce the same files.

import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  ImageRun,
  Packer,
  PageNumber,
  PageOrientation,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType
} from 'docx'
import type { FileChild } from 'docx'
import { htmlToContent } from 'docx/html'
import type { ReportStatus, SyncSettings } from './types'
import { formatAge, formatDicomDate, formatDicomDateTime, formatIsoDateTime, formatSex } from './format'

export interface ReportExportInput {
  study: {
    patientName: string
    patientId: string
    accession: string
    age: string
    sex: string
    birthDate: string
    studyDate: string
    studyTime: string
    description: string
    referring: string
    clinicalHistory: string
  }
  report: {
    status: ReportStatus
    html: string
    procedure: string
    radiologist: string
    updatedAt: string | null
    signedAt: string | null
  } | null
  settings: SyncSettings
}

/** "RAM KUMAR_PG812345_07-Nov-2026" (no characters Windows/Android refuse in file names). */
export function exportFileBase(study: ReportExportInput['study']): string {
  const safe = (x: string) => x.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  return [safe(study.patientName) || 'Patient', safe(study.accession), formatDicomDate(study.studyDate)].filter(Boolean).join('_')
}

interface Facts {
  status: ReportStatus
  isFinal: boolean
  ageSex: string
  procedure: string
  radiologist: string
  studyDate: string
  reportDate: string
  signedOn: string
  statusNote: string
}

function facts(input: ReportExportInput): Facts {
  const { study, report, settings } = input
  const status = report?.status ?? 'NEW'
  const isFinal = status === 'FINAL'
  return {
    status,
    isFinal,
    ageSex: [formatAge(study.age, study.birthDate, study.studyDate), formatSex(study.sex)].filter(Boolean).join(' / '),
    procedure: report?.procedure || study.description,
    radiologist: report?.radiologist || settings.radiologistName,
    studyDate: formatDicomDateTime(study.studyDate, study.studyTime),
    reportDate: formatIsoDateTime(report?.updatedAt ?? new Date().toISOString()),
    signedOn: isFinal && report?.signedAt ? formatIsoDateTime(report.signedAt) : '',
    statusNote: isFinal ? '' : status === 'PRELIMINARY' ? 'PRELIMINARY REPORT' : 'DRAFT – NOT SIGNED'
  }
}

// ------------------------------------------------------------------ plain text

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', deg: '°', plusmn: '±', times: '×', micro: 'µ', le: '≤', ge: '≥', rarr: '→', larr: '←', hellip: '…' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Report HTML (from the editor) -> readable text with bullets, numbers and table rows. */
export function htmlToText(html: string): string {
  const lines: string[] = []
  let cur = ''
  let prefix = ''
  const lists: { ordered: boolean; n: number }[] = []
  let cells: string[] | null = null
  let cell = ''
  let inCell = false
  const flush = (force = false) => {
    const text = cur.replace(/[ \t]+/g, ' ').trim()
    if (text || force) lines.push((prefix + text).replace(/\s+$/, ''))
    else if (prefix.trim()) lines.push(prefix.replace(/\s+$/, ''))
    cur = ''
    prefix = ''
  }
  const tokens = html.replace(/<!--[\s\S]*?-->/g, '').split(/(<[^>]+>)/)
  for (const tok of tokens) {
    if (!tok) continue
    if (tok[0] !== '<') {
      const t = decodeEntities(tok.replace(/[\r\n]+/g, ' '))
      if (inCell) cell += t
      else cur += t
      continue
    }
    const m = /^<\s*(\/)?\s*([a-z0-9]+)([^>]*)>$/i.exec(tok)
    if (!m) continue
    const closing = !!m[1]
    const tag = m[2].toLowerCase()
    const attrs = m[3]
    if (inCell && !['td', 'th', 'tr', 'table', 'tbody', 'thead'].includes(tag)) {
      if (tag === 'br' || (closing && (tag === 'p' || tag === 'li'))) cell += ' '
      continue
    }
    switch (tag) {
      case 'br':
        if (cur.trim() || prefix) {
          lines.push((prefix + cur.trim()).replace(/\s+$/, ''))
          prefix = ' '.repeat(prefix.length)
        } else lines.push('')
        cur = ''
        break
      case 'p':
      case 'div':
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
      case 'blockquote':
        if (closing) {
          if (cur.trim() || prefix) flush()
          else lines.push('')
        } else if (cur.trim()) flush()
        break
      case 'ul':
      case 'ol':
        if (closing) lists.pop()
        else {
          if (cur.trim()) flush()
          const start = /\bstart\s*=\s*"?(\d+)/i.exec(attrs)
          lists.push({ ordered: tag === 'ol', n: start ? Number(start[1]) - 1 : 0 })
        }
        break
      case 'li':
        if (closing) {
          if (cur.trim()) flush()
        } else {
          if (cur.trim()) flush()
          const l = lists[lists.length - 1]
          const indent = '  '.repeat(Math.max(0, lists.length - 1))
          if (l) l.n++
          prefix = indent + (l?.ordered ? `${l.n}. ` : '• ')
        }
        break
      case 'table':
        if (!closing && cur.trim()) flush()
        break
      case 'tr':
        if (closing) {
          if (cells) lines.push(cells.join(' | ').trim())
          cells = null
        } else cells = []
        break
      case 'td':
      case 'th':
        if (closing) {
          cells?.push(cell.replace(/\s+/g, ' ').trim())
          cell = ''
          inCell = false
        } else {
          cell = ''
          inCell = true
        }
        break
      case 'img': {
        const alt = /\balt\s*=\s*"([^"]*)"/i.exec(attrs)?.[1]
        if (cur.trim()) flush()
        lines.push(`[Image${alt ? `: ${decodeEntities(alt)}` : ''}]`)
        break
      }
      case 'hr':
        if (cur.trim()) flush()
        lines.push('----------------------------------------')
        break
      default:
        break
    }
  }
  if (cur.trim()) flush()
  // No runs of blank lines, no blank lines at the ends.
  const out: string[] = []
  for (const l of lines) if (l.trim() || (out.length && out[out.length - 1].trim())) out.push(l)
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out.join('\n')
}

export function buildReportText(input: ReportExportInput): string {
  const { study, settings } = input
  const f = facts(input)
  const out: string[] = []
  if (settings.showLetterhead && settings.institutionName) out.push(settings.institutionName.toUpperCase())
  if (settings.showLetterhead) {
    for (const l of [settings.institutionAddress, settings.institutionContact]) if (l.trim()) out.push(...l.trim().split(/\r?\n/))
  }
  if (out.length) out.push('')
  if (settings.reportTitle) out.push(settings.reportTitle)
  if (f.statusNote) out.push(f.statusNote)
  out.push('')
  const rows: [string, string][] = [
    ['Patient Name', study.patientName],
    ['Patient ID', study.patientId],
    ['Age / Sex', f.ageSex],
    ['Accession No', study.accession],
    ['Study', f.procedure],
    ['Study Date', f.studyDate],
    ['Referred By', study.referring],
    ['Report Date', f.reportDate]
  ]
  for (const [k, v] of rows) out.push(`${k.padEnd(13)}: ${v}`)
  out.push('')
  if (study.clinicalHistory.trim()) {
    out.push(`Clinical details: ${study.clinicalHistory.trim()}`)
    out.push('')
  }
  out.push(htmlToText(input.report?.html ?? ''))
  if (settings.showSignatureBlock) {
    out.push('', '')
    if (f.radiologist) out.push(f.radiologist)
    if (settings.radiologistDesignation.trim()) out.push(...settings.radiologistDesignation.trim().split(/\r?\n/))
    if (settings.radiologistRegNo) out.push(`Reg. No.: ${settings.radiologistRegNo}`)
    if (f.signedOn) out.push(`Signed on ${f.signedOn}`)
  }
  if (settings.footerText.trim()) out.push('', settings.footerText.trim())
  // Windows Notepad and Android both read CRLF fine; Notepad on older Windows needs it.
  return out.join('\r\n') + '\r\n'
}

// ------------------------------------------------------------------ Word

const MM = 56.6929 // twips per millimetre
const MARGINS_MM: Record<SyncSettings['pageMargin'], [number, number, number, number]> = {
  normal: [16, 18, 18, 18],
  narrow: [10, 12, 14, 12],
  wide: [25, 30, 25, 30]
}

function dataUrlImage(url: string): { type: 'png' | 'jpg' | 'gif' | 'bmp'; data: Uint8Array; width: number; height: number } | null {
  const m = /^data:image\/(png|jpe?g|gif|bmp);base64,(.+)$/i.exec(url.trim())
  if (!m) return null
  const bin = atob(m[2])
  const data = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)
  const kind = m[1].toLowerCase()
  const type = kind === 'png' ? 'png' : kind === 'gif' ? 'gif' : kind === 'bmp' ? 'bmp' : 'jpg'
  const size = imageSize(data)
  if (!size) return null
  return { type, data, ...size }
}

/** Reads the pixel size from a PNG / JPEG / GIF / BMP header. */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) {
    return { width: (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19], height: (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23] }
  }
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49) return { width: b[6] | (b[7] << 8), height: b[8] | (b[9] << 8) }
  if (b.length > 26 && b[0] === 0x42 && b[1] === 0x4d) {
    return { width: b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24), height: Math.abs((b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24)) >> 0) }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++
        continue
      }
      const marker = b[i + 1]
      const len = (b[i + 2] << 8) | b[i + 3]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] }
      }
      i += 2 + len
    }
  }
  return null
}

function fit(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  const s = Math.min(1, maxW / w, maxH / h)
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) }
}

const ptToHalf = (pt: string, fallback: number): number => {
  const n = parseFloat(pt)
  return Number.isFinite(n) && n > 4 && n < 80 ? Math.round(n * 2) : fallback
}

export async function buildReportDocx(input: ReportExportInput): Promise<Uint8Array> {
  const { study, report, settings: s } = input
  const f = facts(input)
  const letter = s.pageSize === 'Letter'
  const landscape = s.pageOrientation === 'landscape'
  const [mt, mr, mb, ml] = (MARGINS_MM[s.pageMargin] ?? MARGINS_MM.normal).map((x) => Math.round(x * MM))
  const pageW = letter ? 12240 : 11906
  const pageH = letter ? 15840 : 16838
  const textW = (landscape ? pageH : pageW) - ml - mr // twips
  const textWpx = Math.floor(textW / 15)
  const font = s.editorFontFamily || 'Times New Roman'
  const size = ptToHalf(s.editorFontSize, 24)
  const sans = 'Arial'
  const navy = '1F3B57'

  const children: FileChild[] = []

  // ---- letterhead
  const hasLetterhead = s.showLetterhead && !!(s.institutionName || s.institutionAddress || s.institutionContact || s.logoImage)
  if (hasLetterhead) {
    const textParas: Paragraph[] = []
    if (s.institutionName) {
      textParas.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: s.institutionName, bold: true, size: 32, font: sans, color: navy })] }))
    }
    for (const block of [s.institutionAddress, s.institutionContact]) {
      for (const line of block.split(/\r?\n/).filter((l) => l.trim())) {
        textParas.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: line, size: 19, font: sans, color: '333333' })] }))
      }
    }
    const logo = s.logoImage ? dataUrlImage(s.logoImage) : null
    if (logo) {
      const dim = fit(logo.width, logo.height, 120, 70)
      const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }
      const noBorders = { top: none, bottom: none, left: none, right: none }
      children.push(
        new Table({
          width: { size: textW, type: WidthType.DXA },
          columnWidths: [Math.round(textW * 0.2), textW - Math.round(textW * 0.2)],
          borders: { ...noBorders, insideHorizontal: none, insideVertical: none },
          rows: [
            new TableRow({
              children: [
                new TableCell({
                  borders: noBorders,
                  width: { size: Math.round(textW * 0.2), type: WidthType.DXA },
                  children: [new Paragraph({ children: [new ImageRun({ type: logo.type, data: logo.data, transformation: dim })] })]
                }),
                new TableCell({ borders: noBorders, children: textParas.length ? textParas : [new Paragraph('')] })
              ]
            })
          ]
        })
      )
    } else {
      children.push(...textParas)
    }
    children.push(
      new Paragraph({
        border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: navy, space: 1 } },
        spacing: { after: 120 },
        children: []
      })
    )
  }

  if (s.reportTitle) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 60, after: 60 },
        children: [new TextRun({ text: s.reportTitle, bold: true, size: 25, font: sans, characterSpacing: 20 })]
      })
    )
  }
  if (f.statusNote) {
    children.push(
      new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 }, children: [new TextRun({ text: f.statusNote, bold: true, size: 20, font: sans, color: 'B00020' })] })
    )
  }

  // ---- patient table
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'C9D2DA' }
  const borders = { top: border, bottom: border, left: border, right: border }
  const colW = [0.15, 0.35, 0.15, 0.35].map((x) => Math.round(textW * x))
  const cellPara = (text: string, bold: boolean) =>
    new Paragraph({ spacing: { before: 20, after: 20 }, children: [new TextRun({ text, bold, size: 19, font: sans })] })
  const row = (a: string, av: string, b: string, bv: string) =>
    new TableRow({
      children: [
        new TableCell({ borders, width: { size: colW[0], type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: 'F1F4F7', color: 'auto' }, children: [cellPara(a, true)] }),
        new TableCell({ borders, width: { size: colW[1], type: WidthType.DXA }, children: [cellPara(av, false)] }),
        new TableCell({ borders, width: { size: colW[2], type: WidthType.DXA }, shading: { type: ShadingType.CLEAR, fill: 'F1F4F7', color: 'auto' }, children: [cellPara(b, true)] }),
        new TableCell({ borders, width: { size: colW[3], type: WidthType.DXA }, children: [cellPara(bv, false)] })
      ]
    })
  children.push(
    new Table({
      width: { size: textW, type: WidthType.DXA },
      columnWidths: colW,
      rows: [
        row('Patient Name', study.patientName, 'Patient ID', study.patientId),
        row('Age / Sex', f.ageSex, 'Accession No', study.accession),
        row('Study', f.procedure, 'Study Date', f.studyDate),
        row('Referred By', study.referring, 'Report Date', f.reportDate)
      ]
    })
  )
  children.push(new Paragraph({ spacing: { after: 60 }, children: [] }))

  if (study.clinicalHistory.trim()) {
    const lines = study.clinicalHistory.trim().split(/\r?\n/)
    children.push(
      new Paragraph({
        spacing: { after: 160 },
        children: [
          new TextRun({ text: 'Clinical details: ', bold: true, size: 20, font: sans }),
          ...lines.map((l, i) => new TextRun({ text: l, size: 20, font: sans, break: i > 0 ? 1 : 0 }))
        ]
      })
    )
  }

  // ---- report body (the editor's HTML, converted by docx/html)
  const body = report?.html?.trim() ? htmlToContent(report.html, { maxImageWidth: textWpx }) : []
  children.push(...body)

  // ---- signature
  if (s.showSignatureBlock) {
    const indent = { left: Math.round(textW * 0.55) }
    const sig: Paragraph[] = [new Paragraph({ spacing: { before: 480 }, children: [] })]
    const sigImg = f.isFinal && s.signatureImage ? dataUrlImage(s.signatureImage) : null
    if (sigImg) {
      sig.push(new Paragraph({ indent, children: [new ImageRun({ type: sigImg.type, data: sigImg.data, transformation: fit(sigImg.width, sigImg.height, 200, 55) })] }))
    }
    if (f.radiologist) sig.push(new Paragraph({ indent, children: [new TextRun({ text: f.radiologist, bold: true, size: 22 })] }))
    for (const l of s.radiologistDesignation.split(/\r?\n/).filter((x) => x.trim())) {
      sig.push(new Paragraph({ indent, children: [new TextRun({ text: l, size: 22 })] }))
    }
    if (s.radiologistRegNo) sig.push(new Paragraph({ indent, children: [new TextRun({ text: `Reg. No.: ${s.radiologistRegNo}`, size: 22 })] }))
    if (f.signedOn) sig.push(new Paragraph({ indent, children: [new TextRun({ text: `Signed on ${f.signedOn}`, size: 17, color: '444444' })] }))
    children.push(...sig)
  }

  const footerChildren: Paragraph[] = []
  for (const l of s.footerText.split(/\r?\n/).filter((x) => x.trim())) {
    footerChildren.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: l, size: 17, font: sans, color: '444444' })] }))
  }
  footerChildren.push(
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ children: ['Page ', PageNumber.CURRENT, ' of ', PageNumber.TOTAL_PAGES], size: 17, font: sans, color: '555555' })
      ]
    })
  )

  const doc = new Document({
    creator: 'Personal PACS',
    title: `${study.patientName} - ${f.procedure}`,
    styles: {
      default: {
        document: { run: { font, size }, paragraph: { spacing: { after: 60, line: 264 } } },
        heading1: { run: { font, size: 30, bold: true, color: '000000' }, paragraph: { spacing: { before: 160, after: 80 } } },
        heading2: { run: { font, size: 27, bold: true, color: '000000' }, paragraph: { spacing: { before: 140, after: 60 } } },
        heading3: { run: { font, size: 24, bold: true, color: '000000' }, paragraph: { spacing: { before: 120, after: 60 } } }
      }
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: pageW, height: pageH, orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
            margin: { top: mt, right: mr, bottom: mb, left: ml, footer: Math.round(6 * MM) }
          }
        },
        footers: { default: new Footer({ children: footerChildren }) },
        children
      }
    ]
  })
  const b64 = await Packer.toBase64String(doc)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
