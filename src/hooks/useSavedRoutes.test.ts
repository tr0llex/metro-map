// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FAVORITES_LIMIT,
  FAVORITES_STORAGE_KEY,
  RECENTS_LIMIT,
  RECENTS_STORAGE_KEY,
  type SavedRoute,
} from '../features/route/savedRoutes.ts'
import { useSavedRoutes, type RouteEndpoints } from './useSavedRoutes.ts'

const ends = (n: number): RouteEndpoints => ({
  fromStationId: `1/from-${n}`,
  toStationId: `5/to-${n}`,
  fromTitle: `Откуда ${n}`,
  toTitle: `Куда ${n}`,
})

const stored = (key: string): SavedRoute[] => {
  const raw = window.localStorage.getItem(key)
  return raw ? (JSON.parse(raw) as SavedRoute[]) : []
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useSavedRoutes — чтение при старте', () => {
  it('пустое хранилище даёт пустые списки', () => {
    const { result } = renderHook(() => useSavedRoutes())
    expect(result.current.favorites).toEqual([])
    expect(result.current.recents).toEqual([])
  })

  /**
   * Ровно та поломка, из-за которой приложение падало при каждом построении
   * маршрута: битая запись ВНУТРИ массива. Экран ошибки localStorage
   * сознательно не чистит, поэтому цикл падений был безвыходным.
   */
  it('битые записи внутри массива отбрасываются, годные остаются', () => {
    const good = { ...ends(1), lastUsedAt: 1 }
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify([null, good, { a: 1 }]))
    window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify([good, null]))

    const { result } = renderHook(() => useSavedRoutes())
    expect(result.current.favorites).toEqual([good])
    expect(result.current.recents).toEqual([good])
  })

  it('не-JSON в хранилище не роняет хук', () => {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, '{битое')
    window.localStorage.setItem(RECENTS_STORAGE_KEY, '{битое')
    const { result } = renderHook(() => useSavedRoutes())
    expect(result.current.favorites).toEqual([])
    expect(result.current.recents).toEqual([])
  })

  it('недавние обрезаются до лимита, и обрезанное сразу переписывается в хранилище', () => {
    const many = Array.from({ length: RECENTS_LIMIT + 4 }, (_, i) => ({
      ...ends(i),
      lastUsedAt: i,
    }))
    window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(many))

    const { result } = renderHook(() => useSavedRoutes())
    expect(result.current.recents).toHaveLength(RECENTS_LIMIT)
    expect(stored(RECENTS_STORAGE_KEY)).toHaveLength(RECENTS_LIMIT)
  })

  it('недавние не-массивом стираются из хранилища', () => {
    window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify({ not: 'array' }))
    const { result } = renderHook(() => useSavedRoutes())
    expect(result.current.recents).toEqual([])
    expect(window.localStorage.getItem(RECENTS_STORAGE_KEY)).toBeNull()
  })
})

describe('избранное', () => {
  it('добавляется и удаляется одним и тем же действием', () => {
    const { result } = renderHook(() => useSavedRoutes())

    act(() => result.current.toggleFavorite(ends(1)))
    expect(result.current.isFavorite(ends(1))).toBe(true)
    expect(stored(FAVORITES_STORAGE_KEY)).toHaveLength(1)

    act(() => result.current.toggleFavorite(ends(1)))
    expect(result.current.isFavorite(ends(1))).toBe(false)
    expect(stored(FAVORITES_STORAGE_KEY)).toHaveLength(0)
  })

  it('маршрут опознаётся по паре станций, а не по названиям', () => {
    const { result } = renderHook(() => useSavedRoutes())
    act(() => result.current.toggleFavorite(ends(1)))

    expect(
      result.current.isFavorite({ ...ends(1), fromTitle: 'Другое', toTitle: 'Название' }),
    ).toBe(true)
  })

  it('null не считается избранным', () => {
    const { result } = renderHook(() => useSavedRoutes())
    expect(result.current.isFavorite(null)).toBe(false)
  })

  it('новое избранное встаёт первым', () => {
    const { result } = renderHook(() => useSavedRoutes())
    act(() => result.current.toggleFavorite(ends(1)))
    act(() => result.current.toggleFavorite(ends(2)))
    expect(result.current.favorites[0].fromStationId).toBe(ends(2).fromStationId)
  })

  it('список не растёт бесконечно', () => {
    const { result } = renderHook(() => useSavedRoutes())
    for (let i = 0; i < FAVORITES_LIMIT + 3; i += 1) {
      act(() => result.current.toggleFavorite(ends(i)))
    }
    expect(result.current.favorites).toHaveLength(FAVORITES_LIMIT)
  })
})

describe('недавние', () => {
  it('повтор того же маршрута поднимает его наверх, а не дублирует', () => {
    const { result } = renderHook(() => useSavedRoutes())

    act(() => result.current.rememberRecent(ends(1)))
    act(() => result.current.rememberRecent(ends(2)))
    act(() => result.current.rememberRecent(ends(1)))

    expect(result.current.recents).toHaveLength(2)
    expect(result.current.recents[0].fromStationId).toBe(ends(1).fromStationId)
  })

  it('держится лимит, вытесняются самые старые', () => {
    const { result } = renderHook(() => useSavedRoutes())
    for (let i = 0; i < RECENTS_LIMIT + 3; i += 1) {
      act(() => result.current.rememberRecent(ends(i)))
    }
    expect(result.current.recents).toHaveLength(RECENTS_LIMIT)
    expect(result.current.recents[0].fromStationId).toBe(ends(RECENTS_LIMIT + 2).fromStationId)
  })

  /**
   * lastUsedAt — это ВРЕМЯ, а не порядковый номер: после перезагрузки счётчик
   * начинался бы заново с единицы, и порядок «недавних» ломался.
   */
  it('записывается время, а не порядковый номер', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T10:00:00.000Z'))
    const { result } = renderHook(() => useSavedRoutes())

    act(() => result.current.rememberRecent(ends(1)))
    expect(result.current.recents[0].lastUsedAt).toBe(Date.parse('2026-05-05T10:00:00.000Z'))
    vi.useRealTimers()
  })

  it('очистка стирает и состояние, и хранилище', () => {
    const { result } = renderHook(() => useSavedRoutes())
    act(() => result.current.rememberRecent(ends(1)))
    act(() => result.current.clearRecents())

    expect(result.current.recents).toEqual([])
    expect(stored(RECENTS_STORAGE_KEY)).toEqual([])
  })

  it('избранное и недавние не мешают друг другу', () => {
    const { result } = renderHook(() => useSavedRoutes())
    act(() => result.current.toggleFavorite(ends(1)))
    act(() => result.current.rememberRecent(ends(2)))

    expect(result.current.favorites).toHaveLength(1)
    expect(result.current.recents).toHaveLength(1)
    act(() => result.current.clearRecents())
    expect(result.current.favorites).toHaveLength(1)
  })

  it('недоступное хранилище не мешает работать в памяти', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })
    const { result } = renderHook(() => useSavedRoutes())
    act(() => result.current.rememberRecent(ends(1)))
    expect(result.current.recents).toHaveLength(1)
  })
})
