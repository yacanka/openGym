// Feature compatibility boundary: Supabase operations, never the retired Node API.
import { rpc, invoke } from './supabase.js'
export const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
export const IS_ANDROID = /Android/.test(navigator.userAgent)

export async function api(path, opts = {}) {
  const body = opts.body ? JSON.parse(opts.body) : {}
  const url = new URL(path, location.origin)
  switch (url.pathname) {
    case '/api/activity': return rpc('update_activity', { activity: body })
    case '/api/push/rest-timer': return rpc('schedule_rest', { seconds: body.seconds })
    case '/api/push/rest-timer/cancel': return rpc('cancel_rest')
    case '/api/push/public-key': return invoke('push', { action: 'public-key' })
    case '/api/push/subscribe': return invoke('push', { ...body, action: 'subscribe' })
    case '/api/push/unsubscribe': return invoke('push', { ...body, action: 'unsubscribe' })
    case '/api/push/test': return invoke('push', { action: 'test' })
    case '/api/admin/users': return invoke('admin', { action: 'users' })
    case '/api/admin/notifications': return invoke('admin', { action: 'notifications', offset: Number(url.searchParams.get('offset') || 0) }, opts.expectedId)
    case '/api/admin/notifications/new': return invoke('admin', { ...body, action: 'create-notification' }, opts.expectedId)
    case '/api/admin/notifications/cancel': return invoke('admin', { ...body, action: 'cancel-notification' }, opts.expectedId)
    case '/api/admin/user': return invoke('admin', { action: 'user', id: url.searchParams.get('id') })
    case '/api/admin/user/disable': return invoke('admin', { ...body, action: 'disable' })
    case '/api/admin/invites': return invoke('admin', { action: 'invites' })
    case '/api/admin/invites/new': return invoke('admin', { ...body, action: 'new-invite' })
    case '/api/admin/invites/revoke': return invoke('admin', { ...body, action: 'revoke-invite' })
    default: throw new Error('Unsupported operation')
  }
}
