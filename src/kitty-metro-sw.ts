import { clientsClaim } from 'workbox-core'
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

declare let self: ServiceWorkerGlobalScope

self.skipWaiting()
clientsClaim()

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

registerRoute(new NavigationRoute(createHandlerBoundToURL('index.html')))

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      } catch {
        // ignore
      }

      try {
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
        await Promise.all(
          clients.map(async (client) => {
            try {
              const windowClient = client as WindowClient
              await windowClient.navigate(windowClient.url)
            } catch {
              // ignore
            }
          }),
        )
      } catch {
        // ignore
      }
    })(),
  )
})
