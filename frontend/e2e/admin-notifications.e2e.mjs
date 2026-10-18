import { test, expect } from '@playwright/test'
import { cloudFixture } from './cloud-fixture.mjs'

test.use({ timezoneId: 'Europe/Istanbul' })

async function adminPage(page, { delayCreate = false, loseFirstResponse = false } = {}) {
  const recipient = crypto.randomUUID()
  const notifications = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const cloud = await cloudFixture(page, { admin: true, adminHandler: async body => {
    if (body.action === 'users') return { users: [{ id: recipient, name: 'Push Athlete', hasPush: true, workouts: 0 }], invite_only: false }
    if (body.action === 'invites') return { invites: [] }
    if (body.action === 'notifications') return { notifications, has_more: false }
    if (body.action === 'create-notification') {
      if (delayCreate) await gate
      if (!notifications.some(item => item.id === body.request_id)) notifications.unshift({ id: body.request_id, title: body.title.trim(), body: body.message.trim(), audience: body.audience,
        target_name: 'Push Athlete', due_at: body.scheduled_for || new Date().toISOString(), created_at: new Date().toISOString(),
        recipient_count: 1, status: body.scheduled_for ? 'scheduled' : 'sending', can_cancel: true,
        pending: 1, failed: 0, completed: 0, accepted_devices: 0, expired_devices: 0 })
      if (loseFirstResponse) { loseFirstResponse = false; return { httpStatus: 503, body: { error: 'Response unavailable' } } }
      return { id: body.request_id, recipient_count: 1 }
    }
    if (body.action === 'cancel-notification') {
      const item = notifications.find(item => item.id === body.id)
      item.status = 'cancelled'; item.can_cancel = false; item.pending = 0
      return { ok: true }
    }
    throw new Error('Unexpected admin action')
  } })
  await page.goto('/')
  await page.getByLabel('Email', { exact: true }).fill(cloud.user.email)
  await page.getByLabel('Password', { exact: true }).fill(crypto.randomUUID())
  await page.getByRole('button', { name: 'Sign in', exact: true }).last().click()
  await page.goto('/#/admin')
  await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible()
  return { cloud, recipient, release }
}

test('admin schedules a single-recipient notification, sees it in history and cancels pending work', async ({ page }) => {
  const { cloud, recipient } = await adminPage(page)
  await page.getByLabel('Recipients', { exact: true }).selectOption('user')
  await page.getByLabel('User', { exact: true }).selectOption(recipient)
  await page.getByLabel('Notification title').fill('Training update')
  await page.getByLabel('Message', { exact: true }).fill('Your routine is ready.')
  await page.getByLabel('Delivery', { exact: true }).selectOption('scheduled')
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  await page.getByLabel('Send at').fill(tomorrow + 'T14:30')
  await page.getByRole('button', { name: 'Review notification' }).click()
  await page.getByRole('button', { name: 'Confirm notification' }).click()
  await expect(page.getByText('Training update', { exact: true })).toBeVisible()
  const request = cloud.calls.find(call => call.body?.action === 'create-notification').body
  expect(request.audience).toBe('user')
  expect(request.target_user).toBe(recipient)
  expect(request.scheduled_for).toBe(tomorrow + 'T11:30:00.000Z')
  expect(request.request_id).toMatch(/^[a-f0-9-]{36}$/)
  await page.getByRole('button', { name: 'Cancel notification', exact: true }).click()
  await page.getByRole('button', { name: 'Cancel remaining deliveries' }).click()
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible()
  expect(cloud.calls.find(call => call.body?.action === 'cancel-notification').body.id).toBe(request.request_id)
})

test('broadcast requires review, includes all-recipient scope and blocks repeat submission while sending', async ({ page }) => {
  const { cloud, release } = await adminPage(page, { delayCreate: true })
  await page.getByLabel('Notification title').fill('Announcement')
  await page.getByLabel('Message', { exact: true }).fill('A message for everyone.')
  await page.getByRole('button', { name: 'Review notification' }).click()
  await expect(page.getByText('All eligible users', { exact: true }).last()).toBeVisible()
  expect(cloud.calls.some(call => call.body?.action === 'create-notification')).toBe(false)
  await page.getByRole('button', { name: 'Confirm notification' }).click()
  await expect(page.getByRole('button', { name: 'Sending…', exact: true })).toBeDisabled()
  release()
  await expect(page.getByText('Announcement', { exact: true })).toBeVisible()
  const writes = cloud.calls.filter(call => call.body?.action === 'create-notification')
  expect(writes).toHaveLength(1)
  expect(writes[0].body.audience).toBe('all')
  expect(writes[0].body.target_user).toBeNull()
  expect(writes[0].body.scheduled_for).toBeNull()
  await expect(page.getByText('Provider acceptance does not confirm display on a device.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: '/private/tmp/opengym-admin-notifications-mobile.png', fullPage: true })
})

test('uncertain response keeps the draft and reuses the request identifier on retry', async ({ page }) => {
  await page.clock.install()
  const { cloud } = await adminPage(page, { loseFirstResponse: true })
  await page.getByLabel('Notification title').fill('Retry safely')
  await page.getByLabel('Message', { exact: true }).fill('One announcement.')
  await page.getByLabel('Delivery', { exact: true }).selectOption('scheduled')
  const future = new Date(Date.now() + 10 * 60000).toLocaleString('sv-SE', { timeZone: 'Europe/Istanbul' }).slice(0, 16).replace(' ', 'T')
  await page.getByLabel('Send at').fill(future)
  await page.getByRole('button', { name: 'Review notification' }).click()
  await page.getByRole('button', { name: 'Confirm notification' }).click()
  await expect(page.getByRole('alert')).toContainText('Response unavailable')
  await expect(page.getByLabel('Notification title')).toHaveValue('Retry safely')
  // An ambiguous response may be retried after its original due time.
  await page.clock.setSystemTime(new Date(Date.now() + 15 * 60000))
  await page.getByRole('button', { name: 'Review notification' }).click()
  await page.getByRole('button', { name: 'Confirm notification' }).click()
  await expect(page.getByLabel('Notification title')).toHaveValue('')
  const writes = cloud.calls.filter(call => call.body?.action === 'create-notification')
  expect(writes).toHaveLength(2)
  expect(writes[1].body.request_id).toBe(writes[0].body.request_id)
  await expect(page.getByRole('heading', { name: 'Retry safely', exact: true })).toHaveCount(1)
})
