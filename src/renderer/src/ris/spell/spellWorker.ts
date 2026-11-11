// Spell checking off the main thread: Hunspell dictionaries (British and American English, via
// nspell) plus the built-in radiology words and the user's own words. Works fully offline.

/// <reference lib="webworker" />
import nspell from 'nspell'
import gbAff from '@dict-gb/index.aff?raw'
import gbDic from '@dict-gb/index.dic?raw'
import usAff from '@dict-us/index.aff?raw'
import usDic from '@dict-us/index.dic?raw'
import { MEDICAL_WORDS } from '@shared/medicalWords'
import type { SpellLang, SpellRequest, SpellResponse } from './protocol'

type Dict = ReturnType<typeof nspell>

const dicts: Partial<Record<SpellLang, Dict>> = {}
let active: Dict[] = []
/** Medical + personal words, lower case (accepted in any capitalisation). */
const extra = new Set(MEDICAL_WORDS.map((w) => w.toLowerCase()))
const personal = new Set<string>()

function dict(lang: SpellLang): Dict {
  let d = dicts[lang]
  if (!d) {
    d = lang === 'en-GB' ? nspell(gbAff, gbDic) : nspell(usAff, usDic)
    for (const w of MEDICAL_WORDS) d.add(w)
    for (const w of personal) d.add(w)
    dicts[lang] = d
  }
  return d
}

const norm = (w: string) => w.replace(/[‘’]/g, "'")

function isCorrect(word: string): boolean {
  const w = norm(word)
  if (extra.has(w.toLowerCase())) return true
  for (const d of active) if (d.correct(w)) return true
  // "liver's", "kidneys'"
  const m = /^(.+?)'s?$/i.exec(w)
  if (m && m[1].length > 1 && m[1] !== w) return isCorrect(m[1])
  return false
}

/** Optimal string alignment distance (Levenshtein + swapped neighbours), stops early above `max`. */
function distance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1)
      d[i][j] = v
      rowMin = Math.min(rowMin, v)
    }
    if (rowMin > max) return max + 1
  }
  return d[a.length][b.length]
}

const MEDICAL_LOWER = MEDICAL_WORDS.map((w) => [w, w.toLowerCase()] as const)

function suggest(word: string): string[] {
  const w = norm(word)
  const lower = w.toLowerCase()
  const order: string[] = []
  const score = new Map<string, number>()
  const add = (c: string, s: number) => {
    const key = c.toLowerCase()
    if (key === lower) return
    if (!score.has(key)) order.push(c)
    score.set(key, Math.min(score.get(key) ?? Infinity, s))
  }
  // Swapped neighbours ("teh" -> "the", "recieve" -> "receive") are the most common slip.
  for (let i = 0; i < lower.length - 1; i++) {
    const c = lower.slice(0, i) + lower[i + 1] + lower[i] + lower.slice(i + 2)
    if (isCorrect(c)) add(c, 0)
  }
  for (const d of active) d.suggest(w).forEach((c, i) => add(c, distance(lower, c.toLowerCase()) + i * 0.01))
  // Radiology words the general dictionaries' suggestions may not reach.
  for (const [orig, l] of MEDICAL_LOWER) {
    if (l === lower || Math.abs(l.length - lower.length) > 2 || l[0] !== lower[0]) continue
    const dist = distance(lower, l, 2)
    if (dist <= 2) add(orig, dist + 0.005)
  }
  const ranked = order.sort((a, b) => score.get(a.toLowerCase())! - score.get(b.toLowerCase())!)
  // Keep the writer's capitals: "Hepatomegly" -> "Hepatomegaly".
  const cap = (c: string) =>
    w.length > 1 && w === w.toUpperCase() ? c.toUpperCase() : /^\p{Lu}/u.test(w) ? c[0].toUpperCase() + c.slice(1) : c
  return [...new Set(ranked.map(cap))].slice(0, 6)
}

const post = (m: SpellResponse) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m)

self.onmessage = (e: MessageEvent<SpellRequest>) => {
  const m = e.data
  switch (m.type) {
    case 'init':
      for (const w of m.words) {
        personal.add(w)
        extra.add(w.toLowerCase())
      }
      active = m.langs.map(dict)
      break
    case 'check':
      post({ type: 'checked', id: m.id, words: m.words, wrong: m.words.filter((w) => !isCorrect(w)) })
      break
    case 'suggest':
      post({ type: 'suggested', id: m.id, suggestions: suggest(m.word) })
      break
    case 'add':
      personal.add(m.word)
      extra.add(m.word.toLowerCase())
      for (const d of Object.values(dicts)) d?.add(m.word)
      break
    case 'remove':
      personal.delete(m.word)
      if (!MEDICAL_WORDS.some((x) => x.toLowerCase() === m.word.toLowerCase())) extra.delete(m.word.toLowerCase())
      for (const d of Object.values(dicts)) d?.remove(m.word)
      break
  }
}
