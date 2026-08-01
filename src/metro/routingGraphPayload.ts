import type { FullGraphEdge } from './types'

/**
 * Компактное представление графа ТОЛЬКО для поиска маршрутов.
 *
 * Зачем: `normalized/fullGraph.json` статически импортируется в `fullGraph.ts`,
 * а тот нужен главному потоку синхронно. Воркер маршрутизации собирается Vite
 * отдельным rollup-бандлом, поэтому общий чанк с главным бандлом невозможен —
 * при статическом импорте те же ~123 КБ данных попадали в сборку второй раз.
 *
 * Воркеру не нужны ни названия станций, ни координаты, ни линии, ни хабы —
 * только рёбра (и список id станций, чтобы сохранить прежнюю семантику вызовов).
 * Это сжимает полезную нагрузку до ~20 КБ, которые собираются в отдельный ассет
 * `assets/kitty-metro-routing-graph.json` и подгружаются воркером на старте.
 *
 * Кодировщик вызывается на этапе сборки (плагин в `vite.config.ts`),
 * декодировщик — в воркере. Формат версионируется полем `v`.
 */

/**
 * Путь ассета относительно base — намеренно в КОРНЕ сборки, а не в `assets/`.
 *
 * Имя фиксированное (воркер должен знать его на этапе сборки), а vite-plugin-pwa
 * помечает всё внутри `assets/` как неизменяемое (`revision: null`) — файл с
 * постоянным именем там навсегда застрял бы в precache старой версией. В корне
 * Workbox считает для него revision-хеш и корректно обновляет при смене данных.
 */
export const ROUTING_GRAPH_ASSET_PATH = 'kitty-metro-routing-graph.json'

export const ROUTING_GRAPH_PAYLOAD_VERSION = 1

/** Ребро: [from, to, medianTravelSeconds, isTransfer(0|1), индекс в kinds или -1]. */
export type EncodedRoutingEdge = [string, string, number, number, number]

export interface RoutingGraphPayload {
  v: number
  kinds: string[]
  stationIds: string[]
  edges: EncodedRoutingEdge[]
}

/** Данные, с которыми работает поиск маршрутов. */
export interface RoutingGraphData {
  stationIds: string[]
  edges: FullGraphEdge[]
}

/** Минимальная форма исходного `fullGraph.json`, нужная для кодирования. */
export interface RoutingGraphSource {
  stations: { id: string }[]
  edges: {
    fromStationId: string
    toStationId: string
    medianTravelSeconds: number
    isTransfer?: boolean
    transferKind?: string
  }[]
}

export function encodeRoutingGraph(source: RoutingGraphSource): RoutingGraphPayload {
  const kinds: string[] = []
  const kindIndex = new Map<string, number>()

  const edges: EncodedRoutingEdge[] = source.edges.map((e) => {
    let kind = -1
    if (typeof e.transferKind === 'string' && e.transferKind.length > 0) {
      const existing = kindIndex.get(e.transferKind)
      if (existing === undefined) {
        kind = kinds.length
        kindIndex.set(e.transferKind, kind)
        kinds.push(e.transferKind)
      } else {
        kind = existing
      }
    }
    return [e.fromStationId, e.toStationId, e.medianTravelSeconds, e.isTransfer ? 1 : 0, kind]
  })

  return {
    v: ROUTING_GRAPH_PAYLOAD_VERSION,
    kinds,
    stationIds: source.stations.map((s) => s.id),
    edges,
  }
}

/**
 * Разбирает компактный payload. Бросает на любом несоответствии контракту:
 * молча построить маршрут по битым данным хуже, чем показать ошибку.
 */
export function decodeRoutingGraph(payload: unknown): RoutingGraphData {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Граф маршрутизации: пустой ответ')
  }
  const p = payload as Partial<RoutingGraphPayload>
  if (p.v !== ROUTING_GRAPH_PAYLOAD_VERSION) {
    throw new Error(`Граф маршрутизации: неподдерживаемая версия формата ${String(p.v)}`)
  }
  if (!Array.isArray(p.edges) || !Array.isArray(p.stationIds) || !Array.isArray(p.kinds)) {
    throw new Error('Граф маршрутизации: повреждённые данные')
  }

  const kinds = p.kinds
  const edges: FullGraphEdge[] = p.edges.map((raw) => {
    const [fromStationId, toStationId, medianTravelSeconds, transferFlag, kind] = raw
    const edge: FullGraphEdge = { fromStationId, toStationId, medianTravelSeconds }
    if (transferFlag === 1) edge.isTransfer = true
    if (kind >= 0 && kind < kinds.length) {
      edge.transferKind = kinds[kind] as FullGraphEdge['transferKind']
    }
    return edge
  })

  return { stationIds: p.stationIds, edges }
}
