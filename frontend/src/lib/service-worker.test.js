import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

function loadWorker(globals = {}) {
  const listeners = {}
  runInNewContext(readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8'), {
    self: {
      addEventListener: (name, listener) => {
        listeners[name] = listener
      }
    },
    URL,
    location: { origin: 'https://gym.example' },
    ...globals
  })
  return listeners
}

it('does not cache email/OAuth callbacks or cross-origin authenticated responses', () => {
  const listeners = loadWorker()
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

it.each([['succeeds', false], ['fails', true]])('keeps a consumed network response usable when a delayed cache write %s', async (_outcome, cacheFails) => {
  let openCache
  const cacheReady = new Promise(resolve => { openCache = resolve })
  const background = []
  const lifetime = []
  const warnings = []
  let cachedBody
  const listeners = loadWorker({
    fetch: async () => new Response('fresh page'),
    console: { warn: (message, details) => { warnings.push({ message, name: details.name }) } },
    caches: {
      open: () => ({
        then(callback) {
          const task = cacheReady.then(callback)
          background.push(task)
          // Observe failures below rather than leaking them into the test runner.
          task.catch(() => {})
          return task
        }
      })
    }
  })
  let response
  listeners.fetch({
    request: { method: 'GET', url: 'https://gym.example/index.html' },
    respondWith: task => { response = task },
    waitUntil: task => { lifetime.push(task) }
  })
  expect(await (await response).text()).toBe('fresh page')
  openCache({ put: async (_request, copy) => {
    if (cacheFails) throw new DOMException('Cache full', 'QuotaExceededError')
    cachedBody = await copy.text()
  } })
  await Promise.allSettled(background)
  const settled = await Promise.allSettled(lifetime)
  expect(settled.every(task => task.status === 'fulfilled')).toBe(true)
  expect(cachedBody).toBe(cacheFails ? undefined : 'fresh page')
  expect(warnings).toEqual(cacheFails ? [{ message: 'offline_cache_write_failed', name: 'QuotaExceededError' }] : [])
  expect(lifetime.length).toBeGreaterThan(0)
})

it('serves the offline cache without treating a network outage as a cache write error', async () => {
  const lifetime = []
  const warnings = []
  const listeners = loadWorker({
    fetch: async () => { throw new TypeError('Network unavailable') },
    caches: { match: async () => new Response('offline page') },
    console: { warn: (...args) => { warnings.push(args) } }
  })
  let response
  listeners.fetch({
    request: { method: 'GET', url: 'https://gym.example/index.html' },
    respondWith: task => { response = task },
    waitUntil: task => { lifetime.push(task) }
  })
  expect(await (await response).text()).toBe('offline page')
  await Promise.all(lifetime)
  expect(warnings).toEqual([])
})
