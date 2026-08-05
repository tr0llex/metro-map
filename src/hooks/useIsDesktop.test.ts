// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useIsDesktop } from './useIsDesktop.ts'

/**
 * Условие обязано совпадать с медиазапросами в App.css, theme.css и
 * ThemeToggle.css: CSS рисует панель, а флаг управляет её поведением.
 * Разъедутся — панель будет нарисована сбоку, но продолжит ездить от свайпов.
 */
const SIDE_PANEL_QUERY = '(min-width: 1024px), (max-height: 500px)'

type Listener = () => void

/** Управляемый matchMedia: в jsdom его нет вовсе. */
function stubMatchMedia(initial: boolean) {
  const listeners = new Set<Listener>()
  const media = {
    matches: initial,
    media: SIDE_PANEL_QUERY,
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
  }
  const matchMedia = vi.fn(() => media as unknown as MediaQueryList)
  vi.stubGlobal('matchMedia', matchMedia)

  return {
    matchMedia,
    listeners,
    set(matches: boolean) {
      media.matches = matches
      act(() => {
        for (const fn of listeners) fn()
      })
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('раскладка «боковая панель»', () => {
  /**
   * Начальное значение всегда false и уточняется в эффекте: всё, что зависит
   * от флага, обязано переживать переключение сразу после монтирования.
   */
  it('на широком экране включается после монтирования', () => {
    stubMatchMedia(true)
    const { result } = renderHook(() => useIsDesktop())
    expect(result.current).toBe(true)
  })

  it('на телефоне в портрете остаётся выключенной', () => {
    stubMatchMedia(false)
    const { result } = renderHook(() => useIsDesktop())
    expect(result.current).toBe(false)
  })

  /**
   * Порог по высоте равноправен с шириной. Телефон в альбомной ориентации —
   * 812x375: нижняя шторка занимала 169% высоты экрана, и карте оставалась
   * полоса в 144px, тогда как слева простаивали 812px ширины.
   */
  it('спрашивает ровно тот запрос, что и стили — и по ширине, и по высоте', () => {
    const media = stubMatchMedia(false)
    renderHook(() => useIsDesktop())
    expect(media.matchMedia).toHaveBeenCalledWith(SIDE_PANEL_QUERY)
  })

  it('поворот экрана переключает раскладку на лету', () => {
    const media = stubMatchMedia(false)
    const { result } = renderHook(() => useIsDesktop())

    media.set(true)
    expect(result.current).toBe(true)

    media.set(false)
    expect(result.current).toBe(false)
  })

  it('подписка снимается вместе с хуком', () => {
    const media = stubMatchMedia(true)
    const { unmount } = renderHook(() => useIsDesktop())
    expect(media.listeners.size).toBe(1)

    unmount()
    expect(media.listeners.size).toBe(0)
  })

  /** Старый WebView без matchMedia не должен ронять приложение. */
  it('без matchMedia остаётся выключенной', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { result } = renderHook(() => useIsDesktop())
    expect(result.current).toBe(false)
  })
})
