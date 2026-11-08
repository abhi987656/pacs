import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import { Bold, CaseUpper, Heading, Italic, List, ListOrdered, Redo2, Underline, Undo2 } from 'lucide-react'
import { buildExtensions, changeCase, insertMacroText } from '../renderer/src/ris/editor'
import type { MacroLike as Macro } from '../renderer/src/ris/editor'

/**
 * Android keyboards often don't send a real "Space" key event, so the PC's ".code + Space"
 * shortcut never fires. This watches the text instead: ".nad " right before the cursor expands.
 */
const MacroAutoExpand = Extension.create<{ getMacros: () => Macro[] }>({
  name: 'macroAutoExpand',
  addOptions() {
    return { getMacros: () => [] }
  },
  onTransaction({ transaction }) {
    if (!transaction.docChanged || transaction.getMeta('macroAutoExpand') || !this.editor.isEditable) return
    const before = transaction.before.content.size
    const state = this.editor.state
    if (state.doc.content.size <= before) return // only after typing, not deleting
    const { $from, empty } = state.selection
    if (!empty) return
    const text = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
    const m = /(?:^|\s)(\.([A-Za-z0-9_-]{1,20}))([  ])$/.exec(text)
    if (!m) return
    const macro = this.options.getMacros().find((x) => x.code.toLowerCase() === m[2].toLowerCase())
    if (!macro) return
    const to = $from.pos
    const from = to - m[1].length - m[3].length
    const editor = this.editor
    // After the keyboard has finished its own update.
    setTimeout(() => {
      if (editor.isDestroyed) return
      const cur = editor.state.doc.textBetween(from, to, undefined, '￼')
      if (cur !== m[1] + m[3]) return
      insertMacroText(editor, macro.text + ' ', { from, to })
    }, 0)
  }
})

export function useMobileEditor(opts: {
  content: string
  editable: boolean
  placeholder: string
  getMacros: () => Macro[]
  onChange?: (e: Editor) => void
}) {
  return useEditor({
    extensions: [
      ...buildExtensions({ getMacros: opts.getMacros, placeholder: opts.placeholder }),
      MacroAutoExpand.configure({ getMacros: opts.getMacros })
    ],
    content: opts.content,
    editable: opts.editable,
    editorProps: {
      attributes: { class: 'report-doc m-doc', spellcheck: 'true', autocapitalize: 'sentences', autocorrect: 'on' }
    },
    onUpdate: ({ editor }) => opts.onChange?.(editor)
  })
}

export function MobileEditor({ editor }: { editor: Editor }) {
  return <EditorContent editor={editor} className="m-editor" />
}

/** Compact formatting bar for the phone. */
export function EditorToolbar({ editor, extra }: { editor: Editor; extra?: React.ReactNode }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      heading: e.isActive('heading', { level: 3 }),
      canUndo: e.can().undo(),
      canRedo: e.can().redo(),
      editable: e.isEditable
    })
  })
  if (!s.editable) return null
  // onMouseDown + preventDefault keeps the keyboard open and the cursor where it was.
  const btn = (label: string, active: boolean, run: () => void, icon: React.ReactNode, disabled = false) => (
    <button
      className={`m-tool ${active ? 'active' : ''}`}
      aria-label={label}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {icon}
    </button>
  )
  return (
    <div className="m-toolbar">
      {extra}
      {btn('Bold', s.bold, () => editor.chain().focus().toggleBold().run(), <Bold size={18} />)}
      {btn('Italic', s.italic, () => editor.chain().focus().toggleItalic().run(), <Italic size={18} />)}
      {btn('Underline', s.underline, () => editor.chain().focus().toggleUnderline().run(), <Underline size={18} />)}
      {btn('Bullets', s.bullet, () => editor.chain().focus().toggleBulletList().run(), <List size={18} />)}
      {btn('Numbering', s.ordered, () => editor.chain().focus().toggleOrderedList().run(), <ListOrdered size={18} />)}
      {btn('Heading', s.heading, () => editor.chain().focus().toggleHeading({ level: 3 }).run(), <Heading size={18} />)}
      {btn('UPPER CASE', false, () => changeCase(editor, 'upper'), <CaseUpper size={18} />)}
      {btn('Undo', false, () => editor.chain().focus().undo().run(), <Undo2 size={18} />, !s.canUndo)}
      {btn('Redo', false, () => editor.chain().focus().redo().run(), <Redo2 size={18} />, !s.canRedo)}
    </div>
  )
}

/** Removes anything executable from report HTML before showing it read-only. */
export function safeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html')
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta,form').forEach((n) => n.remove())
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || /^\s*(javascript|vbscript):/i.test(a.value)) el.removeAttribute(a.name)
    }
  })
  return doc.body.firstElementChild?.innerHTML ?? ''
}
