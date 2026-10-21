import { it, expect } from 'vitest'
import { detachSubscription, reconcileSubscription } from './push-session.js'
function browser() {
  let detached = false
  const subscription = {
    endpoint: 'https://fcm.googleapis.com/test',
    unsubscribe: async () => {
      detached = true
    }
  }
  return {
    serviceWorker: {
      getRegistration: async () => ({ pushManager: { getSubscription: async () => subscription } })
    },
    detached: () => detached
  }
}
it('unsubscribes locally even if the old cloud subscription cannot be removed', async () => {
  const b = browser()
  await expect(
    detachSubscription(b.serviceWorker, async () => {
      throw new Error('offline')
    })
  ).rejects.toThrow('offline')
  expect(b.detached()).toBe(true)
})
it('detaches subscriptions belonging to another or revoked session', async () => {
  const b = browser()
  expect(await reconcileSubscription(b.serviceWorker, async () => false)).toBe(false)
  expect(b.detached()).toBe(true)
})
it('retains a subscription confirmed to belong to the current session', async () => {
  const b = browser()
  expect(await reconcileSubscription(b.serviceWorker, async () => true)).toBe(true)
  expect(b.detached()).toBe(false)
})
