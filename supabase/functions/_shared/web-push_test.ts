import { strict as assert } from 'node:assert'
import { Buffer } from 'node:buffer'
// @ts-types="npm:@types/web-push@3.6.4"
import webpush from 'npm:web-push@3.6.7'
import { sendPush } from './web-push.ts'

async function hkdf(input: Uint8Array, salt: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', new Uint8Array(input), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(salt), info: new Uint8Array(info) }, key, bytes * 8))
}

// Verify the wire payload with Web Crypto and RFC 8291, independently of web-push's encoder.
// Fixtures fit one AES-GCM record; this is not a general-purpose message decoder.
async function decryptPayload(body: Uint8Array, receiver: CryptoKeyPair, auth: Uint8Array) {
  const text = new TextEncoder()
  const salt = body.slice(0, 16)
  const senderPublic = body.slice(21, 21 + body[20])
  assert.equal(senderPublic.length, 65)
  const sender = await crypto.subtle.importKey('raw', senderPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: sender }, receiver.privateKey, 256))
  const receiverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', receiver.publicKey))
  const info = new Uint8Array([...text.encode('WebPush: info\0'), ...receiverPublic, ...senderPublic])
  const input = await hkdf(shared, auth, info, 32)
  const key = await hkdf(input, salt, text.encode('Content-Encoding: aes128gcm\0'), 16)
  const iv = await hkdf(input, salt, text.encode('Content-Encoding: nonce\0'), 12)
  const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt'])
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aes, body.slice(21 + body[20])))
  let delimiter = plaintext.length - 1
  while (delimiter >= 0 && plaintext[delimiter] === 0) delimiter--
  assert.equal(plaintext[delimiter], 2)
  return JSON.parse(new TextDecoder().decode(plaintext.slice(0, delimiter)))
}

Deno.test('Web Push generates encrypted payloads using Deno-compatible crypto', async () => {
  const payload = { title: 'sensitive workout', body: 'Test notification ✅', tag: 'test' }
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
    const body = new Uint8Array(init.body)
    const secret = new Uint8Array(Buffer.from(auth, 'base64url'))
    assert.deepEqual(await decryptPayload(body, keys, secret), payload)
    const tampered = body.slice()
    tampered[tampered.length - 1] ^= 1
    await assert.rejects(decryptPayload(tampered, keys, secret), { name: 'OperationError' })
    await assert.rejects(decryptPayload(body, keys, crypto.getRandomValues(new Uint8Array(16))), { name: 'OperationError' })
    return new Response(null,{status:201})
  }
  try {
    assert.equal(await sendPush({endpoint:'https://fcm.googleapis.com/test',keys:{p256dh,auth}}, payload,60),201)
    assert.equal(called,true)
  } finally {
    globalThis.fetch=originalFetch
    names.forEach((name,index)=>previous[index]===undefined?Deno.env.delete(name):Deno.env.set(name,previous[index]!))
  }
})
