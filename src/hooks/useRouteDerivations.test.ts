// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useRouteDerivations } from './useRouteDerivations.ts'
import type {
  FullGraphLine,
  FullGraphStation,
  RouteResult,
  RouteStep,
  TransferKind,
} from '../metro/types.ts'

const LINES = new Map<number, FullGraphLine>([
  [1, { id: 1, title: 'Сокольническая', colorHex: '#E42313', stationIds: [], segments: [] }],
  [5, { id: 5, title: 'Кольцевая', colorHex: '#915133', stationIds: [], segments: [] }],
])

const STATIONS: FullGraphStation[] = [
  { id: '1/a', title: 'А', lineNumericId: 1 },
  { id: '1/b', title: 'Б', lineNumericId: 1 },
  { id: '5/b', title: 'Б', lineNumericId: 5 },
  { id: '5/c', title: 'В', lineNumericId: 5 },
]

const stationById = new Map(STATIONS.map((s) => [s.id, s]))
const stationTitleById = new Map(STATIONS.map((s) => [s.id, s.title]))

const ride = (from: string, to: string, lineId: number, minutes = 3): RouteStep => ({
  fromStationId: from,
  toStationId: to,
  lineId: String(lineId),
  travelMinutes: minutes,
})

const transfer = (
  from: string,
  to: string,
  minutes: number,
  transferKind?: TransferKind,
): RouteStep => ({
  fromStationId: from,
  toStationId: to,
  lineId: '',
  travelMinutes: minutes,
  isTransfer: true,
  transferKind,
})

const result = (steps: RouteStep[]): RouteResult => ({
  steps,
  totalMinutes: steps.reduce((s, x) => s + x.travelMinutes, 0),
  transfersCount: steps.filter((s) => s.isTransfer).length,
})

type Params = Parameters<typeof useRouteDerivations>[0]

function setup(over: Partial<Params> = {}) {
  const params: Params = {
    routeResult: null,
    routeAlternatives: [],
    fromStationId: null,
    toStationId: null,
    fromStation: '',
    toStation: '',
    stationById,
    stationTitleById,
    lineByNumericId: LINES,
    ...over,
  }
  return renderHook(() => useRouteDerivations(params)).result
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-04-01T10:00:00'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('без маршрута', () => {
  it('всё пустое, а не undefined', () => {
    const r = setup()
    expect(r.current.routeArrivalTimeLabel).toBeNull()
    expect(r.current.activeRouteEndpoints).toBeNull()
    expect(r.current.routeStationIds).toEqual([])
    expect(r.current.routeEdgeKeys).toEqual([])
    expect(r.current.routeLongTransferEdgeKeys).toEqual([])
    expect(r.current.decoratedSegments).toEqual([])
  })
})

describe('станции и рёбра маршрута', () => {
  const route = result([ride('1/a', '1/b', 1), transfer('1/b', '5/b', 3), ride('5/b', '5/c', 5)])

  it('станции идут по порядку и без повторов', () => {
    expect(setup({ routeResult: route }).current.routeStationIds).toEqual([
      '1/a',
      '1/b',
      '5/b',
      '5/c',
    ])
  })

  /** Ключ ребра нормализован: направление шага не должно менять подсветку. */
  it('ключи рёбер не зависят от направления', () => {
    const forward = setup({ routeResult: result([ride('1/b', '1/a', 1)]) })
    const backward = setup({ routeResult: result([ride('1/a', '1/b', 1)]) })
    expect(forward.current.routeEdgeKeys).toEqual(backward.current.routeEdgeKeys)
  })

  it('повторное ребро в ключи не задваивается', () => {
    const there = result([ride('1/a', '1/b', 1), ride('1/b', '1/a', 1)])
    expect(setup({ routeResult: there }).current.routeEdgeKeys).toHaveLength(1)
  })
})

describe('длинные пересадки', () => {
  /**
   * Карта рисует длинные пересадки иначе. Типы, которые считаются длинными,
   * заданы явно; 'mcd' и 'ignored' из списка убраны — загрузчик данных такие
   * значения отвергает, и попасть в эту ветку было нельзя.
   */
  it('far, out_of_station и mcc считаются длинными', () => {
    for (const kind of ['far', 'out_of_station', 'mcc'] as const) {
      const route = result([ride('1/a', '1/b', 1), transfer('1/b', '5/b', 2, kind)])
      expect(setup({ routeResult: route }).current.routeLongTransferEdgeKeys, kind).toHaveLength(1)
    }
  })

  it('near длинной не считается, даже если идти долго', () => {
    const route = result([transfer('1/b', '5/b', 30, 'near')])
    expect(setup({ routeResult: route }).current.routeLongTransferEdgeKeys).toEqual([])
  })

  /** Без типа остаётся единственный доступный признак — время. */
  it('пересадка без типа считается длинной по времени от шести минут', () => {
    const long = result([transfer('1/b', '5/b', 6)])
    const short = result([transfer('1/b', '5/b', 5)])
    expect(setup({ routeResult: long }).current.routeLongTransferEdgeKeys).toHaveLength(1)
    expect(setup({ routeResult: short }).current.routeLongTransferEdgeKeys).toEqual([])
  })

  it('перегон длинной пересадкой не станет, сколько бы ни ехал', () => {
    const route = result([ride('1/a', '1/b', 1, 40)])
    expect(setup({ routeResult: route }).current.routeLongTransferEdgeKeys).toEqual([])
  })
})

describe('концы маршрута', () => {
  const route = result([ride('1/a', '1/b', 1)])

  it('берутся названия из справочника станций', () => {
    const r = setup({ routeResult: route, fromStationId: '1/a', toStationId: '1/b' })
    expect(r.current.activeRouteEndpoints).toEqual({
      fromStationId: '1/a',
      toStationId: '1/b',
      fromTitle: 'А',
      toTitle: 'Б',
    })
  })

  it('для станции вне справочника берётся текст поля', () => {
    const r = setup({
      routeResult: route,
      fromStationId: '9/unknown',
      toStationId: '1/b',
      fromStation: '  Ручной ввод  ',
    })
    expect(r.current.activeRouteEndpoints?.fromTitle).toBe('Ручной ввод')
  })

  it('без названия концов нет — избранное и «Поделиться» нечем подписать', () => {
    const r = setup({ routeResult: route, fromStationId: '9/unknown', toStationId: '1/b' })
    expect(r.current.activeRouteEndpoints).toBeNull()
  })

  it('без одной из станций концов нет', () => {
    expect(setup({ routeResult: route, fromStationId: '1/a' }).current.activeRouteEndpoints).toBeNull()
  })
})

describe('время прибытия', () => {
  it('считается от текущего времени плюс длительность маршрута', () => {
    const r = setup({ routeResult: result([ride('1/a', '1/b', 1, 25)]) })
    expect(r.current.routeArrivalTimeLabel).toBe(
      new Date('2026-04-01T10:25:00').toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
      }),
    )
  })

  /**
   * Значение считалось один раз при построении маршрута: с открытой шторкой
   * через двадцать минут оно врало ровно на двадцать минут.
   */
  it('пересчитывается тикером минут, а не замерзает на моменте построения', () => {
    const params: Params = {
      routeResult: result([ride('1/a', '1/b', 1, 25)]),
      routeAlternatives: [],
      fromStationId: null,
      toStationId: null,
      fromStation: '',
      toStation: '',
      stationById,
      stationTitleById,
      lineByNumericId: LINES,
    }
    const { result: r } = renderHook(() => useRouteDerivations(params))
    const before = r.current.routeArrivalTimeLabel

    // advanceTimersByTime двигает и таймеры, и системные часы разом, поэтому
    // отдельный setSystemTime здесь дал бы двойной сдвиг. Пять минут — это
    // пять сработавших границ минуты; хватило бы и одной.
    act(() => {
      vi.advanceTimersByTime(5 * 60_000 + 100)
    })

    expect(before).toBe('10:25')
    expect(r.current.routeArrivalTimeLabel).toBe('10:30')
  })

  it('без маршрута тикер не заводится', () => {
    setup()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('цвета вариантов маршрута', () => {
  it('по каждому варианту — цвета его линий без повторов подряд', () => {
    const alternatives = [
      result([ride('1/a', '1/b', 1), ride('1/b', '1/a', 1), transfer('1/b', '5/b', 2), ride('5/b', '5/c', 5)]),
      result([ride('1/a', '1/b', 1)]),
    ]
    const r = setup({ routeResult: alternatives[0], routeAlternatives: alternatives })

    expect(r.current.routeAlternativeLineColors).toHaveLength(2)
    expect(r.current.routeAlternativeLineColors[0]).toEqual(['#E42313', '#915133'])
    expect(r.current.routeAlternativeLineColors[1]).toEqual(['#E42313'])
  })
})
