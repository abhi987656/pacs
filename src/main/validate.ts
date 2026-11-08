import type { ManualStudyInput } from '@shared/types'

const MANUAL_KEYS: (keyof ManualStudyInput)[] = [
  'patientName', 'patientId', 'accession', 'sex', 'age', 'birthDate', 'description', 'modality',
  'studyDate', 'studyTime', 'referring', 'visitType', 'clinicalHistory'
]

/** Keeps only known patient/study fields, trimmed and length-limited. */
export function cleanManualInput(m: unknown, partial: boolean): Partial<ManualStudyInput> {
  const src = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
  const out: Partial<ManualStudyInput> = {}
  for (const k of MANUAL_KEYS) {
    const v = src[k]
    if (typeof v === 'string') out[k] = v.trim().slice(0, k === 'clinicalHistory' ? 4000 : 200)
    else if (!partial) out[k] = ''
  }
  return out
}

/**
 * Report HTML arriving from the phone is shown and printed on the PC. The editor only produces
 * plain formatting, so strip anything that could run code (defence in depth – the windows'
 * content security policy blocks scripts anyway).
 */
export function sanitizeReportHtml(html: string): string {
  return html
    .slice(0, 30_000_000)
    .replace(/<\s*(script|style|iframe|object|embed|frame|frameset|applet|form|svg|math)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*\/?\s*(script|style|iframe|object|embed|frame|frameset|applet|link|meta|base|form|input|button|textarea|select|svg|math)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src|xlink:href|action|formaction)\s*=\s*("\s*(?:javascript|vbscript|data:text\/html)[^"]*"|'\s*(?:javascript|vbscript|data:text\/html)[^']*'|(?:javascript|vbscript):[^\s>]*)/gi, '')
}
