// Red wavy underline under misspelled words in the TipTap editor, like Microsoft Word.
// The word being typed is left alone until the cursor leaves it.

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { speller } from './speller'

export const spellKey = new PluginKey<DecorationSet>('spellCheck')

const TOKEN = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu

/** Words of a text worth checking, with their offsets (pieces of hyphenated words separately). */
export function checkableWords(text: string): { word: string; start: number; end: number }[] {
  const out: { word: string; start: number; end: number }[] = []
  for (const m of text.matchAll(TOKEN)) {
    let offset = m.index ?? 0
    for (const piece of m[0].split('-')) {
      const word = piece.replace(/['’]+$/, '')
      const start = offset
      offset += piece.length + 1
      if (word.length < 2) continue
      if (/\p{N}/u.test(word)) continue // T2, L4, 5mm
      if (word === word.toUpperCase()) continue // CT, HRCT, USG – like Word's "ignore words in UPPERCASE"
      out.push({ word, start, end: start + word.length })
    }
  }
  return out
}

function decorate(doc: PMNode, skip: { from: number; to: number } | null): DecorationSet {
  const decos: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    // One placeholder character per inline non-text node keeps offsets equal to positions.
    const text = node.textBetween(0, node.content.size, undefined, '￼')
    for (const w of checkableWords(text)) {
      const from = pos + 1 + w.start
      const to = pos + 1 + w.end
      if (skip && from <= skip.to && to >= skip.from) continue
      if (speller.isWrong(w.word)) decos.push(Decoration.inline(from, to, { class: 'spell-error' }, { word: w.word }))
    }
    return false
  })
  return DecorationSet.create(doc, decos)
}

/** The word touching the cursor, while it is being typed. */
function wordAtCursor(state: EditorState): { from: number; to: number } | null {
  const sel = state.selection
  if (!sel.empty) return null
  const $p = sel.$head
  const text = $p.parent.textBetween(0, $p.parent.content.size, undefined, '￼')
  const at = $p.parentOffset
  for (const m of text.matchAll(TOKEN)) {
    const s = m.index ?? 0
    if (s <= at && at <= s + m[0].length) return { from: $p.start() + s, to: $p.start() + s + m[0].length }
  }
  return null
}

export const SpellCheck = Extension.create({
  name: 'spellCheck',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: spellKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr: Transaction, value: DecorationSet) {
            const next = tr.getMeta(spellKey) as DecorationSet | undefined
            if (next) return next
            return tr.docChanged ? value.map(tr.mapping, tr.doc) : value
          }
        },
        props: {
          decorations: (state) => spellKey.getState(state)
        },
        view(view: EditorView) {
          let timer = 0
          let typing = false
          let editable = view.editable
          const refresh = () => {
            timer = 0
            if (view.isDestroyed) return
            const show = speller.enabled && view.editable
            const skip = typing && view.hasFocus() ? wordAtCursor(view.state) : null
            const decos = show ? decorate(view.state.doc, skip) : DecorationSet.empty
            view.dispatch(view.state.tr.setMeta(spellKey, decos).setMeta('addToHistory', false))
          }
          const schedule = (ms: number) => {
            window.clearTimeout(timer)
            timer = window.setTimeout(refresh, ms)
          }
          const off = speller.onChange(() => schedule(30))
          schedule(0)
          return {
            update(v, prev) {
              if (!v.state.doc.eq(prev.doc)) {
                typing = true
                schedule(350)
              } else if (!v.state.selection.eq(prev.selection)) {
                typing = false
                schedule(120)
              } else if (v.editable !== editable) {
                schedule(0) // signed off / reopened: hide / show the underlines
              }
              editable = v.editable
            },
            destroy() {
              window.clearTimeout(timer)
              off()
            }
          }
        }
      })
    ]
  }
})
