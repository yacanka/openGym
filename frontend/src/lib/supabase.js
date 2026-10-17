import { createClient } from '@supabase/supabase-js'
import { MOBILE } from './mobile.js'
import { DEMO } from './demo.js'
import { fetchWithTimeout } from './request.js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY
export const supabase =
  !MOBILE && !DEMO && url && key
    ? createClient(url, key, {
        global: { fetch: fetchWithTimeout },
        auth: {
          flowType: 'pkce',
          detectSessionInUrl: false,
          persistSession: true,
          autoRefreshToken: true
        }
      })
    : null
export function requireSupabase() {
  if (!supabase)
    throw new Error(
      'Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY before building.'
    )
  return supabase
}
export const authRedirect = () => location.origin + location.pathname
export async function sessionHeader(expectedId) {
  const { data, error } = await requireSupabase().auth.getSession()
  if (error) throw error
  if (!data.session || (expectedId && data.session.user.id !== expectedId))
    throw new Error('Account changed. Please sync again.')
  return { Authorization: 'Bearer ' + data.session.access_token }
}
export async function rpc(name, args = {}, expectedId) {
  // Pin the token before creating the request: a concurrent account switch must
  // never attach another account's credentials to an older queued state upload.
  const headers = await sessionHeader(expectedId)
  const { data, error } = await requireSupabase()
    .rpc(name, args)
    .setHeader('Authorization', headers.Authorization)
  if (error) {
    const failure = new Error(error.message || 'Request failed')
    failure.status = error.code === '42501' ? 403 : 400
    failure.definitive = ['22023', '22P02', '23514', '23502'].includes(error.code)
    throw failure
  }
  return data
}
export async function invoke(name, body) {
  const headers = await sessionHeader()
  const { data, error } = await requireSupabase().functions.invoke(name, { body, headers })
  if (error) {
    let message = 'Request failed. Please try again.'
    if (error.context instanceof Response) {
      const failure = await error.context.json().catch(() => null)
      if (failure?.error) message = failure.error
    }
    throw new Error(message)
  }
  return data
}
