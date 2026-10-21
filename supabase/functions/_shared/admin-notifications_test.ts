import { strict as assert } from 'node:assert'
import { notificationArgs, notificationId } from './admin-notifications.ts'
import { HttpError } from './http.ts'

Deno.test('notification request validates scope, identifiers and timestamp at the Edge boundary', () => {
  const id = crypto.randomUUID()
  assert.deepEqual(notificationArgs({ title:'Title',message:'Body',audience:'all',target_user:null,scheduled_for:null,request_id:id }), {
    message_title:'Title',message_body:'Body',audience:'all',target_user:null,scheduled_for:null,request_id:id
  })
  for (const patch of [
    { request_id:'bad' }, { title:[] }, { message:{} }, { audience:'everyone' }, { audience:['all'] },
    { target_user:id }, { audience:'user',target_user:null }, { scheduled_for:'not-a-date' }, { scheduled_for:17 }
  ]) {
    assert.throws(() => notificationArgs({ title:'Title',message:'Body',audience:'all',target_user:null,scheduled_for:null,request_id:id,...patch }),
      (error: unknown) => error instanceof HttpError && error.status === 400)
  }
  assert.equal(notificationId(id), id)
  assert.throws(() => notificationId('not-an-id'), (error: unknown) => error instanceof HttpError && error.status === 400)
})
