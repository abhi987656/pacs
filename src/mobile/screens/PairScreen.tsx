import { useState } from 'react'
import { QrCode, KeyRound } from 'lucide-react'
import { normalizePairCode, parsePairingUri } from '@shared/syncCrypto'
import type { PairingInfo } from '@shared/syncCrypto'
import type { Nav } from '../App'
import { store } from '../db'
import { deviceName } from '../native'
import { PairError, lookupPc, pairWithPc, sync } from '../sync'
import { QrScanner } from '../QrScanner'
import { Page, useUi } from '../ui'

export function PairScreen({ nav, canCancel }: { nav: Nav; canCancel: boolean }) {
  const ui = useUi()
  const [scanning, setScanning] = useState(false)
  const [manual, setManual] = useState(false)
  const [address, setAddress] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const finish = async (info: PairingInfo) => {
    setError(null)
    const prev = store.meta.pairing
    if (prev && prev.pcId !== info.pcId && store.pendingCount() > 0) {
      const ok = await ui.confirm(
        'Pair with a different PC?',
        `This phone has ${store.pendingCount()} change(s) not yet sent to ${prev.pcName}. They will be removed from this phone.`,
        'Pair anyway',
        true
      )
      if (!ok) return
    }
    setBusy(`Connecting to ${info.pcName}…`)
    try {
      await pairWithPc(info, await deviceName())
      setBusy('Paired – downloading cases and templates…')
      sync.init()
      await sync.sync({ manual: true })
      ui.toast(`Paired with ${store.meta.pairing?.pcName ?? 'your PC'}`, 'success')
      nav.tab({ name: 'cases' })
    } catch (e) {
      setError(e instanceof PairError ? e.message : `Pairing failed: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const pairManually = async () => {
    setError(null)
    const c = normalizePairCode(code)
    if (c.length !== 10) {
      setError('The code has 10 letters/numbers, as shown on the PC (for example ABCDE-23456).')
      return
    }
    setBusy('Looking for the PC…')
    try {
      const pc = await lookupPc(address)
      await finish({ pcId: pc.pcId, pcName: pc.pcName, hosts: [pc.host], port: pc.port, code: c })
    } catch (e) {
      setError(e instanceof PairError ? e.message : String((e as Error).message))
      setBusy(null)
    }
  }

  return (
    <Page title="Connect to your PC" onBack={canCancel ? () => nav.back() : undefined}>
      <div className="m-pad">
        <div className="m-hero">
          <img className="m-hero-logo" src="./logo.png" alt="Personal PACS" />
          <div className="m-muted">Report on your phone, synced with Personal PACS on your PC.</div>
        </div>
        <ol className="m-steps">
          <li>Connect this phone and the PC to the same Wi-Fi – or connect the PC to this phone's hotspot.</li>
          <li>
            On the PC open <b>Settings › Phone app › Pair a phone</b>. A QR code appears.
          </li>
          <li>Scan it here. That's all – the phone then syncs by itself.</li>
        </ol>

        {busy ? (
          <div className="m-card m-busy">
            <div className="m-spinner" /> {busy}
          </div>
        ) : (
          <>
            <button className="m-btn primary big block" onClick={() => setScanning(true)}>
              <QrCode size={20} /> Scan QR code
            </button>
            <button className="m-btn plain block" onClick={() => setManual((m) => !m)}>
              <KeyRound size={18} /> Enter code instead
            </button>
          </>
        )}

        {manual && !busy && (
          <div className="m-card">
            <label className="m-field">
              <span>PC address (shown on the PC)</span>
              <input inputMode="decimal" placeholder="192.168.1.5" value={address} onChange={(e) => setAddress(e.target.value)} />
            </label>
            <label className="m-field">
              <span>Code</span>
              <input
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder="ABCDE-23456"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
              />
            </label>
            <button className="m-btn primary block" disabled={!address.trim() || !code.trim()} onClick={() => void pairManually()}>
              Pair
            </button>
          </div>
        )}

        {error && <div className="m-error">{error}</div>}
        <p className="m-muted small">
          Reports travel only over your own Wi-Fi/hotspot, encrypted with a key made during pairing. No internet or cloud is used.
        </p>
      </div>
      {scanning && (
        <QrScanner
          onClose={() => setScanning(false)}
          onText={(text) => {
            const info = parsePairingUri(text)
            if (!info) return false
            setScanning(false)
            void finish(info)
            return true
          }}
        />
      )}
    </Page>
  )
}
