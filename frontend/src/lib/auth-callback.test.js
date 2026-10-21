import { it, expect } from 'vitest'
import { handleAuthCallback } from './auth-callback.js'

it('exchanges a PKCE code once and removes sensitive callback parameters', async () => {
  let code, cleaned
  const result = await handleAuthCallback(
    {
      exchangeCodeForSession: async (value) => {
        code = value
        return { data: {}, error: null }
      }
    },
    'https://gym.example/?code=temporary#/home',
    (value) => {
      cleaned = value
    }
  )
  expect(code).toBe('temporary')
  expect(cleaned).toBe('/#/home')
  expect(result.recovery).toBe(false)
})
it('accepts a recovery email token without depending on the original browser', async () => {
  let received
  const result = await handleAuthCallback(
    {
      verifyOtp: async (value) => {
        received = value
        return { error: null }
      }
    },
    'https://gym.example/?token_hash=hashed&type=recovery',
    () => {}
  )
  expect(received).toEqual({ token_hash: 'hashed', type: 'recovery' })
  expect(result.recovery).toBe(true)
})
it('cleans failed and expired callbacks without hiding the error', async () => {
  let cleaned
  await expect(
    handleAuthCallback(
      { exchangeCodeForSession: async () => ({ error: new Error('Expired link') }) },
      'https://gym.example/?code=expired',
      (value) => {
        cleaned = value
      }
    )
  ).rejects.toThrow('Expired link')
  expect(cleaned).toBe('/#/home')
})
it('does not interpret application hash routes as OAuth tokens', async () => {
  expect(
    await handleAuthCallback({}, 'https://gym.example/#/plan', () => {
      throw new Error('unexpected cleanup')
    })
  ).toEqual({ handled: false, recovery: false })
})
