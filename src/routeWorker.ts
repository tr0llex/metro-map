import { findRouteAlternativesFullGraph } from './metro/routing'
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

ctx.onmessage = (event: MessageEvent<RouteRequestMessage>) => {
  const msg = event.data
  if (!msg || msg.type !== 'route') return

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
