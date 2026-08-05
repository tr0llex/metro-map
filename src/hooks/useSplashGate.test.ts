// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSplashGate } from './useSplashGate.ts'

const MAP_READY_FALLBACK_MS = 3500
const SPLASH_MIN_DURATION_MS = 1200

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

describe('на старте', () => {
  it('заставка показана, карта не готова, основной UI ждёт', () => {
    const { result } = renderHook(() => useSplashGate())

    expect(result.current.isSplashMounted).toBe(true)
    expect(result.current.isSplashDone).toBe(false)
    expect(result.current.isMapReady).toBe(false)
    expect(result.current.isPrimaryUiReady).toBe(false)
  })
})

describe('минимальная длительность заставки', () => {
  /** Заставка — это «привет», а не загрузочный экран: держим её короткой. */
  it('отрабатывает сама через 1200 мс', () => {
    const { result } = renderHook(() => useSplashGate())

    tick(SPLASH_MIN_DURATION_MS - 1)
    expect(result.current.isSplashDone).toBe(false)

    tick(1)
    expect(result.current.isSplashDone).toBe(true)
  })

  it('пропуск по нажатию засчитывается сразу', () => {
    const { result } = renderHook(() => useSplashGate())

    act(() => result.current.markSplashDone())
    expect(result.current.isSplashDone).toBe(true)
  })

  /** Из DOM заставка уходит только после анимации исчезновения. */
  it('снимается с монтирования отдельным сигналом', () => {
    const { result } = renderHook(() => useSplashGate())

    act(() => result.current.markSplashDone())
    expect(result.current.isSplashMounted).toBe(true)

    act(() => result.current.markSplashHidden())
    expect(result.current.isSplashMounted).toBe(false)
  })
})

describe('готовность карты', () => {
  it('карта отчитывается сама', () => {
    const { result } = renderHook(() => useSplashGate())

    act(() => result.current.markMapReady())
    expect(result.current.isMapReady).toBe(true)
  })

  /**
   * Страховка обязательна: пользователь никогда не должен застрять на заставке
   * навсегда, даже если карта не отчиталась о готовности viewport.
   */
  it('без отчёта готовность выставляется принудительно через 3500 мс', () => {
    const { result } = renderHook(() => useSplashGate())

    tick(MAP_READY_FALLBACK_MS - 1)
    expect(result.current.isMapReady).toBe(false)

    tick(1)
    expect(result.current.isMapReady).toBe(true)
  })

  /** Отчитавшаяся карта не должна оставлять висящий таймер страховки. */
  it('после отчёта страховка снимается', () => {
    const clearTimeout = vi.spyOn(window, 'clearTimeout')
    const { result } = renderHook(() => useSplashGate())

    act(() => result.current.markMapReady())
    expect(clearTimeout).toHaveBeenCalled()

    tick(MAP_READY_FALLBACK_MS * 2)
    expect(result.current.isMapReady).toBe(true)
    clearTimeout.mockRestore()
  })
})

describe('показ основного UI', () => {
  /** Оба условия обязательны: карта под заставкой ещё не нарисована. */
  it('одной отработавшей заставки мало', () => {
    const { result } = renderHook(() => useSplashGate())

    tick(SPLASH_MIN_DURATION_MS)
    expect(result.current.isSplashDone).toBe(true)
    expect(result.current.isPrimaryUiReady).toBe(false)
  })

  it('одной готовой карты мало', () => {
    const { result } = renderHook(() => useSplashGate())

    act(() => result.current.markMapReady())
    expect(result.current.isPrimaryUiReady).toBe(false)
  })

  it('вместе — можно показывать', () => {
    const { result } = renderHook(() => useSplashGate())

    act(() => result.current.markMapReady())
    tick(SPLASH_MIN_DURATION_MS)
    expect(result.current.isPrimaryUiReady).toBe(true)
  })

  /** Худший случай: карта молчит, заставку не трогали — UI всё равно появится. */
  it('сам по себе появляется не позже 3500 мс', () => {
    const { result } = renderHook(() => useSplashGate())

    tick(MAP_READY_FALLBACK_MS)
    expect(result.current.isPrimaryUiReady).toBe(true)
  })
})

describe('снятие хука', () => {
  it('висящих таймеров не оставляет', () => {
    const { unmount } = renderHook(() => useSplashGate())
    unmount()

    expect(() => vi.advanceTimersByTime(MAP_READY_FALLBACK_MS * 2)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})
