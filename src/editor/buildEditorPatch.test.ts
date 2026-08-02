import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { buildEditorPatch, hasSavableChanges, type BuildPatchInput } from './buildEditorPatch.ts'
import { fullGraphEdges, fullGraphLines, fullGraphStations } from '../metro/fullGraph.ts'

const RING_LINE_IDS = new Set([5, 95, 97])
const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** Раскладка «как есть»: исходные координаты всех станций, ничего не двигали. */
const untouchedLayout = () => {
  const layout: Record<string, { x: number; y: number }> = {}
  for (const s of fullGraphStations) {
    layout[s.id] = { x: s.sourceX as number, y: s.sourceY as number }
  }
  return layout
}

function build(over: Partial<BuildPatchInput> = {}) {
  return buildEditorPatch({
    lines: fullGraphLines,
    stations: fullGraphStations,
    edges: fullGraphEdges,
    ringLineIds: RING_LINE_IDS,
    layout: untouchedLayout(),
    stationOverrides: {},
    edgeOverrides: {},
    edgeKey,
    ...over,
  })
}

describe('пустое состояние', () => {
  it('без правок сохранять нечего', () => {
    const result = build()
    expect(hasSavableChanges(result)).toBe(false)
    expect(result.counts).toEqual({ layout: 0, stations: 0, rides: 0, transfers: 0 })
    expect(result.unsupported).toEqual([])
  })

  /**
   * Раскладка уходит на сервер целиком всегда — сервер проверяет её полноту.
   * Но счётчик «сдвинуто» обязан показывать ноль, иначе кнопка «Сохранить»
   * горит на пустом месте.
   */
  it('раскладка отправляется целиком, но сдвинутых станций ноль', () => {
    const result = build()
    expect(Object.keys(result.patch.layout ?? {})).toHaveLength(fullGraphStations.length)
    expect(result.counts.layout).toBe(0)
  })
})

describe('раскладка', () => {
  it('сдвиг станции считается и попадает в патч', () => {
    const layout = untouchedLayout()
    const id = fullGraphStations[0].id
    layout[id] = { x: 1234, y: -5 }

    const result = build({ layout })
    expect(result.counts.layout).toBe(1)
    expect(result.patch.layout?.[id]).toEqual([1234, -5])
    expect(hasSavableChanges(result)).toBe(true)
  })

  it('нечисловые координаты в патч не попадают', () => {
    const layout = untouchedLayout()
    layout['broken'] = { x: Number.NaN, y: 0 }
    expect(result_ids(build({ layout }))).not.toContain('broken')
  })
})

const result_ids = (r: ReturnType<typeof build>) => Object.keys(r.patch.layout ?? {})

describe('станции', () => {
  const station = fullGraphStations[0]

  it('переименование попадает в патч', () => {
    const result = build({ stationOverrides: { [station.id]: { title: 'Новое имя' } } })
    expect(result.patch.stations?.[station.id]).toEqual({ title: 'Новое имя' })
    expect(result.counts.stations).toBe(1)
  })

  it('название, совпадающее с текущим, правкой не считается', () => {
    const result = build({ stationOverrides: { [station.id]: { title: station.title } } })
    expect(result.counts.stations).toBe(0)
  })

  it('пробелы по краям срезаются', () => {
    const result = build({ stationOverrides: { [station.id]: { title: '  Имя  ' } } })
    expect(result.patch.stations?.[station.id]?.title).toBe('Имя')
  })

  it('география попадает в патч', () => {
    const result = build({ stationOverrides: { [station.id]: { lat: 55.5, lon: 37.5 } } })
    expect(result.patch.stations?.[station.id]).toEqual({ lat: 55.5, lon: 37.5 })
  })

  /**
   * Перенос станции на другую линию в формате данных выражается переносом
   * записи между файлами — патчем этого не сделать. Молча потерять правку
   * нельзя, поэтому она уходит в список «не попадёт в файлы».
   */
  it('смена линии не сохраняется и названа вслух', () => {
    const result = build({
      stationOverrides: { [station.id]: { lineNumericId: 99 } },
    })
    expect(result.counts.stations).toBe(0)
    expect(result.unsupported.join()).toContain('другую линию')
  })

  it('станция, созданная в редакторе, названа вслух', () => {
    const result = build({ stationOverrides: { 'manual-1': { title: 'Новая' } } })
    expect(result.unsupported.join()).toContain('создана в редакторе')
  })
})

describe('перегоны и пересадки', () => {
  const ride = fullGraphEdges.find((e) => !e.isTransfer)!
  const transfer = fullGraphEdges.find((e) => e.isTransfer)!

  /**
   * В файле линии время хранится у станции, ОТ которой идёт перегон, поэтому
   * ключ обязан нести направление. Ключ редактора направления не знает —
   * оно восстанавливается обходом сегментов линии.
   */
  it('время перегона получает направление из хода линии', () => {
    const key = edgeKey(ride.fromStationId, ride.toStationId)
    const result = build({ edgeOverrides: { [key]: { medianTravelSeconds: 222 } } })

    const entries = Object.entries(result.patch.rides ?? {})
    expect(entries).toHaveLength(1)
    const [directed, seconds] = entries[0]
    expect(seconds).toBe(222)
    expect(directed.split('>').sort()).toEqual([ride.fromStationId, ride.toStationId].sort())
    expect(directed).toContain('>')
  })

  it('время пересадки уходит в transfers, а не в rides', () => {
    const key = edgeKey(transfer.fromStationId, transfer.toStationId)
    const result = build({ edgeOverrides: { [key]: { medianTravelSeconds: 333 } } })

    expect(result.patch.rides).toBeUndefined()
    expect(result.patch.transfers?.upsert).toHaveLength(1)
    expect(result.patch.transfers?.upsert?.[0].seconds).toBe(333)
    expect(result.counts.transfers).toBe(1)
  })

  it('время, равное текущему, правкой не считается', () => {
    const key = edgeKey(ride.fromStationId, ride.toStationId)
    const result = build({
      edgeOverrides: { [key]: { medianTravelSeconds: ride.medianTravelSeconds } },
    })
    expect(hasSavableChanges(result)).toBe(false)
  })

  it('включение «это пересадка» добавляет запись', () => {
    const key = edgeKey(ride.fromStationId, ride.toStationId)
    const result = build({ edgeOverrides: { [key]: { isTransfer: true } } })
    expect(result.patch.transfers?.upsert?.[0].stations.sort()).toEqual(
      [ride.fromStationId, ride.toStationId].sort(),
    )
  })

  it('выключение «это пересадка» удаляет запись', () => {
    const key = edgeKey(transfer.fromStationId, transfer.toStationId)
    const result = build({ edgeOverrides: { [key]: { isTransfer: false } } })
    expect(result.patch.transfers?.remove).toHaveLength(1)
    expect(result.patch.transfers?.upsert).toBeUndefined()
  })

  /** Отключение ребра — проверка маршрута, в данных такого понятия нет. */
  it('отключённое ребро не сохраняется и названо вслух', () => {
    const key = edgeKey(ride.fromStationId, ride.toStationId)
    const result = build({ edgeOverrides: { [key]: { disabled: true } } })
    expect(result.counts.rides).toBe(0)
    expect(result.unsupported.join()).toContain('отключено')
  })

  it('ребро, созданное в редакторе, названо вслух', () => {
    const result = build({ edgeOverrides: { 'нет|такого': { medianTravelSeconds: 100 } } })
    expect(result.unsupported.join()).toContain('создано в редакторе')
  })

  it('одинаковые причины в списке не повторяются', () => {
    const a = edgeKey(ride.fromStationId, ride.toStationId)
    const b = edgeKey(fullGraphEdges[1].fromStationId, fullGraphEdges[1].toStationId)
    const result = build({ edgeOverrides: { [a]: { disabled: true }, [b]: { disabled: true } } })
    expect(new Set(result.unsupported).size).toBe(result.unsupported.length)
  })
})

/**
 * Ради этого раздела заводился отдельный выбор типа: панель показывала
 * «близкая/дальняя» по порогу в шесть минут, а в `transfers.upsert` всегда
 * уходил kind из графа. Пересадка, заведённая как `near`, оставалась `near`
 * навсегда, а `mcc` и `out_of_station` были недостижимы вовсе.
 */
describe('тип пересадки', () => {
  const transfer = fullGraphEdges.find((e) => e.isTransfer)!
  const ride = fullGraphEdges.find((e) => !e.isTransfer)!
  const transferKey = edgeKey(transfer.fromStationId, transfer.toStationId)

  it('смена одного лишь типа — уже правка', () => {
    const result = build({ edgeTransferKinds: { [transferKey]: 'out_of_station' } })

    expect(result.counts.transfers).toBe(1)
    expect(result.patch.transfers?.upsert?.[0]).toMatchObject({
      kind: 'out_of_station',
      seconds: transfer.medianTravelSeconds,
    })
    expect(hasSavableChanges(result)).toBe(true)
  })

  it('тип, совпадающий с графом, правкой не считается', () => {
    const result = build({
      edgeTransferKinds: { [transferKey]: transfer.transferKind ?? 'near' },
    })
    expect(hasSavableChanges(result)).toBe(false)
  })

  it('тип и время меняются одной записью, а не двумя', () => {
    const result = build({
      edgeOverrides: { [transferKey]: { medianTravelSeconds: 333 } },
      edgeTransferKinds: { [transferKey]: 'far' },
    })

    expect(result.patch.transfers?.upsert).toEqual([
      { stations: [transfer.fromStationId, transfer.toStationId], kind: 'far', seconds: 333 },
    ])
  })

  it('новая пересадка из перегона получает выбранный тип', () => {
    const key = edgeKey(ride.fromStationId, ride.toStationId)
    const result = build({
      edgeOverrides: { [key]: { isTransfer: true } },
      edgeTransferKinds: { [key]: 'mcc' },
    })

    expect(result.patch.transfers?.upsert?.[0].kind).toBe('mcc')
  })

  /** У перегона записи в transfers.json нет, приписать тип некуда. */
  it('тип у перегона не сохраняется и назван вслух', () => {
    const key = edgeKey(ride.fromStationId, ride.toStationId)
    const result = build({ edgeTransferKinds: { [key]: 'far' } })

    expect(result.patch.transfers).toBeUndefined()
    expect(result.unsupported.join()).toContain('нет типа пересадки')
  })

  /** Удаление важнее типа: записи, которой приписывать kind, больше нет. */
  it('у выключенной пересадки тип не порождает второй записи', () => {
    const result = build({
      edgeOverrides: { [transferKey]: { isTransfer: false } },
      edgeTransferKinds: { [transferKey]: 'far' },
    })

    expect(result.patch.transfers?.remove).toHaveLength(1)
    expect(result.patch.transfers?.upsert).toBeUndefined()
  })
})

describe('круг «редактор -> data/layout.json»', () => {
  /**
   * Без единой правки координаты в патче обязаны совпасть с файлом на диске.
   *
   * Пока это не выполнялось, редактор отдавал координаты ПОСЛЕ проекции колец
   * и разведения станций, то есть кормил солвер его собственным выходом:
   * первое сохранение сдвигало 151 станцию из 304, второе — те же станции ещё
   * на 24px. Схема расползалась с каждым сохранением.
   */
  it('без правок патч не сдвигает ни одной станции относительно файла', () => {
    const onDisk = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../data/layout.json', import.meta.url)), 'utf8'),
    ) as { stations: Record<string, [number, number]> }

    const patchLayout = build().patch.layout!
    expect(Object.keys(patchLayout).sort()).toEqual(Object.keys(onDisk.stations).sort())

    const moved = Object.keys(patchLayout).filter(
      (id) =>
        patchLayout[id][0] !== onDisk.stations[id][0] ||
        patchLayout[id][1] !== onDisk.stations[id][1],
    )
    expect(moved).toEqual([])
  })
})

/**
 * Ради этого раздела всё и переделывалось: добавить пересадку было НЕЛЬЗЯ
 * ни одним путём. Через существующее ребро сервер отвечал «это перегон, а не
 * пересадка» — все рёбра внутри линии одноимённые. Через кнопку «Добавить»
 * связь попадала в manualEdges, а manualEdges сюда не передавались вовсе:
 * поля во входе не было. Правка исчезала бесследно, панель писала «Правок нет».
 */
describe('связь, созданная в редакторе', () => {
  /** Две станции разных линий, между которыми в данных связи нет. */
  const crossLine = () => {
    const a = fullGraphStations.find((s) => s.lineNumericId === 1)!
    const b = fullGraphStations.find(
      (s) => s.lineNumericId === 2 && !fullGraphEdges.some((e) =>
        edgeKey(e.fromStationId, e.toStationId) === edgeKey(a.id, s.id)),
    )!
    return { a, b }
  }

  const manualEdge = (fromStationId: string, toStationId: string, seconds: number) => ({
    [`manual:${edgeKey(fromStationId, toStationId)}`]: {
      fromStationId,
      toStationId,
      medianTravelSeconds: seconds,
      isTransfer: true,
    } as never,
  })

  it('между разными линиями становится пересадкой в файле', () => {
    const { a, b } = crossLine()
    const result = build({ manualEdges: manualEdge(a.id, b.id, 180) })

    expect(result.counts.transfers).toBe(1)
    expect(result.patch.transfers?.upsert).toEqual([
      { stations: [a.id, b.id], kind: 'near', seconds: 180 },
    ])
    expect(hasSavableChanges(result)).toBe(true)
  })

  /** Молчаливая потеря — худший исход: правка была, файлы не изменились. */
  it('не теряется, даже если время после создания не трогали', () => {
    const { a, b } = crossLine()
    const result = build({ manualEdges: manualEdge(a.id, b.id, 180) })
    expect(result.unsupported).toEqual([])
    expect(result.counts.transfers).toBe(1)
  })

  it('правка времени в панели важнее того, с которым связь создали', () => {
    const { a, b } = crossLine()
    const result = build({
      manualEdges: manualEdge(a.id, b.id, 180),
      edgeOverrides: { [edgeKey(a.id, b.id)]: { medianTravelSeconds: 240 } },
    })

    expect(result.patch.transfers?.upsert).toEqual([
      { stations: [a.id, b.id], kind: 'near', seconds: 240 },
    ])
  })

  /**
   * Сервер такую пару отвергает целиком, и правильно: внутри линии связь —
   * это перегон. Сказать об этом надо ДО сохранения, а не отказом на весь патч.
   */
  it('внутри одной линии названа вслух, а не отправлена на сервер', () => {
    const [a, b] = fullGraphStations.filter((s) => s.lineNumericId === 1).slice(0, 2)
    const result = build({ manualEdges: manualEdge(a.id, b.id, 180) })

    expect(result.patch.transfers).toBeUndefined()
    expect(result.unsupported).toHaveLength(1)
    expect(result.unsupported[0]).toContain('одной линии')
  })

  it('получает выбранный тип, а не только «близкая»', () => {
    const { a, b } = crossLine()
    const result = build({
      manualEdges: manualEdge(a.id, b.id, 180),
      edgeTransferKinds: { [edgeKey(a.id, b.id)]: 'out_of_station' },
    })

    expect(result.patch.transfers?.upsert).toEqual([
      { stations: [a.id, b.id], kind: 'out_of_station', seconds: 180 },
    ])
  })

  /**
   * СТОРОЖ БАГА. «Удалить» на только что заведённой связи ставило ей
   * `disabled`, а пересадка всё равно уезжала в transfers.json: ручные связи
   * разбираются до edgeOverrides и на отметку не смотрели. Снаружи это
   * выглядело как пересадка, появившаяся сама по себе.
   */
  it('удалённая до сохранения в файл не уезжает', () => {
    const { a, b } = crossLine()
    const result = build({
      manualEdges: manualEdge(a.id, b.id, 180),
      edgeOverrides: { [edgeKey(a.id, b.id)]: { disabled: true } },
    })

    expect(result.patch.transfers).toBeUndefined()
    expect(result.counts.transfers).toBe(0)
    expect(hasSavableChanges(result)).toBe(false)
    // Жаловаться не на что: связи ещё нет в файлах, терять нечего.
    expect(result.unsupported).toEqual([])
  })

  /** Иначе одна и та же пересадка уехала бы в файл дважды. */
  it('уже существующая связь не дублируется', () => {
    const existing = fullGraphEdges.find((e) => e.isTransfer)!
    const result = build({
      manualEdges: manualEdge(existing.fromStationId, existing.toStationId, 180),
    })

    expect(result.patch.transfers).toBeUndefined()
    expect(result.unsupported).toEqual([])
  })
})
