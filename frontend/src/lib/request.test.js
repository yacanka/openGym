import { it, expect, vi, afterEach } from 'vitest'
import { fetchWithTimeout } from './request.js'
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const pendingFetch = (_input, options) =>
  new Promise((_resolve, reject) => {
    if (options.signal.aborted) reject(options.signal.reason)
    else
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
  })
it('bounds a stalled request so pending account uploads can be retried', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', pendingFetch)
  const result = expect(fetchWithTimeout('https://project.example.test')).rejects.toMatchObject({
    name: 'TimeoutError'
  })
  await vi.advanceTimersByTimeAsync(15000)
  await result
  expect(vi.getTimerCount()).toBe(0)
})
it('preserves caller cancellation and cleans up its own timeout', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', pendingFetch)
  const controller = new AbortController()
  const result = expect(
    fetchWithTimeout('https://project.example.test', { signal: controller.signal })
  ).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await result
  expect(vi.getTimerCount()).toBe(0)
})
