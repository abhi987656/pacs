import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { FileText, ListChecks, Settings as SettingsIcon, Zap } from 'lucide-react'
import { store, useStore } from './db'
import { sync } from './sync'
import { onAppPause, onAppResume, onBackButton } from './native'
import { UiProvider } from './ui'
import { PairScreen } from './screens/PairScreen'
import { CasesScreen } from './screens/CasesScreen'
import { ReportScreen } from './screens/ReportScreen'
import { CaseForm } from './screens/CaseForm'
import { TemplatesScreen, TemplateEditor } from './screens/TemplatesScreen'
import { MacrosScreen } from './screens/MacrosScreen'
import { SettingsScreen } from './screens/SettingsScreen'

export type Route =
  | { name: 'cases' }
  | { name: 'report'; id: string }
  | { name: 'case-form'; id?: string; thenReport?: boolean }
  | { name: 'templates' }
  | { name: 'template'; id?: string }
  | { name: 'macros' }
  | { name: 'settings' }
  | { name: 'pair' }

export interface Nav {
  push(r: Route): void
  replace(r: Route): void
  back(): void
  tab(r: Route): void
}

const TABS: { route: Route; label: string; icon: typeof FileText }[] = [
  { route: { name: 'cases' }, label: 'Cases', icon: ListChecks },
  { route: { name: 'templates' }, label: 'Templates', icon: FileText },
  { route: { name: 'macros' }, label: 'Macros', icon: Zap },
  { route: { name: 'settings' }, label: 'Settings', icon: SettingsIcon }
]

/** Screens can register a "leave guard" (e.g. the report saves itself before closing). */
export const leaveGuards = new Set<() => Promise<void> | void>()

export function useSyncStatus() {
  return useSyncExternalStore(sync.subscribe, sync.getStatus)
}

function Shell() {
  useStore()
  const [stack, setStack] = useState<Route[]>(() => [store.meta.pairing ? { name: 'cases' } : { name: 'pair' }])
  const stackRef = useRef(stack)
  stackRef.current = stack

  const runGuards = async () => {
    for (const g of [...leaveGuards]) await g()
  }

  const nav: Nav = {
    push: (r) => void runGuards().then(() => setStack((s) => [...s, r])),
    replace: (r) => void runGuards().then(() => setStack((s) => [...s.slice(0, -1), r])),
    back: () => void runGuards().then(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))),
    tab: (r) => void runGuards().then(() => setStack([r]))
  }
  const navRef = useRef(nav)
  navRef.current = nav

  // Android back button: close the current screen; on a main tab go back to Cases, then leave the app.
  useEffect(
    () =>
      onBackButton(() => {
        const s = stackRef.current
        const closers = document.querySelectorAll<HTMLElement>('[data-close]')
        if (closers.length) {
          closers[closers.length - 1].click()
          return true
        }
        if (document.querySelector('.m-backdrop')) {
          ;(document.querySelector('.m-backdrop') as HTMLElement).click()
          return true
        }
        if (s.length > 1) {
          navRef.current.back()
          return true
        }
        if (s[0].name !== 'cases' && s[0].name !== 'pair') {
          navRef.current.tab({ name: 'cases' })
          return true
        }
        return false
      }),
    []
  )

  const route = stack[stack.length - 1]
  const isTab = stack.length === 1 && TABS.some((t) => t.route.name === route.name)

  let screen
  switch (route.name) {
    case 'pair':
      screen = <PairScreen nav={nav} canCancel={!!store.meta.pairing} />
      break
    case 'cases':
      screen = <CasesScreen nav={nav} />
      break
    case 'report':
      screen = <ReportScreen key={route.id} nav={nav} studySyncId={route.id} />
      break
    case 'case-form':
      screen = <CaseForm nav={nav} studySyncId={route.id} thenReport={route.thenReport} />
      break
    case 'templates':
      screen = <TemplatesScreen nav={nav} />
      break
    case 'template':
      screen = <TemplateEditor key={route.id ?? 'new'} nav={nav} syncId={route.id} />
      break
    case 'macros':
      screen = <MacrosScreen nav={nav} />
      break
    case 'settings':
      screen = <SettingsScreen nav={nav} />
      break
  }

  return (
    <div className="m-app">
      <div className="m-screen">{screen}</div>
      {isTab && (
        <nav className="m-tabs">
          {TABS.map((t) => {
            const Icon = t.icon
            const active = t.route.name === route.name
            return (
              <button key={t.label} className={`m-tab ${active ? 'active' : ''}`} onClick={() => nav.tab(t.route)}>
                <Icon size={20} />
                <span>{t.label}</span>
              </button>
            )
          })}
        </nav>
      )}
    </div>
  )
}

export function App() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const kick = useCallback(() => void sync.sync(), [])

  useEffect(() => {
    void store
      .open()
      .then(() => {
        sync.init()
        setReady(true)
        kick()
      })
      .catch((e) => setError(String((e as Error)?.message ?? e)))
  }, [kick])

  // Sync when the app comes back to the screen, every minute while open, and soon after local edits.
  useEffect(() => {
    if (!ready) return
    const offResume = onAppResume(kick)
    const offPause = onAppPause(() => {
      for (const g of [...leaveGuards]) void g()
    })
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') kick()
    }, 60_000)
    let pending: ReturnType<typeof setTimeout> | null = null
    let lastCount = store.pendingCount()
    const off = store.subscribe(() => {
      const n = store.pendingCount()
      if (n > lastCount) {
        if (pending) clearTimeout(pending)
        pending = setTimeout(kick, 4000)
      }
      lastCount = n
    })
    return () => {
      offResume()
      offPause()
      off()
      clearInterval(timer)
      if (pending) clearTimeout(pending)
    }
  }, [ready, kick])

  if (error) return <div className="m-fatal">Could not open the app's storage: {error}</div>
  if (!ready) return <div className="m-loading">Personal PACS</div>
  return (
    <UiProvider>
      <Shell />
    </UiProvider>
  )
}
