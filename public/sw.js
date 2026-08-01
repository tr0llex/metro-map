// Legacy service worker cleanup for old /sw.js registrations.
// This worker forces network requests, clears its caches, and unregisters itself.
//
// НЕ УДАЛЯТЬ до 2027-02-01 (ориентир — 6 месяцев после релиза 1.0.0).
// Актуальный service worker генерируется vite-plugin-pwa и называется
// /kitty-metro-sw.js. Этот файл нужен только для браузеров, где ещё
// зарегистрирован старый /sw.js: он снимает регистрацию сам с себя.
// Пока файл раздаётся, старые установки самоочищаются.
// Подробности и правила кэширования — docs/DEPLOY.md.

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
