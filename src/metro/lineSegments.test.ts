import { describe, expect, it } from 'vitest'

import { lineStationPairs } from './lineSegments.ts'
import { fullGraphLines } from './fullGraph.ts'

/** Кольцевые линии схемы: Кольцевая, МЦК, БКЛ. */
const RING_LINE_IDS = new Set([5, 95, 97])

describe('lineStationPairs — обход линии по соседним парам', () => {
  it('обычная линия: пар на одну меньше, чем станций', () => {
    const line = { stationIds: ['a', 'b', 'c'], segments: [['a', 'b', 'c']] }
    expect(lineStationPairs(line, false)).toEqual([
      ['a', 'b'],
      ['b', 'c'],
    ])
  })

  it('кольцевая линия замыкается парой «последняя → первая»', () => {
    const line = { stationIds: ['a', 'b', 'c'], segments: [['a', 'b', 'c']] }
    expect(lineStationPairs(line, true)).toEqual([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
    ])
  })

  it('линия из двух станций в кольцо не замыкается: это было бы ребро туда-обратно', () => {
    const line = { stationIds: ['a', 'b'], segments: [['a', 'b']] }
    expect(lineStationPairs(line, true)).toEqual([['a', 'b']])
  })

  /**
   * Та самая ошибка, ради которой модуль и появился. Плоский список
   * «основной ход + ветка» при обходе подряд соединял последнюю станцию
   * основного хода с первой станцией ветки: у Филёвской получался штрих от
   * «Александровского сада» к «Деловому центру» через полсхемы.
   */
  it('ответвление НЕ образует пару с концом основного хода', () => {
    const line = {
      stationIds: ['m1', 'm2', 'm3', 'b1', 'b2'],
      segments: [
        ['m1', 'm2', 'm3'],
        ['m2', 'b1', 'b2'],
      ],
    }
    const pairs = lineStationPairs(line, false)

    expect(pairs).toEqual([
      ['m1', 'm2'],
      ['m2', 'm3'],
      ['m2', 'b1'],
      ['b1', 'b2'],
    ])
    expect(pairs).not.toContainEqual(['m3', 'b1'])
  })

  it('ветка начинается со станции отхода, поэтому полилиния связна', () => {
    const line = {
      stationIds: ['m1', 'm2', 'b1'],
      segments: [
        ['m1', 'm2'],
        ['m1', 'b1'],
      ],
    }
    expect(lineStationPairs(line, false)).toContainEqual(['m1', 'b1'])
  })

  it('без segments откатывается на stationIds — данные, собранные до появления веток', () => {
    const line = { stationIds: ['a', 'b', 'c'] }
    expect(lineStationPairs(line, false)).toEqual([
      ['a', 'b'],
      ['b', 'c'],
    ])
  })

  it('пустой segments тоже откатывается на stationIds, а не даёт ноль пар', () => {
    const line = { stationIds: ['a', 'b'], segments: [] }
    expect(lineStationPairs(line, false)).toEqual([['a', 'b']])
  })

  it('фильтр has отсеивает станции без координат', () => {
    const line = { stationIds: ['a', 'b', 'c'], segments: [['a', 'b', 'c']] }
    const pairs = lineStationPairs(line, false, (id) => id !== 'b')
    expect(pairs).toEqual([['a', 'c']])
  })

  it('сегмент, от которого после фильтра осталась одна станция, пар не даёт', () => {
    const line = {
      stationIds: ['m1', 'm2', 'b1'],
      segments: [
        ['m1', 'm2'],
        ['m1', 'b1'],
      ],
    }
    const pairs = lineStationPairs(line, false, (id) => id === 'm1' || id === 'm2')
    expect(pairs).toEqual([['m1', 'm2']])
  })
})

describe('lineStationPairs на реальной схеме', () => {
  it('каждая пара — это существующее ребро линии в графе', async () => {
    const { fullGraphEdges } = await import('./fullGraph.ts')
    const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
    const rideEdges = new Set(
      fullGraphEdges.filter((e) => !e.isTransfer).map((e) => edgeKey(e.fromStationId, e.toStationId)),
    )

    const orphans: string[] = []
    for (const line of fullGraphLines) {
      for (const [a, b] of lineStationPairs(line, RING_LINE_IDS.has(line.id))) {
        if (!rideEdges.has(edgeKey(a, b))) orphans.push(`${line.title}: ${a} — ${b}`)
      }
    }

    expect(orphans, 'обход рисует перегон, которого нет в графе').toEqual([])
  })

  it('обход покрывает ВСЕ перегоны графа — ни один не потерян', async () => {
    const { fullGraphEdges } = await import('./fullGraph.ts')
    const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

    const covered = new Set<string>()
    for (const line of fullGraphLines) {
      for (const [a, b] of lineStationPairs(line, RING_LINE_IDS.has(line.id))) {
        covered.add(edgeKey(a, b))
      }
    }

    const missing = fullGraphEdges
      .filter((e) => !e.isTransfer)
      .map((e) => edgeKey(e.fromStationId, e.toStationId))
      .filter((k) => !covered.has(k))

    expect(missing, 'перегон есть в графе, но обход его не рисует').toEqual([])
  })

  it('у Филёвской ровно два хода: основной и ветка на Москва-Сити', () => {
    const filevskaya = fullGraphLines.find((l) => l.id === 4)
    expect(filevskaya, 'линия 4 не найдена').toBeTruthy()
    expect(filevskaya!.segments.length).toBe(2)

    const branch = filevskaya!.segments[1]
    expect(branch[0], 'ветка обязана начинаться со станции отхода').toBe('4/kievskaya')
    expect(branch).toContain('4/moskva-siti')

    const main = filevskaya!.segments[0]
    expect(main[main.length - 1]).toBe('4/aleksandrovskiy-sad')
  })

  it('у линий без ответвлений сегмент ровно один', () => {
    const many = fullGraphLines.filter((l) => l.segments.length > 1).map((l) => l.id)
    expect(many).toEqual([4])
  })
})
