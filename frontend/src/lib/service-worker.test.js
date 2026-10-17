import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

it('does not cache email/OAuth callbacks or cross-origin authenticated responses', () => {
  const listeners = {}
  runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), {
    self: {
      addEventListener: (name, listener) => {
        listeners[name] = listener
      }
    },
    URL,
    location: { origin: 'https://gym.example' }
  })
  for (const url of [
    'https://gym.example/?code=one-time',
    'https://gym.example/?token_hash=one-time&type=recovery',
    'https://project.supabase.co/rest/v1/user_states'
  ]) {
    let intercepted = false
    listeners.fetch({
      request: { method: 'GET', url },
      respondWith: () => {
        intercepted = true
      }
    })
    expect(intercepted).toBe(false)
  }
})
