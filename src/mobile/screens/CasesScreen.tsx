import { useMemo, useState } from 'react'
import { Plus, RefreshCw, Search } from 'lucide-react'
import { formatAge, formatDicomDate, formatSex, STATUS_LABEL, todayDicom } from '@shared/format'
import type { Nav } from '../App'
import { useSyncStatus } from '../App'
import { store, useStore } from '../db'
import type { LocalStudy } from '../db'
import { sync } from '../sync'
import { Page } from '../ui'

type Filter = 'todo' | 'all' | 'today'

export function SyncPill() {
  useStore()
  const st = useSyncStatus()
  const pending = store.pendingCount()
  const last = store.meta.lastSync
  let label: string
  let cls: string
  if (st.phase === 'unpaired') {
    label = 'Not paired'
    cls = 'warn'
  } else if (st.phase === 'syncing') {
    label = 'Syncing…'
    cls = 'busy'
  } else if (st.phase === 'offline') {
    label = pending ? `PC not found · ${pending} to send` : 'PC not found'
    cls = 'off'
  } else if (st.phase === 'error') {
    label = 'Sync problem'
    cls = 'err'
  } else if (pending) {
    label = `${pending} to send`
    cls = 'warn'
  } else {
    label = last?.ok ? `Synced ${ago(last.at)}` : 'Synced'
    cls = 'ok'
  }
  return (
    <button className={`m-pill ${cls}`} onClick={() => void sync.sync({ manual: true })} title={st.message}>
      <RefreshCw size={13} className={st.phase === 'syncing' ? 'spin' : ''} />
      {label}
    </button>
  )
}

export function ago(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  if (s < 50) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

export function caseLine(s: LocalStudy): string {
  return [formatAge(s.age, s.birthDate, s.studyDate), formatSex(s.sex)].filter(Boolean).join(' / ')
}

export function CasesScreen({ nav }: { nav: Nav }) {
  useStore()
  const st = useSyncStatus()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<Filter>('todo')

  const list = useMemo(() => {
    const text = q.trim().toLowerCase()
    const today = todayDicom()
    return [...store.studies.values()]
      .filter((s) => s.listed || s.isNew)
      .filter((s) => (filter === 'todo' ? s.reportStatus !== 'FINAL' : filter === 'today' ? s.studyDate === today || s.importedAt.slice(0, 10) === new Date().toISOString().slice(0, 10) : true))
      .filter(
        (s) =>
          !text ||
          [s.patientName, s.patientId, s.accession, s.description].some((x) => x.toLowerCase().includes(text))
      )
      .sort((a, b) => (b.studyDate + b.studyTime).localeCompare(a.studyDate + a.studyTime) || b.importedAt.localeCompare(a.importedAt))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, filter, store.version])

  const pairing = store.meta.pairing

  return (
    <Page title="Cases" subtitle={pairing ? pairing.pcName : undefined} actions={<SyncPill />}>
      <div className="m-search">
        <Search size={16} />
        <input placeholder="Name, CR No, PG No, study…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="m-chips">
        {(
          [
            ['todo', 'To report'],
            ['today', 'Today'],
            ['all', 'All']
          ] as [Filter, string][]
        ).map(([k, label]) => (
          <button key={k} className={`m-chip ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>
            {label}
          </button>
        ))}
      </div>
      {(st.phase === 'offline' || st.phase === 'error') && st.message && <div className="m-banner">{st.message}</div>}
      <div className="m-list">
        {list.length === 0 && (
          <div className="m-empty">
            {store.studies.size === 0
              ? 'No cases yet. They appear here after syncing with the PC – or tap + to start a new case.'
              : 'No cases match.'}
          </div>
        )}
        {list.map((s) => {
          const rep = store.reports.get(s.syncId)
          const unsent = s.isNew || s.dirtyFields.length > 0 || !!rep?.dirty
          return (
            <button key={s.syncId} className="m-case" onClick={() => nav.push({ name: 'report', id: s.syncId })}>
              <div className="m-case-main">
                <div className="m-case-name">
                  {s.patientName || '(no name)'} <span className="m-muted">{caseLine(s)}</span>
                </div>
                <div className="m-case-sub">
                  {s.description || s.modalities || 'Study'} · {formatDicomDate(s.studyDate)}
                </div>
                <div className="m-case-ids">
                  {s.patientId && <span>CR {s.patientId}</span>}
                  {s.accession && <span>PG {s.accession}</span>}
                </div>
              </div>
              <div className="m-case-side">
                <span className={`m-badge st-${s.reportStatus}`}>{STATUS_LABEL[s.reportStatus] ?? s.reportStatus}</span>
                {s.numImages === 0 && <span className="m-badge noimg">no images</span>}
                {unsent && <span className="m-dot" title="Not yet sent to the PC" />}
              </div>
            </button>
          )
        })}
      </div>
      <button className="m-fab" onClick={() => nav.push({ name: 'case-form', thenReport: true })} aria-label="New case">
        <Plus size={26} />
      </button>
    </Page>
  )
}
