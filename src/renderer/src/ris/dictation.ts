import type { Editor } from '@tiptap/core'
import type { DictationReplacement } from '@shared/types'

// ------------------------------------------------------------------ microphone capture

/** Captures the microphone at 16 kHz mono and hands out ~100 ms Float32 chunks. */
export class MicCapture {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null

  async start(deviceId: string, onChunk: (s: Float32Array) => void, onLevel: (rms: number) => void): Promise<void> {
    this.stop()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    const ctx = new AudioContext({ sampleRate: 16000 })
    await ctx.audioWorklet.addModule(new URL('/audio/capture-worklet.js', window.location.href).toString())
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    node.port.onmessage = (e: MessageEvent<{ samples: Float32Array; rms: number }>) => {
      onChunk(e.data.samples)
      onLevel(e.data.rms)
    }
    // Keep the graph running without playing anything back.
    const mute = ctx.createGain()
    mute.gain.value = 0
    source.connect(node).connect(mute).connect(ctx.destination)
    if (ctx.state === 'suspended') await ctx.resume()
    this.ctx = ctx
    this.stream = stream
    this.node = node
  }

  stop(): void {
    if (this.node) this.node.port.onmessage = null
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    this.stream = null
    this.node = null
  }
}

export function micErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name ?? ''
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Microphone access is blocked. In Windows Settings › Privacy & security › Microphone, turn on "Let desktop apps access your microphone".'
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'No microphone found. Plug in a microphone/headset or choose another one in Settings › Dictation.'
  if (name === 'NotReadableError') return 'The microphone is being used by another program.'
  return `Could not start the microphone: ${(e as Error)?.message ?? e}`
}

// ------------------------------------------------------------------ text processing

export type DictationAction =
  | { type: 'text'; text: string }
  | { type: 'enter'; count: number }
  | { type: 'undo' }
  | { type: 'macro'; code: string }
  | { type: 'template'; name: string }
  | { type: 'stop' }

// Upper-cased whenever they appear as whole words.
const ACRONYMS = [
  'CBD', 'CHD', 'IHBRD', 'MPD', 'IVC', 'SVC', 'SMA', 'SMV', 'CHA', 'HU', 'CT', 'MRI', 'USG', 'HRCT', 'CECT',
  'NCCT', 'KUB', 'CTA', 'MRA', 'MRCP', 'DWI', 'ADC', 'FLAIR', 'SWI', 'GGO', 'ILD', 'COPD', 'CSF', 'ACL',
  'PCL', 'MCL', 'LCL', 'ICA', 'MCA', 'ACA', 'LAD', 'RCA', 'LCX', 'RUL', 'RML', 'RLL', 'LUL', 'LLL', 'TIRADS',
  'BIRADS', 'LIRADS', 'PIRADS', 'RECIST', 'GB', 'CP', 'PCS', 'VUJ', 'PUJ', 'DVT', 'AAA', 'SOL'
]
const ACRONYM_RE = new RegExp(`\\b(${ACRONYMS.join('|')})\\b`, 'gi')

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function applyReplacements(t: string, reps: DictationReplacement[]): string {
  for (const r of reps) {
    const from = r.from.trim()
    if (!from) continue
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(from)}(?=$|[^\\p{L}\\p{N}])`, 'giu')
    t = t.replace(re, (_m, pre: string) => pre + r.to)
  }
  return t
}

const HYPHEN = '\u0001'
const SLASH = '\u0002'

function inlineCommands(t: string): string {
  return (
    t
      .replace(/\bfull[\s-]?stops?\b/gi, '.')
      .replace(/\bsemi[\s-]?colon\b/gi, ';')
      .replace(/\bcomma\b/gi, ',')
      .replace(/\bquestion mark\b/gi, '?')
      .replace(/\b(?:open|left) (?:bracket|parenthesis|paren)\b/gi, '(')
      .replace(/\b(?:close|right) (?:bracket|parenthesis|paren)\b/gi, ')')
      .replace(/\bhyphen\b/gi, HYPHEN)
      .replace(/\b(?:forward )?slash\b/gi, SLASH)
      // "colon" is also anatomy – only punctuation when it ends the phrase ("Impression colon").
      .replace(/\bcolon[.,]?\s*$/i, ':')
  )
}

function normaliseUnits(t: string): string {
  t = t.replace(/(\d)\s*(?:millimet(?:er|re)s?\b|mms?\b)/gi, '$1 mm')
  t = t.replace(/(\d)\s*(?:centimet(?:er|re)s?\b|cms?\b)/gi, '$1 cm')
  t = t.replace(/\bhounsfield units?\b/gi, 'HU')
  t = t.replace(/(\d)\s*(?:per ?cent)\b/gi, '$1%')
  // 12 by 8 mm, 9.5 x 7.6 cm, 3 by 2 by 1 cm
  for (let i = 0; i < 3; i++) {
    t = t.replace(/(\d(?:\.\d+)?)(\s*(?:mm|cm))?\s*(?:\bby\b|\binto\b|\btimes\b|\bx\b|×|\*)\s*(\d)/gi, '$1$2 x $3')
  }
  return t
}

function joinSpelledLetters(t: string): string {
  // "I.H.B.R.D." -> IHBRD, "C B D" -> CBD (a run of two or more single capital letters)
  t = t.replace(/\b(?:[A-Z]\.){2,}/g, (m) => m.replace(/\./g, ''))
  return t.replace(/\b[A-Z]\b(?:\s+[A-Z]\b)+/g, (m) => m.replace(/\s+/g, ''))
}

function cleanup(t: string): string {
  return t
    .replace(new RegExp(`\\s*${HYPHEN}\\s*`, 'g'), '-')
    .replace(new RegExp(`\\s*${SLASH}\\s*`, 'g'), '/')
    .replace(/[,;:]\s*\./g, '.')
    .replace(/\.(\s*\.)+/g, '.')
    .replace(/,(\s*,)+/g, ',')
    .replace(/\s+([.,;:?!%)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/([.?!]\s+)(\p{Ll})/gu, (_m, a: string, b: string) => a + b.toUpperCase())
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** Turns one recognised phrase into editor actions (text, voice commands …). */
export function parseUtterance(raw: string, opts: { commands: boolean; replacements: DictationReplacement[] }): DictationAction[] {
  let t = applyReplacements(raw.trim(), opts.replacements)
  if (!t) return []
  if (opts.commands) {
    const cmd = t.toLowerCase().replace(/[.,!?;:]+$/g, '').trim()
    if (/^(?:new|next) line$/.test(cmd)) return [{ type: 'enter', count: 1 }]
    if (/^new paragraph$/.test(cmd)) return [{ type: 'enter', count: 2 }]
    if (/^(?:(?:delete|scratch|undo|remove) (?:that|last)|undo)$/.test(cmd)) return [{ type: 'undo' }]
    if (/^(?:stop|end|pause) (?:dictation|dictating|listening)$/.test(cmd)) return [{ type: 'stop' }]
    const macro = /^macro\s*(.+)$/.exec(cmd)
    if (macro) return [{ type: 'macro', code: macro[1].replace(/[^a-z0-9]/g, '') }]
    const tpl = /^(?:insert |use )?template\s+(.+)$/.exec(cmd)
    if (tpl) return [{ type: 'template', name: tpl[1] }]
  }
  const actions: DictationAction[] = []
  // "… seen full stop new line the spleen …" inside one phrase.
  const pieces = opts.commands ? t.split(/[,.]?\s*\b(?:new|next) (line|paragraph)\b[.,]?\s*/i) : [t]
  for (let i = 0; i < pieces.length; i++) {
    if (i % 2 === 1) {
      actions.push({ type: 'enter', count: pieces[i].toLowerCase() === 'paragraph' ? 2 : 1 })
      continue
    }
    let p = pieces[i]
    if (!p.trim()) continue
    if (opts.commands) p = inlineCommands(p)
    p = normaliseUnits(p)
    p = joinSpelledLetters(p)
    p = p.replace(ACRONYM_RE, (m) => m.toUpperCase())
    p = cleanup(p)
    if (p) actions.push({ type: 'text', text: p })
  }
  return actions
}

// Proper nouns / eponyms that must keep their capital letter mid-sentence.
const KEEP_CAPS = new Set([
  'I', 'Doppler', 'Hounsfield', 'Morison', 'Bosniak', 'Fleischner', 'Couinaud', 'Gerota', 'Baker', 'Glisson',
  'Wilson', 'Crohn', "Crohn's", 'Hodgkin', 'Virchow', 'Morton', 'Schmorl', 'Modic', 'Pfirrmann', 'Kerley'
])

/** Inserts recognised text at the cursor with sensible spacing and capitalisation. */
export function insertDictatedText(editor: Editor, text: string, focus = true): void {
  const { $from } = editor.state.selection
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
  const atStart = before.trim() === ''
  const sentenceStart = atStart || /[.?!:]\s*$/.test(before)
  let t = text
  if (!/^[.,;:?!%)]/.test(t)) {
    const first = /^[\p{L}']+/u.exec(t)?.[0] ?? ''
    if (sentenceStart) t = t.charAt(0).toUpperCase() + t.slice(1)
    else if (/^\p{Lu}\p{Ll}+$/u.test(first) && !KEEP_CAPS.has(first)) t = t.charAt(0).toLowerCase() + t.slice(1)
    const last = before.slice(-1)
    if (!atStart && last && !/\s/.test(last) && last !== '(' && last !== '/') t = ` ${t}`
  }
  const chain = focus ? editor.chain().focus() : editor.chain()
  chain.insertContent({ type: 'text', text: t }).scrollIntoView().run()
}
