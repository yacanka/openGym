import { strict as assert } from 'node:assert'
import { validPushEndpoint } from './push-endpoint.ts'
import { handler, HttpError, readBody } from './http.ts'

Deno.test('push endpoints reject SSRF, credentials, ports and suffix spoofing', () => {
  for (const host of ['https://fcm.googleapis.com/send/x','https://updates.push.services.mozilla.com/wpush/v2/x','https://web.push.apple.com/x','https://a.notify.windows.com/x']) assert.equal(validPushEndpoint(host),true)
  for (const host of ['http://fcm.googleapis.com/x','https://127.0.0.1/x','https://169.254.169.254/x','https://fcm.googleapis.com.evil.test/x','https://fcm.googleapis.com@evil.test/x','https://user@fcm.googleapis.com/x','https://fcm.googleapis.com:9999/x']) assert.equal(validPushEndpoint(host),false)
})
Deno.test('body parser rejects oversized and non-object JSON', async () => {
  for(const body of ['[]','null','{bad','x'.repeat(8193)]) await assert.rejects(readBody(new Request('https://example.test',{method:'POST',body})))
  assert.deepEqual(await readBody(new Request('https://example.test',{method:'POST',body:'{"action":"test"}'})),{action:'test'})
})
Deno.test('CORS allows configured origins and denies arbitrary origins', async () => {
  Deno.env.set('APP_ORIGINS','https://gym.example')
  const run=handler(async()=>({ok:true}))
  assert.equal((await run(new Request('https://service.test',{method:'POST',headers:{Origin:'https://evil.test'}}))).status,403)
  const allowed=await run(new Request('https://service.test',{method:'OPTIONS',headers:{Origin:'https://gym.example'}}))
  assert.equal(allowed.status,204);assert.equal(allowed.headers.get('Access-Control-Allow-Origin'),'https://gym.example')
})
Deno.test('errors do not expose internal request data', async () => {
  const response=await handler(async()=>{throw new Error('internal database detail')})(new Request('https://service.test',{method:'POST'}))
  assert.equal(response.status,500);assert.deepEqual(await response.json(),{error:'Request failed'})
  const denied=await handler(async()=>{throw new HttpError(401,'Sign in required')})(new Request('https://service.test',{method:'POST'}))
  assert.equal(denied.status,401)
})
