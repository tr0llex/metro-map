// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { FullGraphStation } from '../metro/types.ts'
import { useNearbyStations } from './useNearbyStations.ts'

const NEARBY_ALLOWED_KEY = 'metro-map-nearby-allowed'
const NEARBY_LIMIT = 6

/** Центр Москвы: от него и считаем «рядом». */
const HERE = { latitude: 55.7558, longitude: 37.6173 }

const station = (id: string, lat: number, lon: number): FullGraphStation =>
  ({ id, title: id, lat, lon }) as FullGraphStation

/**
 * Восемь станций, разнесённых по долготе: чем больше номер, тем дальше.
 * Порядок в массиве обратный ожидаемому — сортировка обязана его исправить.
 */
const stations = Array.from({ length: 8 }, (_, i) =>
  station(`s${8 - i}`, HERE.latitude, HERE.longitude + (8 - i) * 0.01),
)

const getCurrentPosition = vi.fn()

function stubGeolocation(secure = true) {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: secure })
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition },
  })
}

/** Успешный ответ браузера о местоположении. */
const grant = (coords = HERE) =>
  getCurrentPosition.mockImplementation((onOk: PositionCallback) =>
    onOk({ coords } as GeolocationPosition),
  )

/** Отказ с кодом из спецификации GeolocationPositionError. */
const deny = (code: number) =>
  getCurrentPosition.mockImplementation((_ok: PositionCallback, onErr: PositionErrorCallback) =>
    onErr({ code } as GeolocationPositionError),
  )

const setup = (over: Partial<Parameters<typeof useNearbyStations>[0]> = {}) =>
  renderHook(() => useNearbyStations({ allStations: stations, stationOverrides: {}, ...over }))

beforeEach(() => {
  window.localStorage.clear()
  getCurrentPosition.mockReset()
  Reflect.deleteProperty(navigator, 'permissions')
  stubGeolocation()
})

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'permissions')
})

describe('до запроса', () => {
  it('список пуст, ошибок нет', () => {
    const { result } = setup()

    expect(result.current.stations).toEqual([])
    expect(result.current.status).toBe('idle')
    expect(result.current.error).toBeNull()
    expect(getCurrentPosition).not.toHaveBeenCalled()
  })
})

describe('ближайшие станции', () => {
  it('отсортированы по расстоянию и обрезаны до шести', () => {
    grant()
    const { result } = setup()
    act(() => result.current.request())

    expect(result.current.stations.map((s) => s.id)).toEqual([
      's1',
      's2',
      's3',
      's4',
      's5',
      's6',
    ])
    expect(result.current.stations).toHaveLength(NEARBY_LIMIT)
    expect(result.current.status).toBe('idle')
  })

  /** Правки редактора — это и есть настоящие координаты станции. */
  it('координаты из оверрайдов важнее графа', () => {
    grant()
    const { result } = setup({
      stationOverrides: { s8: { lat: HERE.latitude, lon: HERE.longitude } },
    })
    act(() => result.current.request())

    expect(result.current.stations[0].id).toBe('s8')
  })

  it('оверрайд одной координаты не теряет вторую', () => {
    grant()
    const { result } = setup({ stationOverrides: { s8: { lat: HERE.latitude } } })
    act(() => result.current.request())

    // lon остался прежним (самая дальняя станция), поэтому s8 первой не стала.
    expect(result.current.stations[0].id).toBe('s1')
  })

  it('станции без координат в расчёт не идут', () => {
    grant()
    const { result } = setup({
      allStations: [station('нет-координат', NaN as number, NaN as number), ...stations].map(
        (s, i) => (i === 0 ? ({ id: 'нет-координат', title: '' } as FullGraphStation) : s),
      ),
    })
    act(() => result.current.request())

    expect(result.current.stations.map((s) => s.id)).not.toContain('нет-координат')
  })

  it('на время запроса показывает загрузку', () => {
    getCurrentPosition.mockImplementation(() => {})
    const { result } = setup()
    act(() => result.current.request())

    expect(result.current.status).toBe('loading')
  })

  /** По этому флагу на следующем запуске станции определяются без нажатия. */
  it('успех запоминает выданное разрешение', () => {
    grant()
    const { result } = setup()
    act(() => result.current.request())

    expect(window.localStorage.getItem(NEARBY_ALLOWED_KEY)).toBe('1')
  })

  it('недоступное хранилище результат не отменяет', () => {
    grant()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    const { result } = setup()
    act(() => result.current.request())
    expect(result.current.stations).toHaveLength(NEARBY_LIMIT)
  })

  /** Повторный запрос обязан стирать прошлую ошибку, а не показывать её поверх. */
  it('повтор после ошибки её снимает', () => {
    deny(1)
    const { result } = setup()
    act(() => result.current.request())
    expect(result.current.error).not.toBeNull()

    grant()
    act(() => result.current.request())
    expect(result.current.error).toBeNull()
    expect(result.current.status).toBe('idle')
  })
})

describe('отказы', () => {
  /** Каждая причина требует своего совета: «разреши в настройках» ≠ «нет сигнала». */
  it.each([
    [1, 'Нет разрешения на местоположение. Разреши доступ в настройках браузера.'],
    [2, 'Не удалось определить местоположение (нет сигнала).'],
    [3, 'Истекло время ожидания геолокации.'],
    [99, 'Не удалось получить местоположение.'],
  ])('код %i объясняется своими словами', (code, message) => {
    deny(code)
    const { result } = setup()
    act(() => result.current.request())

    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe(message)
  })

  /**
   * Геолокация — powerful feature: по HTTP браузер её не даёт вовсе, и человеку
   * надо сказать почему, а не показывать «не удалось».
   */
  it('по HTTP объясняет, что нужен HTTPS', () => {
    stubGeolocation(false)
    const { result } = setup()
    act(() => result.current.request())

    expect(result.current.error).toBe('Геолокация доступна только по HTTPS (или на localhost).')
    expect(getCurrentPosition).not.toHaveBeenCalled()
  })

  it('без geolocation в браузере говорит об этом', () => {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined })
    const { result } = setup()
    act(() => result.current.request())

    expect(result.current.error).toBe('Геолокация недоступна.')
  })

  it('граф без координат — не молчаливый пустой список', () => {
    grant()
    const { result } = setup({ allStations: [{ id: 'x', title: 'x' } as FullGraphStation] })
    act(() => result.current.request())

    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe('Нет станций с координатами.')
  })
})

describe('повторный визит', () => {
  const stubPermissions = (state: PermissionState | Error) =>
    Object.defineProperty(navigator, 'permissions', {
      configurable: true,
      value: {
        query: vi.fn(() =>
          state instanceof Error
            ? Promise.reject(state)
            : Promise.resolve({ state } as PermissionStatus),
        ),
      },
    })

  /** Без лишнего нажатия — но и без браузерного диалога: сначала Permissions API. */
  it('с действующим разрешением определяет станции сам', async () => {
    window.localStorage.setItem(NEARBY_ALLOWED_KEY, '1')
    stubPermissions('granted')
    grant()

    const { result } = setup()
    await waitFor(() => expect(result.current.stations).toHaveLength(NEARBY_LIMIT))
  })

  /** Разрешение отозвали в настройках — диалог сам собой всплывать не должен. */
  it('с отозванным разрешением молчит', async () => {
    window.localStorage.setItem(NEARBY_ALLOWED_KEY, '1')
    stubPermissions('prompt')
    grant()

    setup()
    await Promise.resolve()
    expect(getCurrentPosition).not.toHaveBeenCalled()
  })

  it('без прошлого разрешения ничего не спрашивает', async () => {
    stubPermissions('granted')
    grant()

    setup()
    await Promise.resolve()
    expect(getCurrentPosition).not.toHaveBeenCalled()
  })

  /** Safari долго не умел Permissions API — там просто ждём нажатия. */
  it('без Permissions API сам не запрашивает', async () => {
    window.localStorage.setItem(NEARBY_ALLOWED_KEY, '1')
    grant()

    setup()
    await Promise.resolve()
    expect(getCurrentPosition).not.toHaveBeenCalled()
  })

  it('упавший Permissions API не роняет хук', async () => {
    window.localStorage.setItem(NEARBY_ALLOWED_KEY, '1')
    stubPermissions(new Error('TypeError: geolocation не поддерживается'))
    grant()

    const { result } = setup()
    await Promise.resolve()
    expect(result.current.status).toBe('idle')
  })

  it('недоступное хранилище считает разрешения не выданным', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    stubPermissions('granted')
    grant()

    setup()
    await Promise.resolve()
    expect(getCurrentPosition).not.toHaveBeenCalled()
  })
})
