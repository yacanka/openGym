import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import type { Subscription } from './web-push.ts'
import { databaseError } from './http.ts'

type Job = { id: string; lease: string; payload: unknown; expires_at: string }
export async function dispatch(client: SupabaseClient, send: (sub: Subscription, payload: unknown, ttl: number) => Promise<number>) {
  const claim = await client.rpc('claim_notifications')
  databaseError(claim.error)
  const jobs = (claim.data || []) as Job[]
  for (const job of jobs) {
    let success = true
    const args = { job: job.id, token: job.lease }
    const targets = await client.rpc('notification_targets', args)
    databaseError(targets.error)
    // Bound concurrency and per-invocation work within the 60s lease.
    const subscriptions = ((targets.data || []) as Subscription[]).slice(0,10)
    for (let start = 0; start < subscriptions.length; start += 5) {
      const results = await Promise.all(subscriptions.slice(start,start+5).map(async sub => {
        try {
          const valid = await client.rpc('notification_targets', args)
          databaseError(valid.error)
          if (!(valid.data as Subscription[]).some(item => item.endpoint === sub.endpoint)) return true
          const ttl = Math.floor((Date.parse(job.expires_at) - Date.now()) / 1000)
          if (ttl <= 0) return true
          const status = await send(sub, job.payload, ttl)
          const gone = status === 404 || status === 410
          if ((status >= 200 && status < 300) || gone) {
            const saved = await client.rpc('record_notification_delivery', { ...args, endpoint: sub.endpoint, gone })
            databaseError(saved.error)
            return true
          }
          return false
        } catch { return false }
      }))
      if (results.some(result => !result)) success = false
    }
    const finished = await client.rpc('finish_notification', { ...args, success })
    databaseError(finished.error)
    if (!success) console.warn('notification_retry_scheduled', { job: job.id })
  }
  return { processed: jobs.length }
}
