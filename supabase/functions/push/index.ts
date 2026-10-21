import { authorize, databaseError, env, handler, HttpError, readBody } from '../_shared/http.ts'
import { validPushEndpoint } from '../_shared/push-endpoint.ts'

Deno.serve(handler(async req => {
  const client = await authorize(req)
  const body = await readBody(req)
  if (body.action === 'public-key') return { key: env('VAPID_PUBLIC_KEY') }
  let result
  switch (body.action) {
    case 'subscribe': {
      const sub = body.subscription as { endpoint?: string; keys?: unknown } | undefined
      if (!validPushEndpoint(sub?.endpoint)) throw new HttpError(400, 'Unsupported push service')
      result = await client.rpc('put_push_subscription', { subscription: sub }); break
    }
    case 'unsubscribe': result = await client.rpc('remove_push_subscription', { endpoint: String(body.endpoint || '') }); break
    case 'test': result = await client.rpc('request_test_push'); break
    default: throw new HttpError(400, 'Unknown push operation')
  }
  databaseError(result.error)
  return result.data
}))
