import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { insertDictatedText, parseUtterance } from '../renderer/src/ris/dictation'
import { insertMacroText } from '../renderer/src/ris/editor'
import { store } from './db'
import { Dictation } from './native'

export type DictPhase = 'off' | 'starting' | 'listening'

/**
 * Mic button for the report: Android's speech recognition, with the same voice commands
 * ("full stop", "new paragraph", "macro …", "delete that" …) and corrections list as the PC.
 */
export function useDictation(
  editor: Editor | null,
  opts: { onTemplate: (name: string) => boolean; onError: (msg: string) => void; onStop?: () => void }
) {
  const [phase, setPhase] = useState<DictPhase>('off')
  const [partial, setPartial] = useState('')
  const phaseRef = useRef<DictPhase>('off')
  phaseRef.current = phase
  const optsRef = useRef(opts)
  optsRef.current = opts
  const editorRef = useRef(editor)
  editorRef.current = editor

  useEffect(() => {
    const handles: Promise<PluginListenerHandle>[] = []
    handles.push(Dictation.addListener('partial', (e) => setPartial(e.text)))
    handles.push(
      Dictation.addListener('final', (e) => {
        setPartial('')
        const ed = editorRef.current
        if (!ed || !ed.isEditable || phaseRef.current === 'off') return
        const st = store.meta.settings
        const actions = parseUtterance(e.text, { commands: st.dictationCommands, replacements: st.dictationReplacements })
        for (const a of actions) {
          if (a.type === 'text') insertDictatedText(ed, a.text, false)
          else if (a.type === 'enter') for (let i = 0; i < a.count; i++) ed.chain().enter().scrollIntoView().run()
          else if (a.type === 'undo') ed.chain().undo().run()
          else if (a.type === 'stop') void stop()
          else if (a.type === 'macro') {
            const m = store.liveMacros().find((x) => x.code.toLowerCase() === a.code)
            if (!m) optsRef.current.onError(`No macro ".${a.code}"`)
            else if (m.text.includes('\n')) insertMacroText(ed, m.text)
            else insertDictatedText(ed, m.text, false)
          } else if (a.type === 'template') {
            if (!optsRef.current.onTemplate(a.name)) optsRef.current.onError(`No template matching "${a.name}"`)
          }
        }
      })
    )
    handles.push(
      Dictation.addListener('state', (e) => {
        if (e.listening && phaseRef.current === 'starting') setPhase('listening')
        if (!e.listening && phaseRef.current !== 'off' && phaseRef.current !== 'starting') {
          // The plugin keeps listening by itself; "not listening" means it stopped for good.
          setPhase('off')
          setPartial('')
        }
      })
    )
    handles.push(
      Dictation.addListener('error', (e) => {
        if (e.fatal) {
          setPhase('off')
          setPartial('')
          optsRef.current.onError(e.message)
        }
      })
    )
    return () => {
      for (const h of handles) void h.then((x) => x.remove())
      if (phaseRef.current !== 'off') void Dictation.stop().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const start = async () => {
    const ed = editorRef.current
    if (!ed || !ed.isEditable) return
    try {
      const av = await Dictation.available()
      if (!av.available) {
        optsRef.current.onError(
          'Speech recognition is not available on this phone. Install or update the “Speech Recognition & Synthesis” / Google app, or use the microphone on the keyboard.'
        )
        return
      }
      // Dictate at the cursor; without one, at the end of the report.
      if (!ed.isFocused && ed.state.selection.from <= 1) ed.commands.setTextSelection(ed.state.doc.content.size)
      setPhase('starting')
      const prefs = store.meta.prefs
      await Dictation.start({ language: prefs.language, preferOffline: prefs.preferOffline })
      setPhase((p) => (p === 'starting' ? 'listening' : p))
    } catch (e) {
      setPhase('off')
      optsRef.current.onError(String((e as Error)?.message ?? e))
    }
  }

  const stop = async () => {
    setPhase('off')
    setPartial('')
    try {
      await Dictation.stop()
    } catch {
      /* ignore */
    }
    optsRef.current.onStop?.()
  }

  return { phase, partial, start, stop, toggle: () => (phaseRef.current === 'off' ? start() : stop()) }
}
