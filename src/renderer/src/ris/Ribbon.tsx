import { useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Editor } from '@tiptap/core'
import { useEditorState } from '@tiptap/react'
import {
  Baseline,
  BookPlus,
  BookText,
  Calendar,
  ClipboardPaste,
  Columns2,
  Copy,
  Eraser,
  FileDown,
  FileText,
  Highlighter,
  History,
  Image as ImageIcon,
  List,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
  Maximize,
  Minus,
  Pilcrow,
  Printer,
  Redo2,
  Replace,
  Rows2,
  Save,
  Scissors,
  Search,
  Table,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  Trash,
  Undo2,
  Zap
} from 'lucide-react'
import type { Settings } from '@shared/types'
import { changeCase, COLORS, FONT_FAMILIES, FONT_SIZES, HIGHLIGHTS, LINE_HEIGHTS, stepFontSize, SYMBOLS } from './editor'
import type { CaseMode } from './editor'

const api = window.api

export type RibbonTab = 'home' | 'insert' | 'layout' | 'view' | 'templates'

interface Props {
  editor: Editor
  disabled: boolean
  settings: Settings
  view: 'print' | 'simple'
  zoom: number
  showMarks: boolean
  fullScreen: boolean
  onView: (v: 'print' | 'simple') => void
  onZoom: (z: number) => void
  onToggleMarks: () => void
  onToggleFullScreen: () => void
  onSave: () => void
  onFind: (replace: boolean) => void
  onSettings: (patch: Partial<Settings>) => void
  onSaveAsTemplate: () => void
  onManage: (tab: 'templates' | 'macros') => void
  onInsertPrior: () => void
  onHistory: () => void
  onPrint: () => void
  onPdf: () => void
}

function Btn({
  title,
  onClick,
  active,
  disabled,
  children,
  wide
}: {
  title: string
  onClick: () => void
  active?: boolean
  disabled?: boolean
  children: ReactNode
  wide?: boolean
}) {
  return (
    <button
      type="button"
      className={`rb-btn ${active ? 'active' : ''} ${wide ? 'wide' : ''}`}
      title={title}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()} // keep editor selection
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function Sep() {
  return <span className="rb-sep" />
}

function Dropdown({ label, title, children, disabled }: { label: ReactNode; title: string; children: ReactNode; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div
      className="rb-dd"
      ref={ref}
      onBlur={(e) => {
        if (!ref.current?.contains(e.relatedTarget as Node)) setOpen(false)
      }}
    >
      <button
        type="button"
        className="rb-btn"
        title={title}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        {label} <span className="caret">▾</span>
      </button>
      {open && (
        <div className="rb-menu" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(false)}>
          {children}
        </div>
      )}
    </div>
  )
}

export function Ribbon(p: Props) {
  const { editor, disabled } = p
  const [tab, setTab] = useState<RibbonTab>('home')
  const fileInput = useRef<HTMLInputElement>(null)

  const st = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      sub: e.isActive('subscript'),
      sup: e.isActive('superscript'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      left: e.isActive({ textAlign: 'left' }),
      center: e.isActive({ textAlign: 'center' }),
      right: e.isActive({ textAlign: 'right' }),
      justify: e.isActive({ textAlign: 'justify' }),
      fontFamily: (e.getAttributes('textStyle').fontFamily as string | undefined) ?? '',
      fontSize: (e.getAttributes('textStyle').fontSize as string | undefined) ?? '',
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      inTable: e.isActive('table'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo()
    })
  })

  const chain = () => editor.chain().focus()
  const fontFamily = st.fontFamily.replace(/["']/g, '') || p.settings.editorFontFamily
  const fontSize = st.fontSize || p.settings.editorFontSize
  const style = st.h1 ? 'h1' : st.h2 ? 'h2' : st.h3 ? 'h3' : 'p'

  const insertPicture = (file: File) => {
    const reader = new FileReader()
    reader.onload = () => chain().setImage({ src: String(reader.result) }).run()
    reader.readAsDataURL(file)
  }

  const insertTable = () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()

  const tabs: [RibbonTab, string][] = [
    ['home', 'Home'],
    ['insert', 'Insert'],
    ['layout', 'Page Layout'],
    ['view', 'View'],
    ['templates', 'Templates']
  ]

  return (
    <div className="ribbon">
      <div className="rb-tabs">
        {tabs.map(([k, label]) => (
          <button key={k} className={`rb-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="rb-bar">
        {tab === 'home' && (
          <>
            <Btn title="Undo (Ctrl+Z)" disabled={disabled || !st.canUndo} onClick={() => chain().undo().run()}>
              <Undo2 size={16} />
            </Btn>
            <Btn title="Redo (Ctrl+Y)" disabled={disabled || !st.canRedo} onClick={() => chain().redo().run()}>
              <Redo2 size={16} />
            </Btn>
            <Btn title="Save draft (Ctrl+S)" disabled={disabled} onClick={p.onSave}>
              <Save size={16} />
            </Btn>
            <Sep />
            <Btn title="Cut" disabled={disabled} onClick={() => void api.editCommand('cut')}>
              <Scissors size={16} />
            </Btn>
            <Btn title="Copy" onClick={() => void api.editCommand('copy')}>
              <Copy size={16} />
            </Btn>
            <Btn title="Paste" disabled={disabled} onClick={() => void api.editCommand('paste')}>
              <ClipboardPaste size={16} />
            </Btn>
            <Sep />
            <select
              className="rb-select font"
              title="Font"
              disabled={disabled}
              value={FONT_FAMILIES.includes(fontFamily) ? fontFamily : ''}
              onChange={(e) => chain().setFontFamily(e.target.value).run()}
            >
              {!FONT_FAMILIES.includes(fontFamily) && <option value="">{fontFamily}</option>}
              {FONT_FAMILIES.map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>
                  {f}
                </option>
              ))}
            </select>
            <select
              className="rb-select size"
              title="Font size"
              disabled={disabled}
              value={FONT_SIZES.includes(fontSize) ? fontSize : ''}
              onChange={(e) => chain().setFontSize(e.target.value).run()}
            >
              {!FONT_SIZES.includes(fontSize) && <option value="">{fontSize}</option>}
              {FONT_SIZES.map((s) => (
                <option key={s} value={s}>
                  {s.replace('pt', '')}
                </option>
              ))}
            </select>
            <Btn title="Grow font" disabled={disabled} onClick={() => chain().setFontSize(stepFontSize(fontSize, 1, p.settings.editorFontSize)).run()}>
              <span className="txt">A<sup>+</sup></span>
            </Btn>
            <Btn title="Shrink font" disabled={disabled} onClick={() => chain().setFontSize(stepFontSize(fontSize, -1, p.settings.editorFontSize)).run()}>
              <span className="txt small">A<sup>−</sup></span>
            </Btn>
            <Dropdown title="Font colour" disabled={disabled} label={<Baseline size={16} color="#ff5252" />}>
              <div className="swatches">
                {COLORS.map((c) => (
                  <button key={c} className="swatch" style={{ background: c }} title={c} onClick={() => chain().setColor(c).run()} />
                ))}
              </div>
              <button className="rb-menu-item" onClick={() => chain().unsetColor().run()}>
                Automatic (black)
              </button>
            </Dropdown>
            <Dropdown title="Highlight" disabled={disabled} label={<Highlighter size={16} color="#ffd600" />}>
              <div className="swatches">
                {HIGHLIGHTS.map((c) => (
                  <button key={c} className="swatch" style={{ background: c }} title={c} onClick={() => chain().toggleHighlight({ color: c }).run()} />
                ))}
              </div>
              <button className="rb-menu-item" onClick={() => chain().unsetHighlight().run()}>
                No highlight
              </button>
            </Dropdown>
            <Btn title="Clear formatting" disabled={disabled} onClick={() => chain().unsetAllMarks().clearNodes().run()}>
              <Eraser size={16} />
            </Btn>
            <Sep />
            <Btn title="Bold (Ctrl+B)" active={st.bold} disabled={disabled} onClick={() => chain().toggleBold().run()}>
              <b className="txt">B</b>
            </Btn>
            <Btn title="Italic (Ctrl+I)" active={st.italic} disabled={disabled} onClick={() => chain().toggleItalic().run()}>
              <i className="txt serif">I</i>
            </Btn>
            <Btn title="Underline (Ctrl+U)" active={st.underline} disabled={disabled} onClick={() => chain().toggleUnderline().run()}>
              <u className="txt">U</u>
            </Btn>
            <Btn title="Strikethrough" active={st.strike} disabled={disabled} onClick={() => chain().toggleStrike().run()}>
              <s className="txt">S</s>
            </Btn>
            <Btn title="Subscript" active={st.sub} disabled={disabled} onClick={() => chain().toggleSubscript().run()}>
              <span className="txt">
                X<sub>2</sub>
              </span>
            </Btn>
            <Btn title="Superscript" active={st.sup} disabled={disabled} onClick={() => chain().toggleSuperscript().run()}>
              <span className="txt">
                X<sup>2</sup>
              </span>
            </Btn>
            <Dropdown title="Change case" disabled={disabled} label={<span className="txt">Aa</span>}>
              {(
                [
                  ['sentence', 'Sentence case.'],
                  ['lower', 'lowercase'],
                  ['upper', 'UPPERCASE'],
                  ['title', 'Capitalize Each Word']
                ] as [CaseMode, string][]
              ).map(([m, l]) => (
                <button key={m} className="rb-menu-item" onClick={() => changeCase(editor, m)}>
                  {l}
                </button>
              ))}
            </Dropdown>
            <Sep />
            <Btn title="Bulleted list" active={st.bullet} disabled={disabled} onClick={() => chain().toggleBulletList().run()}>
              <List size={16} />
            </Btn>
            <Btn title="Numbered list" active={st.ordered} disabled={disabled} onClick={() => chain().toggleOrderedList().run()}>
              <ListOrdered size={16} />
            </Btn>
            <Btn title="Decrease indent (Shift+Tab)" disabled={disabled} onClick={() => chain().liftListItem('listItem').run()}>
              <ListIndentDecrease size={16} />
            </Btn>
            <Btn title="Increase indent / multilevel list (Tab)" disabled={disabled} onClick={() => chain().sinkListItem('listItem').run()}>
              <ListIndentIncrease size={16} />
            </Btn>
            <Sep />
            <Btn title="Align left" active={st.left} disabled={disabled} onClick={() => chain().setTextAlign('left').run()}>
              <TextAlignStart size={16} />
            </Btn>
            <Btn title="Center" active={st.center} disabled={disabled} onClick={() => chain().setTextAlign('center').run()}>
              <TextAlignCenter size={16} />
            </Btn>
            <Btn title="Align right" active={st.right} disabled={disabled} onClick={() => chain().setTextAlign('right').run()}>
              <TextAlignEnd size={16} />
            </Btn>
            <Btn title="Justify" active={st.justify} disabled={disabled} onClick={() => chain().setTextAlign('justify').run()}>
              <TextAlignJustify size={16} />
            </Btn>
            <Dropdown title="Line spacing" disabled={disabled} label={<span className="txt">↕</span>}>
              {LINE_HEIGHTS.map((h) => (
                <button key={h} className="rb-menu-item" onClick={() => chain().setLineHeight(h).run()}>
                  {h}
                </button>
              ))}
            </Dropdown>
            <select
              className="rb-select style"
              title="Paragraph style"
              disabled={disabled}
              value={style}
              onChange={(e) => {
                const v = e.target.value
                if (v === 'p') chain().setParagraph().run()
                else chain().setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 }).run()
              }}
            >
              <option value="p">¶ Normal</option>
              <option value="h1">Heading 1</option>
              <option value="h2">Heading 2</option>
              <option value="h3">Heading 3</option>
            </select>
            <Sep />
            <Btn title="Find (Ctrl+F)" onClick={() => p.onFind(false)}>
              <Search size={16} />
            </Btn>
            <Btn title="Replace (Ctrl+H)" disabled={disabled} onClick={() => p.onFind(true)}>
              <Replace size={16} />
            </Btn>
            <Btn title="Show/Hide ¶" active={p.showMarks} onClick={p.onToggleMarks}>
              <Pilcrow size={16} />
            </Btn>
          </>
        )}

        {tab === 'insert' && (
          <>
            <Btn wide title="Insert a 3×3 table" disabled={disabled} onClick={insertTable}>
              <Table size={16} /> Table
            </Btn>
            {st.inTable && (
              <>
                <Btn wide title="Add row below" disabled={disabled} onClick={() => chain().addRowAfter().run()}>
                  <Rows2 size={16} /> + Row
                </Btn>
                <Btn wide title="Add column right" disabled={disabled} onClick={() => chain().addColumnAfter().run()}>
                  <Columns2 size={16} /> + Column
                </Btn>
                <Btn wide title="Delete row" disabled={disabled} onClick={() => chain().deleteRow().run()}>
                  − Row
                </Btn>
                <Btn wide title="Delete column" disabled={disabled} onClick={() => chain().deleteColumn().run()}>
                  − Column
                </Btn>
                <Btn wide title="Delete table" disabled={disabled} onClick={() => chain().deleteTable().run()}>
                  <Trash size={16} /> Table
                </Btn>
              </>
            )}
            <Sep />
            <Btn wide title="Insert picture from a file" disabled={disabled} onClick={() => fileInput.current?.click()}>
              <ImageIcon size={16} /> Picture
            </Btn>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) insertPicture(f)
                e.target.value = ''
              }}
            />
            <Btn wide title="Insert horizontal line" disabled={disabled} onClick={() => chain().setHorizontalRule().run()}>
              <Minus size={16} /> Line
            </Btn>
            <Btn
              wide
              title="Insert today's date"
              disabled={disabled}
              onClick={() => chain().insertContent(new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })).run()}
            >
              <Calendar size={16} /> Date
            </Btn>
            <Dropdown title="Insert symbol" disabled={disabled} label={<span className="txt">Ω Symbol</span>}>
              <div className="symbols">
                {SYMBOLS.map((s) => (
                  <button key={s} className="symbol" onClick={() => chain().insertContent(s).run()}>
                    {s}
                  </button>
                ))}
              </div>
            </Dropdown>
            <Sep />
            <Btn wide title="Insert text from a previous report of this patient" disabled={disabled} onClick={p.onInsertPrior}>
              <FileText size={16} /> Previous report
            </Btn>
            <span className="rb-hint">Key images: use the camera button in the viewer.</span>
          </>
        )}

        {tab === 'layout' && (
          <>
            <label className="rb-label">
              Margins
              <select className="rb-select" value={p.settings.pageMargin} onChange={(e) => p.onSettings({ pageMargin: e.target.value as Settings['pageMargin'] })}>
                <option value="normal">Normal</option>
                <option value="narrow">Narrow</option>
                <option value="wide">Wide</option>
              </select>
            </label>
            <label className="rb-label">
              Orientation
              <select
                className="rb-select"
                value={p.settings.pageOrientation}
                onChange={(e) => p.onSettings({ pageOrientation: e.target.value as Settings['pageOrientation'] })}
              >
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </select>
            </label>
            <label className="rb-label">
              Size
              <select className="rb-select" value={p.settings.pageSize} onChange={(e) => p.onSettings({ pageSize: e.target.value as Settings['pageSize'] })}>
                <option value="A4">A4</option>
                <option value="Letter">Letter</option>
              </select>
            </label>
            <label className="rb-label check">
              <input type="checkbox" checked={p.settings.showLetterhead} onChange={(e) => p.onSettings({ showLetterhead: e.target.checked })} />
              Letterhead
            </label>
            <label className="rb-label check">
              <input
                type="checkbox"
                checked={p.settings.showSignatureBlock}
                onChange={(e) => p.onSettings({ showSignatureBlock: e.target.checked })}
              />
              Signature block
            </label>
            <Sep />
            <Btn wide title="Print the report" onClick={p.onPrint}>
              <Printer size={16} /> Print
            </Btn>
            <Btn wide title="Save the report as PDF" onClick={p.onPdf}>
              <FileDown size={16} /> PDF
            </Btn>
          </>
        )}

        {tab === 'view' && (
          <>
            <Btn wide title="Simple view" active={p.view === 'simple'} onClick={() => p.onView('simple')}>
              <FileText size={16} /> Simple View
            </Btn>
            <Btn wide title="Print layout (page view)" active={p.view === 'print'} onClick={() => p.onView('print')}>
              <Printer size={16} /> Print Layout
            </Btn>
            <label className="rb-label">
              Zoom
              <select className="rb-select" value={p.zoom} onChange={(e) => p.onZoom(Number(e.target.value))}>
                {[75, 90, 100, 110, 125, 150, 175].map((z) => (
                  <option key={z} value={z}>
                    {z}%
                  </option>
                ))}
              </select>
            </label>
            <Btn wide title="Full screen (F11)" active={p.fullScreen} onClick={p.onToggleFullScreen}>
              <Maximize size={16} /> Full Screen
            </Btn>
            <Btn wide title="Show/Hide paragraph marks" active={p.showMarks} onClick={p.onToggleMarks}>
              <Pilcrow size={16} /> Marks
            </Btn>
            <Btn wide title="Report version history" onClick={p.onHistory}>
              <History size={16} /> History
            </Btn>
          </>
        )}

        {tab === 'templates' && (
          <>
            <Btn wide title="Save the current report text as a new template" onClick={p.onSaveAsTemplate}>
              <BookPlus size={16} /> Save as template
            </Btn>
            <Btn wide title="Create, edit or delete templates" onClick={() => p.onManage('templates')}>
              <BookText size={16} /> Manage templates
            </Btn>
            <Btn wide title="Create, edit or delete macros" onClick={() => p.onManage('macros')}>
              <Zap size={16} /> Manage macros
            </Btn>
            <span className="rb-hint">Macros: type .code then Space (e.g. .nad), or the code then F3.</span>
          </>
        )}
      </div>
    </div>
  )
}
