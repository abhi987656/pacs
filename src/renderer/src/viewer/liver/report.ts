/**
 * Result tables of the liver analysis (shown in the panel and sent to the report), in the
 * layout of the Philips CT Liver Analysis tables: liver, findings, vessels, segments, resection.
 */
import { LANDMARKS, LEVELS, SEGMENTS, segmentName } from './couinaud'
import { VESSEL_NAMES, type LiverState } from './store'

export interface Row {
  label: string
  ml: number
  /** % of the total liver. */
  pct?: number
  /** % of the functional liver (without vessels and findings). */
  pctFn?: number
  hu?: string
  note?: string
  color?: [number, number, number]
  code?: number
}

export interface Tables {
  total: number
  functional: number
  liver: Row[]
  findings: Row[]
  vessels: Row[]
  segments: Row[]
  resection: Row[] | null
  /** Remaining liver after the planned resection, % of the total and of the functional liver. */
  remnant: { ml: number; pct: number; pctFn: number; fnMl: number } | null
  findingsResected: { label: string; pct: number; color: [number, number, number] }[]
}

const hu = (m: { mean: number; sd: number }) => `${Math.round(m.mean)} ± ${Math.round(m.sd)}`
const round1 = (x: number) => Math.round(x * 10) / 10

export function tablesOf(s: LiverState): Tables | null {
  const st = s.stats
  if (!st) return null
  const ml = st.ml
  const total = st.liver.n * ml
  const functional = st.functional * ml
  const pct = (v: number) => (total > 0 ? (100 * v) / total : 0)
  const pctFn = (v: number) => (functional > 0 ? (100 * v) / functional : 0)
  const liver: Row[] = [
    { label: 'Functional liver', ml: functional, pct: pct(functional), note: 'without vessels and findings' },
    { label: 'Total liver', ml: total, pct: 100, hu: hu(st.liver) }
  ]
  const findings: Row[] = s.findingList
    .filter((f) => st.findings[f.id])
    .map((f) => {
      const m = st.findings[f.id]
      const segs = m.segments.map((c) => segmentName(c, s.level).replace('Segment ', 'S')).join(', ')
      return { label: f.name, ml: m.n * ml, pct: pct(m.n * ml), hu: hu(m), note: segs ? `in ${segs}` : '', color: f.color, code: f.id }
    })
  const vessels: Row[] = Object.entries(st.vessels).map(([k, m]) => ({ label: VESSEL_NAMES[Number(k)] ?? 'Vessels', ml: m.n * ml, pct: pct(m.n * ml), hu: hu(m) }))
  const order = SEGMENTS.map((x) => x.code)
  const segments: Row[] = Object.entries(st.segments)
    .map(([k, m]) => ({ code: Number(k), m }))
    .sort((a, b) => order.indexOf(a.code) - order.indexOf(b.code))
    .map(({ code, m }) => ({
      label: segmentName(code, s.level),
      ml: m.n * ml,
      pct: pct(m.n * ml),
      pctFn: pctFn(m.functional * ml),
      hu: hu(m),
      color: SEGMENTS.find((x) => x.code === code)?.color,
      code
    }))
  let resection: Row[] | null = null
  let remnant: Tables['remnant'] = null
  const findingsResected: Tables['findingsResected'] = []
  const r = st.resection
  if (r) {
    resection = []
    for (const code of s.resectSegments) {
      const n = r.bySegment[code]
      if (n) resection.push({ label: segmentName(code, s.level), ml: n * ml, pct: pct(n * ml), color: SEGMENTS.find((x) => x.code === code)?.color })
    }
    if (r.atypical) resection.push({ label: 'Atypical (cut / brush)', ml: r.atypical * ml, pct: pct(r.atypical * ml) })
    resection.push({ label: 'Total resected', ml: r.n * ml, pct: pct(r.n * ml), pctFn: pctFn(r.functional * ml) })
    const remain = (st.liver.n - r.n) * ml
    const remainFn = (st.functional - r.functional) * ml
    resection.push({ label: 'Total remaining', ml: remain, pct: pct(remain), pctFn: pctFn(remainFn) })
    remnant = { ml: remain, pct: pct(remain), pctFn: pctFn(remainFn), fnMl: remainFn }
    for (const f of s.findingList) {
      const x = r.findings[f.id]
      if (x && x.total) findingsResected.push({ label: f.name, pct: (100 * x.resected) / x.total, color: f.color })
    }
  }
  return { total, functional, liver, findings, vessels, segments, resection, remnant, findingsResected }
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
const mlText = (x: number) => `${x >= 100 ? Math.round(x) : round1(x)} mL`
const pctText = (x: number | undefined) => (x == null ? '' : `${round1(x)} %`)

function table(head: string[], rows: string[][]): string {
  return `<table><tbody><tr>${head.map((h) => `<th><p>${esc(h)}</p></th>`).join('')}</tr>${rows
    .map((r) => `<tr>${r.map((c) => `<td><p>${esc(c)}</p></td>`).join('')}</tr>`)
    .join('')}</tbody></table>`
}

/** The results as report text (tables) for the report editor. */
export function reportHtml(s: LiverState, seriesName: string): string | null {
  const t = tablesOf(s)
  if (!t) return null
  const parts: string[] = []
  parts.push(`<h3>CT liver volumetry</h3>`)
  parts.push(`<p>${esc(seriesName ? `Series: ${seriesName}. ` : '')}Liver segmented semi-automatically on CT and reviewed${s.segments ? `; segments from anatomical landmarks (${esc(LEVELS.find((l) => l.id === s.level)?.name ?? '')})` : ''}.</p>`)
  parts.push(table(['Liver', 'Volume', '% of total', 'HU (mean ± SD)'], t.liver.map((r) => [r.label, mlText(r.ml), pctText(r.pct), r.hu ?? ''])))
  if (t.findings.length) parts.push(table(['Finding', 'Volume', '% of liver', 'HU (mean ± SD)', 'Location'], t.findings.map((r) => [r.label, mlText(r.ml), pctText(r.pct), r.hu ?? '', r.note ?? ''])))
  if (t.vessels.length) parts.push(table(['Vessels', 'Volume', '% of liver'], t.vessels.map((r) => [r.label, mlText(r.ml), pctText(r.pct)])))
  if (t.segments.length) parts.push(table(['Segment', 'Volume', '% of total', '% of functional'], t.segments.map((r) => [r.label, mlText(r.ml), pctText(r.pct), pctText(r.pctFn)])))
  if (t.resection) {
    parts.push(table(['Resection plan', 'Volume', '% of liver', '% of functional'], t.resection.map((r) => [r.label, mlText(r.ml), pctText(r.pct), pctText(r.pctFn)])))
    if (t.findingsResected.length)
      parts.push(table([`Findings removed (with ${s.marginMm} mm margin)`, '% resected'], t.findingsResected.map((r) => [r.label, pctText(r.pct)])))
    if (t.remnant) {
      const warn = t.remnant.pctFn < 30 ? ' – below 30 % of the functional liver' : t.remnant.pctFn < 40 ? ' – below 40 % (enough only for a healthy liver)' : ''
      parts.push(`<p><strong>Future liver remnant: ${mlText(t.remnant.ml)} (${pctText(t.remnant.pct)} of the total, ${pctText(t.remnant.pctFn)} of the functional liver)${esc(warn)}.</strong></p>`)
    }
  }
  return parts.join('')
}

/** Short names of landmarks still to place for the level. */
export function missingNames(s: LiverState): string[] {
  const need = LEVELS.find((l) => l.id === s.level)?.needs ?? []
  return need.filter((id) => !(s.landmarks[id]?.length)).map((id) => LANDMARKS.find((l) => l.id === id)?.name ?? id)
}
