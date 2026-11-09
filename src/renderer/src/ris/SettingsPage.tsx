import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Database, FolderOpen, HardDriveDownload, Mic, Plus, Save, Trash, Upload } from 'lucide-react'
import type { DataInfo, Settings } from '@shared/types'
import { useUi } from '../common/ui'
import { FONT_FAMILIES, FONT_SIZES } from './editor'
import { SpeechModelsPanel } from './DictationControl'
import { PhonePanel } from './PhonePanel'

const api = window.api

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
    </label>
  )
}

export function SettingsPage({ settings, onSaved }: { settings: Settings; onSaved: (s: Settings) => void }) {
  const ui = useUi()
  const [s, setS] = useState<Settings>(settings)
  const [info, setInfo] = useState<DataInfo | null>(null)
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const [repFrom, setRepFrom] = useState('')
  const [repTo, setRepTo] = useState('')

  useEffect(() => setS(settings), [settings])
  useEffect(() => {
    void api.getDataInfo().then(setInfo)
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => setMics(d.filter((x) => x.kind === 'audioinput' && x.deviceId !== 'default' && x.deviceId !== 'communications')))
      .catch(() => {})
  }, [])

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }))

  const pickImage = async (k: 'logoImage' | 'signatureImage') => {
    try {
      const url = await api.pickImageAsDataUrl()
      if (url) set(k, url)
    } catch (e) {
      ui.toast(String((e as Error).message), 'error')
    }
  }

  const save = async () => {
    const saved = await api.saveSettings(s)
    onSaved(saved)
    ui.toast('Settings saved', 'success')
  }

  return (
    <div className="settings-page">
      <header className="topbar">
        <div className="brand">
          Personal <span>PACS</span>
        </div>
        <div className="topbar-title">Settings</div>
        <div className="topbar-actions">
          <button className="btn btn-green" onClick={() => void save()}>
            <Save size={16} /> Save settings
          </button>
        </div>
      </header>
      <div className="settings-scroll">
        <section className="card">
          <h3>Radiologist</h3>
          <div className="grid2">
            <Field label="Name (as printed on reports)">
              <input value={s.radiologistName} placeholder="Dr. Firstname Lastname" onChange={(e) => set('radiologistName', e.target.value)} />
            </Field>
            <Field label="Qualification / designation">
              <textarea rows={2} value={s.radiologistDesignation} placeholder="MD (Radiodiagnosis)&#10;Consultant Radiologist" onChange={(e) => set('radiologistDesignation', e.target.value)} />
            </Field>
            <Field label="Registration number">
              <input value={s.radiologistRegNo} onChange={(e) => set('radiologistRegNo', e.target.value)} />
            </Field>
            <Field label="Signature image (printed on signed-off reports)">
              <div className="img-pick">
                {s.signatureImage ? <img src={s.signatureImage} alt="signature" /> : <span className="muted">None</span>}
                <button className="btn btn-small" onClick={() => void pickImage('signatureImage')}>
                  <Upload size={14} /> Choose…
                </button>
                {s.signatureImage && (
                  <button className="btn btn-small" onClick={() => set('signatureImage', '')}>
                    <Trash size={14} />
                  </button>
                )}
              </div>
            </Field>
          </div>
        </section>

        <section className="card">
          <h3>Letterhead &amp; printing</h3>
          <div className="grid2">
            <Field label="Institution / clinic name">
              <input value={s.institutionName} onChange={(e) => set('institutionName', e.target.value)} />
            </Field>
            <Field label="Logo">
              <div className="img-pick">
                {s.logoImage ? <img src={s.logoImage} alt="logo" /> : <span className="muted">None</span>}
                <button className="btn btn-small" onClick={() => void pickImage('logoImage')}>
                  <Upload size={14} /> Choose…
                </button>
                {s.logoImage && (
                  <button className="btn btn-small" onClick={() => set('logoImage', '')}>
                    <Trash size={14} />
                  </button>
                )}
              </div>
            </Field>
            <Field label="Address">
              <textarea rows={2} value={s.institutionAddress} onChange={(e) => set('institutionAddress', e.target.value)} />
            </Field>
            <Field label="Phone / email / website">
              <textarea rows={2} value={s.institutionContact} onChange={(e) => set('institutionContact', e.target.value)} />
            </Field>
            <Field label="Report title">
              <input value={s.reportTitle} onChange={(e) => set('reportTitle', e.target.value)} />
            </Field>
            <Field label="Footer text (e.g. disclaimer)">
              <textarea rows={2} value={s.footerText} onChange={(e) => set('footerText', e.target.value)} />
            </Field>
            <Field label="Paper">
              <div className="row">
                <select value={s.pageSize} onChange={(e) => set('pageSize', e.target.value as Settings['pageSize'])}>
                  <option value="A4">A4</option>
                  <option value="Letter">Letter</option>
                </select>
                <select value={s.pageMargin} onChange={(e) => set('pageMargin', e.target.value as Settings['pageMargin'])}>
                  <option value="normal">Normal margins</option>
                  <option value="narrow">Narrow margins</option>
                  <option value="wide">Wide margins</option>
                </select>
                <select value={s.pageOrientation} onChange={(e) => set('pageOrientation', e.target.value as Settings['pageOrientation'])}>
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </select>
              </div>
            </Field>
            <Field label="Print options">
              <label className="check-line">
                <input type="checkbox" checked={s.showLetterhead} onChange={(e) => set('showLetterhead', e.target.checked)} /> Print
                letterhead (name, logo, address)
              </label>
              <label className="check-line">
                <input type="checkbox" checked={s.showSignatureBlock} onChange={(e) => set('showSignatureBlock', e.target.checked)} /> Print
                signature block
              </label>
            </Field>
          </div>
        </section>

        <section className="card">
          <h3>Reporting</h3>
          <div className="grid2">
            <Field label="Default font">
              <div className="row">
                <select value={s.editorFontFamily} onChange={(e) => set('editorFontFamily', e.target.value)}>
                  {FONT_FAMILIES.map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
                <select value={s.editorFontSize} onChange={(e) => set('editorFontSize', e.target.value)}>
                  {FONT_SIZES.map((f) => (
                    <option key={f}>{f}</option>
                  ))}
                </select>
              </div>
            </Field>
            <Field label="Autosave drafts every (seconds, 0 = off)">
              <input type="number" min={0} max={600} value={s.autosaveSeconds} onChange={(e) => set('autosaveSeconds', Number(e.target.value))} />
            </Field>
            <Field label="Viewer">
              <label className="check-line">
                <input type="checkbox" checked={s.autoOpenViewer} onChange={(e) => set('autoOpenViewer', e.target.checked)} /> Open the images
                automatically when I open a report
              </label>
            </Field>
          </div>
        </section>

        <section className="card">
          <h3>
            <Mic size={15} /> Dictation (offline speech recognition)
          </h3>
          <p className="muted">
            Press <b>F4</b> in the report (or in the viewer) and speak. Text appears after each short pause. Everything runs on
            this computer – no internet needed after the model is downloaded.
          </p>
          <SpeechModelsPanel
            selected={s.dictationModel}
            onSelect={(id) => {
              set('dictationModel', id)
              void api.saveSettings({ ...s, dictationModel: id }).then(onSaved)
            }}
          />
          <div className="grid2" style={{ marginTop: 12 }}>
            <Field label="Microphone">
              <select value={s.dictationMicId} onChange={(e) => set('dictationMicId', e.target.value)}>
                <option value="">Windows default microphone</option>
                {mics.map((m) => (
                  <option key={m.deviceId} value={m.deviceId}>
                    {m.label || 'Microphone'}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Pause that ends a phrase: ${(s.dictationPauseMs / 1000).toFixed(1)} s`} hint="Shorter = text appears sooner; longer = fewer broken sentences.">
              <input type="range" min={300} max={1500} step={100} value={s.dictationPauseMs} onChange={(e) => set('dictationPauseMs', Number(e.target.value))} />
            </Field>
            <Field label="Voice commands">
              <label className="check-line">
                <input type="checkbox" checked={s.dictationCommands} onChange={(e) => set('dictationCommands', e.target.checked)} /> Understand
                spoken commands
              </label>
              <small className="muted">
                "full stop", "comma", "semicolon", "colon" (at the end), "question mark", "open/close bracket", "hyphen", "slash",
                "new line", "new paragraph", "delete that", "macro &lt;code&gt;", "template &lt;name&gt;", "stop dictation".
                Numbers like "12 by 8 millimeters" become "12 x 8 mm".
              </small>
            </Field>
            <Field label="Corrections (words the computer keeps getting wrong)">
              <div className="reps">
                {s.dictationReplacements.map((r, i) => (
                  <div key={i} className="rep-row">
                    <span className="rep-from">{r.from}</span>
                    <span className="muted">→</span>
                    <span className="rep-to">{r.to}</span>
                    <button
                      className="icon-btn"
                      title="Remove"
                      onClick={() => set('dictationReplacements', s.dictationReplacements.filter((_, j) => j !== i))}
                    >
                      <Trash size={14} />
                    </button>
                  </div>
                ))}
                <div className="rep-row">
                  <input placeholder="heard as…" value={repFrom} onChange={(e) => setRepFrom(e.target.value)} />
                  <span className="muted">→</span>
                  <input placeholder="write instead" value={repTo} onChange={(e) => setRepTo(e.target.value)} />
                  <button
                    className="btn btn-small"
                    disabled={!repFrom.trim()}
                    onClick={() => {
                      set('dictationReplacements', [...s.dictationReplacements, { from: repFrom.trim(), to: repTo.trim() }])
                      setRepFrom('')
                      setRepTo('')
                    }}
                  >
                    <Plus size={14} /> Add
                  </button>
                </div>
              </div>
            </Field>
          </div>
          <p className="muted small">Remember to click “Save settings” after changing the microphone, pause, commands or corrections.</p>
        </section>

        <PhonePanel />

        <section className="card">
          <h3>Data</h3>
          {info && (
            <>
              <p>
                <Database size={14} /> {info.studies} studies · {info.series} series · {info.images} images · {info.reports} reports
              </p>
              <p className="mono">{info.dataDir}</p>
              <p className="muted">
                Images are copied into this folder when imported, so the CD or USB stick can be removed. Keep this folder out of
                OneDrive/Dropbox (it contains patient data) and use BitLocker drive encryption on a laptop.
              </p>
            </>
          )}
          <div className="row">
            <button className="btn" onClick={() => void api.openDataFolder()}>
              <FolderOpen size={15} /> Open data folder
            </button>
            <button
              className="btn"
              onClick={async () => {
                const f = await api.backupDatabase()
                if (f) ui.toast(`Backup saved: ${f}`, 'success')
              }}
            >
              <HardDriveDownload size={15} /> Back up reports database…
            </button>
            <button className="btn" onClick={() => void api.changeDataFolder()}>
              <FolderOpen size={15} /> Change data folder…
            </button>
          </div>
          {info && <p className="muted small">Personal PACS version {info.appVersion}</p>}
        </section>

        <section className="card warn">
          <h3>Important</h3>
          <p>
            This software is not a certified medical device. Use it for personal reporting workflow, teaching and research; verify
            findings on your institution's approved diagnostic systems.
          </p>
        </section>
      </div>
    </div>
  )
}
