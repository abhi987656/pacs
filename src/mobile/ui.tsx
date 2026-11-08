import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export interface SheetAction {
  label: string
  hint?: string
  danger?: boolean
  onSelect: () => void
}

interface Dialog {
  title: string
  body?: ReactNode
  buttons: { label: string; kind?: 'primary' | 'danger'; value: string }[]
  resolve: (v: string | null) => void
}

interface UiApi {
  toast(text: string, kind?: 'info' | 'success' | 'error'): void
  sheet(title: string, actions: SheetAction[]): void
  confirm(title: string, body: ReactNode, okLabel?: string, danger?: boolean): Promise<boolean>
  choose(title: string, body: ReactNode, buttons: Dialog['buttons']): Promise<string | null>
}

const Ctx = createContext<UiApi | null>(null)

export function useUi(): UiApi {
  const v = useContext(Ctx)
  if (!v) throw new Error('UiProvider missing')
  return v
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: string }[]>([])
  const [sheet, setSheet] = useState<{ title: string; actions: SheetAction[] } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const idRef = useRef(0)

  const toast = useCallback((text: string, kind: 'info' | 'success' | 'error' = 'info') => {
    const id = ++idRef.current
    setToasts((t) => [...t.slice(-2), { id, text, kind }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3200)
  }, [])

  const choose = useCallback(
    (title: string, body: ReactNode, buttons: Dialog['buttons']) =>
      new Promise<string | null>((resolve) => setDialog({ title, body, buttons, resolve })),
    []
  )

  const api = useMemo<UiApi>(
    () => ({
      toast,
      sheet: (title, actions) => setSheet({ title, actions }),
      confirm: async (title, body, okLabel = 'OK', danger = false) =>
        (await choose(title, body, [
          { label: 'Cancel', value: 'no' },
          { label: okLabel, value: 'yes', kind: danger ? 'danger' : 'primary' }
        ])) === 'yes',
      choose
    }),
    [toast, choose]
  )

  const closeDialog = (v: string | null) => {
    dialog?.resolve(v)
    setDialog(null)
  }

  return (
    <Ctx.Provider value={api}>
      {children}
      {sheet && (
        <div className="m-backdrop" onClick={() => setSheet(null)}>
          <div className="m-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="m-sheet-grip" />
            <div className="m-sheet-title">{sheet.title}</div>
            {sheet.actions.map((a, i) => (
              <button
                key={i}
                className={`m-sheet-item ${a.danger ? 'danger' : ''}`}
                onClick={() => {
                  setSheet(null)
                  a.onSelect()
                }}
              >
                <span>{a.label}</span>
                {a.hint && <small>{a.hint}</small>}
              </button>
            ))}
            <button className="m-sheet-item cancel" onClick={() => setSheet(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {dialog && (
        <div className="m-backdrop center" onClick={() => closeDialog(null)}>
          <div className="m-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="m-dialog-title">{dialog.title}</div>
            {dialog.body && <div className="m-dialog-body">{dialog.body}</div>}
            <div className="m-dialog-buttons">
              {dialog.buttons.map((b) => (
                <button key={b.value} className={`m-btn ${b.kind === 'primary' ? 'primary' : b.kind === 'danger' ? 'danger' : 'plain'}`} onClick={() => closeDialog(b.value)}>
                  {b.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      <div className="m-toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`m-toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  )
}

/** Full-screen page with a top bar (title, back button, actions) and scrollable body. */
export function Page({
  title,
  subtitle,
  onBack,
  actions,
  children,
  footer,
  className = ''
}: {
  title: ReactNode
  subtitle?: ReactNode
  onBack?: () => void
  actions?: ReactNode
  children: ReactNode
  footer?: ReactNode
  className?: string
}) {
  return (
    <div className={`m-page ${className}`}>
      <header className="m-topbar">
        {onBack && (
          <button className="m-icon-btn" onClick={onBack} aria-label="Back">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
        )}
        <div className="m-topbar-title">
          <div className="m-title">{title}</div>
          {subtitle && <div className="m-subtitle">{subtitle}</div>}
        </div>
        <div className="m-topbar-actions">{actions}</div>
      </header>
      <div className="m-body">{children}</div>
      {footer && <footer className="m-footer">{footer}</footer>}
    </div>
  )
}
