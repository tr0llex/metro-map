import { describe, expect, it } from 'vitest'
import {
  findRouteAlternativesFullGraph,
  findShortestRouteFullGraph,
  isRoutingGraphReady,
  resetRoutingGraph,
  setRoutingGraph,
} from './routing'
import { decodeRoutingGraph, encodeRoutingGraph } from './routingGraphPayload'
import { fullGraphEdges, fullGraphStations } from './fullGraph'
import {
  TRANSFER_PENALTY_MINUTES,
  buildAdjacencyListFromFullGraph,
  buildEdgeByKey,
  buildRouteResultFromPath,
  findParallelEdgeKeys,
  undirectedEdgeKey,
} from './graphCore'
import type { FullGraphEdge, RouteResult } from './types'

// ---------------------------------------------------------------------------
// Реальные пары станций (id из normalized/fullGraph.json).
// Взяты «через всю схему», чтобы маршруты были длинными и с пересадками.
// ---------------------------------------------------------------------------
const MEDVEDKOVO = '6/medvedkovo'
const SALARYEVO = '1/salarevo'
const PYATNITSKOE = '3/pyatnitskoe-shosse'
const VYKHINO = '7/vykhino'
const KHOVRINO = '2/khovrino'
const YUGO_ZAPADNAYA = '1/yugo-zapadnaya'
const PLANERNAYA = '7/planernaya'
const ROKOSSOVSKOGO_MCC = '95/bulvar-rokossovskogo'
const KOMSOMOLSKAYA_1 = '1/komsomolskaya'
const KOMSOMOLSKAYA_5 = '5/komsomolskaya'

const LONG_PAIRS: [string, string, string][] = [
  [MEDVEDKOVO, SALARYEVO, 'Медведково → Саларьево'],
  [PYATNITSKOE, VYKHINO, 'Пятницкое шоссе → Выхино'],
  [KHOVRINO, YUGO_ZAPADNAYA, 'Ховрино → Юго-Западная'],
  [PLANERNAYA, ROKOSSOVSKOGO_MCC, 'Планерная → Бульвар Рокоссовского (МЦК)'],
]

const stationIds = fullGraphStations.map((s) => s.id)
const stationIdSet = new Set(stationIds)

/**
 * Граф в поиск маршрутов подаётся явно (модуль больше не импортирует данные сам —
 * иначе они дублировались бы в бандле воркера). Прогоняем его РОВНО через тот же
 * путь, что и в проде: encode → сериализация в JSON → decode. Так весь набор
 * маршрутных проверок ниже заодно доказывает, что компактный формат ассета не
 * теряет ничего важного для построения маршрутов.
 */
function initRoutingGraphFromPayload(): void {
  const payload = encodeRoutingGraph({ stations: fullGraphStations, edges: fullGraphEdges })
  setRoutingGraph(decodeRoutingGraph(JSON.parse(JSON.stringify(payload))))
}

initRoutingGraphFromPayload()

describe('setRoutingGraph — явная инициализация графа', () => {
  it('без инициализации поиск маршрута падает с понятной ошибкой', () => {
    resetRoutingGraph()
    try {
      expect(isRoutingGraphReady()).toBe(false)
      expect(() => findShortestRouteFullGraph(MEDVEDKOVO, SALARYEVO)).toThrow(/не инициализирован/i)
      expect(() => findRouteAlternativesFullGraph(MEDVEDKOVO, SALARYEVO)).toThrow(
        /не инициализирован/i,
      )
    } finally {
      initRoutingGraphFromPayload()
    }
    expect(isRoutingGraphReady()).toBe(true)
  })

  it('компактный payload сохраняет все рёбра, время, пересадки и их тип', () => {
    const payload = encodeRoutingGraph({ stations: fullGraphStations, edges: fullGraphEdges })
    const decoded = decodeRoutingGraph(JSON.parse(JSON.stringify(payload)))

    expect(decoded.stationIds).toEqual(stationIds)
    expect(decoded.edges.length).toBe(fullGraphEdges.length)

    for (let i = 0; i < fullGraphEdges.length; i += 1) {
      const source = fullGraphEdges[i]
      const restored = decoded.edges[i]
      expect(restored.fromStationId).toBe(source.fromStationId)
      expect(restored.toStationId).toBe(source.toStationId)
      expect(restored.medianTravelSeconds).toBe(source.medianTravelSeconds)
      expect(!!restored.isTransfer).toBe(!!source.isTransfer)
      expect(restored.transferKind).toBe(source.transferKind)
    }
  })

  it('отвергает payload неизвестной версии и повреждённые данные', () => {
    expect(() => decodeRoutingGraph({ v: 999, kinds: [], stationIds: [], edges: [] })).toThrow()
    expect(() => decodeRoutingGraph({ v: 1, kinds: [], stationIds: [] })).toThrow()
    expect(() => decodeRoutingGraph(null)).toThrow()
  })
})

/** Детерминированная выборка пар станций: без Math.random, шаг — простое число. */
function samplePairs(stepA: number, stepB: number, offsetB = 5): [string, string][] {
  const pairs: [string, string][] = []
  for (let i = 0; i < stationIds.length; i += stepA) {
    for (let j = offsetB; j < stationIds.length; j += stepB) {
      if (i === j) continue
      pairs.push([stationIds[i], stationIds[j]])
    }
  }
  return pairs
}

/** Полный набор структурных проверок одного маршрута. */
function expectRouteIsWellFormed(route: RouteResult, fromId: string, toId: string, label: string) {
  expect(route.steps.length, `${label}: маршрут без шагов`).toBeGreaterThan(0)

  expect(route.steps[0].fromStationId, `${label}: маршрут не начинается в from`).toBe(fromId)
  expect(
    route.steps[route.steps.length - 1].toStationId,
    `${label}: маршрут не заканчивается в to`,
  ).toBe(toId)

  for (let i = 0; i < route.steps.length - 1; i += 1) {
    expect(route.steps[i].toStationId, `${label}: разрыв цепочки на шаге ${i}`).toBe(
      route.steps[i + 1].fromStationId,
    )
  }

  for (const step of route.steps) {
    expect(stationIdSet.has(step.fromStationId), `${label}: неизвестная станция ${step.fromStationId}`).toBe(true)
    expect(stationIdSet.has(step.toStationId), `${label}: неизвестная станция ${step.toStationId}`).toBe(true)
    expect(step.travelMinutes, `${label}: неположительное время шага`).toBeGreaterThan(0)
    expect(Number.isFinite(step.travelMinutes)).toBe(true)
  }

  const transferSteps = route.steps.filter((s) => s.isTransfer).length
  expect(route.transfersCount, `${label}: transfersCount != числу пересадочных шагов`).toBe(transferSteps)

  const rawSum = route.steps.reduce((sum, s) => sum + s.travelMinutes, 0)
  expect(route.totalMinutes, `${label}: totalMinutes != ceil(сумма шагов)`).toBe(Math.ceil(rawSum))
}

// ===========================================================================

describe('findShortestRouteFullGraph — базовые случаи', () => {
  it('возвращает пустой маршрут, если станция отправления и назначения совпадают', () => {
    const id = fullGraphEdges[0].fromStationId
    const result = findShortestRouteFullGraph(id, id)

    expect(result).not.toBeNull()
    expect(result!.steps).toEqual([])
    expect(result!.totalMinutes).toBe(0)
    expect(result!.transfersCount).toBe(0)
  })

  it('строит прямой маршрут между соседними станциями одной линии', () => {
    const edge = fullGraphEdges.find((e) => !e.isTransfer)!
    const result = findShortestRouteFullGraph(edge.fromStationId, edge.toStationId)

    expect(result).not.toBeNull()
    expectRouteIsWellFormed(result!, edge.fromStationId, edge.toStationId, 'соседние станции')
    expect(result!.steps.length).toBe(1)
    expect(result!.transfersCount).toBe(0)
  })

  it('считает пересадку, когда маршрут идёт по пересадочному ребру', () => {
    const transferEdge = fullGraphEdges.find((e) => e.isTransfer)!
    const result = findShortestRouteFullGraph(transferEdge.fromStationId, transferEdge.toStationId)

    expect(result).not.toBeNull()
    expect(result!.transfersCount).toBeGreaterThanOrEqual(1)
    expect(result!.steps.some((s) => s.isTransfer)).toBe(true)
  })

  it('возвращает null для несуществующего id станции отправления', () => {
    expect(findShortestRouteFullGraph('no-such-station', KOMSOMOLSKAYA_1)).toBeNull()
  })

  it('возвращает null для несуществующего id станции назначения', () => {
    expect(findShortestRouteFullGraph(KOMSOMOLSKAYA_1, 'no-such-station')).toBeNull()
  })

  it('находит маршрут между любыми двумя станциями схемы (граф связен для маршрутизации)', () => {
    for (const [from, to] of samplePairs(29, 41)) {
      const route = findShortestRouteFullGraph(from, to)
      expect(route, `нет маршрута ${from} → ${to}`).not.toBeNull()
    }
  })
})

describe('TRANSFER_PENALTY_MINUTES — штраф только для поиска, не для отображения', () => {
  it('штраф ненулевой (иначе три прогона Дейкстры вырождаются в один и тот же путь)', () => {
    expect(TRANSFER_PENALTY_MINUTES).toBe(2)
    expect(TRANSFER_PENALTY_MINUTES).toBeGreaterThan(0)
  })

  it('totalMinutes пересадочного ребра равен только времени перехода, без штрафа', () => {
    const transferEdge = fullGraphEdges.find(
      (e) => e.isTransfer && e.medianTravelSeconds > 0,
    )!
    const route = findShortestRouteFullGraph(transferEdge.fromStationId, transferEdge.toStationId)!

    expect(route.steps.length).toBe(1)
    const expectedMinutes = Math.ceil(route.steps[0].travelMinutes)
    // Если бы штраф попадал в отображаемое время, тут было бы +TRANSFER_PENALTY_MINUTES.
    expect(route.totalMinutes).toBe(expectedMinutes)
    expect(route.totalMinutes).toBeLessThan(expectedMinutes + TRANSFER_PENALTY_MINUTES)
  })

  it('buildRouteResultFromPath не прибавляет штраф ни при каком числе пересадок', () => {
    const edgeByKey = buildEdgeByKey(fullGraphEdges)
    const route = findShortestRouteFullGraph(MEDVEDKOVO, SALARYEVO)!
    expect(route.transfersCount).toBeGreaterThan(0)

    const path = [route.steps[0].fromStationId, ...route.steps.map((s) => s.toStationId)]
    const rebuilt = buildRouteResultFromPath(path, edgeByKey)

    const rawSum = rebuilt.steps.reduce((sum, s) => sum + s.travelMinutes, 0)
    expect(rebuilt.totalMinutes).toBe(Math.ceil(rawSum))
    expect(rebuilt.totalMinutes).toBe(route.totalMinutes)
  })

  it('изменение штрафа не меняет отображаемое время одного и того же пути', () => {
    const edgeByKey = buildEdgeByKey(fullGraphEdges)
    const zero = findShortestRouteFullGraph(KHOVRINO, YUGO_ZAPADNAYA, { transferPenaltyMinutes: 0 })!
    const path = [zero.steps[0].fromStationId, ...zero.steps.map((s) => s.toStationId)]

    // Тот же путь, пересобранный независимо, обязан дать то же время —
    // значит, штраф нигде не «протекает» в totalMinutes.
    expect(buildRouteResultFromPath(path, edgeByKey).totalMinutes).toBe(zero.totalMinutes)
  })

  it('большой штраф уменьшает (или сохраняет) число пересадок и не уменьшает время', () => {
    for (const [from, to, label] of LONG_PAIRS) {
      const cheap = findShortestRouteFullGraph(from, to, { transferPenaltyMinutes: 0 })!
      const strict = findShortestRouteFullGraph(from, to, { transferPenaltyMinutes: 60 })!

      expect(strict.transfersCount, `${label}: строгий штраф не сократил пересадки`).toBeLessThanOrEqual(
        cheap.transfersCount,
      )
      expect(cheap.totalMinutes, `${label}: маршрут без штрафа не быстрейший по времени езды`).toBeLessThanOrEqual(
        strict.totalMinutes,
      )
    }
  })
})

describe('findRouteAlternativesFullGraph — набор альтернатив', () => {
  it('возвращает несколько РАЗНЫХ маршрутов на реальных дальних парах', () => {
    for (const [from, to, label] of LONG_PAIRS) {
      const routes = findRouteAlternativesFullGraph(from, to)

      // Регрессия: при нулевом штрафе все три прогона Дейкстры давали один путь
      // и пользователь видел 2 варианта вместо 6. Порог 3, а не 4: на паре
      // Медведково → Саларьево столько реально и есть — после сверки данных со
      // схемой добавились пересадки, оптимум стал явным и почти-ничьи
      // схлопнулись. Остальные три пары дают 4, 6 и 6.
      expect(routes.length, `${label}: мало альтернатив`).toBeGreaterThanOrEqual(3)
      expect(routes.length).toBeLessThanOrEqual(6)

      const keys = routes.map((r) =>
        [r.steps[0].fromStationId, ...r.steps.map((s) => s.toStationId)].join('>'),
      )
      expect(new Set(keys).size, `${label}: среди альтернатив есть дубликаты путей`).toBe(keys.length)
    }
  })

  it('альтернативы отличаются не только порядком: есть разброс по числу пересадок', () => {
    for (const [from, to, label] of LONG_PAIRS) {
      const routes = findRouteAlternativesFullGraph(from, to)
      const transferCounts = new Set(routes.map((r) => r.transfersCount))
      expect(transferCounts.size, `${label}: у всех альтернатив одинаковое число пересадок`).toBeGreaterThan(1)
    }
  })

  it('первый вариант — самый быстрый из набора', () => {
    for (const [from, to, label] of LONG_PAIRS) {
      const routes = findRouteAlternativesFullGraph(from, to)
      const minMinutes = Math.min(...routes.map((r) => r.totalMinutes))
      expect(routes[0].totalMinutes, `${label}: первый вариант не самый быстрый`).toBe(minMinutes)
    }
  })

  it('в наборе есть вариант с минимальным числом пересадок', () => {
    for (const [from, to, label] of LONG_PAIRS) {
      const routes = findRouteAlternativesFullGraph(from, to)
      const minTransfers = Math.min(...routes.map((r) => r.transfersCount))
      // Вариант «меньше всего пересадок» ставится вторым (или совпадает с самым быстрым).
      expect(
        Math.min(routes[0].transfersCount, routes[1].transfersCount),
        `${label}: вариант с минимумом пересадок не в начале списка`,
      ).toBe(minTransfers)
    }
  })

  it('времена альтернатив правдоподобны: положительны, конечны и не абсурдно велики', () => {
    for (const [from, to, label] of LONG_PAIRS) {
      const routes = findRouteAlternativesFullGraph(from, to)
      const fastest = routes[0].totalMinutes

      expect(fastest, `${label}: подозрительно быстрый маршрут через всю Москву`).toBeGreaterThan(20)
      for (const r of routes) {
        expect(Number.isFinite(r.totalMinutes)).toBe(true)
        expect(r.totalMinutes).toBeGreaterThan(0)
        // Худшая альтернатива не должна быть кратно хуже быстрейшей.
        expect(r.totalMinutes, `${label}: альтернатива абсурдно длинная`).toBeLessThanOrEqual(fastest * 3)
        expect(r.transfersCount).toBeLessThanOrEqual(8)
      }
    }
  })

  it('все альтернативы структурно корректны (связность, границы, суммы)', () => {
    for (const [from, to, label] of LONG_PAIRS) {
      const routes = findRouteAlternativesFullGraph(from, to)
      routes.forEach((route, index) => {
        expectRouteIsWellFormed(route, from, to, `${label} #${index}`)
      })
    }
  })

  it('на массовой выборке пар все маршруты корректны и уникальны', () => {
    for (const [from, to] of samplePairs(37, 53)) {
      const routes = findRouteAlternativesFullGraph(from, to)
      expect(routes.length, `нет альтернатив ${from} → ${to}`).toBeGreaterThan(0)

      const keys = new Set<string>()
      for (const route of routes) {
        expectRouteIsWellFormed(route, from, to, `${from} → ${to}`)
        keys.add([route.steps[0].fromStationId, ...route.steps.map((s) => s.toStationId)].join('>'))
      }
      expect(keys.size, `дубликаты альтернатив ${from} → ${to}`).toBe(routes.length)
    }
  })

  it('возвращает один пустой маршрут, если станции совпадают', () => {
    const routes = findRouteAlternativesFullGraph(KOMSOMOLSKAYA_1, KOMSOMOLSKAYA_1)
    expect(routes.length).toBe(1)
    expect(routes[0].steps).toEqual([])
    expect(routes[0].totalMinutes).toBe(0)
  })

  it('возвращает пустой массив для несуществующей станции', () => {
    expect(findRouteAlternativesFullGraph('no-such-station', KOMSOMOLSKAYA_1)).toEqual([])
    expect(findRouteAlternativesFullGraph(KOMSOMOLSKAYA_1, 'no-such-station')).toEqual([])
  })

  it('возвращает пустой массив, если станция отрезана от графа (все её рёбра отключены)', () => {
    const isolated = MEDVEDKOVO // конечная станция: единственное ребро
    const incident = fullGraphEdges.filter(
      (e) => e.fromStationId === isolated || e.toStationId === isolated,
    )
    expect(incident.length).toBeGreaterThan(0)

    const edgeOverrides = Object.fromEntries(
      incident.map((e) => [undirectedEdgeKey(e.fromStationId, e.toStationId), { disabled: true }]),
    )

    expect(findRouteAlternativesFullGraph(isolated, SALARYEVO, { edgeOverrides })).toEqual([])
  })

  it('соблюдает maxAlternatives=1, даже когда быстрейший и минимум пересадок — разные пути', () => {
    // Регрессия: кап проверялся только в цикле по others, а pushUnique(fastest)
    // и pushUnique(fewestTransfers) выполнялись до него — при запросе одного
    // варианта возвращались два. Парк культуры → Орехово: как раз тот случай,
    // когда быстрейший маршрут и маршрут с минимумом пересадок различаются.
    const routes = findRouteAlternativesFullGraph('1/park-kultury', '2/orekhovo', {
      maxAlternatives: 1,
    })
    expect(routes.length).toBe(1)
  })

  it('соблюдает maxAlternatives для значений > 1', () => {
    for (const n of [2, 3, 4, 6]) {
      const routes = findRouteAlternativesFullGraph(MEDVEDKOVO, SALARYEVO, { maxAlternatives: n })
      expect(routes.length, `запрошено ${n} альтернатив`).toBeLessThanOrEqual(n)
      expect(routes.length).toBeGreaterThan(0)
    }
  })
})

describe('findRouteAlternativesFullGraph — edgeOverrides и extraEdges', () => {
  const FROM = KOMSOMOLSKAYA_1
  const TO = SALARYEVO

  function midEdgeKeyOfBaseRoute() {
    const base = findRouteAlternativesFullGraph(FROM, TO)[0]
    const mid = base.steps[Math.floor(base.steps.length / 2)]
    return { base, key: undirectedEdgeKey(mid.fromStationId, mid.toStationId) }
  }

  it('disabled-ребро исключается из маршрута и путь перестраивается', () => {
    const { base, key } = midEdgeKeyOfBaseRoute()
    const rerouted = findRouteAlternativesFullGraph(FROM, TO, {
      edgeOverrides: { [key]: { disabled: true } },
    })

    expect(rerouted.length).toBeGreaterThan(0)
    const usesDisabled = rerouted[0].steps.some(
      (s) => undirectedEdgeKey(s.fromStationId, s.toStationId) === key,
    )
    expect(usesDisabled, 'отключённое ребро всё ещё используется').toBe(false)
    expect(rerouted[0].totalMinutes, 'обход не может быть быстрее исходного').toBeGreaterThan(
      base.totalMinutes,
    )
    expectRouteIsWellFormed(rerouted[0], FROM, TO, 'после disable')
  })

  it('увеличение medianTravelSeconds уводит маршрут с этого ребра', () => {
    const { base, key } = midEdgeKeyOfBaseRoute()
    const slowed = findRouteAlternativesFullGraph(FROM, TO, {
      edgeOverrides: { [key]: { medianTravelSeconds: 6000 } },
    })

    expect(slowed.length).toBeGreaterThan(0)
    expect(
      slowed[0].steps.some((s) => undirectedEdgeKey(s.fromStationId, s.toStationId) === key),
      'сильно замедленное ребро всё ещё в быстрейшем маршруте',
    ).toBe(false)
    expect(slowed[0].totalMinutes).toBeGreaterThan(base.totalMinutes)
  })

  it('override без изменений даёт тот же результат, что и базовый граф', () => {
    const base = findRouteAlternativesFullGraph(FROM, TO)
    const noop = findRouteAlternativesFullGraph(FROM, TO, { edgeOverrides: {} })

    expect(noop.map((r) => r.totalMinutes)).toEqual(base.map((r) => r.totalMinutes))
    expect(noop.map((r) => r.transfersCount)).toEqual(base.map((r) => r.transfersCount))
  })

  it('extraEdges добавляет новый перегон и он используется, если выгоден', () => {
    const base = findRouteAlternativesFullGraph(KOMSOMOLSKAYA_1, SALARYEVO)[0]

    const shortcut = findRouteAlternativesFullGraph(KOMSOMOLSKAYA_1, SALARYEVO, {
      extraEdges: [
        {
          fromStationId: KOMSOMOLSKAYA_1,
          toStationId: SALARYEVO,
          medianTravelSeconds: 60,
        },
      ],
    })

    expect(shortcut.length).toBeGreaterThan(0)
    expect(shortcut[0].steps.length, 'прямое дешёвое ребро не использовано').toBe(1)
    expect(shortcut[0].totalMinutes).toBe(1)
    expect(shortcut[0].totalMinutes).toBeLessThan(base.totalMinutes)
  })

  it('extraEdges имеет приоритет над базовым ребром той же пары станций', () => {
    const baseEdge = fullGraphEdges.find(
      (e) => !e.isTransfer && e.medianTravelSeconds > 60,
    )!
    const routes = findRouteAlternativesFullGraph(baseEdge.fromStationId, baseEdge.toStationId, {
      extraEdges: [
        {
          fromStationId: baseEdge.fromStationId,
          toStationId: baseEdge.toStationId,
          medianTravelSeconds: 6,
        },
      ],
    })

    expect(routes[0].steps.length).toBe(1)
    expect(routes[0].steps[0].travelMinutes).toBeCloseTo(0.1, 10)
  })

  it('override isTransfer=false убирает пересадку из счётчика', () => {
    const key = undirectedEdgeKey(KOMSOMOLSKAYA_1, KOMSOMOLSKAYA_5)
    const withTransfer = findRouteAlternativesFullGraph(KOMSOMOLSKAYA_1, KOMSOMOLSKAYA_5)[0]
    expect(withTransfer.transfersCount).toBe(1)

    const without = findRouteAlternativesFullGraph(KOMSOMOLSKAYA_1, KOMSOMOLSKAYA_5, {
      edgeOverrides: { [key]: { isTransfer: false } },
    })[0]
    expect(without.transfersCount).toBe(0)
    expect(without.totalMinutes).toBe(withTransfer.totalMinutes)
  })
})

describe('graphCore — вспомогательные структуры', () => {
  it('buildAdjacencyListFromFullGraph строит двунаправленный граф', () => {
    const adjacency = buildAdjacencyListFromFullGraph(fullGraphEdges)
    for (const edge of fullGraphEdges.slice(0, 50)) {
      const forward = adjacency.get(edge.fromStationId) ?? []
      const backward = adjacency.get(edge.toStationId) ?? []
      expect(forward.some((n) => n.toStationId === edge.toStationId)).toBe(true)
      expect(backward.some((n) => n.toStationId === edge.fromStationId)).toBe(true)
    }
  })

  it('undirectedEdgeKey не зависит от порядка станций', () => {
    expect(undirectedEdgeKey('a', 'b')).toBe(undirectedEdgeKey('b', 'a'))
    expect(undirectedEdgeKey('a', 'b')).not.toBe(undirectedEdgeKey('a', 'c'))
  })

  // -------------------------------------------------------------------------
  // ИНВАРИАНТ «пара станций → одно ребро».
  //
  // Путь Дейкстры — это список ВЕРШИН; тип и время шага восстанавливаются потом
  // по паре станций (`buildEdgeByKey`). Появись между парой два ребра — перегон
  // и пересадка, — поиск пошёл бы по одному, а нарисовалось бы другое: чужое
  // время, чужой тип, лишняя пересадка в счётчике. Сейчас таких рёбер нет;
  // тесты ниже существуют, чтобы это оставалось проверяемым фактом.
  // -------------------------------------------------------------------------
  it('в графе нет параллельных рёбер между одной парой станций', () => {
    expect(findParallelEdgeKeys(fullGraphEdges)).toEqual([])
  })

  it('findParallelEdgeKeys ловит подсунутую параллель', () => {
    const base = fullGraphEdges.find((e) => !e.isTransfer)!
    const parallel: FullGraphEdge = {
      ...base,
      isTransfer: true,
      medianTravelSeconds: base.medianTravelSeconds + 600,
    }
    expect(findParallelEdgeKeys([...fullGraphEdges, parallel])).toEqual([
      undirectedEdgeKey(base.fromStationId, base.toStationId),
    ])
  })

  it('ручное ребро вытесняет базовое, а не встаёт параллельно ему', () => {
    // Единственный способ добавить ребро из TS — extraEdges редактора.
    // findRouteAlternativesFullGraph выбрасывает базовое ребро той же пары,
    // поэтому инвариант держится и в редакторской сборке.
    const base = fullGraphEdges.find((e) => !e.isTransfer)!
    const manual: FullGraphEdge = {
      ...base,
      isTransfer: true,
      medianTravelSeconds: base.medianTravelSeconds + 600,
    }

    const route = findRouteAlternativesFullGraph(base.fromStationId, base.toStationId, {
      extraEdges: [manual],
    })[0]

    expect(route.steps.length).toBe(1)
    expect(route.steps[0].travelMinutes).toBe(manual.medianTravelSeconds / 60)
    expect(route.steps[0].isTransfer).toBe(true)
    expect(route.transfersCount).toBe(1)
  })

  it('buildRouteResultFromPath на пустом/одиночном пути даёт нулевой маршрут', () => {
    const edgeByKey = buildEdgeByKey(fullGraphEdges)
    expect(buildRouteResultFromPath([], edgeByKey)).toEqual({
      steps: [],
      totalMinutes: 0,
      transfersCount: 0,
    })
    expect(buildRouteResultFromPath([KOMSOMOLSKAYA_1], edgeByKey).steps).toEqual([])
  })
})
