import { strict as assert } from 'node:assert'
import { Buffer } from 'node:buffer'
// @ts-types="npm:@types/web-push@3.6.4"
import webpush from 'npm:web-push@3.6.7'
import { sendPush } from './web-push.ts'

Deno.test('Web Push generates encrypted payloads using Deno-compatible crypto', async () => {
  const vapid=webpush.generateVAPIDKeys()
  const keys=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits'])
  const p256dh=Buffer.from(await crypto.subtle.exportKey('raw',keys.publicKey)).toString('base64url')
  const auth=Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
  const originalFetch=globalThis.fetch
  const names=['VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT']
  const previous=names.map(name=>Deno.env.get(name))
  Deno.env.set(names[0],vapid.publicKey);Deno.env.set(names[1],vapid.privateKey);Deno.env.set(names[2],'mailto:contact@example.test')
  let called=false
  globalThis.fetch=async (_input,init)=>{
    called=true
    const headers=new Headers(init?.headers)
    assert.equal(headers.get('Content-Encoding'),'aes128gcm')
    assert.equal(headers.get('TTL'),'60')
    assert.ok(headers.get('Authorization')?.startsWith('vapid '))
    assert.equal(init?.redirect,'error')
    assert.ok(init?.body instanceof Uint8Array)
    assert.ok(!(new TextDecoder().decode(init.body)).includes('sensitive workout'))
    return new Response(null,{status:201})
  }
  try {
    assert.equal(await sendPush({endpoint:'https://fcm.googleapis.com/test',keys:{p256dh,auth}}, {title:'sensitive workout'},60),201)
    assert.equal(called,true)
  } finally {
    globalThis.fetch=originalFetch
    names.forEach((name,index)=>previous[index]===undefined?Deno.env.delete(name):Deno.env.set(name,previous[index]!))
  }
})
