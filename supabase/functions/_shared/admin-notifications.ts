import { HttpError } from './http.ts'

export function notificationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, 'Invalid notification identifier')
  }
  return value
}
export function notificationArgs(body: Record<string, unknown>) {
  if (typeof body.title !== 'string' || typeof body.message !== 'string'
    || typeof body.audience !== 'string' || !['all','user'].includes(body.audience)
    || (body.audience === 'all' && body.target_user !== null)
    || (body.scheduled_for !== null && (typeof body.scheduled_for !== 'string' || !Number.isFinite(Date.parse(body.scheduled_for))))) {
    throw new HttpError(400, 'Check title, message and recipients')
  }
  return {
    message_title: body.title, message_body: body.message, audience: body.audience,
    target_user: body.audience === 'user' ? notificationId(body.target_user) : null,
    scheduled_for: body.scheduled_for, request_id: notificationId(body.request_id)
  }
}
