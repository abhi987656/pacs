import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

// ------------------------------------------------------------------ modal dialogs

interface DialogButton<T> {
  label: string
  value: T
  kind?: 'primary' | 'danger' | 'default'
}

interface DialogRequest {
  title: string
  message?: ReactNode
  buttons: DialogButton<unknown>[]
  input?: { label: string; value: string; placeholder?: string; multiline?: boolean }
  resolve: (v: unknown) => void
}

interface UiContextValue {
  ask<T>(title: string, message: ReactNode, buttons: DialogButton<T>[]): Promise<T | null>
  confirm(title: string, message?: ReactNode, okLabel?: string, danger?: boolean): Promise<boolean>
  prompt(title: string, label: string, initial?: string, placeholder?: string): Promise<string | null>
  toast(text: string, kind?: 'info' | 'error' | 'success'): void
}

const UiContext = createContext<UiContextValue | null>(null)

export function useUi(): UiContextValue {
  const v = useContext(UiContext)
  if (!v) throw new Error('UiProvider missing')
  return v
}

interface Toast {
  id: number
  text: string
  kind: 'info' | 'error' | 'success'
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogRequest | null>(null)
  const [inputValue, setInputValue] = useState('')
  const [toasts, setToasts] = useState<Toast[]>([])
  const toastId = useRef(1)

  const ask = useCallback(<T,>(title: string, message: ReactNode, buttons: DialogButton<T>[]) => {
    return new Promise<T | null>((resolve) => {
      setDialog({ title, message, buttons: buttons as DialogButton<unknown>[], resolve: resolve as (v: unknown) => void })
    })
  }, [])

  const confirm = useCallback(
    async (title: string, message?: ReactNode, okLabel = 'OK', danger = false) => {
      const r = await ask<boolean>(title, message, [
        { label: 'Cancel', value: false },
        { label: okLabel, value: true, kind: danger ? 'danger' : 'primary' }
      ])
      return r === true
    },
    [ask]
  )

  const prompt = useCallback((title: string, label: string, initial = '', placeholder = '') => {
    setInputValue(initial)
    return new Promise<string | null>((resolve) => {
      setDialog({
        title,
        buttons: [
          { label: 'Cancel', value: null },
          { label: 'OK', value: '__input__', kind: 'primary' }
        ],
        input: { label, value: initial, placeholder },
        resolve: resolve as (v: unknown) => void
      })
    })
  }, [])

  const toast = useCallback((text: string, kind: 'info' | 'error' | 'success' = 'info') => {
    const id = toastId.current++
    setToasts((t) => [...t, { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3000)
  }, [])

  const close = (value: unknown) => {
    if (!dialog) return
    const v = value === '__input__' ? inputValue : value
    dialog.resolve(v)
    setDialog(null)
  }

  const value = useMemo(() => ({ ask, confirm, prompt, toast }), [ask, confirm, prompt, toast])

  return (
    <UiContext.Provider value={value}>
      {children}
      {dialog && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close(null)}>
          <div className="modal" role="dialog" aria-label={dialog.title}>
            <div className="modal-title">{dialog.title}</div>
            {dialog.message && <div className="modal-body">{dialog.message}</div>}
            {dialog.input && (
              <div className="modal-body">
                <label className="field">
                  <span>{dialog.input.label}</span>
                  <input
                    autoFocus
                    value={inputValue}
                    placeholder={dialog.input.placeholder}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') close('__input__')
                      if (e.key === 'Escape') close(null)
                    }}
                  />
                </label>
              </div>
            )}
            <div className="modal-buttons">
              {dialog.buttons.map((b, i) => (
                <button
                  key={i}
                  className={`btn ${b.kind === 'primary' ? 'btn-green' : b.kind === 'danger' ? 'btn-red' : ''}`}
                  autoFocus={!dialog.input && b.kind === 'primary'}
                  onClick={() => close(b.value)}
                >
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </UiContext.Provider>
  )
}

// ------------------------------------------------------------------ misc hooks

export function useEvent<T extends unknown[]>(subscribe: (cb: (...a: T) => void) => () => void, handler: (...a: T) => void) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => subscribe((...a: T) => ref.current(...a)), [subscribe])
}

/** A floating panel (non-modal) used for find/replace and similar tools. */
export function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="float-panel">
      <div className="float-panel-title">
        <span>{title}</span>
        <button className="icon-btn" onClick={onClose} title="Close">
          ×
        </button>
      </div>
      <div className="float-panel-body">{children}</div>
    </div>
  )
}

/** Generic modal shell for larger custom dialogs. */
export function Modal({
  title,
  onClose,
  children,
  wide,
  footer
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
  footer?: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-label={title}>
        <div className="modal-title">
          <span>{title}</span>
          <button className="icon-btn modal-x" onClick={onClose} title="Close">
            ×
          </button>
        </div>
        <div className="modal-content">{children}</div>
        {footer && <div className="modal-buttons">{footer}</div>}
      </div>
    </div>
  )
}
