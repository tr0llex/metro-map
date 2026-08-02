// Legacy service worker cleanup for old /sw.js registrations.
// This worker unregisters itself and, until it does, serves requests from the
// network with a cache fallback.
//
// НЕ УДАЛЯТЬ до 2027-02-01 (ориентир — 6 месяцев после релиза 1.0.0).
// Актуальный service worker генерируется vite-plugin-pwa и называется
// /metro-map-sw.js. Этот файл нужен только для браузеров, где ещё
// зарегистрирован старый /sw.js: он снимает регистрацию сам с себя.
// Пока файл раздаётся, старые установки самоочищаются.
// Подробности и правила кэширования — docs/DEPLOY.md.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Кэши здесь НАМЕРЕННО не удаляются.
    // Раньше этот обработчик делал caches.keys() → caches.delete() по всем
    // кэшам origin'а. К моменту его срабатывания новый metro-map-sw.js уже
    // мог уложить precache — и чистка сносила именно его, а Workbox повторно
    // install не выполняет. Итог: офлайн молча переставал работать ровно у тех
    // пользователей, которые обновлялись. Старые кэши уберёт
    // cleanupOutdatedCaches нового воркера.

    // Intentionally do not force navigation/reload.
    // This worker exists only to clean up old registrations.
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

// Пока клиент контролируется этим воркером (до перезагрузки после unregister),
// через него идут ВСЕ запросы. Голый fetch без catch означал, что офлайн любой
// запрос — включая навигацию — падал сетевой ошибкой: пользователь старой
// установки без сети видел не приложение, а страницу ошибки браузера.
self.addEventListener('fetch', (event) => {
  const { request } = event

  event.respondWith((async () => {
    try {
      return await fetch(request)
    } catch (networkError) {
      const cached = await caches.match(request)
      if (cached) return cached

      // Для навигации отдаём оболочку приложения, если она хоть где-то осталась.
      if (request.mode === 'navigate') {
        const shell = (await caches.match('/index.html')) || (await caches.match('/'))
        if (shell) return shell
      }

      throw networkError
    }
  })())
})
