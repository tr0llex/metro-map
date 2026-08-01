import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fullGraphEdges, fullGraphStations } from './fullGraph'
import type { FullGraphEdge } from './types'

/**
 * Отдельный файл, потому что здесь `./graphCore` подменяется шпионом: нужно
 * доказать ФАКТ переиспользования предрасчитанных структур, а не только то, что
 * ответы совпадают. В `routing.test.ts` тот же модуль импортируется напрямую и
 * проверяется по существу — смешивать не стоит.
 */

const buildAdjacencySpy = vi.fn()
const buildEdgeByKeySpy = vi.fn()

vi.mock('./graphCore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./graphCore')>()
  return {
    ...actual,
    buildAdjacencyListFromFullGraph: (edges: FullGraphEdge[]) => {
      buildAdjacencySpy(edges)
      return actual.buildAdjacencyListFromFullGraph(edges)
    },
    buildEdgeByKey: (edges: FullGraphEdge[]) => {
      buildEdgeByKeySpy(edges)
      return actual.buildEdgeByKey(edges)
    },
  }
})

const { findRouteAlternativesFullGraph, setRoutingGraph } = await import('./routing')

const FROM = 'mos-6-6.81'
const TO = 'mos-1-1.514'

const stationIds = fullGraphStations.map((s) => s.id)

beforeEach(() => {
  setRoutingGraph({ stationIds, edges: fullGraphEdges })
  buildAdjacencySpy.mockClear()
  buildEdgeByKeySpy.mockClear()
})

describe('findRouteAlternativesFullGraph — переиспользование предрасчитанного графа', () => {
  it('без опций не пересобирает смежность и индекс рёбер', () => {
    findRouteAlternativesFullGraph(FROM, TO)
    expect(buildAdjacencySpy).not.toHaveBeenCalled()
    expect(buildEdgeByKeySpy).not.toHaveBeenCalled()
  })

  it('ПУСТЫЕ edgeOverrides/extraEdges считаются отсутствующими (так шлёт прод)', () => {
    // Прод-заглушка редактора всегда передаёт `{}` и `[]`; до починки пустой
    // объект был truthy и граф пересобирался на КАЖДЫЙ запрос маршрута.
    findRouteAlternativesFullGraph(FROM, TO, { edgeOverrides: {}, extraEdges: [] })
    expect(buildAdjacencySpy).not.toHaveBeenCalled()
    expect(buildEdgeByKeySpy).not.toHaveBeenCalled()
  })

  it('непустые edgeOverrides граф пересобирают', () => {
    findRouteAlternativesFullGraph(FROM, TO, {
      edgeOverrides: { 'mos-1-1.54|mos-5-5.55': { disabled: true } },
    })
    expect(buildAdjacencySpy).toHaveBeenCalledTimes(1)
    expect(buildEdgeByKeySpy).toHaveBeenCalledTimes(1)
  })

  it('непустые extraEdges граф пересобирают', () => {
    findRouteAlternativesFullGraph(FROM, TO, {
      extraEdges: [{ fromStationId: FROM, toStationId: TO, medianTravelSeconds: 60 }],
    })
    expect(buildAdjacencySpy).toHaveBeenCalledTimes(1)
  })

  it('пустые оверрайды дают тот же маршрут, что и базовый граф', () => {
    const base = findRouteAlternativesFullGraph(FROM, TO)
    const empty = findRouteAlternativesFullGraph(FROM, TO, { edgeOverrides: {}, extraEdges: [] })
    expect(empty).toEqual(base)
  })
})

describe('параллельные рёбра между одной парой станций (N-2)', () => {
  const A = 'st-a'
  const B = 'st-b'
  const C = 'st-c'

  /** Перегон A→B (10 мин) и «параллельная» пересадка A→B (1 мин). */
  const parallelEdges: FullGraphEdge[] = [
    { fromStationId: A, toStationId: B, medianTravelSeconds: 600 },
    { fromStationId: A, toStationId: B, medianTravelSeconds: 60, isTransfer: true },
    { fromStationId: B, toStationId: C, medianTravelSeconds: 120 },
  ]

  it('путь с оверрайдами больше не отбрасывает параллельное ребро', () => {
    setRoutingGraph({ stationIds: [A, B, C], edges: parallelEdges })

    const base = findRouteAlternativesFullGraph(A, C)[0]
    const withOverrides = findRouteAlternativesFullGraph(A, C, {
      edgeOverrides: { 'zzz|zzz': { disabled: true } },
    })[0]

    // Ключевое: прод (базовый граф) и редактор (путь с оверрайдами) считают одинаково.
    expect(withOverrides.totalMinutes).toBe(base.totalMinutes)
    expect(withOverrides.steps.length).toBe(base.steps.length)
  })

  it('ручное ребро по-прежнему вытесняет базовые рёбра той же пары', () => {
    setRoutingGraph({ stationIds: [A, B, C], edges: parallelEdges })

    const withManual = findRouteAlternativesFullGraph(A, B, {
      extraEdges: [{ fromStationId: A, toStationId: B, medianTravelSeconds: 30 }],
    })[0]

    expect(withManual.steps.length).toBe(1)
    expect(withManual.steps[0].travelMinutes).toBe(0.5)
    expect(withManual.transfersCount).toBe(0)
  })
})
