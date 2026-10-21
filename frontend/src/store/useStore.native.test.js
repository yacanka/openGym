import { it, expect, vi } from 'vitest'

vi.mock('../lib/mobile.js', () => ({
  MOBILE: true,
  nativeLoad: async () => null,
  nativeSave: async () => {},
  syncReminder: async () => true
}))

it('retains native local data and custom exercises without a Supabase configuration', async () => {
  const values = new Map([
    [
      'gym_state_v1',
      JSON.stringify({
        customEx: [{ id: 'custom-native-test', n: 'Local custom exercise' }],
        workouts: [],
        routines: []
      })
    ]
  ])
  vi.stubGlobal('localStorage', {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  })
  vi.stubGlobal('document', new EventTarget())
  vi.stubGlobal('window', new EventTarget())
  try {
    const { useStore } = await import('./useStore.js')
    const { exOr } = await import('../lib/exercises.js')
    await useStore.getState().boot()
    expect(useStore.getState().ready).toBe(true)
    expect(useStore.getState().isGuest()).toBe(true)
    expect(useStore.getState().user).toBeNull()
    expect(exOr('custom-native-test').n).toBe('Local custom exercise')
    expect(values.has('gym_account_v2:guest')).toBe(false)
  } finally {
    vi.unstubAllGlobals()
  }
})
