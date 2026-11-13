import { useCallback, useEffect, useRef, useState } from 'react'
import { ClipboardList, FileText, Settings as SettingsIcon, BookText } from 'lucide-react'
import logoMark from '../assets/logo-mark.png'
import type { Settings, StudyFilter } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useEvent, useUi } from '../common/ui'
import { ReceiveCenter } from './Sharing'
import { speller } from './spell/speller'
import { spellLangs } from './spell/protocol'
import type { ReceiveCenterHandle } from './Sharing'
import { Worklist } from './Worklist'
import { ReportPage } from './ReportPage'
import type { ReportPageHandle } from './ReportPage'
import { SettingsPage } from './SettingsPage'
import { TemplatesPage } from './TemplatesPage'

export type Page =
  | { name: 'worklist' }
  | { name: 'report'; studyId: number }
  | { name: 'settings' }
  | { name: 'templates'; tab?: 'templates' | 'macros' }

const api = window.api

export function App() {
  const ui = useUi()
  const [page, setPage] = useState<Page>({ name: 'worklist' })
  const [filter, setFilter] = useState<StudyFilter>({ status: '', modality: '', text: '' })
  const [studyOrder, setStudyOrder] = useState<number[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const reportRef = useRef<ReportPageHandle>(null)
  const receiveRef = useRef<ReceiveCenterHandle>(null)

  useEffect(() => {
    void api.getSettings().then((s) => {
      setSettings(s)
      setSettingsLoaded(true)
    })
  }, [])

  // Spell checking in the report editor (Settings › Spelling).
  useEffect(() => {
    if (!settingsLoaded) return
    let stale = false
    void api.spellWords().then((words) => {
      if (!stale) speller.configure({ enabled: settings.spellCheck, langs: spellLangs(settings.spellLanguage), words })
    })
    return () => {
      stale = true
    }
  }, [settingsLoaded, settings.spellCheck, settings.spellLanguage])
  useEvent(api.onSpellWordsChanged, (words: string[]) => speller.syncWords(words))

  /** Navigate, but give an open report the chance to save unsaved changes first. */
  const navigate = useCallback(
    async (next: Page) => {
      if (page.name === 'report' && reportRef.current) {
        const ok = await reportRef.current.confirmLeave()
        if (!ok) return
      }
      setPage(next)
    },
    [page]
  )

  const openReport = useCallback(
    async (studyId: number, withImages = settings.autoOpenViewer) => {
      await navigate({ name: 'report', studyId })
      if (withImages) void api.openViewer(studyId)
    },
    [navigate, settings.autoOpenViewer]
  )

  // "Report" button pressed in the viewer window.
  useEvent(api.onOpenReport, (studyId: number) => {
    if (page.name === 'report' && page.studyId === studyId) return
    void openReport(studyId, false)
  })

  useEvent(api.onKeyImage, () => {
    if (page.name !== 'report') ui.toast('Open a report first to add key images.', 'info')
  })

  useEvent(api.onReportHtml, () => {
    if (page.name !== 'report') ui.toast('Open a report first to add the results.', 'info')
  })

  useEvent(api.onToggleDictation, () => {
    if (page.name !== 'report') ui.toast('Open a report to dictate (F4).', 'info')
  })

  // Case sharing: a personalpacs:// link opened the app, and second opinions sent back to us.
  useEffect(() => {
    void api.takeShareLink().then((link) => link && receiveRef.current?.open(link))
  }, [])
  useEvent(api.onShareLink, (link: string) => receiveRef.current?.open(link))
  useEvent(api.onShareEvent, (e) => {
    if (e.type === 'opinion') ui.toast(`${e.fromName} sent their report on ${e.title}. Open the case to read it.`, 'success')
  })

  const rail = [
    { key: 'worklist', icon: <ClipboardList size={20} />, label: 'Worklist', go: () => navigate({ name: 'worklist' }) },
    {
      key: 'report',
      icon: <FileText size={20} />,
      label: 'Report',
      go: () => {
        if (page.name !== 'report') ui.toast('Choose a study in the worklist and click Report.', 'info')
      }
    },
    { key: 'templates', icon: <BookText size={20} />, label: 'Templates & macros', go: () => navigate({ name: 'templates' }) },
    { key: 'settings', icon: <SettingsIcon size={20} />, label: 'Settings', go: () => navigate({ name: 'settings' }) }
  ]

  return (
    <div className="app">
      <nav className="rail">
        <div className="rail-logo" title="Personal PACS">
          <img src={logoMark} alt="Personal PACS" width={34} height={34} />
        </div>
        {rail.map((r) => (
          <button
            key={r.key}
            className={`rail-btn ${page.name === r.key ? 'active' : ''}`}
            title={r.label}
            onClick={() => void r.go()}
          >
            {r.icon}
          </button>
        ))}
      </nav>
      <div className="app-main">
        {page.name === 'worklist' && (
          <Worklist
            filter={filter}
            onFilterChange={setFilter}
            onOrderChange={setStudyOrder}
            onOpenReport={(id) => void openReport(id)}
            onOpenImages={(id) => void api.openViewer(id)}
            onReceive={() => receiveRef.current?.open()}
            settings={settings}
          />
        )}
        {page.name === 'report' && (
          <ReportPage
            key={page.studyId}
            ref={reportRef}
            studyId={page.studyId}
            studyOrder={studyOrder}
            settings={settings}
            onSettingsChange={setSettings}
            onBack={() => void navigate({ name: 'worklist' })}
            onOpenStudy={(id) => void openReport(id)}
            onManageTemplates={(tab) => void navigate({ name: 'templates', tab })}
          />
        )}
        {page.name === 'settings' && <SettingsPage settings={settings} onSaved={setSettings} />}
        {page.name === 'templates' && <TemplatesPage initialTab={page.tab ?? 'templates'} settings={settings} />}
      </div>
      <ReceiveCenter ref={receiveRef} onOpenCase={(id) => void openReport(id)} />
    </div>
  )
}
