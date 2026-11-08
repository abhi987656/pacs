// PDF export on the phone (the PC uses its built-in Chromium for PDFs). Same layout as the PC:
// letterhead, title, patient table, clinical details, report, signature, page numbers.

import pdfMake from 'pdfmake/build/pdfmake'
import vfs from 'pdfmake/build/vfs_fonts'
import htmlToPdfmake from 'html-to-pdfmake'
import type { ReportExportInput } from '@shared/reportExport'
import { formatAge, formatDicomDateTime, formatIsoDateTime, formatSex } from '@shared/format'

pdfMake.addVirtualFileSystem(vfs)

const MM = 72 / 25.4
const MARGINS: Record<string, [number, number, number, number]> = {
  // left, top, right, bottom (points)
  normal: [18 * MM, 16 * MM, 18 * MM, 22 * MM],
  narrow: [12 * MM, 10 * MM, 12 * MM, 18 * MM],
  wide: [30 * MM, 25 * MM, 30 * MM, 29 * MM]
}

const ptSize = (s: string, fallback: number) => {
  const n = parseFloat(s)
  return Number.isFinite(n) && n > 4 && n < 60 ? n : fallback
}

export async function buildReportPdf(input: ReportExportInput): Promise<Uint8Array> {
  const { study, report, settings: s } = input
  const status = report?.status ?? 'NEW'
  const isFinal = status === 'FINAL'
  const ageSex = [formatAge(study.age, study.birthDate, study.studyDate), formatSex(study.sex)].filter(Boolean).join(' / ')
  const procedure = report?.procedure || study.description
  const radiologist = report?.radiologist || s.radiologistName
  const margins = MARGINS[s.pageMargin] ?? MARGINS.normal
  const landscape = s.pageOrientation === 'landscape'
  const pageW = (s.pageSize === 'Letter' ? 612 : 595.28) * 1
  const pageH = s.pageSize === 'Letter' ? 792 : 841.89
  const textW = (landscape ? pageH : pageW) - margins[0] - margins[2]
  const baseSize = ptSize(s.editorFontSize, 12)

  const content: unknown[] = []

  const hasLetterhead = s.showLetterhead && !!(s.institutionName || s.institutionAddress || s.institutionContact || s.logoImage)
  if (hasLetterhead) {
    const textStack: unknown[] = []
    if (s.institutionName) textStack.push({ text: s.institutionName, bold: true, fontSize: 16, color: '#1f3b57' })
    for (const block of [s.institutionAddress, s.institutionContact]) {
      if (block.trim()) textStack.push({ text: block.trim(), fontSize: 9.5, color: '#333333' })
    }
    const logoOk = /^data:image\/(png|jpe?g);base64,/i.test(s.logoImage)
    content.push({
      columns: logoOk
        ? [
            { image: s.logoImage, fit: [90, 52], width: 95 },
            { stack: textStack, alignment: 'center', width: '*' },
            { text: '', width: 95 }
          ]
        : [{ stack: textStack, alignment: 'center', width: '*' }],
      columnGap: 8
    })
    content.push({ canvas: [{ type: 'line', x1: 0, y1: 4, x2: textW, y2: 4, lineWidth: 1.5, lineColor: '#1f3b57' }], margin: [0, 0, 0, 6] })
  }
  if (s.reportTitle) content.push({ text: s.reportTitle, alignment: 'center', bold: true, fontSize: 12.5, characterSpacing: 1, margin: [0, 4, 0, 4] })
  if (!isFinal) {
    content.push({
      text: status === 'PRELIMINARY' ? 'PRELIMINARY REPORT' : 'DRAFT – NOT SIGNED',
      alignment: 'center',
      bold: true,
      fontSize: 10,
      color: '#b00020',
      margin: [0, 0, 0, 4]
    })
  }

  const th = (t: string) => ({ text: t, bold: true, fillColor: '#f1f4f7', fontSize: 9.5 })
  const td = (t: string) => ({ text: t, fontSize: 9.5 })
  content.push({
    table: {
      widths: ['15%', '35%', '15%', '35%'],
      body: [
        [th('Patient Name'), td(study.patientName), th('Patient ID'), td(study.patientId)],
        [th('Age / Sex'), td(ageSex), th('Accession No'), td(study.accession)],
        [th('Study'), td(procedure), th('Study Date'), td(formatDicomDateTime(study.studyDate, study.studyTime))],
        [th('Referred By'), td(study.referring), th('Report Date'), td(formatIsoDateTime(report?.updatedAt ?? new Date().toISOString()))]
      ]
    },
    layout: {
      hLineColor: () => '#c9d2da',
      vLineColor: () => '#c9d2da',
      hLineWidth: () => 0.6,
      vLineWidth: () => 0.6,
      paddingTop: () => 2,
      paddingBottom: () => 2
    },
    margin: [0, 0, 0, 8]
  })
  if (study.clinicalHistory.trim()) {
    content.push({ text: [{ text: 'Clinical details: ', bold: true }, study.clinicalHistory.trim()], fontSize: 10, margin: [0, 0, 0, 10] })
  }

  const html = report?.html?.trim() ? report.html : ''
  if (html) {
    const body = htmlToPdfmake(html, {
      window,
      imagesByReference: false,
      removeExtraBlanks: true,
      defaultStyles: {
        p: { margin: [0, 0, 0, 4] },
        h1: { fontSize: 15, bold: true, margin: [0, 8, 0, 4] },
        h2: { fontSize: 13.5, bold: true, margin: [0, 7, 0, 3] },
        h3: { fontSize: 12, bold: true, margin: [0, 6, 0, 3] },
        ul: { margin: [0, 2, 0, 6] },
        ol: { margin: [0, 2, 0, 6] },
        li: { margin: [0, 0, 0, 2] },
        table: { margin: [0, 6, 0, 6] },
        td: { margin: [3, 2, 3, 2] },
        th: { margin: [3, 2, 3, 2], bold: true }
      }
    })
    content.push(fitImages(body, textW))
  }

  if (s.showSignatureBlock) {
    const sig: unknown[] = []
    if (isFinal && /^data:image\/(png|jpe?g);base64,/i.test(s.signatureImage)) sig.push({ image: s.signatureImage, fit: [150, 42] })
    if (radiologist) sig.push({ text: radiologist, bold: true })
    if (s.radiologistDesignation.trim()) sig.push({ text: s.radiologistDesignation.trim() })
    if (s.radiologistRegNo) sig.push({ text: `Reg. No.: ${s.radiologistRegNo}` })
    if (isFinal && report?.signedAt) sig.push({ text: `Signed on ${formatIsoDateTime(report.signedAt)}`, fontSize: 8.5, color: '#444444' })
    content.push({ columns: [{ text: '', width: '55%' }, { stack: sig, width: '*', fontSize: 11 }], margin: [0, 24, 0, 0], unbreakable: true })
  }

  const footerText = s.footerText.trim()
  const dd = {
    pageSize: s.pageSize === 'Letter' ? 'LETTER' : 'A4',
    pageOrientation: landscape ? 'landscape' : 'portrait',
    pageMargins: margins,
    info: { title: `${study.patientName} - ${procedure}`, creator: 'Personal PACS' },
    defaultStyle: { font: 'Roboto', fontSize: baseSize, lineHeight: 1.15 },
    content,
    footer: (page: number, pages: number) => ({
      stack: [
        ...(footerText ? [{ text: footerText, fontSize: 8.5, color: '#444444', alignment: 'center' }] : []),
        { text: `Page ${page} of ${pages}`, fontSize: 8.5, color: '#555555', alignment: 'center' }
      ],
      margin: [margins[0], 6, margins[2], 0]
    })
  }
  const buf = await pdfMake.createPdf(dd).getBuffer()
  return buf instanceof Uint8Array ? new Uint8Array(buf) : new Uint8Array(buf as ArrayBuffer)
}

/** Keeps report images (key images) inside the page width. */
function fitImages(node: unknown, maxW: number): unknown {
  if (Array.isArray(node)) return node.map((n) => fitImages(n, maxW))
  if (node && typeof node === 'object') {
    const o = { ...(node as Record<string, unknown>) }
    if (typeof o.image === 'string') {
      const w = typeof o.width === 'number' ? o.width : maxW
      o.width = Math.min(w, maxW)
      delete o.height
    }
    for (const k of ['stack', 'columns', 'ul', 'ol', 'text']) if (Array.isArray(o[k])) o[k] = fitImages(o[k], maxW)
    if (o.table && typeof o.table === 'object') {
      const t = { ...(o.table as Record<string, unknown>) }
      if (Array.isArray(t.body)) t.body = (t.body as unknown[]).map((r) => fitImages(r, maxW))
      o.table = t
    }
    return o
  }
  return node
}
