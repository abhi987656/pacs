import { useCallback, useEffect, useRef, useState } from 'react'
import { ClipboardList, FileText, Settings as SettingsIcon, BookText, Monitor } from 'lucide-react'
import type { Settings, StudyFilter } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useEvent, useUi } from '../common/ui'
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
  const reportRef = useRef<ReportPageHandle>(null)

  useEffect(() => {
    void api.getSettings().then(setSettings)
  }, [])

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

  useEvent(api.onToggleDictation, () => {
    if (page.name !== 'report') ui.toast('Open a report to dictate (F4).', 'info')
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
          <Monitor size={22} />
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
    </div>
  )
}
