import { Laptop, RefreshCw, Unlink } from 'lucide-react'
import type { Nav } from '../App'
import { useSyncStatus } from '../App'
import { store, useStore } from '../db'
import { sync } from '../sync'
import { ago } from './CasesScreen'
import { Page, useUi } from '../ui'

const LANGUAGES: [string, string][] = [
  ['en-IN', 'English (India)'],
  ['en-GB', 'English (UK)'],
  ['en-US', 'English (US)']
]

export function SettingsScreen({ nav }: { nav: Nav }) {
  useStore()
  const ui = useUi()
  const st = useSyncStatus()
  const p = store.meta.pairing
  const last = store.meta.lastSync
  const prefs = store.meta.prefs
  const s = store.meta.settings

  return (
    <Page title="Settings">
      <div className="m-pad">
        <section className="m-card">
          <h3>
            <Laptop size={16} /> PC
          </h3>
          {p ? (
            <>
              <div className="m-kv">
                <span>Paired with</span>
                <b>{p.pcName}</b>
              </div>
              <div className="m-kv">
                <span>Address</span>
                <b>{st.host ?? p.lastHost ?? p.hosts.join(', ')}</b>
              </div>
              <div className="m-kv">
                <span>Last sync</span>
                <b>{last ? `${ago(last.at)} ${last.ok ? '✓' : '– failed'}` : 'never'}</b>
              </div>
              <div className="m-kv">
                <span>Waiting to send</span>
                <b>{store.pendingCount()}</b>
              </div>
              {st.message && <div className={st.phase === 'idle' ? 'm-muted small' : 'm-error'}>{st.message}</div>}
              <div className="m-actions">
                <button className="m-btn primary grow" disabled={st.phase === 'syncing'} onClick={() => void sync.sync({ manual: true })}>
                  <RefreshCw size={16} className={st.phase === 'syncing' ? 'spin' : ''} /> Sync now
                </button>
              </div>
            </>
          ) : (
            <p className="m-muted">Not paired with a PC.</p>
          )}
          <div className="m-actions">
            <button className="m-btn plain grow" onClick={() => nav.push({ name: 'pair' })}>
              {p ? 'Pair again / another PC' : 'Pair with PC'}
            </button>
          </div>
        </section>

        <section className="m-card">
          <h3>Dictation</h3>
          <label className="m-field">
            <span>Language / accent</span>
            <select value={prefs.language} onChange={(e) => void store.setMeta('prefs', { ...prefs, language: e.target.value })}>
              {LANGUAGES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="m-check">
            <input type="checkbox" checked={prefs.preferOffline} onChange={(e) => void store.setMeta('prefs', { ...prefs, preferOffline: e.target.checked })} />
            Prefer offline recognition (audio stays on the phone when the offline English pack is installed)
          </label>
          <p className="m-muted small">
            Tap the mic in a report and speak. Voice commands {s.dictationCommands ? 'are on' : 'are off'} (set on the PC): “full stop”, “comma”,
            “new line”, “new paragraph”, “delete that”, “macro nad”, “template …”, “stop dictation”. Your PC's corrections list (
            {s.dictationReplacements.length}) is used here too.
          </p>
          <p className="m-muted small">
            For offline use: Android Settings › search “offline speech recognition” (or Google app › Settings › Voice › Offline speech recognition)
            › download English.
          </p>
        </section>

        <section className="m-card">
          <h3>Reports</h3>
          <p className="m-muted small">
            Letterhead, signature and page layout for Word/PDF exports come from the PC's settings
            {s.radiologistName ? ` (${s.radiologistName})` : ''}. Reports are signed off on the PC.
          </p>
        </section>

        {p && (
          <section className="m-card">
            <h3>
              <Unlink size={16} /> Unpair
            </h3>
            <p className="m-muted small">Removes the pairing and all cases, reports, templates and macros from this phone. The PC keeps everything.</p>
            <button
              className="m-btn danger block"
              onClick={async () => {
                const pending = store.pendingCount()
                const ok = await ui.confirm(
                  'Unpair this phone?',
                  pending ? `${pending} change(s) have not reached the PC yet and will be lost.` : 'Everything stays on the PC.',
                  'Unpair',
                  true
                )
                if (!ok) return
                await store.wipe()
                sync.init()
                nav.tab({ name: 'pair' })
              }}
            >
              Unpair and remove data
            </button>
          </section>
        )}
        <p className="m-muted small center">Personal PACS for Android · not a certified medical device</p>
      </div>
    </Page>
  )
}
