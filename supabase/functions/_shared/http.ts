import { createClient } from 'npm:@supabase/supabase-js@2.118.0'

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}
export function env(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error('Missing server configuration')
  return value
}
export function serverClient() {
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { global: { fetch: timedFetch }, auth: { persistSession: false, autoRefreshToken: false } })
}
const timedFetch: typeof fetch = (input, options) => fetch(input, { ...options,
  signal: options?.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) })
export async function authorize(req: Request, admin = false) {
  const authorization = req.headers.get('Authorization') || ''
  if (!authorization.startsWith('Bearer ')) throw new HttpError(401, 'Sign in required')
  const client = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authorization }, fetch: timedFetch }, auth: { persistSession: false, autoRefreshToken: false }
  })
  const { data: identity, error } = await client.auth.getUser(authorization.slice(7))
  if (error || !identity.user) throw new HttpError(401, 'Session expired')
  const { data: account, error: accessError } = await client.rpc('account_status')
  if (accessError || !account?.allowed || (admin && !account.admin)) throw new HttpError(403, 'Access denied')
  return client
}
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  const reader = req.body?.getReader()
  if (!reader) return {}
  let size = 0
  const chunks: Uint8Array[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > 8192) { await reader.cancel(); throw new HttpError(413, 'Request too large') }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes))
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
    return body
  } catch { throw new HttpError(400, 'Invalid JSON') }
}
export function handler(run: (req: Request) => Promise<unknown>) {
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get('Origin')
    const allowed = (Deno.env.get('APP_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean)
    if (origin && !allowed.includes(origin)) return new Response('Forbidden origin', { status: 403 })
    const headers: Record<string, string> = {
      'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin',
      'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS'
    }
    if (origin) headers['Access-Control-Allow-Origin'] = origin
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
    try {
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed')
      return new Response(JSON.stringify(await run(req)), { headers })
    } catch (error) {
      const known = error instanceof HttpError
      if (!known) console.error('edge_request_failed', { name: error instanceof Error ? error.name : 'unknown' })
      return new Response(JSON.stringify({ error: known ? error.message : 'Request failed' }), { status: known ? error.status : 500, headers })
    }
  }
}
export function databaseError(error: { code?: string; message?: string } | null) {
  if (!error) return
  if (error.code === '42501') throw new HttpError(403, 'Access denied')
  if (error.code === '22023') throw new HttpError(400, error.message || 'Invalid request')
  if (error.code === 'P0002') throw new HttpError(404, 'Record not found')
  throw new Error('Database request failed')
}
