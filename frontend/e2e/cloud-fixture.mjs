// Contract doubles for the hosted network boundary. SQL policies and transactions
// are tested separately against PostgreSQL; no real provider credentials are used.
export async function cloudFixture(page, { admin = false, adminHandler } = {}) {
  const id = crypto.randomUUID(),
    sessionId = crypto.randomUUID()
  const email = 'athlete@example.test'
  const user = {
    id,
    email,
    aud: 'authenticated',
    role: 'authenticated',
    email_confirmed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    app_metadata: { provider: 'email' },
    user_metadata: { name: 'Test Athlete' }
  }
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const access = [
    encode({ alg: 'HS256', typ: 'JWT' }),
    encode({ sub: id, session_id: sessionId, exp: Math.floor(Date.now() / 1000) + 3600 }),
    crypto.randomUUID()
  ].join('.')
  const session = {
    access_token: access,
    refresh_token: crypto.randomUUID(),
    expires_in: 3600,
    token_type: 'bearer',
    user
  }
  const calls = []
  let saved = null,
    version = 0
  await page.route('http://127.0.0.1:55441/**', async (route) => {
    const request = route.request(),
      url = new URL(request.url())
    const body = request.postDataJSON()
    calls.push({ path: url.pathname, body, url })
    let result = {},
      status = 200
    if (url.pathname === '/auth/v1/token') result = session
    else if (url.pathname === '/auth/v1/user') result = user
    else if (url.pathname === '/auth/v1/signup') result = user
    else if (url.pathname === '/rest/v1/rpc/account_status')
      result = { id, name: 'Test Athlete', allowed: true, admin, disabled: false }
    else if (url.pathname === '/functions/v1/admin' && adminHandler) {
      result = await adminHandler(body)
      if (result.httpStatus) { status = result.httpStatus; result = result.body }
    }
    else if (url.pathname === '/rest/v1/user_states')
      result = saved ? [{ state: saved, version }] : []
    else if (url.pathname === '/rest/v1/rpc/save_user_state') {
      if (body.expected_version !== version) result = { status: 'conflict', state: saved, version }
      else {
        saved = body.state
        version++
        result = { status: 'saved', version }
      }
    } else if (url.pathname === '/auth/v1/logout') status = 204
    else if (url.pathname === '/auth/v1/authorize')
      return route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<h1>OAuth provider boundary</h1>'
      })
    await route.fulfill({
      status,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: status === 204 ? undefined : JSON.stringify(result)
    })
  })
  return { calls, user, state: () => saved }
}

