// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { useStationSuggestions } from './useStationSuggestions.ts'
import type { FullGraphLine, FullGraphStation } from '../metro/types.ts'
import type { SavedRoute } from '../features/route/savedRoutes.ts'

const line = (id: number, title: string, colorHex: string): FullGraphLine => ({
  id,
  title,
  colorHex,
  stationIds: [],
  segments: [],
})

const station = (id: string, title: string, lineNumericId: number): FullGraphStation => ({
  id,
  title,
  lineNumericId,
})

const LINES = new Map<number, FullGraphLine>([
  [1, line(1, 'Сокольническая', '#E42313')],
  [3, line(3, 'Арбатско-Покровская', '#0072BA')],
  [5, line(5, 'Кольцевая', '#915133')],
])

const STATIONS = [
  station('1/sokolniki', 'Сокольники', 1),
  station('1/kievskaya', 'Киевская', 1),
  station('3/kievskaya', 'Киевская', 3),
  station('5/kievskaya', 'Киевская', 5),
  station('1/park-kultury', 'Парк культуры', 1),
  station('3/arbatskaya', 'Арбатская', 3),
]

const route = (from: string, to: string, fromTitle: string, toTitle: string): SavedRoute => ({
  fromStationId: from,
  toStationId: to,
  fromTitle,
  toTitle,
  lastUsedAt: 1,
})

type Params = Parameters<typeof useStationSuggestions>[0]

function setup(over: Partial<Params> = {}) {
  const params: Params = {
    allStations: STATIONS,
    stationOverrides: {},
    lineByNumericId: LINES,
    fromStation: '',
    toStation: '',
    fromFixed: false,
    toFixed: false,
    sameStationField: null,
    fromStationId: null,
    toStationId: null,
    recentRoutes: [],
    favoriteRoutes: [],
    nearbyStations: [],
    ...over,
  }
  return renderHook(() => useStationSuggestions(params)).result
}

describe('подсказки по вводу', () => {
  it('ищут по подстроке независимо от регистра', () => {
    const r = setup({ fromStation: 'соколь' })
    expect(r.current.fromSuggestions.map((s) => s.title)).toContain('Сокольники')
  })

  /**
   * Уточнение линии показывается ТОЛЬКО у неуникальных названий: у трёх
   * «Киевских» без него не отличить, а у «Сокольников» это лишний шум.
   */
  it('название линии подставляется только у станций-тёзок', () => {
    const r = setup({ fromStation: 'киевская' })
    const kiev = r.current.fromSuggestions.filter((s) => s.title === 'Киевская')
    expect(kiev.length).toBe(3)
    expect(kiev.every((s) => !!s.lineTitle)).toBe(true)

    const sokol = setup({ fromStation: 'сокольники' }).current.fromSuggestions[0]
    expect(sokol.lineTitle).toBeUndefined()
  })

  it('цвет линии приходит вместе со строкой', () => {
    const r = setup({ fromStation: 'сокольники' })
    expect(r.current.fromSuggestions[0].color).toBe('#E42313')
  })

  it('у выбранной станции подсказок нет', () => {
    const r = setup({ fromStation: 'Сокольники', fromFixed: true })
    expect(r.current.fromSuggestions).toEqual([])
  })

  /**
   * После отказа «эта станция уже занята соседним полем» список закрывается:
   * иначе он висит поверх подсказки под полем и повторно предлагает ровно ту
   * станцию, которую только что отклонили.
   */
  it('отказ по совпадению станций закрывает список и даёт подсказку под полем', () => {
    const r = setup({ fromStation: 'киевская', sameStationField: 'from' })
    expect(r.current.fromSuggestions).toEqual([])
    expect(r.current.fromFieldHint).toBe('Эта станция уже выбрана в поле «Куда»')
    expect(r.current.toFieldHint).toBeNull()
  })

  it('«ничего не нашли» отличается от пустого поля и от выбранной станции', () => {
    expect(setup({ fromStation: 'щщщ' }).current.fromNoMatches).toBe(true)
    expect(setup({ fromStation: '' }).current.fromNoMatches).toBe(false)
    expect(setup({ fromStation: '   ' }).current.fromNoMatches).toBe(false)
    expect(setup({ fromStation: 'щщщ', fromFixed: true }).current.fromNoMatches).toBe(false)
    expect(
      setup({ fromStation: 'щщщ', sameStationField: 'from' }).current.fromNoMatches,
    ).toBe(false)
  })

  it('переименование через оверрайд участвует в поиске', () => {
    const r = setup({
      fromStation: 'новое имя',
      stationOverrides: { '1/sokolniki': { title: 'Новое имя' } },
    })
    expect(r.current.fromSuggestions[0]?.title).toBe('Новое имя')
  })
})

describe('подсказки для ПУСТОГО поля', () => {
  it('в «Откуда» станции рядом идут первыми', () => {
    const r = setup({
      nearbyStations: [station('1/park-kultury', 'Парк культуры', 1)],
      favoriteRoutes: [route('1/sokolniki', '3/arbatskaya', 'Сокольники', 'Арбатская')],
    })
    expect(r.current.fromDefaultSuggestions[0].title).toBe('Парк культуры')
    expect(r.current.fromDefaultSuggestions[0].meta).toBe('Рядом')
  })

  it('в «Куда» первыми идут цели избранных поездок', () => {
    const r = setup({
      nearbyStations: [station('1/park-kultury', 'Парк культуры', 1)],
      favoriteRoutes: [route('1/sokolniki', '3/arbatskaya', 'Сокольники', 'Арбатская')],
    })
    expect(r.current.toDefaultSuggestions[0].title).toBe('Арбатская')
    expect(r.current.toDefaultSuggestions[0].meta).toBe('Избранное')
  })

  it('уже выбранные станции в подсказки не попадают', () => {
    const r = setup({
      fromStationId: '1/sokolniki',
      toStationId: '3/arbatskaya',
      nearbyStations: [station('1/sokolniki', 'Сокольники', 1)],
      recentRoutes: [route('1/sokolniki', '3/arbatskaya', 'Сокольники', 'Арбатская')],
    })
    const ids = r.current.fromDefaultSuggestions.map((s) => s.id)
    expect(ids).not.toContain('1/sokolniki')
    expect(ids).not.toContain('3/arbatskaya')
  })

  /** Связка «эта станция → вот эта» ценнее, чем просто недавняя станция. */
  it('маршруты, парные уже выбранной станции, поднимаются наверх', () => {
    const r = setup({
      toStationId: '3/arbatskaya',
      recentRoutes: [
        route('1/park-kultury', '5/kievskaya', 'Парк культуры', 'Киевская'),
        route('1/sokolniki', '3/arbatskaya', 'Сокольники', 'Арбатская'),
      ],
    })
    expect(r.current.fromDefaultSuggestions[0].title).toBe('Сокольники')
  })

  it('дубликаты между источниками не повторяются', () => {
    const r = setup({
      nearbyStations: [station('1/sokolniki', 'Сокольники', 1)],
      favoriteRoutes: [route('1/sokolniki', '3/arbatskaya', 'Сокольники', 'Арбатская')],
      recentRoutes: [route('1/sokolniki', '3/arbatskaya', 'Сокольники', 'Арбатская')],
    })
    const ids = r.current.fromDefaultSuggestions.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('список для пустого поля короче списка результатов поиска', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      route(`1/from-${i}`, `1/to-${i}`, `Откуда ${i}`, `Куда ${i}`),
    )
    const r = setup({ recentRoutes: many })
    expect(r.current.fromDefaultSuggestions.length).toBeLessThanOrEqual(6)
  })

  it('без истории и без геолокации подсказок нет — выдумывать «популярное» неоткуда', () => {
    const r = setup()
    expect(r.current.fromDefaultSuggestions).toEqual([])
    expect(r.current.toDefaultSuggestions).toEqual([])
  })
})
