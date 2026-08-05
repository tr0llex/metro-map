// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useShareRoute } from './useShareRoute.ts'

const SHARE_HINT_DURATION_MS = 2400

const titles = new Map([
  ['1/arbatskaya', 'Арбатская'],
  ['5/kitay-gorod', 'Китай-город'],
])

const params = {
  fromStationId: '1/arbatskaya',
  toStationId: '5/kitay-gorod',
  stationTitleById: titles,
}

const clipboard = { writeText: vi.fn() }

beforeEach(() => {
  clipboard.writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
  Reflect.deleteProperty(navigator, 'share')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'share')
})

const stubShare = (impl: (data: ShareData) => Promise<void>) => {
  const share = vi.fn(impl)
  Object.defineProperty(navigator, 'share', { configurable: true, value: share })
  return share
}

describe('системный шит', () => {
  /** На телефоне это единственный привычный способ поделиться. */
  it('пробуется первым и с человекочитаемым заголовком', async () => {
    const share = stubShare(() => Promise.resolve())
    const { result } = renderHook(() => useShareRoute(params))

    await act(() => result.current.shareRoute())

    expect(share).toHaveBeenCalledTimes(1)
    const data = share.mock.calls[0][0]
    expect(data.title).toBe('Метро: Арбатская → Китай-город')
    expect(data.url).toContain('from=1%2Farbatskaya')
    expect(data.url).toContain('to=5%2Fkitay-gorod')
    expect(clipboard.writeText).not.toHaveBeenCalled()
  })

  /** Успешный шит уже всё сказал — подсказка была бы вторым сообщением об одном. */
  it('после успеха подсказку не показывает', async () => {
    stubShare(() => Promise.resolve())
    const { result } = renderHook(() => useShareRoute(params))

    await act(() => result.current.shareRoute())
    expect(result.current.shareHint).toBeNull()
  })

  /** Закрыть шит — осознанное решение пользователя, а не сбой. */
  it('отмену пользователем молча принимает', async () => {
    stubShare(() => Promise.reject(new DOMException('отменено', 'AbortError')))
    const { result } = renderHook(() => useShareRoute(params))

    await act(() => result.current.shareRoute())

    expect(clipboard.writeText).not.toHaveBeenCalled()
    expect(result.current.shareHint).toBeNull()
  })

  /** Шит упал по-настоящему — человек всё равно должен получить ссылку. */
  it('настоящую ошибку доигрывает копированием', async () => {
    stubShare(() => Promise.reject(new Error('NotAllowedError')))
    const { result } = renderHook(() => useShareRoute(params))

    await act(() => result.current.shareRoute())

    expect(clipboard.writeText).toHaveBeenCalledTimes(1)
    expect(result.current.shareHint).toBe('Ссылка на маршрут скопирована')
  })

  /** Названия станций могли не найтись — заголовок обязан остаться осмысленным. */
  it('без названий станций берёт общий заголовок', async () => {
    const share = stubShare(() => Promise.resolve())
    const { result } = renderHook(() =>
      useShareRoute({ ...params, stationTitleById: new Map() }),
    )

    await act(() => result.current.shareRoute())
    expect(share.mock.calls[0][0].title).toBe('Маршрут в метро Москвы')
  })
})

describe('копирование в буфер', () => {
  it('без системного шита копирует ссылку и говорит об этом', async () => {
    const { result } = renderHook(() => useShareRoute(params))

    await act(() => result.current.shareRoute())

    expect(clipboard.writeText).toHaveBeenCalledTimes(1)
    expect(clipboard.writeText.mock.calls[0][0]).toContain('from=1%2Farbatskaya')
    expect(result.current.shareHint).toBe('Ссылка на маршрут скопирована')
  })

  /** Молчаливый отказ — худший исход: человек уверен, что ссылка у него. */
  it('о неудаче говорит прямо', async () => {
    clipboard.writeText.mockRejectedValue(new Error('нет доступа'))
    const { result } = renderHook(() => useShareRoute(params))

    await act(() => result.current.shareRoute())
    expect(result.current.shareHint).toBe('Не удалось скопировать ссылку')
  })

  it('подсказка гаснет сама', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { result } = renderHook(() => useShareRoute(params))

    await act(() => result.current.shareRoute())
    await waitFor(() => expect(result.current.shareHint).not.toBeNull())

    act(() => {
      vi.advanceTimersByTime(SHARE_HINT_DURATION_MS)
    })
    expect(result.current.shareHint).toBeNull()
  })

  /** Второе нажатие обязано продлить подсказку, а не погасить её по старому таймеру. */
  it('повторное нажатие перезапускает отсчёт', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { result } = renderHook(() => useShareRoute(params))

    await act(() => result.current.shareRoute())
    act(() => {
      vi.advanceTimersByTime(SHARE_HINT_DURATION_MS - 200)
    })
    await act(() => result.current.shareRoute())

    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(result.current.shareHint).not.toBeNull()

    act(() => {
      vi.advanceTimersByTime(SHARE_HINT_DURATION_MS)
    })
    expect(result.current.shareHint).toBeNull()
  })
})

describe('неполный маршрут', () => {
  it.each([
    ['без начала', { fromStationId: null }],
    ['без конца', { toStationId: null }],
    ['пустой', { fromStationId: null, toStationId: null }],
  ])('%s делиться нечем', async (_name, over) => {
    const share = stubShare(() => Promise.resolve())
    const { result } = renderHook(() => useShareRoute({ ...params, ...over }))

    await act(() => result.current.shareRoute())

    expect(share).not.toHaveBeenCalled()
    expect(clipboard.writeText).not.toHaveBeenCalled()
    expect(result.current.shareHint).toBeNull()
  })
})

describe('снятие хука', () => {
  /** Таймер подсказки переживал бы размонтирование и звал setState у мертвеца. */
  it('гасит незавершённый отсчёт подсказки', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const clearTimeout = vi.spyOn(window, 'clearTimeout')

    const { result, unmount } = renderHook(() => useShareRoute(params))
    await act(() => result.current.shareRoute())
    clearTimeout.mockClear()

    unmount()
    expect(clearTimeout).toHaveBeenCalled()
  })
})
