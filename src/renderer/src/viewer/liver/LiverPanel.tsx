import { useSyncExternalStore } from 'react'
import { Ban, Brush, Eraser, FileText, MousePointerClick, Save, Scissors, Target, Undo2, X } from 'lucide-react'
import { LANDMARKS, LEVELS, SEGMENTS, segmentName, type LandmarkId, type SegLevel } from './couinaud'
import { liverStore, type LiverState, type LiverStep, type LiverTool } from './store'
import { missingNames, tablesOf, type Row } from './report'

const useLiver = (): LiverState => useSyncExternalStore((fn) => liverStore.subscribe(fn), () => liverStore.state)

const STEPS: { id: LiverStep; label: string }[] = [
  { id: 'liver', label: '1 Liver' },
  { id: 'findings', label: '2 Findings' },
  { id: 'vessels', label: '3 Vessels' },
  { id: 'segments', label: '4 Segments' },
  { id: 'resection', label: '5 Resection' }
]

/** Default tool when a step is opened. */
const STEP_TOOL: Record<LiverStep, LiverTool> = { liver: 'seed', findings: 'lesion', vessels: null, segments: 'landmark', resection: null }

const rgb = (c?: readonly number[]) => (c ? `rgb(${c[0]},${c[1]},${c[2]})` : 'transparent')
const ml = (x: number) => (x >= 100 ? `${Math.round(x)}` : `${Math.round(x * 10) / 10}`)
const pc = (x?: number) => (x == null ? '' : `${Math.round(x * 10) / 10} %`)

function ToolButton(props: { tool: LiverTool; label: string; icon: React.ReactNode; title: string; s: LiverState }) {
  const on = props.s.tool === props.tool
  return (
    <button className={`lv-tool ${on ? 'on' : ''}`} title={props.title} onClick={() => liverStore.ui({ tool: on ? null : props.tool, pendingCut: null })}>
      {props.icon}
      {props.label}
    </button>
  )
}

function Table({ rows, cols }: { rows: Row[]; cols: ('pct' | 'pctFn' | 'hu' | 'note')[] }) {
  return (
    <table className="lv-table">
      <tbody>
        {rows.map((r, k) => (
          <tr key={k}>
            <td>
              {r.color && <span className="lv-swatch" style={{ background: rgb(r.color) }} />}
              {r.label}
            </td>
            <td className="num">{ml(r.ml)} mL</td>
            {cols.includes('pct') && <td className="num">{pc(r.pct)}</td>}
            {cols.includes('pctFn') && <td className="num">{pc(r.pctFn)}</td>}
            {cols.includes('hu') && <td className="num dim">{r.hu}</td>}
            {cols.includes('note') && <td className="dim">{r.note}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Schematic of the landmarks (front view, patient's right on the left), the chosen one in orange. */
function Guide({ active, placed }: { active: LandmarkId | null; placed: Set<LandmarkId> }) {
  const pos: Record<LandmarkId, [number, number]> = {
    ivc: [120, 34],
    rhv: [52, 70],
    mhv: [98, 104],
    uf: [178, 96],
    rpb: [82, 92],
    lpb: [162, 84],
    tll: [226, 58],
    slv: [150, 38],
    dlv: [140, 60]
  }
  return (
    <svg className="lv-guide" viewBox="0 0 240 150">
      <path d="M12,62 C22,22 92,12 150,20 C192,25 232,40 236,56 C200,72 162,96 122,120 C92,140 42,142 22,122 C10,106 6,82 12,62 Z" fill="#5a5f66" stroke="#c98a4b" strokeWidth="3" />
      <ellipse cx="120" cy="30" rx="9" ry="16" fill="#3d63c9" />
      <g stroke="#3d63c9" strokeWidth="5" strokeLinecap="round" fill="none">
        <path d="M118,36 L48,74" />
        <path d="M120,40 L98,112" />
        <path d="M124,36 L200,46" />
      </g>
      <g stroke="#62c26a" strokeWidth="7" strokeLinecap="round" fill="none">
        <path d="M118,148 L122,96" />
        <path d="M122,96 L80,92" />
        <path d="M122,96 L164,84" />
      </g>
      <path d="M178,96 L184,128" stroke="#9aa0a6" strokeDasharray="3 3" strokeWidth="2" />
      {LANDMARKS.map((l) => {
        const [x, y] = pos[l.id]
        const on = active === l.id
        const c = on ? '#ff9a00' : placed.has(l.id) ? '#35d06a' : '#ffffff'
        return (
          <g key={l.id} stroke={c} strokeWidth={on ? 3 : 2}>
            <line x1={x - 5} y1={y - 5} x2={x + 5} y2={y + 5} />
            <line x1={x + 5} y1={y - 5} x2={x - 5} y2={y + 5} />
            {on && <circle cx={x} cy={y} r={9} fill="none" />}
          </g>
        )
      })}
    </svg>
  )
}

export function LiverPanel(props: { onClose: () => void; onReport: () => void; onSave: () => void }) {
  const s = useLiver()
  const t = tablesOf(s)
  const has = !!s.liver
  const step = (id: LiverStep) => liverStore.ui({ step: id, tool: STEP_TOOL[id], pendingCut: null, activeLandmark: id === 'segments' ? s.activeLandmark ?? nextLandmark(s) : s.activeLandmark })
  const brush = (
    <label className="lv-row" title="Brush radius (a ball: it works through neighbouring slices too)">
      Brush
      <input type="range" min={2} max={30} value={s.brushMm} onChange={(e) => liverStore.ui({ brushMm: Number(e.target.value) })} />
      <span className="num">{s.brushMm} mm</span>
    </label>
  )
  return (
    <div className="liver-panel">
      <div className="lv-head">
        <span>Liver analysis</span>
        <button className="lv-icon" title="Close the liver analysis" onClick={props.onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="lv-steps">
        {STEPS.map((x) => (
          <button key={x.id} className={s.step === x.id ? 'on' : ''} onClick={() => step(x.id)} disabled={!has && x.id !== 'liver' && x.id !== 'findings'}>
            {x.label}
          </button>
        ))}
      </div>
      {s.busy && <div className="lv-busy">{s.busy}</div>}
      {s.message && (
        <div className="lv-message" onClick={() => liverStore.ui({ message: null })} title="Click to dismiss">
          {s.message}
        </div>
      )}
      <div className="lv-body">
        {s.step === 'liver' && (
          <>
            <p className="lv-hint">
              {has
                ? 'Click again where liver is missing. "Not liver" + click separates a part that ran into a neighbouring organ. Brushes add or remove a ball of tissue.'
                : 'Click inside the liver on any image (portal venous phase works best). The whole liver is found from that click.'}
            </p>
            <div className="lv-tools">
              <ToolButton s={s} tool="seed" label={has ? 'Add part' : 'Click liver'} icon={<MousePointerClick size={15} />} title="Click inside the liver" />
              <ToolButton s={s} tool="exclude" label="Not liver" icon={<Ban size={15} />} title="Click on tissue that was taken but is not liver (heart, kidney, stomach…)" />
              <ToolButton s={s} tool="paint" label="Add" icon={<Brush size={15} />} title="Brush: add liver" />
              <ToolButton s={s} tool="erase" label="Remove" icon={<Eraser size={15} />} title="Brush: remove liver" />
            </div>
            {(s.tool === 'paint' || s.tool === 'erase') && brush}
            <div className="lv-tools">
              <button className="lv-tool" disabled={!liverStore.canUndo} onClick={() => liverStore.undo()}>
                <Undo2 size={15} /> Undo
              </button>
              <button className="lv-tool" disabled={!has} onClick={() => liverStore.clearLiver()}>
                Clear
              </button>
            </div>
          </>
        )}
        {s.step === 'findings' && (
          <>
            <p className="lv-hint">Click the centre of a lesion and drag to its edge (or just click). The finding brushes add to / remove from the selected finding.</p>
            <div className="lv-tools">
              <ToolButton s={s} tool="lesion" label="New finding" icon={<Target size={15} />} title="Click a lesion's centre and drag to its edge" />
              <ToolButton s={s} tool="finding-paint" label="Add" icon={<Brush size={15} />} title="Brush: add to the selected finding" />
              <ToolButton s={s} tool="finding-erase" label="Remove" icon={<Eraser size={15} />} title="Brush: remove from the selected finding" />
            </div>
            {(s.tool === 'finding-paint' || s.tool === 'finding-erase') && brush}
            {s.findingList.length > 0 && (
              <table className="lv-table select">
                <tbody>
                  {s.findingList.map((f) => {
                    const m = s.stats?.findings[f.id]
                    return (
                      <tr key={f.id} className={s.activeFinding === f.id ? 'sel' : ''} onClick={() => liverStore.ui({ activeFinding: f.id })}>
                        <td>
                          <span className="lv-swatch" style={{ background: rgb(f.color) }} />
                          <input className="lv-name" value={f.name} onChange={(e) => liverStore.renameFinding(f.id, e.target.value)} />
                        </td>
                        <td className="num">{m ? `${ml(m.n * (s.stats?.ml ?? 0))} mL` : ''}</td>
                        <td className="num dim">{m ? `${Math.round(m.mean)} HU` : ''}</td>
                        <td>
                          <button className="lv-icon" title="Delete this finding" onClick={(e) => (e.stopPropagation(), liverStore.deleteFinding(f.id))}>
                            <X size={13} />
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </>
        )}
        {s.step === 'vessels' && (
          <>
            <p className="lv-hint">
              Contrast-filled veins inside the liver (portal venous phase). With the IVC, hepatic vein and portal bifurcation landmarks of step 4 placed,
              they are sorted into portal (purple) and hepatic (cyan) veins.
            </p>
            <div className="lv-tools">
              <button className="lv-tool" disabled={!has || !!s.busy} onClick={() => void liverStore.findVessels().then((ok) => !ok && liverStore.ui({ message: 'No contrast-filled vessels found in the liver (scan without contrast?).' }))}>
                Find vessels
              </button>
              {s.vesselThreshold != null && (
                <span className="lv-row">
                  above
                  <button className="lv-icon" onClick={() => void liverStore.findVessels((s.vesselThreshold ?? 0) - 10)}>
                    −
                  </button>
                  <span className="num">{s.vesselThreshold} HU</span>
                  <button className="lv-icon" onClick={() => void liverStore.findVessels((s.vesselThreshold ?? 0) + 10)}>
                    +
                  </button>
                </span>
              )}
              {s.vessels && (
                <button className="lv-tool" onClick={() => liverStore.clearVessels()}>
                  Clear
                </button>
              )}
            </div>
            {t && t.vessels.length > 0 && <Table rows={t.vessels} cols={['pct', 'hu']} />}
          </>
        )}
        {s.step === 'segments' && (
          <>
            <select className="lv-select" value={s.level} onChange={(e) => liverStore.setLevel(e.target.value as SegLevel)}>
              {LEVELS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <Guide active={s.activeLandmark} placed={new Set(LANDMARKS.filter((l) => s.landmarks[l.id]?.length).map((l) => l.id))} />
            {s.activeLandmark && (
              <p className="lv-hint">
                <strong>{LANDMARKS.find((l) => l.id === s.activeLandmark)?.name}</strong> (click to add): {LANDMARKS.find((l) => l.id === s.activeLandmark)?.hint}
              </p>
            )}
            <table className="lv-table select">
              <tbody>
                {LANDMARKS.filter((l) => LEVELS.find((x) => x.id === s.level)?.needs.includes(l.id)).map((l) => {
                  const n = s.landmarks[l.id]?.length ?? 0
                  return (
                    <tr key={l.id} className={s.activeLandmark === l.id ? 'sel' : ''} onClick={() => liverStore.selectLandmark(l.id)}>
                      <td>{l.name}</td>
                      <td className="num">
                        {n} / {l.points}
                      </td>
                      <td>
                        {n > 0 && (
                          <button className="lv-icon" title="Remove this landmark" onClick={(e) => (e.stopPropagation(), liverStore.clearLandmark(l.id))}>
                            <X size={13} />
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {!s.segments && has && <p className="lv-hint dim">Still to place: {missingNames(s).join(', ') || '—'}</p>}
            {t && t.segments.length > 0 && <Table rows={t.segments} cols={['pct', 'pctFn']} />}
          </>
        )}
        {s.step === 'resection' && (
          <>
            {s.segments ? (
              <>
                <p className="lv-hint">Anatomical resection: tick the segments to remove.</p>
                <div className="lv-segs">
                  {SEGMENTS.filter((x) => s.stats?.segments[x.code]).map((x) => (
                    <label key={x.code} className="lv-seg">
                      <input type="checkbox" checked={s.resectSegments.includes(x.code)} onChange={() => liverStore.toggleResectSegment(x.code)} />
                      <span className="lv-swatch" style={{ background: rgb(x.color) }} />
                      {segmentName(x.code, s.level).replace('Segment ', 'S')}
                    </label>
                  ))}
                </div>
              </>
            ) : (
              <p className="lv-hint dim">Define the segments (step 4) for an anatomical resection.</p>
            )}
            <p className="lv-hint">
              Atypical resection: draw a cut line on an image, then click the side to remove; or brush tissue out / back in.
              {s.pendingCut && <strong> Now click the side of the yellow line to remove.</strong>}
            </p>
            <div className="lv-tools">
              <ToolButton s={s} tool="cut" label="Cut" icon={<Scissors size={15} />} title="Draw a cut line, then click the side to remove" />
              <ToolButton s={s} tool="resect-paint" label="Remove tissue" icon={<Brush size={15} />} title="Brush: add tissue to the resection" />
              <ToolButton s={s} tool="resect-erase" label="Keep tissue" icon={<Eraser size={15} />} title="Brush: keep tissue (take it out of the resection)" />
            </div>
            {(s.tool === 'resect-paint' || s.tool === 'resect-erase') && brush}
            {s.cuts.length > 0 && (
              <div className="lv-cuts">
                {s.cuts.map((_, k) => (
                  <span key={k} className="lv-chip">
                    Cut {k + 1}
                    <button className="lv-icon" onClick={() => liverStore.removeCut(k)}>
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <label className="lv-row" title="Margin around each finding counted in '% resected'">
              Safety margin
              <input type="number" min={0} max={30} value={s.marginMm} onChange={(e) => liverStore.setMargin(Math.max(0, Math.min(30, Number(e.target.value) || 0)))} />
              mm
            </label>
            {t?.resection && (
              <>
                <table className="lv-table">
                  <tbody>
                    <tr className="dim">
                      <td>Resection</td>
                      <td className="num">Volume</td>
                      <td className="num">% liver</td>
                      <td className="num">% funct.</td>
                    </tr>
                  </tbody>
                </table>
                <Table rows={t.resection} cols={['pct', 'pctFn']} />
                {t.remnant && (
                  <div className={`lv-remnant ${t.remnant.pctFn < 30 ? 'bad' : t.remnant.pctFn < 40 ? 'warn' : 'ok'}`}>
                    Remnant {ml(t.remnant.ml)} mL = {pc(t.remnant.pct)} of the liver, {pc(t.remnant.pctFn)} of the functional liver
                    {t.remnant.pctFn < 30 ? ' (below 30 %)' : t.remnant.pctFn < 40 ? ' (below 40 %)' : ''}
                  </div>
                )}
                {t.findingsResected.length > 0 && (
                  <table className="lv-table">
                    <tbody>
                      {t.findingsResected.map((f, k) => (
                        <tr key={k}>
                          <td>
                            <span className="lv-swatch" style={{ background: rgb(f.color) }} />
                            {f.label} (+{s.marginMm} mm)
                          </td>
                          <td className="num">{pc(f.pct)} resected</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
            {(s.resectSegments.length > 0 || s.cuts.length > 0 || s.resectBrush) && (
              <button className="lv-tool" onClick={() => liverStore.clearResection()}>
                Clear the plan
              </button>
            )}
          </>
        )}
      </div>
      <div className="lv-display">
        <label className="lv-row">
          Opacity
          <input type="range" min={10} max={90} value={Math.round(s.opacity * 100)} onChange={(e) => liverStore.ui({ opacity: Number(e.target.value) / 100 })} />
        </label>
        <div className="lv-checks">
          {(['liver', 'findings', 'vessels', 'segments', 'resection'] as const).map((k) => (
            <label key={k}>
              <input type="checkbox" checked={s.show[k]} onChange={() => liverStore.ui({ show: { ...s.show, [k]: !s.show[k] } })} />
              {k[0].toUpperCase() + k.slice(1)}
            </label>
          ))}
        </div>
      </div>
      <div className="lv-results">
        {t ? (
          <>
            <Table rows={t.liver} cols={['pct', 'hu']} />
            {t.findings.length > 0 && <Table rows={t.findings} cols={['pct', 'note']} />}
          </>
        ) : (
          <p className="lv-hint dim">No liver yet.</p>
        )}
        <div className="lv-tools">
          <button className="lv-tool" disabled={!t} onClick={props.onReport} title="Put the tables and the 3-D view into the report">
            <FileText size={15} /> Send to report
          </button>
          <button className={`lv-tool ${s.saved ? '' : 'attn'}`} disabled={!has} onClick={props.onSave} title="Save the analysis with the study">
            <Save size={15} /> {s.saved ? 'Saved' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function nextLandmark(s: LiverState): LandmarkId | null {
  const need = LEVELS.find((l) => l.id === s.level)?.needs ?? []
  return need.find((id) => !(s.landmarks[id]?.length)) ?? need[0] ?? null
}
