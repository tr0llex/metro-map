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
 */
const graphReady: Promise<void> = (async () => {
  const base = import.meta.env?.BASE_URL ?? '/'
  const response = await fetch(`${base}${ROUTING_GRAPH_ASSET_PATH}`)
  if (!response.ok) {
    throw new Error(`Не удалось загрузить граф метро: HTTP ${response.status}`)
  }
  setRoutingGraph(decodeRoutingGraph(await response.json()))
})()

// Подписка-заглушка: без неё отказ промиса до прихода первого запроса
// всплывает как unhandledrejection и шумит в консоли.
graphReady.catch(() => {})

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

  graphReady.then(
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
