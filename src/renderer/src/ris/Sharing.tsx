// Case sharing UI: share a case with another Personal PACS user (anywhere on the internet),
// see who downloaded it, and receive cases shared with you.

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, Copy, Download, Globe, Inbox, Loader2, Send, Share2, ShieldCheck, X, Zap } from 'lucide-react'
import type { ReceivedShareInfo, ReceiveProgress, SecondOpinion, ShareEvent, ShareInfo, ShareLinkState, StudyRow } from '@shared/types'
import { formatBytes, formatDicomDate, formatIsoDateTime, STATUS_LABEL } from '@shared/format'
import { Modal, useEvent, useUi } from '../common/ui'

const api = window.api

/** All shares of this PC, kept up to date. */
export function useShares(): ShareInfo[] {
  const [list, setList] = useState<ShareInfo[]>([])
  useEffect(() => {
    void api.shareList().then(setList)
  }, [])
  useEvent(api.onShareEvent, (e: ShareEvent) => {
    if (e.type !== 'share') return
    setList((l) => {
      const others = l.filter((x) => x.id !== e.share.id)
      if (e.share.status === 'closed') return others
      return [e.share, ...others].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    })
  })
  return list
}

function useCopy() {
  const ui = useUi()
  return useCallback(
    async (text: string, what: string) => {
      try {
        await navigator.clipboard.writeText(text)
        ui.toast(`${what} copied`, 'success')
      } catch {
        ui.toast('Could not copy – select the text and press Ctrl+C', 'error')
      }
    },
    [ui]
  )
}

const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.floor((a / b) * 100)) : 0)

function WayChip({ label, state, icon }: { label: string; state: ShareLinkState; icon: ReactNode }) {
  const text = state === 'ready' ? 'ready' : state === 'starting' ? 'starting…' : state === 'unavailable' ? 'not available' : 'off'
  return (
    <span className={`way-chip way-${state}`} title={label}>
      {icon} {label}: {state === 'starting' ? <Loader2 size={12} className="spin" /> : null} {text}
    </span>
  )
}

/** One shared case: code, link, message, how it can be reached, who downloaded it. */
export function ShareCard({ share, compact }: { share: ShareInfo; compact?: boolean }) {
  const ui = useUi()
  const copy = useCopy()
  const live = share.status === 'active' || share.status === 'preparing'
  const reachable = share.direct === 'ready' || share.relay === 'ready'

  let headline: ReactNode
  if (share.status === 'preparing') headline = 'Preparing the files…'
  else if (share.status === 'error') headline = <span className="err-text">{share.error}</span>
  else if (share.status === 'stopped' || share.status === 'expired')
    headline = (
      <>
        {share.status === 'stopped' ? 'Stopped' : 'Expired'} – the code no longer downloads the case.
        {share.replyUntil && <> A report sent back is still accepted until {formatIsoDateTime(share.replyUntil)}.</>}
      </>
    )
  else if (reachable) headline = <span className="ok-text">Ready – send the message (or just the code) to your colleague.</span>
  else if (share.direct === 'starting' || share.relay === 'starting') headline = 'Connecting to the internet…'
  else
    headline = (
      <span className="err-text">
        This computer can&apos;t be reached from the internet right now{share.error ? ` (${share.error})` : ''}. Check the internet
        connection; it keeps trying.
      </span>
    )

  const stop = async () => {
    const close = !share.allowReply
    if (
      !(await ui.confirm(
        'Stop sharing?',
        close ? 'The code will stop working.' : 'The code will stop downloading the case. A report sent back to you is still accepted.',
        'Stop sharing',
        true
      ))
    )
      return
    await api.shareStop(share.id, close)
  }

  return (
    <div className={`share-card ${compact ? 'compact' : ''}`}>
      {compact && (
        <div className="share-card-title">
          <b>{share.title}</b>
          <span className="muted small">
            {share.anonymized ? 'anonymized · ' : ''}shared {formatIsoDateTime(share.createdAt)}
          </span>
        </div>
      )}
      <div className="share-code-row">
        <div>
          <div className="muted small">Code</div>
          <div className="share-code mono">{share.code}</div>
        </div>
        {live && (
          <div className="share-code-btns">
            <button className="btn btn-green" onClick={() => void copy(share.message, 'Message')} title="Copy a ready-to-send message with the link and the code">
              <Copy size={14} /> Copy message
            </button>
            <button className="btn btn-small" onClick={() => void copy(share.code, 'Code')}>
              Copy code
            </button>
            <button className="btn btn-small" disabled={!share.link} onClick={() => share.link && void copy(share.link, 'Link')}>
              Copy link
            </button>
          </div>
        )}
      </div>
      <div className="share-headline">{headline}</div>
      {live && (
        <div className="share-ways">
          <WayChip label="Direct" state={share.direct} icon={<Zap size={12} />} />
          <WayChip label="Relay" state={share.relay} icon={<Globe size={12} />} />
          <span className="muted small">
            {share.files} files · {formatBytes(share.totalBytes)} · until {formatIsoDateTime(share.expiresAt)}
          </span>
        </div>
      )}
      {!compact && live && (
        <textarea className="share-message" readOnly value={share.message} rows={4} onFocus={(e) => e.currentTarget.select()} />
      )}
      {share.downloads.length > 0 && (
        <ul className="share-downloads">
          {share.downloads.map((d) => (
            <li key={d.id}>
              {d.done ? <Check size={14} className="ok-text" /> : <Download size={14} />}
              <b>{d.name || 'Someone'}</b>
              <span>{d.done ? 'downloaded' : `downloading ${pct(d.bytes, d.total)}%`}</span>
              <span className="muted small">
                {d.via === 'direct' ? 'direct' : 'via relay'} · {formatIsoDateTime(d.lastSeen).slice(-5)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {share.replies > 0 && (
        <div className="share-replies">
          <Inbox size={14} /> {share.replies === 1 ? '1 report was sent back' : `${share.replies} reports were sent back`} – open the case to read
          {share.replies === 1 ? ' it' : ' them'}.
        </div>
      )}
      <div className="share-card-actions">
        {live ? (
          <button className="btn btn-small btn-red-outline" onClick={() => void stop()}>
            Stop sharing
          </button>
        ) : (
          <button className="btn btn-small" onClick={() => void api.shareStop(share.id, true)} title="Remove from the list (no more reports back)">
            <X size={13} /> Remove
          </button>
        )}
      </div>
    </div>
  )
}

/** Choose how to share, then show the code and the live status. */
export function ShareDialog({ study, senderName, onClose }: { study: StudyRow; senderName: string; onClose: () => void }) {
  const ui = useUi()
  const [anonymize, setAnonymize] = useState(false)
  const [allowReply, setAllowReply] = useState(true)
  const [busy, setBusy] = useState(false)
  const [share, setShare] = useState<ShareInfo | null>(null)
  const idRef = useRef<string | null>(null)

  useEvent(api.onShareEvent, (e: ShareEvent) => {
    if (e.type === 'share' && e.share.id === idRef.current) setShare(e.share.status === 'closed' ? null : e.share)
  })

  const start = async () => {
    setBusy(true)
    try {
      const s = await api.shareCreate(study.id, { anonymize, allowReply })
      idRef.current = s.id
      setShare(s)
    } catch (e) {
      ui.toast(`Could not share: ${(e as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={share ? 'Case shared' : 'Share this case'}
      onClose={onClose}
      footer={
        share ? (
          <>
            <span className="muted small modal-note">You can close this window – sharing continues while Personal PACS is open.</span>
            <div className="spacer" />
            <button className="btn btn-green" onClick={onClose}>
              Done
            </button>
          </>
        ) : (
          <>
            <div className="spacer" />
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-green" disabled={busy} onClick={() => void start()}>
              {busy ? <Loader2 size={14} className="spin" /> : <Share2 size={14} />} Share
            </button>
          </>
        )
      }
    >
      <div className="share-dialog">
        <div className="share-study">
          <b>{study.patientName || '(no name)'}</b> · {study.description || study.modalities} · {formatDicomDate(study.studyDate)}
          <div className="muted small">
            {study.numImages > 0 ? `${study.numImages} images` : 'no images'} · report: {STATUS_LABEL[study.reportStatus]}
          </div>
        </div>
        {!share ? (
          <>
            <p className="share-intro">
              Your colleague downloads this case and its report straight from this computer into their Personal PACS, from anywhere
              on the internet. Everything is encrypted with the code.
            </p>
            <div className="share-choice">
              <div className="share-choice-title">Patient details</div>
              <label className="check-line">
                <input type="radio" name="anon" checked={!anonymize} onChange={() => setAnonymize(false)} />
                <span>
                  <b>Keep</b> name, ID and PG No <span className="muted small">– for a colleague who needs to know the patient</span>
                </span>
              </label>
              <label className="check-line">
                <input type="radio" name="anon" checked={anonymize} onChange={() => setAnonymize(true)} />
                <span>
                  <ShieldCheck size={13} /> <b>Remove</b> name, ID, birth date, PG No, hospital and doctors{' '}
                  <span className="muted small">– also from the report text. Names burned into the pictures can&apos;t be removed.</span>
                </span>
              </label>
            </div>
            <label className="check-line">
              <input type="checkbox" checked={allowReply} onChange={(e) => setAllowReply(e.target.checked)} />
              <span>
                Let them <b>send their report back</b> to me (second opinion)
              </span>
            </label>
            <p className="muted small">
              The code works for 24 hours or until you stop it, while this computer is on with Personal PACS open.
              {!senderName && ' Tip: put your name in Settings › Radiologist so your colleague sees who sent it.'}
            </p>
          </>
        ) : (
          <ShareCard share={share} />
        )}
      </div>
    </Modal>
  )
}

/** The list of shared cases (Settings and the worklist's "Sharing" button). */
export function SharesList({ shares, empty }: { shares: ShareInfo[]; empty?: ReactNode }) {
  if (!shares.length) return <>{empty ?? <p className="muted small">You are not sharing any case.</p>}</>
  return (
    <div className="shares-list">
      {shares.map((s) => (
        <ShareCard key={s.id} share={s} compact />
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ receiving

export interface ReceiveCenterHandle {
  open(input?: string): void
}

/**
 * The "Receive case" window and, while it's hidden, a small progress card. Lives at the app level
 * so a download keeps running (and stays visible) while the user works on other cases.
 */
export const ReceiveCenter = forwardRef<ReceiveCenterHandle, { onOpenCase: (studyId: number) => void }>(function ReceiveCenter(
  { onOpenCase },
  ref
) {
  const ui = useUi()
  const [visible, setVisible] = useState(false)
  const [input, setInput] = useState('')
  const [jobId, setJobId] = useState<string | null>(null)
  const [p, setP] = useState<ReceiveProgress | null>(null)
  const jobRef = useRef<string | null>(null)
  const latest = useRef(new Map<string, ReceiveProgress>())

  const start = useCallback(
    async (text: string) => {
      if (!text.trim()) return
      try {
        const id = await api.receiveStart(text)
        jobRef.current = id
        setJobId(id)
        setP(latest.current.get(id) ?? null)
      } catch (e) {
        ui.toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
      }
    },
    [ui]
  )

  const running = !!p && (p.phase === 'connecting' || p.phase === 'downloading' || p.phase === 'importing')
  const runningRef = useRef(false)
  runningRef.current = running || (!!jobId && !p)

  useImperativeHandle(ref, () => ({
    open(text?: string) {
      setVisible(true)
      if (text) {
        setInput(text)
        if (!runningRef.current) void start(text)
      } else if (!runningRef.current && p && p.phase !== 'done') {
        setJobId(null)
        setP(null)
      }
    }
  }))

  const visibleRef = useRef(visible)
  visibleRef.current = visible
  useEvent(api.onReceiveProgress, (x: ReceiveProgress) => {
    latest.current.set(x.jobId, x)
    if (x.jobId !== jobRef.current) return
    setP(x)
    if (x.phase === 'done' && !visibleRef.current) ui.toast(`Case received from ${x.sender} – it is in your worklist.`, 'success')
    if (x.phase === 'error' && !visibleRef.current) ui.toast(`Receiving failed: ${x.message}`, 'error')
  })

  const reset = () => {
    jobRef.current = null
    setJobId(null)
    setP(null)
    setInput('')
  }

  const close = () => {
    setVisible(false)
    if (!running && p && p.phase !== 'done') reset()
  }

  const phaseText = (x: ReceiveProgress) =>
    x.phase === 'downloading'
      ? `${formatBytes(x.bytes)} of ${formatBytes(x.total)}${x.rate > 0 ? ` · ${formatBytes(x.rate)}/s` : ''}`
      : x.message

  const card = !visible && p && (running || p.phase === 'done') && (
    <div className={`receive-chip ${p.phase === 'done' ? 'done' : ''}`} onClick={() => setVisible(true)} title="Show">
      <Download size={15} />
      <span>
        {p.phase === 'done' ? `Received: ${p.title}` : p.phase === 'downloading' ? `Receiving… ${pct(p.bytes, p.total)}%` : p.message}
      </span>
      {p.phase === 'done' && (
        <button
          className="icon-btn"
          title="Dismiss"
          onClick={(e) => {
            e.stopPropagation()
            reset()
          }}
        >
          <X size={13} />
        </button>
      )}
    </div>
  )

  return (
    <>
      {card}
      {visible && (
        <Modal
          title="Receive a case"
          onClose={close}
          footer={
            running ? (
              <>
                <button className="btn btn-red-outline" onClick={() => jobId && void api.receiveCancel(jobId)}>
                  Cancel download
                </button>
                <div className="spacer" />
                <button className="btn" onClick={close} title="Keep downloading in the background">
                  Hide
                </button>
              </>
            ) : p?.phase === 'done' && p.studyId ? (
              <>
                <button className="btn" onClick={reset}>
                  Receive another
                </button>
                <div className="spacer" />
                <button
                  className="btn btn-green"
                  onClick={() => {
                    const id = p.studyId!
                    setVisible(false)
                    reset()
                    onOpenCase(id)
                  }}
                >
                  Open the case
                </button>
              </>
            ) : (
              <>
                <div className="spacer" />
                <button className="btn" onClick={close}>
                  Close
                </button>
                <button className="btn btn-green" disabled={!input.trim()} onClick={() => void start(input)}>
                  <Download size={14} /> {p?.phase === 'error' ? 'Try again' : 'Receive'}
                </button>
              </>
            )
          }
        >
          <div className="receive-dialog">
            {!p || p.phase === 'error' || p.phase === 'cancelled' ? (
              <>
                <label className="field">
                  <span>Paste the message, the link or the code your colleague sent you</span>
                  <textarea
                    autoFocus
                    rows={3}
                    value={input}
                    placeholder="e.g. ABCDE-23456"
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        void start(input)
                      }
                    }}
                  />
                </label>
                {p?.phase === 'error' && <div className="err-text receive-error">{p.message}</div>}
                {p?.phase === 'cancelled' && <div className="muted">Download cancelled.</div>}
                <p className="muted small">
                  The case comes straight from your colleague&apos;s computer, encrypted. Their computer must be on with Personal PACS
                  open.
                </p>
              </>
            ) : (
              <div className="receive-progress">
                <div className="receive-title">
                  {p.phase === 'done' ? <Check size={18} className="ok-text" /> : <Loader2 size={18} className="spin" />}
                  <div>
                    <b>{p.title || 'Shared case'}</b>
                    {p.sender && <div className="muted small">from {p.sender}</div>}
                  </div>
                </div>
                {(p.phase === 'downloading' || p.phase === 'importing' || p.phase === 'done') && p.total > 0 && (
                  <div className="progress">
                    <div style={{ width: `${p.phase === 'downloading' ? pct(p.bytes, p.total) : 100}%` }} />
                  </div>
                )}
                <div className="receive-status">
                  <span>{phaseText(p)}</span>
                  {p.via && <span className="muted small">{p.via === 'direct' ? 'direct connection' : 'via relay'}</span>}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}
    </>
  )
})

// ------------------------------------------------------------------ report page

/** Report page side panel: where the case came from, send your report back, second opinions. */
export function SharingPanel({
  study,
  onShare,
  saveFirst,
  onInsert
}: {
  study: StudyRow
  onShare: () => void
  /** Saves unsaved changes so the latest text is sent. */
  saveFirst: () => Promise<boolean>
  onInsert?: (html: string) => void
}) {
  const ui = useUi()
  const [info, setInfo] = useState<ReceivedShareInfo | null>(null)
  const [opinions, setOpinions] = useState<SecondOpinion[]>([])
  const [view, setView] = useState<SecondOpinion | null>(null)
  const [sending, setSending] = useState(false)

  const load = useCallback(() => {
    void api.receivedInfo(study.id).then(setInfo)
    void api.secondOpinions(study.id).then(setOpinions)
  }, [study.id])
  useEffect(load, [load])
  useEvent(api.onShareEvent, (e: ShareEvent) => {
    if (e.type === 'opinion' && e.studyId === study.id) load()
  })

  const who = info?.senderName || 'the sender'
  const canReply = !!info?.allowReply && Date.now() < Date.parse(info.replyUntil || '2100-01-01')

  const send = async () => {
    if (!(await saveFirst())) return
    setSending(true)
    try {
      ui.toast(await api.replySend(study.id), 'success')
      load()
    } catch (e) {
      ui.toast((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="sharing-panel">
      {info && (
        <div className="received-box">
          <div className="kv-s">
            Received from <b>{who}</b>
            <br />
            <span className="muted">
              {formatIsoDateTime(info.receivedAt)}
              {info.anonymized ? ' · anonymized' : ''}
            </span>
          </div>
          {canReply ? (
            <>
              <button className="btn btn-small btn-green" disabled={sending} onClick={() => void send()}>
                {sending ? <Loader2 size={13} className="spin" /> : <Send size={13} />} {info.repliedAt ? 'Send my report again' : `Send my report to ${who}`}
              </button>
              <div className="kv-s muted small">
                {info.repliedAt ? `Sent ${formatIsoDateTime(info.repliedAt)}. ` : ''}Possible until {formatIsoDateTime(info.replyUntil)}.
              </div>
            </>
          ) : (
            <div className="kv-s muted small">{info.allowReply ? 'Too late to send a report back.' : `${who} did not ask for a report back.`}</div>
          )}
        </div>
      )}
      {opinions.length > 0 && (
        <div className="opinions">
          <div className="kv-s strong">Second opinions</div>
          {opinions.map((o) => (
            <div key={o.id} className="opinion-row">
              <div>
                <b>{o.fromName || 'A colleague'}</b>
                {o.fromDesignation && <span className="muted small"> · {o.fromDesignation}</span>}
                <div className="muted small">
                  {formatIsoDateTime(o.receivedAt)} · <span className={`badge st-${o.status}`}>{STATUS_LABEL[o.status]}</span>
                </div>
              </div>
              <button className="btn btn-small" onClick={() => setView(o)}>
                Read
              </button>
            </div>
          ))}
        </div>
      )}
      <button className="link-btn" onClick={onShare}>
        <Share2 size={12} /> Share this case with a colleague…
      </button>
      {view && (
        <Modal
          wide
          title={`Second opinion – ${view.fromName || 'a colleague'}${view.fromDesignation ? `, ${view.fromDesignation}` : ''}`}
          onClose={() => setView(null)}
          footer={
            <>
              <span className="muted small modal-note">Received {formatIsoDateTime(view.receivedAt)}. Also kept in this report&apos;s History.</span>
              <div className="spacer" />
              <button className="btn" onClick={() => setView(null)}>
                Close
              </button>
              {onInsert && (
                <button
                  className="btn btn-green"
                  onClick={() => {
                    onInsert(view.html)
                    setView(null)
                  }}
                >
                  Insert into my report
                </button>
              )}
            </>
          }
        >
          <div className="prior-report report-doc" dangerouslySetInnerHTML={{ __html: view.html }} />
        </Modal>
      )}
    </div>
  )
}
