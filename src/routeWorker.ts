import { findRouteAlternativesFullGraph, setRoutingGraph } from './metro/routing'
import { ROUTING_GRAPH_ASSET_PATH, decodeRoutingGraph } from './metro/routingGraphPayload'
import type { EdgeOverride, FullGraphEdge, RouteResult } from './metro/types'

type RouteRequestMessage = {
  type: 'route'
  requestId: number
  fromId: string
  toId: string
  maxAlternatives?: number
  edgeOverrides?: Record<string, EdgeOverride>
  extraEdges?: FullGraphEdge[]
}

type RouteResponseMessage =
  | {
      type: 'routeResult'
      requestId: number
      routes: RouteResult[]
    }
  | {
      type: 'routeError'
      requestId: number
      errorMessage: string
    }

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope

/**
 * Граф маршрутизации приходит отдельным ассетом, а не статическим импортом:
 * воркер собирается отдельным бандлом, и импорт `fullGraph.json` дублировал бы
 * все данные в сборке (см. комментарий в `metro/routingGraphPayload.ts`).
 *
 * Загрузка стартует НА ЭТАПЕ ЗАГРУЗКИ МОДУЛЯ, то есть сразу при создании воркера,
 * задолго до первого запроса маршрута — так первый маршрут не становится медленнее.
 * Запросы, пришедшие до готовности, просто ждут этот промис (порядок ответов
 * сохраняется, т.к. коллбеки промиса выполняются в порядке подписки).
 *
 * Провал загрузки НЕ запоминается: раньше отклонённый промис жил до конца жизни
 * воркера, и после единственной сетевой ошибки кнопка «Попробовать ещё раз»
 * в приложении была бесполезна — воркер отвечал той же ошибкой до перезагрузки
 * страницы. Теперь неудачная попытка сбрасывает кеш промиса, и СЛЕДУЮЩИЙ запрос
 * маршрута сам инициирует новую загрузку. Успешная загрузка кешируется навсегда,
 * поэтому граф по-прежнему качается ровно один раз.
 */
async function loadGraph(): Promise<void> {
  const base = import.meta.env?.BASE_URL ?? '/'
  const response = await fetch(`${base}${ROUTING_GRAPH_ASSET_PATH}`)
  if (!response.ok) {
    throw new Error(`Не удалось загрузить граф метро: HTTP ${response.status}`)
  }

  // SPA-фолбэк на сервере отдаёт index.html со статусом 200, если ассет пропал.
  // Без этой проверки ошибка вылезала как невнятный «Unexpected token '<'».
  const contentType = response.headers?.get?.('content-type') ?? ''
  if (contentType && !contentType.includes('json')) {
    throw new Error(`Не удалось загрузить граф метро: сервер вернул ${contentType} вместо JSON`)
  }

  setRoutingGraph(decodeRoutingGraph(await response.json()))
}

let graphReadyPromise: Promise<void> | null = null

function ensureGraphReady(): Promise<void> {
  if (!graphReadyPromise) {
    graphReadyPromise = loadGraph().catch((err: unknown) => {
      graphReadyPromise = null
      throw err
    })
  }
  return graphReadyPromise
}

// Подписка-заглушка: без неё отказ промиса до прихода первого запроса
// всплывает как unhandledrejection и шумит в консоли.
ensureGraphReady().catch(() => {})

function respondTo(msg: RouteRequestMessage): void {
  const { requestId, fromId, toId, maxAlternatives, edgeOverrides, extraEdges } = msg
  try {
    const routes = findRouteAlternativesFullGraph(fromId, toId, {
      maxAlternatives,
      edgeOverrides,
      extraEdges,
    })

    const response: RouteResponseMessage = { type: 'routeResult', requestId, routes }
    ctx.postMessage(response)
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Route build error'
    const response: RouteResponseMessage = { type: 'routeError', requestId, errorMessage }
    ctx.postMessage(response)
  }
}

ctx.onmessage = (event: MessageEvent<RouteRequestMessage>) => {
  const msg = event.data
  if (!msg || msg.type !== 'route') return

  ensureGraphReady().then(
    () => respondTo(msg),
    (err: unknown) => {
      const errorMessage = err instanceof Error ? err.message : 'Route graph load error'
      const response: RouteResponseMessage = {
        type: 'routeError',
        requestId: msg.requestId,
        errorMessage,
      }
      ctx.postMessage(response)
    },
  )
}
