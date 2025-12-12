// Legacy service worker cleanup for old /sw.js registrations
// This worker forces network requests, clears its caches, and unregisters itself

self.addEventListener('install', (event) => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const cacheNames = await caches.keys()
      await Promise.all(cacheNames.map((name) => caches.delete(name)))
    } catch (e) {
      // ignore
    }

    try {
      await self.clients.claim()
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of clients) {
        client.navigate(client.url)
      }
    } catch (e) {
      // ignore
    }

    try {
      await self.registration.unregister()
    } catch (e) {
      // ignore
    }
  })())
})

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request))
})
