import type { ReportExportInput } from '@shared/reportExport'
import { store } from './db'
import type { LocalReport, LocalStudy } from './db'
import { saveToDocuments, shareFile } from './native'

export type ExportKind = 'docx' | 'pdf' | 'txt'

export function exportInput(study: LocalStudy, report: LocalReport | null): ReportExportInput {
  return {
    study: {
      patientName: study.patientName,
      patientId: study.patientId,
      accession: study.accession,
      age: study.age,
      sex: study.sex,
      birthDate: study.birthDate,
      studyDate: study.studyDate,
      studyTime: study.studyTime,
      description: study.description,
      referring: study.referring,
      clinicalHistory: study.clinicalHistory
    },
    report: report
      ? {
          status: report.status,
          html: report.html,
          procedure: report.procedure,
          radiologist: report.radiologist,
          updatedAt: report.updatedAt || null,
          signedAt: report.signedAt
        }
      : null,
    settings: store.meta.settings
  }
}

/** Builds the file (the export code loads only when first used, keeping app start fast). */
export async function buildExport(kind: ExportKind, study: LocalStudy, report: LocalReport | null): Promise<{ name: string; data: Uint8Array | string }> {
  const input = exportInput(study, report)
  const { exportFileBase, buildReportDocx, buildReportText } = await import('@shared/reportExport')
  const base = exportFileBase(input.study)
  if (kind === 'docx') return { name: `${base}.docx`, data: await buildReportDocx(input) }
  if (kind === 'txt') return { name: `${base}.txt`, data: '﻿' + buildReportText(input) }
  const { buildReportPdf } = await import('./reportPdf')
  return { name: `${base}.pdf`, data: await buildReportPdf(input) }
}

export async function exportAndShare(kind: ExportKind, study: LocalStudy, report: LocalReport | null): Promise<void> {
  const f = await buildExport(kind, study, report)
  await shareFile(f.name, f.data)
}

export async function exportAndSave(kind: ExportKind, study: LocalStudy, report: LocalReport | null): Promise<string> {
  const f = await buildExport(kind, study, report)
  return saveToDocuments(f.name, f.data)
}
