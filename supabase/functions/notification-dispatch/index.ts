import { env, handler, HttpError, serverClient } from '../_shared/http.ts'
import { dispatch } from '../_shared/dispatch.ts'
import { sendPush } from '../_shared/web-push.ts'

Deno.serve(handler(async req => {
  const expected = new TextEncoder().encode(env('DISPATCH_SECRET'))
  const actual = new TextEncoder().encode(req.headers.get('x-dispatch-secret') || '')
  let difference = expected.length ^ actual.length
  for (let i=0; i<expected.length; i++) difference |= expected[i] ^ (actual[i] || 0)
  if (difference !== 0 || expected.length < 32) throw new HttpError(401, 'Unauthorized scheduler')
  return await dispatch(serverClient(), sendPush)
}))
