import { test, expect } from '@playwright/test'

// Contract doubles for the hosted network boundary. SQL policies and transactions
// are tested separately against PostgreSQL; no real provider credentials are used.
async function cloudFixture(page) {
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
      result = { id, name: 'Test Athlete', allowed: true, admin: false, disabled: false }
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

test('email registration asks for confirmation and does not upload local guest data', async ({
  page
}) => {
  const cloud = await cloudFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Create account', exact: true }).first().click()
  await page.getByLabel('Your name', { exact: true }).fill('Test Athlete')
  await page.getByLabel('Email', { exact: true }).fill(cloud.user.email)
  await page.getByLabel('Password', { exact: true }).fill(crypto.randomUUID())
  await page.getByRole('button', { name: 'Create account', exact: true }).last().click()
  await expect(page.getByRole('status')).toContainText('Check your email')
  expect(cloud.calls.find((call) => call.path === '/auth/v1/signup').body.data).toEqual({
    name: 'Test Athlete'
  })
  expect(cloud.state()).toBeNull()
})
test('email login reaches account settings and normal logout returns to sign in', async ({
  page
}) => {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  const cloud = await cloudFixture(page)
  await page.goto('/')
  await page.getByLabel('Email', { exact: true }).fill(cloud.user.email)
  await page.getByLabel('Password', { exact: true }).fill(crypto.randomUUID())
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click()
  await page.goto('/#/settings')
  await expect(page.getByText('Test Athlete', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible()
  expect(
    cloud.calls.some(
      (call) => call.path === '/auth/v1/logout' && call.url.searchParams.get('scope') === 'local'
    )
  ).toBe(true)
  expect(errors).toEqual([])
})
test('Google uses PKCE with a static frontend return URL', async ({ page }) => {
  const cloud = await cloudFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await expect(page.getByRole('heading', { name: 'OAuth provider boundary' })).toBeVisible()
  const call = cloud.calls.find((call) => call.path === '/auth/v1/authorize')
  expect(call.url.searchParams.get('provider')).toBe('google')
  expect(call.url.searchParams.get('redirect_to')).toBe('http://127.0.0.1:5179/')
  expect(call.url.searchParams.get('code_challenge_method')).toBe('s256')
})
test('guest mode still allows training without an account', async ({ page }) => {
  await cloudFixture(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Continue without account' }).click()
  await page.goto('/#/settings')
  await expect(page.getByText('Load starter plan (PPL)', { exact: true })).toBeVisible()
  await expect(page.getByText('Export backup (JSON)', { exact: true })).toBeVisible()
})
