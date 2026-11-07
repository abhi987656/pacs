import { BrowserWindow } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Report, Settings, StudyRow } from '@shared/types'
import {
  escapeHtml,
  formatAge,
  formatDicomDate,
  formatDicomDateTime,
  formatIsoDateTime,
  formatSex
} from '@shared/format'

const MARGINS: Record<Settings['pageMargin'], string> = {
  normal: '16mm 18mm 18mm 18mm',
  narrow: '10mm 12mm 14mm 12mm',
  wide: '25mm 30mm 25mm 30mm'
}

const nl2br = (s: string) => escapeHtml(s).replace(/\n/g, '<br/>')

export function buildReportHtml(study: StudyRow, report: Report | null, s: Settings): string {
  const status = report?.status ?? 'NEW'
  const isFinal = status === 'FINAL'
  const ageSex = [formatAge(study.age, study.birthDate, study.studyDate), formatSex(study.sex)]
    .filter(Boolean)
    .join(' / ')
  const procedure = report?.procedure || study.description
  const radiologist = report?.radiologist || s.radiologistName

  const hasLetterhead = s.showLetterhead && !!(s.institutionName || s.institutionAddress || s.institutionContact || s.logoImage)
  const letterhead = hasLetterhead
    ? `<header class="lh">
        ${s.logoImage ? `<img class="logo" src="${s.logoImage}" />` : ''}
        <div class="lh-text">
          ${s.institutionName ? `<div class="inst">${escapeHtml(s.institutionName)}</div>` : ''}
          ${s.institutionAddress ? `<div class="addr">${nl2br(s.institutionAddress)}</div>` : ''}
          ${s.institutionContact ? `<div class="addr">${nl2br(s.institutionContact)}</div>` : ''}
        </div>
      </header>`
    : ''

  const row = (a: string, av: string, b: string, bv: string) =>
    `<tr><th>${a}</th><td>${escapeHtml(av)}</td><th>${b}</th><td>${escapeHtml(bv)}</td></tr>`

  const signature = s.showSignatureBlock
    ? `<div class="sign">
        ${s.signatureImage && isFinal ? `<img src="${s.signatureImage}" />` : ''}
        <div class="sname">${escapeHtml(radiologist)}</div>
        ${s.radiologistDesignation ? `<div>${nl2br(s.radiologistDesignation)}</div>` : ''}
        ${s.radiologistRegNo ? `<div>Reg. No.: ${escapeHtml(s.radiologistRegNo)}</div>` : ''}
        ${isFinal && report?.signedAt ? `<div class="small">Signed on ${escapeHtml(formatIsoDateTime(report.signedAt))}</div>` : ''}
      </div>`
    : ''

  const statusNote = isFinal
    ? ''
    : `<div class="draft">${status === 'PRELIMINARY' ? 'PRELIMINARY REPORT' : 'DRAFT – NOT SIGNED'}</div>`

  return `<!doctype html>
<html><head><meta charset="utf-8"/>
<title>${escapeHtml(study.patientName)} - ${escapeHtml(procedure)}</title>
<style>
  @page {
    size: ${s.pageSize} ${s.pageOrientation};
    margin: ${MARGINS[s.pageMargin] ?? MARGINS.normal};
    @bottom-center { content: "Page " counter(page) " of " counter(pages); font: 8.5pt Arial, sans-serif; color: #555; }
  }
  html, body { margin: 0; padding: 0; }
  body { font-family: '${s.editorFontFamily}', 'Times New Roman', serif; font-size: ${s.editorFontSize}; color: #000; }
  .lh { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid #1f3b57; padding-bottom: 8px; margin-bottom: 8px; }
  .lh .logo { max-height: 70px; max-width: 120px; object-fit: contain; }
  .lh-text { flex: 1; text-align: center; }
  .inst { font: bold 16pt Arial, sans-serif; color: #1f3b57; }
  .addr { font: 9.5pt Arial, sans-serif; color: #333; }
  .title { text-align: center; font: bold 12.5pt Arial, sans-serif; letter-spacing: 1px; margin: 6px 0; }
  .draft { text-align: center; color: #b00020; font: bold 10pt Arial, sans-serif; margin-bottom: 4px; }
  table.pt { width: 100%; border-collapse: collapse; font: 9.5pt Arial, sans-serif; margin-bottom: 8px; }
  table.pt th { text-align: left; font-weight: bold; padding: 3px 6px; width: 15%; background: #f1f4f7; border: 1px solid #c9d2da; white-space: nowrap; }
  table.pt td { padding: 3px 6px; width: 35%; border: 1px solid #c9d2da; }
  .clin { font: 10pt Arial, sans-serif; margin: 6px 0 10px; }
  .body p { margin: 0 0 4px; }
  .body ul, .body ol { margin: 2px 0 6px; padding-left: 22px; }
  .body li p { margin: 0 0 2px; }
  .body table { border-collapse: collapse; margin: 6px 0; }
  .body td, .body th { border: 1px solid #888; padding: 3px 6px; vertical-align: top; }
  .body img { max-width: 100%; height: auto; }
  .body h1 { font-size: 15pt; } .body h2 { font-size: 13.5pt; } .body h3 { font-size: 12pt; }
  .sign { margin-top: 28px; margin-left: auto; width: 45%; text-align: left; font-size: 11pt; page-break-inside: avoid; }
  .sign img { max-height: 55px; max-width: 200px; display: block; margin-bottom: 2px; }
  .sname { font-weight: bold; }
  .small { font-size: 8.5pt; color: #444; margin-top: 2px; }
  .footer { margin-top: 18px; border-top: 1px solid #999; padding-top: 4px; font: 8.5pt Arial, sans-serif; color: #444; text-align: center; }
</style></head>
<body>
  ${letterhead}
  ${s.reportTitle ? `<div class="title">${escapeHtml(s.reportTitle)}</div>` : ''}
  ${statusNote}
  <table class="pt">
    ${row('Patient Name', study.patientName, 'Patient ID', study.patientId)}
    ${row('Age / Sex', ageSex, 'Accession No', study.accession)}
    ${row('Study', procedure, 'Study Date', formatDicomDateTime(study.studyDate, study.studyTime))}
    ${row('Referred By', study.referring, 'Report Date', formatIsoDateTime(report?.updatedAt ?? new Date().toISOString()))}
  </table>
  ${study.clinicalHistory ? `<div class="clin"><b>Clinical details:</b> ${nl2br(study.clinicalHistory)}</div>` : ''}
  <div class="body">${report?.html ?? ''}</div>
  ${signature}
  ${s.footerText ? `<div class="footer">${nl2br(s.footerText)}</div>` : ''}
</body></html>`
}

async function withPrintWindow<T>(html: string, tmpDir: string, fn: (win: BrowserWindow) => Promise<T>): Promise<T> {
  const file = join(tmpDir, `print-${Date.now()}.html`)
  await writeFile(file, html, 'utf8')
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true }
  })
  try {
    await win.loadURL(pathToFileURL(file).toString())
    return await fn(win)
  } finally {
    win.destroy()
  }
}

export async function renderPdf(html: string, tmpDir: string): Promise<Buffer> {
  return withPrintWindow(html, tmpDir, (win) =>
    win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })
  )
}

export async function printHtml(html: string, tmpDir: string): Promise<boolean> {
  return withPrintWindow(
    html,
    tmpDir,
    (win) =>
      new Promise<boolean>((resolve) => {
        win.webContents.print({ silent: false, printBackground: true }, (success) => resolve(success))
      })
  )
}

export function defaultPdfName(study: StudyRow): string {
  const safe = (x: string) => x.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  const parts = [safe(study.patientName) || 'Patient', safe(study.accession), formatDicomDate(study.studyDate)]
  return parts.filter(Boolean).join('_') + '.pdf'
}
