import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TextStyleKit } from '@tiptap/extension-text-style'
import TextAlign from '@tiptap/extension-text-align'
import Highlight from '@tiptap/extension-highlight'
import Subscript from '@tiptap/extension-subscript'
import Superscript from '@tiptap/extension-superscript'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import { Placeholder } from '@tiptap/extensions'
import type { Macro } from '@shared/types'

/** Only the code and text of a macro are needed (PC and phone macros differ otherwise). */
export type MacroLike = Pick<Macro, 'code' | 'text'>

export const FONT_FAMILIES = [
  'Times New Roman',
  'Arial',
  'Calibri',
  'Cambria',
  'Georgia',
  'Segoe UI',
  'Tahoma',
  'Verdana',
  'Courier New'
]
export const FONT_SIZES = ['8pt', '9pt', '10pt', '10.5pt', '11pt', '12pt', '13pt', '14pt', '16pt', '18pt', '20pt', '24pt', '28pt', '36pt']
export const LINE_HEIGHTS = ['1', '1.15', '1.5', '2', '2.5']
export const SYMBOLS = ['°', '±', '×', '≈', '≤', '≥', '→', '↑', '↓', 'µ', '½', '¼', '²', '³', '~', '§']
export const COLORS = ['#000000', '#c00000', '#e36c09', '#1f4e79', '#0070c0', '#00b050', '#7030a0', '#7f7f7f']
export const HIGHLIGHTS = ['#ffff00', '#92d050', '#00b0f0', '#ff99cc', '#ffc000']

/** Expands macros: ".code" + Space/Enter, or "code" + F3 (like Word AutoText). */
const MacroExpansion = Extension.create<{ getMacros: () => MacroLike[] }>({
  name: 'macroExpansion',
  addOptions() {
    return { getMacros: () => [] }
  },
  addKeyboardShortcuts() {
    const expand = (requireDot: boolean, trailing: string): boolean => {
      const { state } = this.editor
      const { $from, empty } = state.selection
      if (!empty || !this.editor.isEditable) return false
      const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
      const re = requireDot ? /(?:^|\s)(\.([A-Za-z0-9_-]{1,20}))$/ : /(?:^|\s)(\.?([A-Za-z0-9_-]{1,20}))$/
      const m = re.exec(before)
      if (!m) return false
      const macro = this.options.getMacros().find((x) => x.code.toLowerCase() === m[2].toLowerCase())
      if (!macro) return false
      const from = $from.pos - m[1].length
      insertMacroText(this.editor, macro.text + trailing, { from, to: $from.pos })
      return true
    }
    return {
      Space: () => expand(true, ' '),
      Enter: () => {
        expand(true, '')
        return false // let Enter continue (new paragraph / list item)
      },
      F3: () => expand(false, '')
    }
  }
})

export function insertMacroText(editor: Editor, text: string, range?: { from: number; to: number }): void {
  const lines = text.split(/\r?\n/)
  const content =
    lines.length === 1
      ? text
        ? { type: 'text', text }
        : ''
      : lines.map((l) => ({ type: 'paragraph', content: l ? [{ type: 'text', text: l }] : [] }))
  if (!content) return
  if (range) editor.chain().focus().insertContentAt(range, content).run()
  else editor.chain().focus().insertContent(content).run()
}

export function buildExtensions(opts: { getMacros: () => MacroLike[]; placeholder: string }) {
  return [
    StarterKit.configure({
      codeBlock: false,
      code: false,
      link: { openOnClick: false, autolink: true },
      heading: { levels: [1, 2, 3] }
    }),
    TextStyleKit,
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Highlight.configure({ multicolor: true }),
    Subscript,
    Superscript,
    TableKit.configure({ table: { resizable: true } }),
    Image.configure({ allowBase64: true, inline: false, resize: { enabled: true, alwaysPreserveAspectRatio: true } }),
    Placeholder.configure({ placeholder: opts.placeholder }),
    MacroExpansion.configure({ getMacros: opts.getMacros })
  ]
}

// ------------------------------------------------------------------ change case

export type CaseMode = 'upper' | 'lower' | 'sentence' | 'title'

export function changeCase(editor: Editor, mode: CaseMode): void {
  const { state } = editor
  const { from, to, empty } = state.selection
  if (empty) return
  const tr = state.tr
  const edits: { from: number; to: number; text: string; marks: readonly import('@tiptap/pm/model').Mark[] }[] = []
  let sentenceStart = true
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) sentenceStart = true
    if (!node.isText || !node.text) return
    const start = Math.max(from, pos)
    const end = Math.min(to, pos + node.text.length)
    const original = node.text.slice(start - pos, end - pos)
    let text = original
    if (mode === 'upper') text = original.toUpperCase()
    else if (mode === 'lower') text = original.toLowerCase()
    else if (mode === 'title') text = original.toLowerCase().replace(/(^|[\s(/-])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase())
    else {
      let out = ''
      for (const ch of original.toLowerCase()) {
        if (sentenceStart && /\p{L}/u.test(ch)) {
          out += ch.toUpperCase()
          sentenceStart = false
        } else {
          out += ch
          if (/[.!?]/.test(ch)) sentenceStart = true
        }
      }
      text = out
    }
    if (text !== original) edits.push({ from: start, to: end, text, marks: node.marks })
  })
  for (const e of edits.reverse()) {
    tr.replaceWith(e.from, e.to, state.schema.text(e.text, e.marks))
  }
  if (edits.length) editor.view.dispatch(tr)
}

// ------------------------------------------------------------------ find & replace

export interface Match {
  from: number
  to: number
}

export function findMatches(editor: Editor, query: string, matchCase: boolean): Match[] {
  if (!query) return []
  const out: Match[] = []
  const q = matchCase ? query : query.toLowerCase()
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return
    const text = matchCase ? node.text : node.text.toLowerCase()
    let i = text.indexOf(q)
    while (i >= 0) {
      out.push({ from: pos + i, to: pos + i + q.length })
      i = text.indexOf(q, i + q.length)
    }
  })
  return out
}

export function findNext(editor: Editor, query: string, matchCase: boolean): boolean {
  const matches = findMatches(editor, query, matchCase)
  if (!matches.length) return false
  const cur = editor.state.selection.to
  const next = matches.find((m) => m.from >= cur) ?? matches[0]
  editor.chain().focus().setTextSelection(next).scrollIntoView().run()
  return true
}

export function replaceCurrent(editor: Editor, query: string, replacement: string, matchCase: boolean): boolean {
  const { from, to } = editor.state.selection
  const selected = editor.state.doc.textBetween(from, to)
  const same = matchCase ? selected === query : selected.toLowerCase() === query.toLowerCase()
  if (same && from !== to) {
    editor.view.dispatch(editor.state.tr.insertText(replacement, from, to))
  }
  return findNext(editor, query, matchCase)
}

export function replaceAll(editor: Editor, query: string, replacement: string, matchCase: boolean): number {
  const matches = findMatches(editor, query, matchCase)
  if (!matches.length) return 0
  const tr = editor.state.tr
  for (const m of [...matches].reverse()) tr.insertText(replacement, m.from, m.to)
  editor.view.dispatch(tr)
  return matches.length
}

// ------------------------------------------------------------------ templates

export interface PlaceholderContext {
  patient_name: string
  patient_id: string
  age: string
  sex: string
  study: string
  study_date: string
  accession: string
  referring: string
  radiologist: string
  prior_date: string
  today: string
}

export function fillPlaceholders(html: string, ctx: PlaceholderContext): string {
  return html.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, key: string) => {
    const v = (ctx as unknown as Record<string, string>)[key]
    if (v === undefined) return m
    return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') || '____'
  })
}

/** Font-size step helper for the grow/shrink buttons. */
export function stepFontSize(current: string | undefined, dir: 1 | -1, fallback: string): string {
  const cur = current || fallback
  const idx = FONT_SIZES.indexOf(cur)
  if (idx >= 0) return FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, idx + dir))]
  const n = parseFloat(cur) || 12
  return `${Math.max(6, n + dir)}pt`
}
