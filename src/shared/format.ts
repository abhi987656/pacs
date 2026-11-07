// Formatting helpers shared by the main process (printing) and the renderer.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** DICOM PN "FAMILY^GIVEN^MIDDLE^PREFIX^SUFFIX" -> "FAMILY GIVEN MIDDLE" */
export function formatPersonName(pn: string | null | undefined): string {
  if (!pn) return ''
  const first = pn.split('=')[0] // ignore ideographic/phonetic groups
  return first
    .split('^')
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ')
}

/** YYYYMMDD -> 07-Nov-2026 */
export function formatDicomDate(d: string | null | undefined): string {
  if (!d) return ''
  const m = /^(\d{4})\.?(\d{2})\.?(\d{2})/.exec(d.trim())
  if (!m) return d
  const month = MONTHS[Number(m[2]) - 1] ?? m[2]
  return `${m[3]}-${month}-${m[1]}`
}

/** HHMMSS(.ffff) -> 14:19 */
export function formatDicomTime(t: string | null | undefined): string {
  if (!t) return ''
  const m = /^(\d{2}):?(\d{2})?/.exec(t.trim())
  if (!m) return t
  return `${m[1]}:${m[2] ?? '00'}`
}

export function formatDicomDateTime(d: string, t: string): string {
  const date = formatDicomDate(d)
  const time = formatDicomTime(t)
  return [date, time].filter(Boolean).join(' ')
}

/** ISO timestamp -> 07-Nov-2026 16:21 */
export function formatIsoDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "056Y" -> "56 y", "011M" -> "11 m", "020D" -> "20 d"; falls back to computing from dates. */
export function formatAge(age: string | null | undefined, birthDate?: string, studyDate?: string): string {
  if (age) {
    const m = /^(\d{1,3})\s*([DWMY])?$/i.exec(age.trim())
    if (m) {
      const n = Number(m[1])
      const unit = (m[2] ?? 'Y').toLowerCase()
      return `${n} ${unit}`
    }
    return age
  }
  if (birthDate && /^\d{8}$/.test(birthDate)) {
    const ref = studyDate && /^\d{8}$/.test(studyDate) ? studyDate : todayDicom()
    const by = Number(birthDate.slice(0, 4))
    const bm = Number(birthDate.slice(4, 6))
    const bd = Number(birthDate.slice(6, 8))
    const ry = Number(ref.slice(0, 4))
    const rm = Number(ref.slice(4, 6))
    const rd = Number(ref.slice(6, 8))
    let years = ry - by
    if (rm < bm || (rm === bm && rd < bd)) years--
    if (years >= 2) return `${years} y`
    let months = (ry - by) * 12 + (rm - bm) - (rd < bd ? 1 : 0)
    if (months >= 1) return `${months} m`
    const days = Math.round(
      (Date.UTC(ry, rm - 1, rd) - Date.UTC(by, bm - 1, bd)) / 86400000
    )
    return `${Math.max(days, 0)} d`
  }
  return ''
}

export function formatSex(sex: string | null | undefined): string {
  const s = (sex ?? '').trim().toUpperCase()
  if (s === 'M' || s === 'F' || s === 'O') return s
  return s ? s[0] : ''
}

export function todayDicom(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

export function dicomDateFromDate(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

export const STATUS_LABEL: Record<string, string> = {
  NEW: 'Unreported',
  DRAFT: 'Draft',
  PRELIMINARY: 'Preliminary',
  FINAL: 'Signed off'
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
