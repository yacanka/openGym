import { authorize, databaseError, handler, HttpError, readBody } from '../_shared/http.ts'

Deno.serve(handler(async req => {
  const client = await authorize(req, true)
  const body = await readBody(req)
  let result
  switch (body.action) {
    case 'users': result = await client.rpc('admin_users'); break
    case 'user': result = await client.rpc('admin_user', { id: body.id }); break
    case 'disable':
      if (typeof body.disabled !== 'boolean') throw new HttpError(400, 'Invalid account status')
      result = await client.rpc('admin_set_disabled', { id: body.id, disabled: body.disabled }); break
    case 'invites': result = await client.rpc('admin_invites'); break
    case 'new-invite': result = await client.rpc('admin_new_invite', { note: String(body.note || '') }); break
    case 'revoke-invite': result = await client.rpc('admin_revoke_invite', { code: String(body.code || '') }); break
    default: throw new HttpError(400, 'Unknown admin operation')
  }
  databaseError(result.error)
  return result.data
}))
