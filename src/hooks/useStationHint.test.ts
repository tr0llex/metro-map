// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useStationHint } from './useStationHint.ts'

const STATION_HINT_DURATION_MS = 2200

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

const tick = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })

describe('подтверждение выбора станции', () => {
  it('до тапа подсказки нет', () => {
    const { result } = renderHook(() => useStationHint())
    expect(result.current.hint).toBeNull()
  })

  it('показывает вид и текст', () => {
    const { result } = renderHook(() => useStationHint())

    act(() => result.current.show('from', 'Откуда: Арбатская'))

    expect(result.current.hint?.kind).toBe('from')
    expect(result.current.hint?.text).toBe('Откуда: Арбатская')
  })

  /** Точка тапа нужна, чтобы подсказка встала над станцией, а не под шапкой. */
  it('запоминает точку тапа и цвет линии', () => {
    const { result } = renderHook(() => useStationHint())

    act(() =>
      result.current.show('to', 'Куда: Китай-город', {
        point: { x: 120, y: 340 },
        lineColor: '#d9232e',
      }),
    )

    expect(result.current.hint?.point).toEqual({ x: 120, y: 340 })
    expect(result.current.hint?.lineColor).toBe('#d9232e')
  })

  /** Оба поля необязательны: подсказку зовут и из формы, где точки тапа нет. */
  it('без места и цвета подставляет пустые значения, а не undefined', () => {
    const { result } = renderHook(() => useStationHint())

    act(() => result.current.show('from', 'Откуда: Арбатская'))

    expect(result.current.hint?.point).toBeNull()
    expect(result.current.hint?.lineColor).toBeNull()
  })

  it('гаснет сама через 2200 мс', () => {
    const { result } = renderHook(() => useStationHint())
    act(() => result.current.show('from', 'Откуда: Арбатская'))

    tick(STATION_HINT_DURATION_MS - 1)
    expect(result.current.hint).not.toBeNull()

    tick(1)
    expect(result.current.hint).toBeNull()
  })
})

describe('быстрые повторные тапы', () => {
  /**
   * Ради этого у подсказки и есть id: два тапа подряд дают один и тот же текст
   * («Куда: …»), и без нового id анимация появления не перезапустилась бы.
   */
  it('каждый показ получает новый id', () => {
    const { result } = renderHook(() => useStationHint())

    act(() => result.current.show('from', 'Откуда: Арбатская'))
    const first = result.current.hint!.id

    act(() => result.current.show('to', 'Куда: Арбатская'))
    expect(result.current.hint!.id).toBeGreaterThan(first)
  })

  /** Иначе вторая подсказка гасла бы по таймеру первой — раньше срока. */
  it('второй тап продлевает показ, а не наследует чужой отсчёт', () => {
    const { result } = renderHook(() => useStationHint())

    act(() => result.current.show('from', 'Откуда: Арбатская'))
    tick(STATION_HINT_DURATION_MS - 200)
    act(() => result.current.show('to', 'Куда: Китай-город'))

    tick(300)
    expect(result.current.hint?.text).toBe('Куда: Китай-город')

    tick(STATION_HINT_DURATION_MS)
    expect(result.current.hint).toBeNull()
  })

  /** Колбэк уходит в пропсы карты — новая ссылка сбросила бы её мемоизацию. */
  it('ссылка на show стабильна', () => {
    const { result, rerender } = renderHook(() => useStationHint())
    const first = result.current.show

    rerender()
    expect(result.current.show).toBe(first)
  })
})

describe('снятие хука', () => {
  it('гасит незавершённый отсчёт', () => {
    const clearTimeout = vi.spyOn(window, 'clearTimeout')
    const { result, unmount } = renderHook(() => useStationHint())

    act(() => result.current.show('from', 'Откуда: Арбатская'))
    clearTimeout.mockClear()

    unmount()
    expect(clearTimeout).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
