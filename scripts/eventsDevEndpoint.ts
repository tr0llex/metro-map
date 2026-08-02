/**
 * Приёмник `/e/<событие>` для dev- и preview-сервера.
 *
 * В проде этот путь обслуживает nginx: отвечает 204 и пишет строку в отдельный
 * журнал без IP и User-Agent (snippets/samoylove-events.conf в deploy-kit).
 * Локально nginx нет, и без заглушки каждый построенный маршрут давал бы 404
 * в консоли — сначала тому, кто разрабатывает, а потом и сквозным тестам,
 * которые справедливо считают ошибку в консоли поломкой.
 *
 * Заглушка ничего не пишет и никуда не ходит: её задача — вернуть тот же 204,
 * что вернул бы прод, чтобы поведение клиента можно было проверить локально.
 * В прод-бандл не попадает ни строчки: плагин живёт только в хуках серверов.
 */
import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'

/** Тот же шаблон имени, что и в nginx: только он решает, что 204, а что 404. */
const EVENT_PATH = /^\/e\/[a-z][a-z0-9_]{2,39}$/

export function eventsDevEndpoint(): Plugin {
  const middleware = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ): void => {
    const path = (req.url ?? '').split('?')[0]
    if (!path.startsWith('/e/')) {
      next()
      return
    }

    if (EVENT_PATH.test(path)) {
      res.statusCode = 204
      res.setHeader('Cache-Control', 'no-store')
      res.end()
      return
    }

    res.statusCode = 404
    res.end()
  }

  return {
    name: 'samoylove-events-dev-endpoint',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}
