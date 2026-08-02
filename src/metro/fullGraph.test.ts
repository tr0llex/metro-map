import { describe, expect, it } from 'vitest'
import {
  fullGraphEdges,
  fullGraphLines,
  fullGraphRingShapes,
  fullGraphStations,
  fullGraphTransferHubs,
} from './fullGraph'
import { undirectedEdgeKey } from './graphCore'

/**
 * Эталонные размеры графа normalized/fullGraph.json на момент написания тестов.
 *
 * ВАЖНО: эти числа обновляются ОСОЗНАННО — вместе с правкой данных и после
 * проверки схемы глазами. Тест ниже отдельно проверяет «разумный диапазон»
 * (чтобы поймать катастрофическую потерю данных) и отдельно — точное
 * совпадение (чтобы случайная перегенерация данных не прошла незамеченной).
 */
const EXPECTED_GRAPH_SIZE = {
  lines: 16,
  stations: 304,
  edges: 386,
  transferHubs: 56,
} as const

/** ID кольцевых линий: Кольцевая (5), МЦК (95), БКЛ (97). */
const RING_LINE_IDS = [5, 95, 97] as const

/** Допуск отклонения станции кольца от аналитической формы, px. */
const RING_TOLERANCE_PX = 0.01

const stationById = new Map(fullGraphStations.map((s) => [s.id, s]))
const lineById = new Map(fullGraphLines.map((l) => [l.id, l]))

describe('fullGraph.json — размеры графа', () => {
  it('размеры графа в разумных пределах (нет катастрофической потери данных)', () => {
    expect(fullGraphLines.length).toBeGreaterThanOrEqual(10)
    expect(fullGraphLines.length).toBeLessThanOrEqual(40)
    expect(fullGraphStations.length).toBeGreaterThanOrEqual(250)
    expect(fullGraphStations.length).toBeLessThanOrEqual(600)
    expect(fullGraphEdges.length).toBeGreaterThanOrEqual(fullGraphStations.length)
    expect(fullGraphEdges.length).toBeLessThanOrEqual(fullGraphStations.length * 3)
    expect(fullGraphTransferHubs.length).toBeGreaterThanOrEqual(30)
    expect(fullGraphTransferHubs.length).toBeLessThanOrEqual(150)
  })

  it('размеры графа совпадают с эталоном EXPECTED_GRAPH_SIZE (обновлять осознанно)', () => {
    expect({
      lines: fullGraphLines.length,
      stations: fullGraphStations.length,
      edges: fullGraphEdges.length,
      transferHubs: fullGraphTransferHubs.length,
    }).toEqual(EXPECTED_GRAPH_SIZE)
  })
})

describe('fullGraph.json — станции', () => {
  it('id станций уникальны', () => {
    expect(stationById.size).toBe(fullGraphStations.length)
  })

  it('у всех станций заданы layoutX/layoutY (иначе схема рисуется в точке 0,0)', () => {
    const broken = fullGraphStations.filter(
      (s) => !Number.isFinite(s.layoutX) || !Number.isFinite(s.layoutY),
    )
    expect(broken.map((s) => s.id)).toEqual([])
  })

  it('у всех станций непустой заголовок', () => {
    const broken = fullGraphStations.filter((s) => !s.title || s.title.trim().length === 0)
    expect(broken.map((s) => s.id)).toEqual([])
  })

  it('lineNumericId задан у всех станций и ссылается на существующую линию', () => {
    const broken = fullGraphStations.filter(
      (s) => s.lineNumericId === null || s.lineNumericId === undefined || !lineById.has(s.lineNumericId),
    )
    expect(broken.map((s) => `${s.id}:${s.lineNumericId}`)).toEqual([])
  })
})

describe('fullGraph.json — линии', () => {
  it('id линий уникальны', () => {
    expect(lineById.size).toBe(fullGraphLines.length)
  })

  it('все stationIds линий ссылаются на существующие станции', () => {
    const dangling: string[] = []
    for (const line of fullGraphLines) {
      for (const id of line.stationIds) {
        if (!stationById.has(id)) dangling.push(`${line.id}:${id}`)
      }
    }
    expect(dangling).toEqual([])
  })

  it('в каждой линии не меньше двух станций и нет повторов', () => {
    for (const line of fullGraphLines) {
      expect(line.stationIds.length, `линия ${line.id} (${line.title})`).toBeGreaterThanOrEqual(2)
      expect(new Set(line.stationIds).size, `повторы в линии ${line.id}`).toBe(line.stationIds.length)
    }
  })

  it('у всех линий валидный цвет #rrggbb', () => {
    for (const line of fullGraphLines) {
      expect(line.colorHex, `линия ${line.id}`).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })

  it('каждая станция принадлежит ровно одной линии по её lineNumericId', () => {
    const mismatched: string[] = []
    for (const line of fullGraphLines) {
      for (const id of line.stationIds) {
        const station = stationById.get(id)
        if (station && station.lineNumericId !== line.id) {
          mismatched.push(`${id}: в линии ${line.id}, но lineNumericId=${station.lineNumericId}`)
        }
      }
    }
    expect(mismatched).toEqual([])
  })
})

describe('fullGraph.json — рёбра', () => {
  it('все концы рёбер ссылаются на существующие станции', () => {
    const dangling = fullGraphEdges.filter(
      (e) => !stationById.has(e.fromStationId) || !stationById.has(e.toStationId),
    )
    expect(dangling.map((e) => `${e.fromStationId}->${e.toStationId}`)).toEqual([])
  })

  it('нет петель и нет дублей пары станций', () => {
    const loops = fullGraphEdges.filter((e) => e.fromStationId === e.toStationId)
    expect(loops).toEqual([])

    const seen = new Set<string>()
    const dupes: string[] = []
    for (const e of fullGraphEdges) {
      const key = undirectedEdgeKey(e.fromStationId, e.toStationId)
      if (seen.has(key)) dupes.push(key)
      seen.add(key)
    }
    expect(dupes).toEqual([])
  })

  it('medianTravelSeconds положительно и правдоподобно (до 20 минут)', () => {
    const broken = fullGraphEdges.filter(
      (e) => !Number.isFinite(e.medianTravelSeconds) || e.medianTravelSeconds <= 0 || e.medianTravelSeconds > 1200,
    )
    expect(broken.map((e) => `${e.fromStationId}->${e.toStationId}:${e.medianTravelSeconds}`)).toEqual([])
  })

  it('в графе есть пересадочные рёбра', () => {
    expect(fullGraphEdges.filter((e) => e.isTransfer).length).toBeGreaterThan(0)
  })
})

describe('fullGraph.json — пересадочные хабы', () => {
  it('id хабов уникальны', () => {
    expect(new Set(fullGraphTransferHubs.map((h) => h.id)).size).toBe(fullGraphTransferHubs.length)
  })

  it('все stationIds хабов ссылаются на существующие станции', () => {
    const dangling: string[] = []
    for (const hub of fullGraphTransferHubs) {
      for (const id of hub.stationIds) {
        if (!stationById.has(id)) dangling.push(`${hub.id}:${id}`)
      }
    }
    expect(dangling).toEqual([])
  })

  it('нет хабов из одной станции (такой хаб не является пересадкой)', () => {
    const degenerate = fullGraphTransferHubs.filter((h) => h.stationIds.length < 2)
    expect(degenerate.map((h) => h.id)).toEqual([])
  })

  it('станция не входит в два разных хаба', () => {
    const owner = new Map<string, string>()
    const conflicts: string[] = []
    for (const hub of fullGraphTransferHubs) {
      for (const id of hub.stationIds) {
        const prev = owner.get(id)
        if (prev) conflicts.push(`${id}: ${prev} и ${hub.id}`)
        else owner.set(id, hub.id)
      }
    }
    expect(conflicts).toEqual([])
  })

  it('minTransferSeconds положительно и правдоподобно', () => {
    for (const hub of fullGraphTransferHubs) {
      expect(hub.minTransferSeconds, `хаб ${hub.id}`).toBeGreaterThan(0)
      expect(hub.minTransferSeconds, `хаб ${hub.id}`).toBeLessThanOrEqual(1800)
    }
  })
})

describe('fullGraph.json — связность', () => {
  function componentSize(useHubs: boolean): number {
    const adjacency = new Map<string, string[]>()
    const link = (a: string, b: string) => {
      if (!adjacency.has(a)) adjacency.set(a, [])
      adjacency.get(a)!.push(b)
    }
    for (const e of fullGraphEdges) {
      link(e.fromStationId, e.toStationId)
      link(e.toStationId, e.fromStationId)
    }
    if (useHubs) {
      for (const hub of fullGraphTransferHubs) {
        for (const a of hub.stationIds) {
          for (const b of hub.stationIds) {
            if (a !== b) link(a, b)
          }
        }
      }
    }

    const start = fullGraphStations[0].id
    const visited = new Set<string>([start])
    const stack = [start]
    while (stack.length > 0) {
      const current = stack.pop()!
      for (const next of adjacency.get(current) ?? []) {
        if (!visited.has(next)) {
          visited.add(next)
          stack.push(next)
        }
      }
    }
    return visited.size
  }

  it('граф связен по рёбрам и хабам (одна компонента)', () => {
    expect(componentSize(true)).toBe(fullGraphStations.length)
  })

  it('граф связен уже по одним рёбрам (пересадки заданы рёбрами, а не только хабами)', () => {
    expect(componentSize(false)).toBe(fullGraphStations.length)
  })

  it('у каждой станции есть хотя бы одно ребро', () => {
    const withEdges = new Set<string>()
    for (const e of fullGraphEdges) {
      withEdges.add(e.fromStationId)
      withEdges.add(e.toStationId)
    }
    const orphans = fullGraphStations.filter((s) => !withEdges.has(s.id))
    expect(orphans.map((s) => s.id)).toEqual([])
  })
})

describe('fullGraph.json — ringShapes (данные = картинка)', () => {
  it('поле ringShapes присутствует и разбирается', () => {
    expect(Object.keys(fullGraphRingShapes).length).toBeGreaterThan(0)
  })

  it('формы заданы для всех кольцевых линий (5, 95, 97)', () => {
    for (const lineId of RING_LINE_IDS) {
      expect(lineById.has(lineId), `линия ${lineId} отсутствует в данных`).toBe(true)
      expect(fullGraphRingShapes[String(lineId)], `нет ringShape для линии ${lineId}`).toBeDefined()
    }
  })

  it('параметры форм конечны и положительны', () => {
    for (const [lineId, shape] of Object.entries(fullGraphRingShapes)) {
      expect(Number.isFinite(shape.cx), `линия ${lineId}`).toBe(true)
      expect(Number.isFinite(shape.cy), `линия ${lineId}`).toBe(true)
      if (shape.kind === 'circle') {
        expect(shape.r, `линия ${lineId}`).toBeGreaterThan(0)
      } else {
        expect(shape.rx, `линия ${lineId}`).toBeGreaterThan(0)
        expect(shape.ry, `линия ${lineId}`).toBeGreaterThan(0)
      }
    }
  })

  it('станции кольцевых линий лежат ровно на своей форме (допуск 0.01 px)', () => {
    for (const [lineId, shape] of Object.entries(fullGraphRingShapes)) {
      const line = lineById.get(Number(lineId))
      expect(line, `нет линии ${lineId} для ringShape`).toBeDefined()
      if (!line) continue

      const rx = shape.kind === 'circle' ? shape.r : shape.rx
      const ry = shape.kind === 'circle' ? shape.r : shape.ry

      for (const stationId of line.stationIds) {
        const station = stationById.get(stationId)
        expect(station, `нет станции ${stationId}`).toBeDefined()
        if (!station) continue

        const nx = (station.layoutX! - shape.cx) / rx
        const ny = (station.layoutY! - shape.cy) / ry
        // Нормированное отклонение, переведённое в пиксели по большей полуоси
        // (консервативная оценка сверху для расстояния до эллипса).
        const deviationPx = Math.abs(Math.hypot(nx, ny) - 1) * Math.max(rx, ry)

        expect(
          deviationPx,
          `станция ${stationId} (${station.title}) линии ${lineId} вне кольца: ${deviationPx.toFixed(4)} px`,
        ).toBeLessThan(RING_TOLERANCE_PX)
      }
    }
  })

  it('станции распределены по кольцу, а не сбиты в одну точку', () => {
    for (const [lineId, shape] of Object.entries(fullGraphRingShapes)) {
      const line = lineById.get(Number(lineId))
      if (!line) continue
      const rx = shape.kind === 'circle' ? shape.r : shape.rx
      const ry = shape.kind === 'circle' ? shape.r : shape.ry

      const angles = line.stationIds
        .map((id) => stationById.get(id))
        .filter((s): s is NonNullable<typeof s> => !!s)
        .map((s) => Math.atan2((s.layoutY! - shape.cy) / ry, (s.layoutX! - shape.cx) / rx))

      expect(new Set(angles.map((a) => a.toFixed(4))).size, `линия ${lineId}: совпадающие углы`).toBe(
        angles.length,
      )
      expect(Math.max(...angles) - Math.min(...angles), `линия ${lineId}: станции в секторе`).toBeGreaterThan(
        Math.PI,
      )
    }
  })
})
