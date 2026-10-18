import { test, expect } from '@playwright/test'

import { cloudFixture } from './cloud-fixture.mjs'

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
