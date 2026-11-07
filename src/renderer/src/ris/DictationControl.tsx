import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { Download, Mic, MicOff, Trash, X } from 'lucide-react'
import type { Macro, Settings, SpeechEvent, SpeechModelId, SpeechStatus, Template } from '@shared/types'
import { Modal, useEvent, useUi } from '../common/ui'
import { insertMacroText } from './editor'
import { insertDictatedText, MicCapture, micErrorMessage, parseUtterance } from './dictation'

const api = window.api

// ------------------------------------------------------------------ model list (used here and in Settings)

export function SpeechModelsPanel({
  selected,
  onSelect,
  onInstalled
}: {
  selected: SpeechModelId
  onSelect: (id: SpeechModelId) => void
  onInstalled?: (id: SpeechModelId) => void
}) {
  const ui = useUi()
  const [status, setStatus] = useState<SpeechStatus | null>(null)

  useEffect(() => {
    void api.speechStatus().then(setStatus)
  }, [])
  useEvent(api.onSpeechEvent, (e: SpeechEvent) => {
    if (e.type === 'status') setStatus(e.status)
  })

  const install = async (id: SpeechModelId) => {
    try {
      await api.speechInstall(id)
      ui.toast('Speech model installed', 'success')
      onSelect(id)
      onInstalled?.(id)
    } catch (e) {
      const msg = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      if (!/cancel/i.test(msg)) ui.toast(`Download failed: ${msg}`, 'error')
    }
  }

  const remove = async (id: SpeechModelId) => {
    if (await ui.confirm('Remove speech model?', 'It can be downloaded again later.', 'Remove', true)) await api.speechRemove(id)
  }

  if (!status) return <p className="muted">Checking…</p>
  return (
    <div className="speech-models">
      {status.models.map((m) => {
        const installing = status.install?.modelId === m.id ? status.install : null
        return (
          <label key={m.id} className={`speech-model ${selected === m.id ? 'selected' : ''}`}>
            <input type="radio" name="speech-model" checked={selected === m.id} onChange={() => onSelect(m.id)} />
            <div className="speech-model-text">
              <b>{m.name}</b>
              <span className="muted small">{m.description}</span>
              {installing && (
                <div className="progress">
                  <div style={{ width: `${Math.round(installing.progress * 100)}%` }} />
                </div>
              )}
              {installing && (
                <span className="small">Downloading and unpacking… {Math.round(installing.progress * 100)}% – you can keep working.</span>
              )}
            </div>
            <div className="speech-model-actions">
              {m.installed ? (
                <>
                  <span className="badge st-FINAL">Installed</span>
                  <button className="icon-btn" title="Remove" onClick={(e) => (e.preventDefault(), void remove(m.id))}>
                    <Trash size={15} />
                  </button>
                </>
              ) : installing ? (
                <button className="btn btn-small" onClick={(e) => (e.preventDefault(), void api.speechCancelInstall())}>
                  <X size={14} /> Cancel
                </button>
              ) : (
                <button className="btn btn-small btn-green" disabled={!!status.install} onClick={(e) => (e.preventDefault(), void install(m.id))}>
                  <Download size={14} /> Download {m.downloadMB} MB
                </button>
              )}
            </div>
          </label>
        )
      })}
      {status.error && <p className="error-text">{status.error}</p>}
    </div>
  )
}

// ------------------------------------------------------------------ dictation button + engine

interface Props {
  editor: Editor
  settings: Settings
  onSettingsChange: (s: Settings) => void
  readOnly: boolean
  macros: Macro[]
  templates: Template[]
  onTemplate: (t: Template) => void
}

type Phase = 'off' | 'starting' | 'listening'

export function DictationControl(p: Props) {
  const ui = useUi()
  const [phase, setPhase] = useState<Phase>('off')
  const [speaking, setSpeaking] = useState(false)
  const [pending, setPending] = useState(0)
  const [level, setLevel] = useState(0)
  const [heard, setHeard] = useState('')
  const [setup, setSetup] = useState(false)
  const [loadingModel, setLoadingModel] = useState(false)
  const mic = useRef(new MicCapture())
  const phaseRef = useRef<Phase>('off')
  phaseRef.current = phase
  const propsRef = useRef(p)
  propsRef.current = p

  const stop = useCallback(async () => {
    mic.current.stop()
    setLevel(0)
    setSpeaking(false)
    if (phaseRef.current !== 'off') {
      setPhase('off')
      api.dictationActive(false)
      await api.speechStop().catch(() => {})
    }
  }, [])

  const start = useCallback(async () => {
    const { settings, readOnly } = propsRef.current
    if (readOnly) {
      ui.toast('This report is signed off – reopen it to dictate.', 'info')
      return
    }
    const status = await api.speechStatus()
    const model = status.models.find((m) => m.id === settings.dictationModel)
    if (!model?.installed) {
      setSetup(true)
      return
    }
    setPhase('starting')
    try {
      if (status.loadedModel !== model.id) setLoadingModel(true)
      await api.speechStart(model.id, settings.dictationPauseMs)
      setLoadingModel(false)
      await mic.current.start(
        settings.dictationMicId,
        (samples) => api.speechAudio(samples),
        (rms) => setLevel(rms)
      )
      setPhase('listening')
      api.dictationActive(true)
      propsRef.current.editor.commands.focus()
    } catch (e) {
      setLoadingModel(false)
      mic.current.stop()
      setPhase('off')
      api.dictationActive(false)
      await api.speechStop().catch(() => {})
      const name = (e as { name?: string })?.name
      const msg = name ? micErrorMessage(e) : String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      ui.toast(msg, 'error')
    }
  }, [ui])

  const toggle = useCallback(() => {
    if (phaseRef.current === 'off') void start()
    else if (phaseRef.current === 'listening') void stop()
  }, [start, stop])

  // Stop when leaving the report.
  useEffect(() => () => void stop(), [stop])

  // F4 here, or F4 / mic button in the viewer window.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F4') {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggle])
  useEvent(api.onToggleDictation, () => toggle())

  useEvent(api.onSpeechEvent, (e: SpeechEvent) => {
    const { editor, settings, macros, templates, onTemplate } = propsRef.current
    if (e.type === 'speaking') setSpeaking(e.speaking)
    else if (e.type === 'pending') setPending(e.count)
    else if (e.type === 'status' && e.status.engine === 'error' && phaseRef.current !== 'off') {
      ui.toast(e.status.error ?? 'Dictation stopped because of an error.', 'error')
      void stop()
    } else if (e.type === 'text') {
      setHeard(e.text)
      if (!editor.isEditable) return
      const actions = parseUtterance(e.text, { commands: settings.dictationCommands, replacements: settings.dictationReplacements })
      for (const a of actions) {
        if (a.type === 'text') insertDictatedText(editor, a.text)
        else if (a.type === 'enter') for (let i = 0; i < a.count; i++) editor.chain().focus().enter().run()
        else if (a.type === 'undo') editor.chain().focus().undo().run()
        else if (a.type === 'stop') void stop()
        else if (a.type === 'macro') {
          const m = macros.find((x) => x.code.toLowerCase() === a.code)
          if (m) {
            if (m.text.includes('\n')) insertMacroText(editor, m.text)
            else insertDictatedText(editor, m.text)
          }
          else ui.toast(`No macro ".${a.code}"`, 'error')
        } else if (a.type === 'template') {
          const words = a.name.toLowerCase().split(/\s+/).filter(Boolean)
          const t = templates.find((x) => words.every((w) => x.name.toLowerCase().includes(w)))
          if (t) onTemplate(t)
          else ui.toast(`No template matching "${a.name}"`, 'error')
        }
      }
    }
  })

  const status =
    phase === 'starting'
      ? loadingModel
        ? 'Loading speech model…'
        : 'Starting microphone…'
      : phase === 'listening'
        ? speaking
          ? 'Hearing you…'
          : pending > 0
            ? 'Typing…'
            : 'Listening – speak now'
        : 'Dictate (F4)'

  return (
    <>
      <div className="dictation">
        <button
          className={`dict-btn ${phase !== 'off' ? 'on' : ''} ${speaking ? 'speaking' : ''}`}
          title="Dictation on/off (F4 – also works from the viewer)"
          disabled={p.readOnly && phase === 'off'}
          onClick={toggle}
        >
          {phase === 'off' ? <MicOff size={17} /> : <Mic size={17} />}
          <span>{status}</span>
        </button>
        {phase === 'listening' && (
          <div className="dict-level" title="Microphone level">
            <div style={{ width: `${Math.min(100, Math.round(Math.sqrt(level) * 220))}%` }} />
          </div>
        )}
      </div>
      {phase === 'listening' && heard && <div className="dict-heard" title="Last phrase recognised">“{heard}”</div>}
      {setup && (
        <Modal title="Set up dictation" onClose={() => setSetup(false)} wide>
          <p>
            Dictation runs <b>offline on this computer</b> – your voice never leaves it. It needs a speech-recognition model,
            downloaded once (internet needed only for this).
          </p>
          <SpeechModelsPanel
            selected={p.settings.dictationModel}
            onSelect={async (id) => {
              if (id !== p.settings.dictationModel) p.onSettingsChange(await api.saveSettings({ ...p.settings, dictationModel: id }))
            }}
            onInstalled={() => {
              setSetup(false)
              ui.toast('Dictation is ready – press F4 and start speaking.', 'success')
            }}
          />
        </Modal>
      )}
    </>
  )
}
