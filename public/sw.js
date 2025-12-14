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

    // Intentionally do not force navigation/reload.
    // This worker exists only to clean up old registrations and caches.
    try {
      await self.clients.claim()
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
