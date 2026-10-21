// @ts-types="npm:@types/web-push@3.6.4"
import webpush from 'npm:web-push@3.6.7'
import { env } from './http.ts'
import { validPushEndpoint } from './push-endpoint.ts'
export type Subscription = { endpoint: string; keys: { auth: string; p256dh: string } }

export async function sendPush(subscription: Subscription, payload: unknown, ttl: number): Promise<number> {
  if (!validPushEndpoint(subscription.endpoint)) return 410
  const details = webpush.generateRequestDetails(subscription, JSON.stringify(payload), {
    urgency: 'high', TTL: Math.max(0, Math.min(900, ttl)),
    vapidDetails: { subject: env('VAPID_SUBJECT'), publicKey: env('VAPID_PUBLIC_KEY'), privateKey: env('VAPID_PRIVATE_KEY') }
  })
  const response = await fetch(details.endpoint, {
    method: 'POST', headers: details.headers as Record<string,string>, body: new Uint8Array(details.body!),
    redirect: 'error', signal: AbortSignal.timeout(5000)
  })
  await response.body?.cancel()
  return response.status
}
