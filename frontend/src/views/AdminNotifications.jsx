import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { useUI } from '../store/useUI.js'
import { confirmSheet } from '../sheets.jsx'
import { Button, TextArea, TextField } from '../components/ui.jsx'

const statusLabel = {
  scheduled: 'Scheduled', sending: 'Sending', completed: 'Completed',
  completed_with_errors: 'Completed with errors', cancelled: 'Cancelled'
}
const dateLabel = value => new Date(value).toLocaleString()

export default function AdminNotifications({ users, ownerId }) {
  const [audience, setAudience] = useState('all')
  const [target, setTarget] = useState('')
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [delivery, setDelivery] = useState('now')
  const [sendAt, setSendAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [history, setHistory] = useState(null)
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const request = useRef(null)
  const pending = useRef(false)
  const mounted = useRef(true)
  const toast = useUI(s => s.toast)
  const eligible = (users || []).filter(user => user.hasPush && !user.disabled)
  const refresh = () => setRevision(value => value + 1)

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let active = true, sequence = 0
    setHistory(null)
    const load = async () => {
      const current = ++sequence
      try {
        const result = await api('/api/admin/notifications?offset=' + offset, { expectedId: ownerId })
        if (active && current === sequence) { setHistory(result); setHistoryError('') }
      } catch (e) {
        if (active && current === sequence) setHistoryError(e.message)
      }
    }
    load()
    const timer = setInterval(load, 15000)
    return () => { active = false; clearInterval(timer) }
  }, [offset, revision, ownerId])

  const send = async payload => {
    if (pending.current || !mounted.current) return
    pending.current = true
    setBusy(true)
    setError('')
    try {
      const result = await api('/api/admin/notifications/new', {
        method: 'POST', body: JSON.stringify(payload), expectedId: ownerId
      })
      if (!mounted.current) return
      toast('Notification queued for ' + result.recipient_count + ' users')
      setTitle(''); setMessage(''); setSendAt(''); request.current = null
      setOffset(0); refresh()
    } catch (e) {
      if (mounted.current) setError(e.message + ' Retry the same draft to safely check the original request.')
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const review = event => {
    event.preventDefault()
    if (pending.current) return
    setError('')
    const due = delivery === 'scheduled' ? new Date(sendAt) : null
    if (due && !Number.isFinite(due.getTime())) {
      setError('Choose a future time within 30 days.'); return
    }
    if (!title.trim() || !message.trim() || (audience === 'user' && !eligible.some(user => user.id === target))) {
      setError('Check title, message and recipients.'); return
    }
    const draft = { title: title.trim(), message: message.trim(), audience,
      target_user: audience === 'user' ? target : null, scheduled_for: due?.toISOString() || null }
    const fingerprint = JSON.stringify(draft)
    if (request.current?.fingerprint !== fingerprint && due && (due <= new Date() || due.getTime() > Date.now() + 30 * 86400000)) {
      setError('Choose a future time within 30 days.'); return
    }
    // Keep the same identifier after a lost response; the database deduplicates retries.
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() }
    const payload = { ...draft, request_id: request.current.id }
    confirmSheet({ title: 'Review notification', confirmText: 'Confirm notification', message: <>
      <strong>{draft.title}</strong><p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{draft.message}</p>
      <p>{audience === 'all' ? 'All eligible users' : eligible.find(user => user.id === target)?.name}</p>
      <p>{due ? dateLabel(due) : 'Send now'}</p>
      <small>Only users with active push subscriptions are included. Their enabled devices will be notified.</small>
    </>, onConfirm: () => send(payload) })
  }
  const cancel = item => confirmSheet({ title: 'Cancel notification?', confirmText: 'Cancel remaining deliveries', danger: true,
    message: 'Stop pending deliveries for “' + item.title + '”? Notifications already handed to a provider cannot be recalled.',
    onConfirm: async () => {
      if (pending.current || !mounted.current) return
      pending.current = true; setBusy(true)
      try {
        await api('/api/admin/notifications/cancel', { method: 'POST', body: JSON.stringify({ id: item.id }), expectedId: ownerId })
        if (mounted.current) { toast('Remaining deliveries cancelled'); refresh() }
      } catch (e) { if (mounted.current) setError(e.message) }
      finally { pending.current = false; if (mounted.current) setBusy(false) }
    }
  })

  return <section className="card admin-notifications" aria-labelledby="admin-notifications-title">
    <h2 id="admin-notifications-title">Notifications</h2>
    <p className="small muted">Send an announcement now or schedule it up to 30 days ahead. Recipients are selected when you confirm.</p>
    <form onSubmit={review}>
      <fieldset disabled={busy}>
        <label>Recipients<select aria-label="Recipients" className="field" value={audience} onChange={e => setAudience(e.target.value)}>
          <option value="all">All eligible users</option><option value="user">One user</option>
        </select></label>
        {audience === 'user' && <label>User<select aria-label="User" className="field" value={target} required onChange={e => setTarget(e.target.value)}>
          <option value="">Choose a user</option>
          {eligible.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
        </select></label>}
        <label>Notification title<TextField value={title} onChange={e => setTitle(e.target.value)} maxLength={80} required /></label>
        <label>Message<TextArea value={message} onChange={e => setMessage(e.target.value)} maxLength={500} required /></label>
        <label>Delivery<select aria-label="Delivery" className="field" value={delivery} onChange={e => setDelivery(e.target.value)}>
          <option value="now">Send now</option><option value="scheduled">Schedule</option>
        </select></label>
        {delivery === 'scheduled' && <label>Send at<TextField aria-label="Send at" type="datetime-local" value={sendAt} onChange={e => setSendAt(e.target.value)} required />
          <span className="small muted">Your timezone: {Intl.DateTimeFormat().resolvedOptions().timeZone}. Delivery may be delayed by the device or provider.</span>
        </label>}
        <Button variant="primary" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Review notification'}</Button>
      </fieldset>
    </form>
    {error && <p role="alert" className="small" style={{ color: 'var(--red)' }}>{error}</p>}
    <div className="row between" style={{ marginTop: 24 }}><h3>Notification history</h3><Button size="sm" onClick={refresh}>Refresh history</Button></div>
    <p className="small muted">History is kept for 90 days. <span>Provider acceptance does not confirm display on a device.</span></p>
    {historyError && <p role="alert" className="small" style={{ color: 'var(--red)' }}>{historyError}</p>}
    {!history && !historyError && <p className="small muted" role="status">Loading notifications…</p>}
    {history?.notifications.length === 0 && <p className="small muted">No notifications yet.</p>}
    {history?.notifications.map(item => <article key={item.id} className="admin-notification-entry">
      <div className="row between" style={{ gap: 8, alignItems: 'flex-start' }}>
        <h4 style={{ margin: 0, overflowWrap: 'anywhere' }}>{item.title}</h4><span className="tag">{statusLabel[item.status] || item.status}</span>
      </div>
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.body}</p>
      <p className="small muted">{item.audience === 'all' ? 'All eligible users' : item.target_name || 'Deleted user'} · {item.recipient_count} users · {dateLabel(item.due_at)}</p>
      <p className="small muted">Pending users: {item.pending} · Completed users: {item.completed} · Failed users: {item.failed}</p>
      <p className="small muted">Provider accepted: {item.accepted_devices} devices · Expired subscriptions: {item.expired_devices}</p>
      {item.interrupted_users > 0 && <p className="small muted">Cancelled while sending to {item.interrupted_users} users. Provider counts may be incomplete; in-flight notifications cannot be recalled.</p>}
      {item.can_cancel && <Button variant="danger" size="sm" disabled={busy} onClick={() => cancel(item)}>Cancel notification</Button>}
    </article>)}
    {(offset > 0 || history?.has_more) && <div className="row between" style={{ marginTop: 12 }}>
      <Button size="sm" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 20))}>Previous page</Button>
      <Button size="sm" disabled={!history?.has_more} onClick={() => setOffset(value => value + 20)}>Next page</Button>
    </div>}
  </section>
}
