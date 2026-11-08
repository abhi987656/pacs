import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Smartphone, Trash, Wifi, WifiOff } from 'lucide-react'
import type { PhoneLinkStatus } from '@shared/types'
import { formatIsoDateTime } from '@shared/format'
import { formatPairCode } from '@shared/syncCrypto'
import { Modal, useEvent, useUi } from '../common/ui'

const api = window.api

/** Settings card: turn the phone link on, pair the Android app (QR code) and manage paired phones. */
export function PhonePanel() {
  const ui = useUi()
  const [st, setSt] = useState<PhoneLinkStatus | null>(null)
  const [qr, setQr] = useState<string>('')
  const [showPair, setShowPair] = useState(false)

  useEffect(() => {
    void api.phoneStatus().then(setSt)
  }, [])

  useEvent(api.onPhoneEvent, (e) => {
    if (e.type === 'status') setSt(e.status)
    else if (e.type === 'paired') {
      setShowPair(false)
      ui.toast(`Paired with ${e.device.name}`, 'success')
    }
  })

  const pairing = st?.pairing ?? null
  useEffect(() => {
    if (!pairing) {
      setQr('')
      return
    }
    void QRCode.toDataURL(pairing.uri, { errorCorrectionLevel: 'M', margin: 2, width: 260, color: { dark: '#000000', light: '#ffffff' } }).then(setQr)
  }, [pairing?.uri]) // eslint-disable-line react-hooks/exhaustive-deps

  const startPairing = async () => {
    const s = await api.phoneStartPairing()
    setSt(s)
    if (s.error) ui.toast(s.error, 'error')
    else setShowPair(true)
  }

  const closePairing = async () => {
    setShowPair(false)
    setSt(await api.phoneCancelPairing())
  }

  if (!st) return null
  const where = st.addresses.length ? st.addresses.join(', ') : 'no network connection'

  return (
    <section className="card">
      <h3>
        <Smartphone size={15} /> Phone app (Android)
      </h3>
      <p className="muted">
        Write reports on your Android phone. When the phone and this PC are on the same Wi-Fi or hotspot, cases, templates, macros
        and reports sync automatically. Nothing goes over the internet.
      </p>

      <div className="phone-status">
        {st.running ? <Wifi size={16} className="ok-text" /> : <WifiOff size={16} className="muted" />}
        <span>
          {st.running ? (
            <>
              Phone link is <b>on</b> – this PC is <b>{st.pcName}</b> at {where} (port {st.port}).
            </>
          ) : st.enabled ? (
            <>Phone link could not start{st.error ? `: ${st.error}` : ''}.</>
          ) : (
            <>Phone link is off.</>
          )}
        </span>
        <div className="spacer" />
        {st.enabled ? (
          <button className="btn btn-small" onClick={async () => setSt(await api.phoneSetEnabled(false))}>
            Turn off
          </button>
        ) : (
          <button className="btn btn-small" onClick={async () => setSt(await api.phoneSetEnabled(true))}>
            Turn on
          </button>
        )}
        <button className="btn btn-small btn-green" onClick={() => void startPairing()}>
          <Smartphone size={14} /> Pair a phone…
        </button>
      </div>

      {st.lastSync && (
        <p className="muted small">
          Last sync: {st.lastSync.device} · {formatIsoDateTime(st.lastSync.at)} · {st.lastSync.summary}
        </p>
      )}

      <div className="phone-devices">
        {st.devices.length === 0 ? (
          <p className="muted small">No phone paired yet.</p>
        ) : (
          st.devices.map((d) => (
            <div key={d.id} className="phone-device">
              <Smartphone size={16} />
              <div className="phone-device-text">
                <b>{d.name}</b>
                <small className="muted">
                  Paired {formatIsoDateTime(d.createdAt)}
                  {d.lastSeen ? ` · last synced ${formatIsoDateTime(d.lastSeen)}${d.lastIp ? ` from ${d.lastIp}` : ''}` : ' · not synced yet'}
                </small>
              </div>
              <button
                className="icon-btn"
                title="Remove this phone (it can no longer sync)"
                onClick={async () => {
                  if (await ui.confirm('Remove phone?', `"${d.name}" will no longer be able to sync with this PC. You can pair it again later.`, 'Remove'))
                    setSt(await api.phoneRemoveDevice(d.id))
                }}
              >
                <Trash size={14} />
              </button>
            </div>
          ))
        )}
      </div>

      <details className="phone-help">
        <summary>Install the app · can't connect? Tips</summary>
        <ul>
          <li>
            Get the app on the phone: on GitHub open this project's <b>Actions › Build Android app</b>, download the{' '}
            <b>PersonalPACS-Android</b> artifact and open the APK (allow installing from your browser/Files app).
          </li>
          <li>Keep Personal PACS open on this PC while syncing (it can be minimised).</li>
          <li>
            The first time, Windows asks whether Personal PACS may use the network – tick <b>both</b> “Private” and “Public” and click
            Allow. (If you clicked Cancel: Windows Security › Firewall › Allow an app through firewall › tick Personal PACS.)
          </li>
          <li>
            The phone's own hotspot is the most reliable: connect this PC to the phone's hotspot. Many hospital Wi-Fi networks block
            devices from talking to each other.
          </li>
          <li>If the phone was lost, remove it above – its key stops working immediately.</li>
        </ul>
      </details>

      {showPair && pairing && (
        <Modal
          title="Pair your phone"
          onClose={() => void closePairing()}
          footer={
            <>
              <span className="muted small modal-note">This code works once and expires at {formatIsoDateTime(pairing.expiresAt).slice(-5)}.</span>
              <div className="spacer" />
              <button className="btn" onClick={() => void closePairing()}>
                Cancel
              </button>
            </>
          }
        >
          <div className="pair-box">
            <div className="pair-qr">{qr ? <img src={qr} alt="Pairing QR code" width={260} height={260} /> : null}</div>
            <ol className="pair-steps">
              <li>Connect the phone and this PC to the same Wi-Fi, or connect this PC to the phone's hotspot.</li>
              <li>
                Open <b>Personal PACS</b> on the phone and tap <b>Scan QR code</b>.
              </li>
              <li>Point the camera at this code. Done – the phone syncs by itself from now on.</li>
            </ol>
            <div className="pair-manual">
              <div className="muted small">No camera? On the phone tap “Enter code” and type:</div>
              <div>
                PC address: <b className="mono">{st.addresses[0] ?? '—'}</b>
                {st.port !== 47820 && <span className="mono">:{st.port}</span>}
              </div>
              <div>
                Code: <b className="mono pair-code">{formatPairCode(pairing.code)}</b>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </section>
  )
}
