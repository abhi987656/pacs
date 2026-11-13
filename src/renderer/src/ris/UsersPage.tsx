/**
 * Master software: the people who asked to use Personal PACS. Approve a request (with the number
 * of computers the account may use), decline it, withdraw access, change the computer limit or
 * free a computer's place.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Monitor, RefreshCw, Trash2, Undo2, X } from 'lucide-react'
import type { AccessAdminData, AccessDevice, AccessMember, MemberStatus } from '@shared/types'
import { useUi } from '../common/ui'

const api = window.api

type Tab = 'pending' | 'approved' | 'closed' | 'all'
const TABS: { id: Tab; label: string }[] = [
  { id: 'pending', label: 'Requests' },
  { id: 'approved', label: 'Approved' },
  { id: 'closed', label: 'Declined / withdrawn' },
  { id: 'all', label: 'All' }
]
const STATUS_LABEL: Record<MemberStatus, string> = { pending: 'Waiting', approved: 'Approved', denied: 'Declined', revoked: 'Withdrawn' }

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '')

/** Waiting requests, refreshed every minute (for the badge on the side bar). */
export function usePendingCount(enabled: boolean): [number, (n: number) => void] {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let stop = false
    const load = () =>
      api
        .adminList()
        .then((d) => !stop && setN(d.members.filter((m) => m.status === 'pending').length))
        .catch(() => {})
    void load()
    const t = setInterval(load, 60000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [enabled])
  return [n, setN]
}

export function UsersPage({ onPending }: { onPending?: (n: number) => void }) {
  const ui = useUi()
  const [data, setData] = useState<AccessAdminData | null>(null)
  const [tab, setTab] = useState<Tab>('pending')
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [limits, setLimits] = useState<Record<string, number>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await api.adminList()
      setData(d)
      setError(null)
      onPending?.(d.members.filter((m) => m.status === 'pending').length)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [onPending])
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 30000)
    return () => clearInterval(t)
  }, [load])

  const devicesOf = useMemo(() => {
    const m = new Map<string, AccessDevice[]>()
    for (const d of data?.devices ?? []) m.set(d.user_id, [...(m.get(d.user_id) ?? []), d])
    return m
  }, [data])
  const counts = useMemo(() => {
    const c: Record<Tab, number> = { pending: 0, approved: 0, closed: 0, all: 0 }
    for (const m of data?.members ?? []) {
      c.all++
      if (m.status === 'pending') c.pending++
      else if (m.status === 'approved') c.approved++
      else c.closed++
    }
    return c
  }, [data])
  const rows = (data?.members ?? []).filter((m) => tab === 'all' || (tab === 'closed' ? m.status === 'denied' || m.status === 'revoked' : m.status === tab))

  const act = async (key: string, job: () => Promise<void>, done: string) => {
    setBusy(key)
    try {
      await job()
      ui.toast(done, 'success')
      await load()
    } catch (e) {
      ui.toast((e as Error).message, 'error')
    } finally {
      setBusy(null)
    }
  }
  const limitOf = (m: AccessMember) => limits[m.user_id] ?? m.max_devices
  const decide = (m: AccessMember, status: MemberStatus) =>
    act(
      m.user_id,
      () => api.adminDecide(m.user_id, status, status === 'approved' ? limitOf(m) : undefined),
      status === 'approved' ? `${m.name} approved (${limitOf(m)} computer${limitOf(m) === 1 ? '' : 's'})` : status === 'denied' ? `${m.name} declined` : `${m.name}: access withdrawn`
    )
  const remove = async (m: AccessMember) => {
    const ok = await ui.confirm('Delete this request?', `${m.name} (${m.email}) is removed from the list. If they sign in again, a new request appears.`, 'Delete')
    if (ok) await act(m.user_id, () => api.adminDeleteMember(m.user_id), `${m.name} removed`)
  }
  const saveLimit = (m: AccessMember) => {
    if (limitOf(m) === m.max_devices) return
    void act(m.user_id, () => api.adminSetDevices(m.user_id, limitOf(m)), `${m.name} may use ${limitOf(m)} computer${limitOf(m) === 1 ? '' : 's'}`)
  }

  return (
    <div className="users-page">
      <header className="topbar">
        <div className="brand">
          Personal <span>PACS</span> Master
        </div>
        <div className="topbar-title">Users</div>
        <div className="topbar-actions">
          <button className="btn" onClick={() => void load()} title="Refresh (also every 30 seconds)">
            <RefreshCw size={15} /> Refresh
          </button>
        </div>
      </header>
      <div className="users-body">
        <div className="seg users-tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label} <span className="users-count">{counts[t.id]}</span>
            </button>
          ))}
        </div>
        {error && <div className="users-error">{error}</div>}
        {!data && !error && <p className="muted">Loading…</p>}
        {data && rows.length === 0 && <p className="muted users-empty">{tab === 'pending' ? 'No requests waiting.' : 'Nobody here.'}</p>}
        {rows.length > 0 && (
          <table className="users-table">
            <thead>
              <tr>
                <th />
                <th>Name</th>
                <th>Email</th>
                <th>Asked</th>
                <th>Status</th>
                <th>Computers</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const devs = devicesOf.get(m.user_id) ?? []
                const expanded = open.has(m.user_id)
                const toggle = () =>
                  setOpen((o) => {
                    const n = new Set(o)
                    if (n.has(m.user_id)) n.delete(m.user_id)
                    else n.add(m.user_id)
                    return n
                  })
                return (
                  <Fragment key={m.user_id}>
                    <tr className={`st-${m.status}`}>
                      <td>
                        <button className="icon-btn" onClick={toggle} title="Computers" disabled={!devs.length}>
                          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </button>
                      </td>
                      <td className="users-name">{m.name}</td>
                      <td>{m.email}</td>
                      <td className="muted">{when(m.requested_at)}</td>
                      <td>
                        <span className={`users-status st-${m.status}`}>{STATUS_LABEL[m.status]}</span>
                      </td>
                      <td>
                        <span className="users-limit" title="Computers used / computers allowed">
                          {devs.length} /
                          <input
                            type="number"
                            min={1}
                            max={100}
                            value={limitOf(m)}
                            onChange={(e) => setLimits((l) => ({ ...l, [m.user_id]: Math.max(1, Math.min(100, Number(e.target.value) || 1)) }))}
                            onBlur={() => m.status === 'approved' && saveLimit(m)}
                            onKeyDown={(e) => e.key === 'Enter' && m.status === 'approved' && saveLimit(m)}
                          />
                        </span>
                      </td>
                      <td>
                        <div className="users-actions">
                        {m.status !== 'approved' && (
                          <button className="btn btn-green btn-small" disabled={busy === m.user_id} onClick={() => void decide(m, 'approved')}>
                            <Check size={14} /> Approve
                          </button>
                        )}
                        {m.status === 'pending' && (
                          <button className="btn btn-red-outline btn-small" disabled={busy === m.user_id} onClick={() => void decide(m, 'denied')}>
                            <X size={14} /> Decline
                          </button>
                        )}
                        {m.status === 'approved' && (
                          <button className="btn btn-red-outline btn-small" disabled={busy === m.user_id} onClick={() => void decide(m, 'revoked')}>
                            <Undo2 size={14} /> Withdraw
                          </button>
                        )}
                        {(m.status === 'denied' || m.status === 'revoked') && (
                          <button className="btn btn-small" disabled={busy === m.user_id} onClick={() => void remove(m)} title="Delete this request">
                            <Trash2 size={14} />
                          </button>
                        )}
                        </div>
                      </td>
                    </tr>
                    {expanded &&
                      devs.map((d) => (
                        <tr key={d.id} className="users-device">
                          <td />
                          <td colSpan={2}>
                            <Monitor size={13} /> {d.name || 'Computer'} <span className="muted">· {d.platform} · version {d.app_version || '?'}</span>
                          </td>
                          <td className="muted" colSpan={2}>
                            last used {when(d.last_seen)}
                          </td>
                          <td colSpan={2}>
                            <button
                              className="btn btn-small"
                              disabled={busy === d.id}
                              title="Frees this computer's place (for example after the person changed computers)"
                              onClick={() => void act(d.id, () => api.adminRemoveDevice(d.id), `${d.name || 'Computer'} removed`)}
                            >
                              <Trash2 size={13} /> Remove computer
                            </button>
                          </td>
                        </tr>
                      ))}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
        <p className="muted users-note">
          New accounts wait here until you approve them. The number under Computers is how many computers the account may be used on; lowering it does not
          remove computers already in use – remove them with the arrow on the left. Withdrawn accounts are locked at their next start with internet (an
          approved computer works offline for up to 7 days).
        </p>
      </div>
    </div>
  )
}
