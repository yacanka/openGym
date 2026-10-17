/* openGym service worker — runtime caching (works with Vite's hashed asset names).
   Media (img/gif) cache-first; everything else network-first with offline fallback. */
const CACHE = 'opengym-rt-v2'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()))
})
self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : {}
  e.waitUntil(self.registration.showNotification(data.title || 'openGym', {
    body: data.body || '',
    icon: 'icon-512.png',
    badge: 'icon-180.png',
    tag: data.tag || 'opengym',
    renotify: true
  }))
})
self.addEventListener('notificationclick', e => {
  e.notification.close()
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then(clients => {
    const c = clients.find(c => 'focus' in c)
    return c ? c.focus() : self.clients.openWindow('./')
  }))
})

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin) return
  if (url.pathname.startsWith('/api/')) return    // never cache auth/data
  if (['code', 'token_hash', 'error', 'error_description', 'flow'].some(key => url.searchParams.has(key))) return

  const isMedia = url.pathname.includes('/img/') || url.pathname.includes('/gif/')
  if (isMedia) {
    e.respondWith(caches.open(CACHE).then(c => c.match(e.request).then(hit =>
      hit || fetch(e.request).then(res => { if (res.ok) c.put(e.request, res.clone()); return res })
    )))
  } else {
    let cacheWrite = Promise.resolve()
    const response = fetch(e.request).then(res => {
      if (res.ok) {
        // Clone before returning the response: opening the cache can outlast page consumption.
        const copy = res.clone()
        cacheWrite = caches.open(CACHE).then(c => c.put(e.request, copy))
      }
      return res
    })
    e.waitUntil(response.then(() => cacheWrite, () => {}).catch(error => {
      console.warn('offline_cache_write_failed', { name: error?.name || 'Error' })
    }))
    e.respondWith(response.catch(() => caches.match(e.request).then(hit => hit || caches.match('index.html'))))
  }
})
