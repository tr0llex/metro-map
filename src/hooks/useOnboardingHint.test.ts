// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useOnboardingHint } from './useOnboardingHint.ts'

const KEY = 'metro-map-onboarding-hint-seen'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('подсказка первого запуска', () => {
  it('на чистой установке показывается', () => {
    const { result } = renderHook(() => useOnboardingHint())
    expect(result.current.isVisible).toBe(true)
  })

  it('закрывается насовсем', () => {
    const { result } = renderHook(() => useOnboardingHint())

    act(() => result.current.dismiss())

    expect(result.current.isVisible).toBe(false)
    expect(window.localStorage.getItem(KEY)).toBe('1')
  })

  /** Ради этого отметка и уезжает в хранилище: подсказка первого запуска — один раз. */
  it('на следующем запуске не возвращается', () => {
    window.localStorage.setItem(KEY, '1')
    const { result } = renderHook(() => useOnboardingHint())
    expect(result.current.isVisible).toBe(false)
  })

  it('повторное закрытие ничего не ломает', () => {
    const { result } = renderHook(() => useOnboardingHint())

    act(() => result.current.dismiss())
    act(() => result.current.dismiss())
    expect(result.current.isVisible).toBe(false)
  })

  /** Ссылка стабильна: подсказка уходит в пропсы, и новый колбэк ронял бы мемоизацию. */
  it('колбэк закрытия не меняется между рендерами', () => {
    const { result, rerender } = renderHook(() => useOnboardingHint())
    const first = result.current.dismiss

    rerender()
    expect(result.current.dismiss).toBe(first)
  })
})

describe('недоступное хранилище', () => {
  /**
   * Приватный режим: чтение бросает. Показывать подсказку вечно на каждом
   * запуске хуже, чем не показать ни разу, — поэтому здесь она молчит.
   */
  it('при отказе на чтении подсказку не показывает', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })

    const { result } = renderHook(() => useOnboardingHint())
    expect(result.current.isVisible).toBe(false)
  })

  /** Отметку записать не вышло, но в этой сессии подсказка обязана исчезнуть. */
  it('при отказе на записи всё равно закрывается', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    const { result } = renderHook(() => useOnboardingHint())
    act(() => result.current.dismiss())
    expect(result.current.isVisible).toBe(false)
  })
})
