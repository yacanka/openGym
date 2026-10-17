import { strict as assert } from 'node:assert'
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import { dispatch } from './dispatch.ts'

function fixture(cancel=false) {
  const job={id:crypto.randomUUID(),lease:crypto.randomUUID(),payload:{title:'Rest over'},expires_at:new Date(Date.now()+60000).toISOString()}
  const sub={endpoint:'https://fcm.googleapis.com/test',keys:{auth:'generated-by-browser',p256dh:'generated-by-browser'}}
  let checks=0,finished: boolean|undefined,delivered=false,gone=false
  const client={rpc:async(name:string,args:Record<string,unknown>={})=>{
    if(name==='claim_notifications')return {data:[job],error:null}
    if(name==='notification_targets'){checks++;return {data:cancel&&checks>1?[]:[sub],error:null}}
    if(name==='record_notification_delivery'){delivered=true;gone=!!args.gone;return {data:null,error:null}}
    if(name==='finish_notification'){finished=!!args.success;return {data:null,error:null}}
    throw new Error('Unexpected RPC')
  }} as unknown as SupabaseClient
  return {client,result:()=>({finished,delivered,gone})}
}
Deno.test('cancelled claim is rechecked before outbound send',async()=>{
  const f=fixture(true)
  await dispatch(f.client,()=>{throw new Error('cancelled job must not send')})
  assert.deepEqual(f.result(),{finished:true,delivered:false,gone:false})
})
Deno.test('permanent push expiry records delivery and removes the subscription',async()=>{
  const f=fixture();await dispatch(f.client,async()=>410)
  assert.deepEqual(f.result(),{finished:true,delivered:true,gone:true})
})
Deno.test('temporary provider failure leaves the job retryable',async()=>{
  const f=fixture();await dispatch(f.client,async()=>503)
  assert.deepEqual(f.result(),{finished:false,delivered:false,gone:false})
})
