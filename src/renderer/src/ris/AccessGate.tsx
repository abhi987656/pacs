/**
 * Sign-in and access screens: the software opens only for an approved account (the user
 * software) or a master account (the master software). Approved computers keep working offline
 * for 7 days after their last check with the server.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Clock, KeyRound, LogOut, RefreshCw, ShieldAlert, ShieldCheck, WifiOff } from 'lucide-react'
import logoMark from '../assets/logo-mark.png'
import type { AccessState } from '@shared/types'
import { useEvent } from '../common/ui'

const api = window.api

export function useAccess(): AccessState | null {
  const [s, setS] = useState<AccessState | null>(null)
  useEffect(() => {
    void api.getAccess().then(setS)
  }, [])
  useEvent(api.onAccessChanged, setS)
  return s
}

const appName = (s: AccessState) => (s.edition === 'master' ? 'Personal PACS Master' : 'Personal PACS')
const daysLeft = (until?: number) => (until ? Math.max(0, Math.ceil((until - Date.now()) / 86400000)) : 0)

export function AccessGate({ children }: { children: ReactNode }) {
  const s = useAccess()
  if (!s) return <div className="access-screen" />
  if (s.status === 'approved' || s.status === 'off') {
    return (
      <>
        {children}
        {s.offlineUntil && (
          <div className="offline-pill" title="The server could not be reached; this computer's approval is used until then.">
            <WifiOff size={13} /> Offline – {daysLeft(s.offlineUntil)} day{daysLeft(s.offlineUntil) === 1 ? '' : 's'} left
          </div>
        )}
      </>
    )
  }
  return <AccessScreen s={s} />
}

function AccessScreen({ s }: { s: AccessState }) {
  const [busy, setBusy] = useState(false)
  const run = async (job: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await job()
    } finally {
      setBusy(false)
    }
  }
  const actions = (...buttons: ('check' | 'again' | 'out')[]) => (
    <div className="access-actions">
      {buttons.includes('check') && (
        <button className="btn btn-green" disabled={busy} onClick={() => void run(api.checkAccess)}>
          <RefreshCw size={15} /> Check again
        </button>
      )}
      {buttons.includes('again') && (
        <button className="btn btn-green" disabled={busy} onClick={() => void run(api.askAccessAgain)}>
          <KeyRound size={15} /> Ask again
        </button>
      )}
      {buttons.includes('out') && (
        <button className="btn btn-gray" disabled={busy} onClick={() => void run(api.signOut)}>
          <LogOut size={15} /> Sign out
        </button>
      )}
    </div>
  )
  const who = s.email ? (
    <p className="access-who">
      {s.name && s.name !== s.email ? `${s.name} · ` : ''}
      {s.email}
    </p>
  ) : null
  let body: ReactNode
  switch (s.status) {
    case 'checking':
      body = <p className="access-text">Checking your access…</p>
      break
    case 'signed-out':
      body = <SignInForm s={s} />
      break
    case 'pending':
      body = (
        <>
          <h2>
            <Clock size={20} /> Request sent
          </h2>
          {who}
          <p className="access-text">Your request is waiting for approval by the administrator. {appName(s)} opens as soon as it is approved.</p>
          {actions('check', 'out')}
        </>
      )
      break
    case 'denied':
    case 'revoked':
      body = (
        <>
          <h2>
            <ShieldAlert size={20} /> {s.status === 'denied' ? 'Request declined' : 'Access withdrawn'}
          </h2>
          {who}
          <p className="access-text">
            {s.status === 'denied' ? 'The administrator declined this request.' : 'The administrator has withdrawn this account’s access.'} You can ask again.
          </p>
          {actions('again', 'check', 'out')}
        </>
      )
      break
    case 'device-limit':
      body = (
        <>
          <h2>
            <ShieldAlert size={20} /> Computer limit reached
          </h2>
          {who}
          <p className="access-text">
            This account is already used on {s.devices ?? s.maxDevices} computer{(s.devices ?? s.maxDevices) === 1 ? '' : 's'} – it may be used on {s.maxDevices}. Ask the
            administrator to allow more computers, or to remove one you no longer use.
          </p>
          {actions('check', 'out')}
        </>
      )
      break
    case 'not-admin':
      body = (
        <>
          <h2>
            <ShieldAlert size={20} /> Not a master account
          </h2>
          {who}
          <p className="access-text">The master software opens only with a master account. Sign in with yours.</p>
          {actions('out')}
        </>
      )
      break
    case 'offline':
      body = (
        <>
          <h2>
            <WifiOff size={20} /> No connection
          </h2>
          {who}
          <p className="access-text">{s.message}</p>
          <p className="access-text dim">An approved computer keeps working for 7 days after its last check with the server.</p>
          {actions('check', 'out')}
        </>
      )
      break
    default:
      body = (
        <>
          <h2>
            <ShieldAlert size={20} /> Something went wrong
          </h2>
          {who}
          <p className="access-text">{s.message}</p>
          {actions('check', 'out')}
        </>
      )
  }
  return (
    <div className="access-screen">
      <div className="access-card">
        <div className="access-brand">
          <img src={logoMark} alt="" width={40} height={40} />
          <div>
            <div className="access-app">{appName(s)}</div>
            <div className="access-sub">{s.edition === 'master' ? 'Approves the users of Personal PACS' : 'DICOM viewer and reporting'}</div>
          </div>
        </div>
        {body}
      </div>
    </div>
  )
}

function SignInForm({ s }: { s: AccessState }) {
  const master = s.edition === 'master'
  const [mode, setMode] = useState<'in' | 'up'>('in')
  const [name, setName] = useState('')
  const [email, setEmail] = useState(s.email ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [local, setLocal] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setLocal(null)
    if (mode === 'up' && !name.trim()) return setLocal('Enter your name.')
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setLocal('Enter your email address.')
    if (password.length < 6) return setLocal('The password needs at least 6 characters.')
    setBusy(true)
    try {
      if (mode === 'up') await api.signUp(name.trim(), email.trim(), password)
      else await api.signIn(email.trim(), password)
    } finally {
      setBusy(false)
    }
  }
  const message = local ?? s.message
  return (
    <form className="access-form" onSubmit={(e) => void submit(e)}>
      {!master ? (
        <div className="seg access-tabs">
          <button type="button" className={mode === 'in' ? 'active' : ''} onClick={() => setMode('in')}>
            Sign in
          </button>
          <button type="button" className={mode === 'up' ? 'active' : ''} onClick={() => setMode('up')}>
            Create account
          </button>
        </div>
      ) : (
        <h2>
          <ShieldCheck size={20} /> Master sign-in
        </h2>
      )}
      {mode === 'up' && (
        <label className="field">
          <span>Name</span>
          <input autoFocus value={name} maxLength={120} placeholder="Dr. Firstname Lastname" onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      <label className="field">
        <span>Email</span>
        <input autoFocus={mode === 'in'} type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        <span>Password</span>
        <input type="password" value={password} maxLength={128} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {message && <div className="access-error">{message}</div>}
      <button className="btn btn-green full" type="submit" disabled={busy}>
        {busy ? 'Please wait…' : mode === 'up' ? 'Create account and ask for access' : 'Sign in'}
      </button>
      {!master && (
        <p className="access-text dim">
          {mode === 'up' ? 'After creating the account, the administrator approves it before you can use Personal PACS.' : 'New here? Create an account – the administrator then approves it.'}
        </p>
      )}
    </form>
  )
}
