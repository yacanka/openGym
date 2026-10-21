export async function detachSubscription(serviceWorker, remove) {
  const registration = await serviceWorker?.getRegistration()
  const subscription = await registration?.pushManager?.getSubscription()
  if (!subscription) return
  try {
    await remove(subscription.endpoint)
  } finally {
    await subscription.unsubscribe()
  }
}
export async function reconcileSubscription(serviceWorker, isBound) {
  const registration = await serviceWorker?.getRegistration()
  const subscription = await registration?.pushManager?.getSubscription()
  if (!subscription) return false
  if (await isBound(subscription.endpoint)) return true
  await subscription.unsubscribe()
  return false
}
