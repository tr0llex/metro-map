// Надгробие для service worker под прежним именем.
//
// НЕ УДАЛЯТЬ до 2027-02-01 (ориентир — 6 месяцев после релиза 1.0.0).
//
// Актуальный воркер генерируется vite-plugin-pwa и называется
// /metro-map-sw.js. Раньше он назывался /kitty-metro-sw.js; при переименовании
// старое имя просто исчезло, и по нему стало отдаваться 404.
//
// Чем это плохо. Браузер периодически перезапрашивает скрипт воркера по тому
// адресу, по которому его когда-то зарегистрировал. У всех, кто открывал сайт
// до переименования, этот адрес — /kitty-metro-sw.js. Пока по нему 404,
// поведение зависит от браузера, и полагаться на его милость незачем: этот
// файл снимает регистрацию сам, и установка чинится независимо от того, как
// именно браузер обходится с пропавшим скриптом. После снятия регистрации
// страница при следующей загрузке зарегистрирует актуальный воркер.
//
// Ровно тем же занят соседний public/sw.js — надгробие ещё более раннего
// имени. Приём и оговорки те же, включая главную.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Кэши здесь НАМЕРЕННО не удаляются.
    // В public/sw.js на этом уже обожглись: чистка caches.keys() к моменту
    // срабатывания сносила precache, который новый воркер успел уложить, а
    // Workbox повторно install не выполняет. Офлайн молча переставал работать
    // ровно у тех, кто обновлялся. Старые кэши уберёт cleanupOutdatedCaches
    // актуального воркера.

    try {
      await self.clients.claim()
    } catch {
      // ignore
    }

    try {
      await self.registration.unregister()
    } catch {
      // ignore
    }
  })())
})

// Пока клиент контролируется этим воркером — до перезагрузки после unregister —
// через него идут ВСЕ запросы. Голый fetch без catch означал бы, что в офлайне
// любой запрос, включая навигацию, падает сетевой ошибкой: пользователь старой
// установки без сети увидел бы не приложение, а страницу ошибки браузера.
self.addEventListener('fetch', (event) => {
  const { request } = event

  event.respondWith((async () => {
    try {
      return await fetch(request)
    } catch (networkError) {
      const cached = await caches.match(request)
      if (cached) return cached

      if (request.mode === 'navigate') {
        const shell = (await caches.match('/index.html')) || (await caches.match('/'))
        if (shell) return shell
      }

      throw networkError
    }
  })())
})
