// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FAVORITES_LIMIT,
  FAVORITES_STORAGE_KEY,
  RECENTS_LIMIT,
  RECENTS_STORAGE_KEY,
  isSavedRoute,
  persistRoutesToStorage,
  type SavedRoute,
} from './savedRoutes.ts'

const route = (over: Partial<SavedRoute> = {}): SavedRoute => ({
  fromStationId: '1/sokolniki',
  toStationId: '5/kievskaya',
  fromTitle: 'Сокольники',
  toTitle: 'Киевская',
  lastUsedAt: 1_700_000_000_000,
  ...over,
})

describe('isSavedRoute — проверка записи из localStorage', () => {
  it('пропускает корректную запись', () => {
    expect(isSavedRoute(route())).toBe(true)
  })

  /**
   * Ради этого проверка и существует. Одна битая запись внутри массива
   * (например `[null]`) роняла приложение при КАЖДОМ построении маршрута, а
   * экран ошибки localStorage сознательно не чистит — получался вечный цикл
   * падений, из которого нельзя выйти изнутри приложения.
   */
  it('отвергает null, undefined и не-объекты', () => {
    for (const bad of [null, undefined, 0, 1, '', 'route', true, []]) {
      expect(isSavedRoute(bad), JSON.stringify(bad)).toBe(false)
    }
  })

  it('отвергает запись без любого обязательного поля', () => {
    const keys: (keyof SavedRoute)[] = [
      'fromStationId',
      'toStationId',
      'fromTitle',
      'toTitle',
      'lastUsedAt',
    ]
    for (const key of keys) {
      const broken: Record<string, unknown> = { ...route() }
      delete broken[key]
      expect(isSavedRoute(broken), `без ${key}`).toBe(false)
    }
  })

  it('отвергает поля неверного типа', () => {
    expect(isSavedRoute(route({ fromStationId: 1 as unknown as string }))).toBe(false)
    expect(isSavedRoute(route({ lastUsedAt: '2024' as unknown as number }))).toBe(false)
  })

  /** NaN и Infinity — числа по typeof, но временем быть не могут. */
  it('отвергает нечисловое время', () => {
    expect(isSavedRoute(route({ lastUsedAt: Number.NaN }))).toBe(false)
    expect(isSavedRoute(route({ lastUsedAt: Number.POSITIVE_INFINITY }))).toBe(false)
  })

  it('фильтрует массив со смесью годных и битых записей', () => {
    const mixed = [route(), null, { fromStationId: '1/a' }, route({ fromTitle: 'Другая' })]
    expect(mixed.filter(isSavedRoute)).toHaveLength(2)
  })
})

describe('persistRoutesToStorage', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('записывает под указанным ключом и читается обратно', () => {
    const routes = [route(), route({ fromTitle: 'Вторая' })]
    persistRoutesToStorage(RECENTS_STORAGE_KEY, routes)

    const raw = window.localStorage.getItem(RECENTS_STORAGE_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!)).toEqual(routes)
  })

  it('избранное и недавние лежат под разными ключами', () => {
    persistRoutesToStorage(FAVORITES_STORAGE_KEY, [route()])
    persistRoutesToStorage(RECENTS_STORAGE_KEY, [])
    expect(JSON.parse(window.localStorage.getItem(FAVORITES_STORAGE_KEY)!)).toHaveLength(1)
    expect(JSON.parse(window.localStorage.getItem(RECENTS_STORAGE_KEY)!)).toHaveLength(0)
  })

  /** Приватный режим и переполненная квота не должны ронять приложение. */
  it('переполнение хранилища проглатывается молча', () => {
    const spy = vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })
    expect(() => persistRoutesToStorage(RECENTS_STORAGE_KEY, [route()])).not.toThrow()
    spy.mockRestore()
  })
})

describe('пределы списков', () => {
  it('недавних меньше, чем избранных: список подсказок должен оставаться коротким', () => {
    expect(RECENTS_LIMIT).toBeLessThan(FAVORITES_LIMIT)
    expect(RECENTS_LIMIT).toBeGreaterThan(0)
  })
})
