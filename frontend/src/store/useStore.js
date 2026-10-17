import { create } from 'zustand'
import { requireSupabase, supabase, rpc, invoke, sessionHeader } from '../lib/supabase.js'
import { createAccountSync } from '../lib/account-sync.js'
import { handleAuthCallback } from '../lib/auth-callback.js'
import { detachSubscription, reconcileSubscription } from '../lib/push-session.js'
import { localTZ } from '../lib/format.js'
import { registerCustom } from '../lib/exercises.js'
import { DEMO, DEMO_SEEDED } from '../lib/demo.js'
import { MOBILE, nativeLoad, nativeSave, syncReminder } from '../lib/mobile.js'

const KEY = 'gym_state_v1'
export const DEF = {
  unit: 'kg', restSec: 90, sound: true, keepAwake: true, lang: 'en',
  theme: 'dark', accent: 'lime', body: 'male', targetW: null,
  bodyweight: [], routines: [], week: {}, dayPlan: {},
  exWeights: {}, workouts: [], active: null, customEx: [], gifSize: 'full',
  // effort: which per-set effort scale is logged — 'none' | 'rir' | 'rpe'. null, not 'none', so
  // that a profile which never chose (loaded state is overlaid on DEF, on every path: local,
  // server pull, backup import) still falls back to the `showRir` boolean this replaced and
  // keeps the column it had. See effortOf.
  reminder: { on: false, time: '08:00', tz: null }, effort: null
}
const clone = o => JSON.parse(JSON.stringify(o))

function loadState() {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return Object.assign(clone(DEF), JSON.parse(raw))
  } catch (e) { /* ignore */ }
  return clone(DEF)
}

const hasData = st => !!((st.workouts || []).length || (st.routines || []).length || (st.bodyweight || []).length)

export const useStore = create((set, get) => {
  let pushTm = null
  let saveTm = null
  let bootPromise = null
  let authGeneration = 0
  const localOnly = MOBILE || DEMO
  const sync = createAccountSync({
    storage: localStorage,
    empty: () => clone(DEF),
    remote: {
      async load(id) {
        const headers = await sessionHeader(id)
        const { data, error } = await requireSupabase().from('user_states').select('state,version,updated_at').eq('user_id', id).maybeSingle().setHeader('Authorization', headers.Authorization)
        if (error) throw error
        return data
      },
      save: (id, state, expected_version, mutation_id) => rpc('save_user_state', { state, expected_version, mutation_id }, id)
    },
    onState(state) {
      const S = Object.assign(clone(DEF), state)
      registerCustom(S.customEx)
      set({ S })
    },
    onStatus(record) {
      set({ syncStatus: { dirty: record.dirty, conflict: record.conflict, backup: record.backup, error: record.error } })
    }
  })
  const persist = (S, push = true) => {
    S._ts = Date.now()
    registerCustom(S.customEx)
    if (localOnly) {
      localStorage.setItem(KEY, JSON.stringify(S))
      set({ S })
      if (MOBILE) {
        clearTimeout(saveTm)
        saveTm = setTimeout(() => { saveTm = null; nativeSave(get().S); syncReminder(get().S) }, 800)
      }
      return
    }
    sync.update(S, push)
    if (push && get().user?.allowed) {
      clearTimeout(pushTm)
      pushTm = setTimeout(() => get().pushState(), 1500)
    }
  }
  const selectUser = async session => {
    const generation = ++authGeneration
    if (!session) {
      clearTimeout(pushTm)
      sessionStorage.removeItem('gym_recovery')
      set({ user: null, accountError: null, recovery: false })
      sync.select(null)
      return
    }
    try {
      const user = await rpc('account_status')
      if (generation !== authGeneration) return
      const changed = get().user?.id !== user.id
      if (changed) {
        try {
          await reconcileSubscription(navigator.serviceWorker, endpoint => rpc('push_subscription_status', { endpoint }, user.id))
        } catch {
          // A binding that cannot be confirmed must not follow an account switch.
          try { await detachSubscription(navigator.serviceWorker, async () => {}) } catch { /* Browser unavailable. */ }
        }
        if (generation !== authGeneration) return
      }
      set({ user, accountError: null })
      localStorage.removeItem('gym_guest')
      if (changed) sync.select(user.id)
      if (user.allowed) {
        await sync.sync()
        const tz = localTZ()
        if (generation === authGeneration && get().S.reminder?.on && get().S.reminder.tz !== tz) {
          get().update(s => { s.reminder = { ...s.reminder, tz } })
        }
      }
    } catch (e) {
      if (generation !== authGeneration) return
      if (e.status === 403) {
        set({ user: null, accountError: e.message })
        sync.select(null)
      } else {
        // Offline access is limited to this already-authenticated account's cache.
        set({ user: { id: session.user.id, name: session.user.user_metadata?.name || 'Athlete', allowed: true, admin: false }, accountError: e.message })
        sync.select(session.user.id)
      }
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (MOBILE && saveTm) { clearTimeout(saveTm); saveTm = null; nativeSave(get().S) }
      if (pushTm) { clearTimeout(pushTm); pushTm = null; get().pushState() }
    } else if (!localOnly) get().refreshAuth()
  })
  window.addEventListener('online', () => { if (!localOnly) get().refreshAuth() })

  const initialState = localOnly ? loadState() : clone(DEF)
  registerCustom(initialState.customEx)
  return {
    S: initialState, user: null, ready: false,
    accountError: null, recovery: false,
    syncStatus: { dirty: false, conflict: null, backup: null, error: null },
    update(mut, push = true) { const S=clone(get().S); mut(S); persist(S,push) },
    replaceState(S,push=false) { persist(clone(S),push) },
    isGuest: () => localStorage.getItem('gym_guest') === '1',
    setGuest(v) {
      if (v) localStorage.setItem('gym_guest','1'); else localStorage.removeItem('gym_guest')
      set({})
    },
    async refreshAuth() {
      if (!supabase || localOnly) return
      const { data, error } = await supabase.auth.getSession()
      if (error) { set({ accountError: error.message }); return }
      await selectUser(data.session)
    },
    async pushState() {
      if (localOnly || !get().user?.allowed) return
      clearTimeout(pushTm)
      await sync.sync()
    },
    async pullState() { if (!localOnly && get().user?.allowed) await sync.sync() },
    async resolveConflict(choice) { await sync.resolve(choice) },
    guestData: () => sync.guest(),
    hasGuestData: () => hasData(sync.guest()),
    async importGuest() {
      if (!get().user?.allowed) return
      persist(clone(sync.guest()))
      await get().pushState()
    },
    async signOut() {
      await get().pushState()
      if (supabase) {
        // Detach this browser's subscription before switching accounts on a shared device.
        try { await detachSubscription(navigator.serviceWorker, endpoint => invoke('push', { action: 'unsubscribe', endpoint })) }
        catch { /* Session revocation additionally gates dispatch. */ }
        const { error } = await supabase.auth.signOut({ scope: 'local' })
        if (error) throw error
      }
      await selectUser(null)
      localStorage.removeItem('gym_guest')
      sessionStorage.removeItem('gym_recovery')
      set({})
    },
    async signOutAll() {
      await get().pushState()
      try { await detachSubscription(navigator.serviceWorker, endpoint => invoke('push', { action: 'unsubscribe', endpoint })) }
      catch { /* Global revocation also invalidates every subscription binding. */ }
      const { error } = await requireSupabase().auth.signOut({ scope: 'global' })
      if (error) throw error
      await selectUser(null)
      localStorage.removeItem('gym_guest')
      sessionStorage.removeItem('gym_recovery')
      set({})
    },
    finishRecovery() { sessionStorage.removeItem('gym_recovery'); set({ recovery: false }) },
    async resetDemo() {
      const { buildDemoState } = await import('../lib/demoSeed.js')
      persist(Object.assign(clone(DEF),buildDemoState()),false)
    },
    boot() {
      if (bootPromise) return bootPromise
      bootPromise = (async () => {
        if (MOBILE) {
          const saved=await nativeLoad()
          if (saved && (!hasData(get().S) || (saved._ts||0)>=(get().S._ts||0))) persist(Object.assign(clone(DEF),saved),false)
          else if (hasData(get().S)) nativeSave(get().S)
          get().setGuest(true); syncReminder(get().S); set({ ready: true }); return
        }
        if (DEMO) {
          if (!localStorage.getItem(DEMO_SEEDED)) { localStorage.setItem(DEMO_SEEDED,'1'); await get().resetDemo() }
          get().setGuest(true); set({ ready: true }); return
        }
        // Preserve pre-migration data without silently attaching it to a new account.
        if (localStorage.getItem(KEY) && !localStorage.getItem('gym_legacy_backup_v1')) {
          localStorage.setItem('gym_legacy_backup_v1',localStorage.getItem(KEY))
          if (!localStorage.getItem('gym_user') && !localStorage.getItem('gym_account_v2:guest')) {
            sync.select(null); sync.update(loadState(),false)
          }
        }
        sync.select(null)
        if (!supabase) { set({ ready:true,accountError:'Supabase is not configured.' }); return }
        try {
          const callback=await handleAuthCallback(supabase.auth,location.href,url=>history.replaceState(null,'',url))
          if (callback.recovery) sessionStorage.setItem('gym_recovery','1')
          await get().refreshAuth()
          set({ recovery:sessionStorage.getItem('gym_recovery')==='1' })
        } catch (e) { set({ accountError:e.message }) }
        supabase.auth.onAuthStateChange(event => {
          if (event==='PASSWORD_RECOVERY') { sessionStorage.setItem('gym_recovery','1'); set({recovery:true}) }
          // Supabase auth callbacks hold a lock: make API calls after returning.
          if (event!=='INITIAL_SESSION') setTimeout(()=>get().refreshAuth(),0)
        })
        set({ready:true})
      })()
      return bootPromise
    }
  }
})

export { hasData }
