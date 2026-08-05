// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { usePerfInteraction } from './usePerfInteraction.ts'

/** Столько тишины после жеста, и дорогие эффекты возвращаются. */
const IDLE_MS = 180

const root = () => document.documentElement
const isMarked = () => root().classList.contains('perf-interaction')

beforeEach(() => {
  vi.useFakeTimers()
  root().classList.remove('perf-interaction')
})

afterEach(() => {
  vi.useRealTimers()
  root().classList.remove('perf-interaction')
})

const tick = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })

describe('отметка «идёт жест»', () => {
  /** По классу на <html> стили отключают дорогие эффекты на время жеста. */
  it('вешает класс на корень документа', () => {
    const { result } = renderHook(() => usePerfInteraction())
    expect(isMarked()).toBe(false)

    act(() => result.current())
    expect(isMarked()).toBe(true)
  })

  it('снимается через 180 мс тишины', () => {
    const { result } = renderHook(() => usePerfInteraction())
    act(() => result.current())

    tick(IDLE_MS - 1)
    expect(isMarked()).toBe(true)

    tick(1)
    expect(isMarked()).toBe(false)
  })

  /**
   * Жест — это поток событий: каждое движение пальца обязано отодвигать снятие,
   * иначе эффекты вернутся посреди перетаскивания шторки.
   */
  it('каждое событие жеста отодвигает снятие', () => {
    const { result } = renderHook(() => usePerfInteraction())

    act(() => result.current())
    for (let i = 0; i < 10; i += 1) {
      tick(IDLE_MS - 20)
      act(() => result.current())
      expect(isMarked()).toBe(true)
    }

    tick(IDLE_MS)
    expect(isMarked()).toBe(false)
  })

  /** Второй вызов подряд не должен добавлять класс повторно. */
  it('класс не задваивается', () => {
    const { result } = renderHook(() => usePerfInteraction())

    act(() => result.current())
    act(() => result.current())
    expect(root().className.match(/perf-interaction/g)).toHaveLength(1)
  })

  it('новый жест после затишья снова помечается', () => {
    const { result } = renderHook(() => usePerfInteraction())

    act(() => result.current())
    tick(IDLE_MS)
    expect(isMarked()).toBe(false)

    act(() => result.current())
    expect(isMarked()).toBe(true)
  })

  /** Колбэк раздаётся в обработчики карты и шторки — новая ссылка их бы пересоздала. */
  it('ссылка стабильна между рендерами', () => {
    const { result, rerender } = renderHook(() => usePerfInteraction())
    const first = result.current

    rerender()
    expect(result.current).toBe(first)
  })
})

describe('снятие хука', () => {
  /**
   * Класс живёт на <html>, а не внутри компонента: оставить его — значит
   * навсегда выключить эффекты во всём приложении.
   */
  it('убирает класс, даже если жест не закончился', () => {
    const { result, unmount } = renderHook(() => usePerfInteraction())
    act(() => result.current())
    expect(isMarked()).toBe(true)

    unmount()
    expect(isMarked()).toBe(false)
  })

  it('висящих таймеров не оставляет', () => {
    const { result, unmount } = renderHook(() => usePerfInteraction())
    act(() => result.current())

    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
