import { useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { authRedirect, requireSupabase, rpc, supabase } from '../lib/supabase.js'
import { t } from '../lib/i18n.js'
import { Button } from './ui.jsx'

function Feedback({ error, message }) {
  return (
    <>
      {error && (
        <p role="alert" className="auth-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="small">
          {message}
        </p>
      )}
    </>
  )
}
export function AuthForm({ onDone }) {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const run = async (task) => {
    if (busy) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await task()
    } catch (e) {
      setError(e.message || t('Request failed'))
    } finally {
      setBusy(false)
    }
  }
  const submit = (e) => {
    e.preventDefault()
    run(async () => {
      const auth = requireSupabase().auth
      let result
      if (mode === 'register')
        result = await auth.signUp({
          email: email.trim(),
          password,
          options: { data: { name: name.trim() }, emailRedirectTo: authRedirect() }
        })
      else if (mode === 'reset')
        result = await auth.resetPasswordForEmail(email.trim(), {
          redirectTo: authRedirect() + '?flow=recovery'
        })
      else result = await auth.signInWithPassword({ email: email.trim(), password })
      if (result.error) throw result.error
      setPassword('')
      if (mode === 'login' || result.data?.session) {
        await useStore.getState().refreshAuth()
        onDone?.()
      } else
        setMessage(
          t('Check your email to continue. If an account exists, you will receive a message.')
        )
    })
  }
  return (
    <div className="auth-form">
      <div className="auth-actions">
        {['login', 'register'].map((value) => (
          <Button
            key={value}
            type="button"
            disabled={busy}
            variant={mode === value ? 'primary' : 'plain'}
            onClick={() => {
              setMode(value)
              setError('')
              setMessage('')
            }}
          >
            {t(value === 'login' ? 'Sign in' : 'Create account')}
          </Button>
        ))}
      </div>
      <form onSubmit={submit}>
        {mode === 'register' && (
          <label>
            {t('Your name')}
            <input
              className="field"
              name="name"
              autoComplete="name"
              maxLength={40}
              value={name}
              required
              onChange={(e) => setName(e.target.value)}
            />
          </label>
        )}
        <label>
          {t('Email')}
          <input
            className="field"
            name="email"
            type="email"
            autoComplete="email"
            value={email}
            required
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        {mode !== 'reset' && (
          <label>
            {t('Password')}
            <input
              className="field"
              name="password"
              type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              minLength={mode === 'register' ? 8 : undefined}
              value={password}
              required
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        )}
        <Button type="submit" variant="primary" disabled={busy || !supabase}>
          {busy
            ? t('Please wait…')
            : t(
                mode === 'register'
                  ? 'Create account'
                  : mode === 'reset'
                  ? 'Send reset email'
                  : 'Sign in'
              )}
        </Button>
      </form>
      <Button
        type="button"
        disabled={busy || !supabase}
        onClick={() =>
          run(async () => {
            const { error } = await requireSupabase().auth.signInWithOAuth({
              provider: 'google',
              options: { redirectTo: authRedirect() }
            })
            if (error) throw error
          })
        }
      >
        {t('Continue with Google')}
      </Button>
      <div className="auth-actions">
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setMode('reset')
            setError('')
            setMessage('')
          }}
        >
          {t('Forgot password?')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy || !email || !supabase}
          onClick={() =>
            run(async () => {
              const { error } = await requireSupabase().auth.resend({
                type: 'signup',
                email: email.trim(),
                options: { emailRedirectTo: authRedirect() }
              })
              if (error) throw error
              setMessage(
                t('Check your email to continue. If an account exists, you will receive a message.')
              )
            })
          }
        >
          {t('Resend verification email')}
        </Button>
      </div>
      <Feedback error={error} message={message} />
    </div>
  )
}

export function PasswordForm({ recovery = false }) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  return (
    <form
      className="auth-form"
      onSubmit={async (e) => {
        e.preventDefault()
        if (busy) return
        setBusy(true)
        setError('')
        setMessage('')
        try {
          const { error } = await requireSupabase().auth.updateUser({ password })
          if (error) throw error
          setPassword('')
          setMessage(t('Password updated'))
          if (recovery) useStore.getState().finishRecovery()
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy(false)
        }
      }}
    >
      <label>
        {t('New password')}
        <input
          className="field"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <Button type="submit" variant="primary" disabled={busy}>
        {t('Save password')}
      </Button>
      <Feedback error={error} message={message} />
    </form>
  )
}

export function AccountGate() {
  const { user, recovery, accountError } = useStore()
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <main className="narrow auth-gate">
      <h1>
        {t(
          recovery
            ? 'Choose a new password'
            : user?.disabled
            ? 'Account disabled'
            : 'Invite code required'
        )}
      </h1>
      {recovery ? (
        <PasswordForm recovery />
      ) : user?.needs_invite && !user.disabled ? (
        <form
          className="auth-form"
          onSubmit={async (e) => {
            e.preventDefault()
            if (busy) return
            setBusy(true)
            setError('')
            try {
              await rpc('redeem_invite', { code })
              await useStore.getState().refreshAuth()
            } catch (e) {
              setError(e.message)
            } finally {
              setBusy(false)
            }
          }}
        >
          <label>
            {t('Invite code')}
            <input
              className="field"
              required
              maxLength={40}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </label>
          <Button type="submit" disabled={busy}>
            {t('Continue')}
          </Button>
        </form>
      ) : (
        <p>{t('Contact the administrator to restore access.')}</p>
      )}
      <Feedback error={error || accountError} />
      <Button
        variant="ghost"
        onClick={() =>
          useStore
            .getState()
            .signOut()
            .catch((e) => setError(e.message))
        }
      >
        {t('Sign out')}
      </Button>
    </main>
  )
}

export function AccountSettings() {
  const { user, syncStatus } = useStore()
  const toast = useUI((s) => s.toast)
  const [showPassword, setShowPassword] = useState(false)
  if (!user) return <AuthForm />
  return (
    <div className="auth-form account-settings">
      <p>
        <strong>{user.name}</strong>
        <br />
        <span className="small muted">
          {t(syncStatus.dirty ? 'Changes waiting to sync' : 'Your data syncs with your profile.')}
        </span>
      </p>
      {useStore.getState().hasGuestData() && (
        <Button
          onClick={() =>
            useUI.getState().openSheet((close) => (
              <div className="auth-form">
                <h3>{t('Import guest data?')}</h3>
                <p>
                  {t(
                    'This replaces this account’s data with the guest data on this device. Export a backup first.'
                  )}
                </p>
                <Button
                  variant="primary"
                  onClick={async () => {
                    await useStore.getState().importGuest()
                    close()
                  }}
                >
                  {t('Import')}
                </Button>
              </div>
            ))
          }
        >
          {t('Import guest data')}
        </Button>
      )}
      {localStorage.getItem('gym_legacy_backup_v1') && (
        <Button
          onClick={() =>
            downloadJSON(
              JSON.parse(localStorage.getItem('gym_legacy_backup_v1')),
              'opengym-legacy-backup.json'
            )
          }
        >
          {t('Export pre-migration backup')}
        </Button>
      )}
      <Button onClick={() => setShowPassword(!showPassword)}>{t('Set or change password')}</Button>
      {showPassword && <PasswordForm />}
      <Button
        onClick={() =>
          useStore
            .getState()
            .pushState()
            .catch((e) => toast(e.message))
        }
      >
        {t('Sync now')}
      </Button>
      <Button
        onClick={() =>
          useStore
            .getState()
            .signOut()
            .catch((e) => toast(e.message))
        }
      >
        {t('Sign out')}
      </Button>
      <Button
        onClick={() =>
          useUI.getState().openSheet((close) => (
            <div className="auth-form">
              <h3>{t('Sign out everywhere?')}</h3>
              <p>{t('This ends every session for your account.')}</p>
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    await useStore.getState().signOutAll()
                    close()
                  } catch (e) {
                    toast(e.message)
                  }
                }}
              >
                {t('Sign out everywhere')}
              </Button>
            </div>
          ))
        }
      >
        {t('Sign out everywhere')}
      </Button>
    </div>
  )
}
export function downloadJSON(state, filename) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })
  )
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
export function SyncNotice() {
  const { user, syncStatus } = useStore()
  const [busy, setBusy] = useState(false)
  if (!user) return null
  const resolve = async (choice) => {
    setBusy(true)
    try {
      await useStore.getState().resolveConflict(choice)
    } finally {
      setBusy(false)
    }
  }
  if (syncStatus.conflict)
    return (
      <aside className="narrow card auth-form sync-notice" role="alert">
        <h2>{t('Choose which data to keep')}</h2>
        <p>
          {t(
            'This device and another device changed your data. Both copies are preserved until you choose.'
          )}
        </p>
        <div className="auth-actions">
          <Button disabled={busy} onClick={() => resolve('local')}>
            {t('Use this device’s data')}
          </Button>
          <Button disabled={busy} onClick={() => resolve('cloud')}>
            {t(
              syncStatus.conflict.source === 'tab' ? 'Use the other tab’s data' : 'Use cloud data'
            )}
          </Button>
        </div>
        <div className="auth-actions">
          <Button onClick={() => downloadJSON(useStore.getState().S, 'opengym-local.json')}>
            {t('Export local copy')}
          </Button>
          <Button onClick={() => downloadJSON(syncStatus.conflict.state, 'opengym-cloud.json')}>
            {t('Export cloud copy')}
          </Button>
        </div>
      </aside>
    )
  if (syncStatus.error)
    return (
      <aside className="narrow card sync-notice" role="status">
        {t('Sync unavailable. Your changes remain on this device.')}
        <p>{syncStatus.error}</p>
        {syncStatus.backup && (
          <Button onClick={() => downloadJSON(syncStatus.backup, 'opengym-conflict-backup.json')}>
            {t('Export preserved conflict copy')}
          </Button>
        )}
        <Button onClick={() => useStore.getState().refreshAuth()}>{t('Retry')}</Button>
      </aside>
    )
  if (syncStatus.backup)
    return (
      <aside className="narrow card sync-notice">
        <Button onClick={() => downloadJSON(syncStatus.backup, 'opengym-conflict-backup.json')}>
          {t('Export preserved conflict copy')}
        </Button>
      </aside>
    )
  return null
}
