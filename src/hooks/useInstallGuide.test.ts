// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { markInstallGuideEarned, useInstallGuide } from './useInstallGuide.ts'

const EARNED_KEY = 'metro-map-install-guide-earned'
const SEEN_KEY = 'metro-map-install-guide-seen'
const DELAY_MS = 900

const ready = { isPrimaryUiReady: true, isOnboardingHintVisible: false }

/** По умолчанию: обычная вкладка браузера, не установленное приложение. */
function stubEnvironment({
  ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  standalone = false,
  innerWidth = 1280,
}: { ua?: string; standalone?: boolean; innerWidth?: number } = {}) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: standalone && query.includes('standalone'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  Object.defineProperty(window.navigator, 'userAgent', { configurable: true, value: ua })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth })
}

/** Карточка «зарабатывается»: человек уже строил маршрут в прошлый запуск. */
const earn = () => window.localStorage.setItem(EARNED_KEY, '1')

beforeEach(() => {
  window.localStorage.clear()
  vi.useFakeTimers()
  stubEnvironment()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const waitDelay = () =>
  act(() => {
    vi.advanceTimersByTime(DELAY_MS)
  })

describe('право карточки на показ', () => {
  /**
   * UX-9. Раньше карточка выезжала через ~1,8 с после запуска и приходила до
   * того, как человек понял, что это за приложение. Теперь она появляется
   * только тому, кто уже застал пользу и пришёл снова.
   */
  it('до первого построенного маршрута не показывается никогда', () => {
    const { result } = renderHook(() => useInstallGuide(ready))
    waitDelay()
    expect(result.current.shouldShow).toBe(false)
  })

  it('заработавшему показывается', () => {
    earn()
    const { result } = renderHook(() => useInstallGuide(ready))
    waitDelay()
    expect(result.current.shouldShow).toBe(true)
  })

  /**
   * Флаг ставится по факту построенного маршрута, но карточка появится только
   * на следующем запуске: иначе она накрывает свежий результат ровно в тот
   * момент, ради которого человек всё и делал.
   */
  it('отметка посреди сессии карточку не выпускает', () => {
    const { result } = renderHook(() => useInstallGuide(ready))
    act(() => markInstallGuideEarned())
    waitDelay()

    expect(window.localStorage.getItem(EARNED_KEY)).toBe('1')
    expect(result.current.shouldShow).toBe(false)
  })

  /** Карточка не должна выпрыгивать вместе с картой. */
  it('выдерживает паузу после появления основного UI', () => {
    earn()
    const { result } = renderHook(() => useInstallGuide(ready))

    expect(result.current.shouldShow).toBe(false)
    act(() => {
      vi.advanceTimersByTime(DELAY_MS - 1)
    })
    expect(result.current.shouldShow).toBe(false)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.shouldShow).toBe(true)
  })

  it('под заставкой отсчёт не идёт', () => {
    earn()
    const { result, rerender } = renderHook((props: typeof ready) => useInstallGuide(props), {
      initialProps: { ...ready, isPrimaryUiReady: false },
    })

    waitDelay()
    expect(result.current.shouldShow).toBe(false)

    rerender(ready)
    waitDelay()
    expect(result.current.shouldShow).toBe(true)
  })

  /** Карточка накрывала подсказку онбординга, которую человек начал читать. */
  it('онбординг не перебивает', () => {
    earn()
    const { result, rerender } = renderHook((props: typeof ready) => useInstallGuide(props), {
      initialProps: { ...ready, isOnboardingHintVisible: true },
    })
    waitDelay()
    expect(result.current.shouldShow).toBe(false)

    rerender(ready)
    expect(result.current.shouldShow).toBe(true)
  })

  /** Приложение уже установлено — предлагать установку абсурдно. */
  it('в установленном приложении молчит', () => {
    earn()
    stubEnvironment({ standalone: true })
    const { result } = renderHook(() => useInstallGuide(ready))
    waitDelay()
    expect(result.current.shouldShow).toBe(false)
  })

  /** Safari на iOS сообщает о standalone своим полем, а не медиазапросом. */
  it('в установленном приложении на iOS молчит', () => {
    earn()
    stubEnvironment({ ua: 'iPhone' })
    Object.defineProperty(window.navigator, 'standalone', { configurable: true, value: true })

    const { result } = renderHook(() => useInstallGuide(ready))
    waitDelay()
    expect(result.current.shouldShow).toBe(false)

    Reflect.deleteProperty(window.navigator, 'standalone')
  })

  it('увиденную однажды карточку больше не показывает', () => {
    earn()
    window.localStorage.setItem(SEEN_KEY, '1')
    const { result } = renderHook(() => useInstallGuide(ready))
    waitDelay()
    expect(result.current.shouldShow).toBe(false)
  })

  /** Приватный режим: без хранилища «уже видел» не проверить — молчим. */
  it('без доступа к хранилищу молчит', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const { result } = renderHook(() => useInstallGuide(ready))
    waitDelay()
    expect(result.current.shouldShow).toBe(false)
  })
})

describe('платформа для текста инструкции', () => {
  it.each([
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'ios'],
    ['iPad', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'ios'],
    ['Android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8)', 'android'],
  ] as const)('%s → %s', (_name, ua, expected) => {
    earn()
    stubEnvironment({ ua })
    const { result } = renderHook(() => useInstallGuide(ready))
    waitDelay()
    expect(result.current.platform).toBe(expected)
  })

  /** Без узнаваемого UA решает ширина: узкое окно — точно не десктоп. */
  it('широкое окно — настольный браузер', () => {
    earn()
    stubEnvironment({ innerWidth: 1024 })
    const { result } = renderHook(() => useInstallGuide(ready))
    waitDelay()
    expect(result.current.platform).toBe('desktop')
  })

  it('узкое окно без узнаваемого UA — общая инструкция', () => {
    earn()
    stubEnvironment({ innerWidth: 500 })
    const { result } = renderHook(() => useInstallGuide(ready))
    waitDelay()
    expect(result.current.platform).toBe('unknown')
  })

  /** Скрытая карточка платформы не имеет — но и врать про неё незачем. */
  it('у скрытой карточки платформа нейтральная', () => {
    window.localStorage.setItem(SEEN_KEY, '1')
    const { result } = renderHook(() => useInstallGuide(ready))
    expect(result.current.platform).toBe('unknown')
  })
})

describe('закрытие', () => {
  it('прячет карточку и запоминает это навсегда', () => {
    earn()
    const { result } = renderHook(() => useInstallGuide(ready))
    waitDelay()
    expect(result.current.shouldShow).toBe(true)

    act(() => result.current.close())

    expect(result.current.shouldShow).toBe(false)
    expect(window.localStorage.getItem(SEEN_KEY)).toBe('1')
  })

  /** Запись не прошла — но в этой сессии карточка обязана исчезнуть. */
  it('при отказе хранилища всё равно прячет', () => {
    earn()
    const { result } = renderHook(() => useInstallGuide(ready))
    waitDelay()

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    act(() => result.current.close())
    expect(result.current.shouldShow).toBe(false)
  })
})

describe('отметка о полученной пользе', () => {
  it('ставится в хранилище', () => {
    markInstallGuideEarned()
    expect(window.localStorage.getItem(EARNED_KEY)).toBe('1')
  })

  /** Она вызывается на успешном маршруте — упасть там она права не имеет. */
  it('переживает отказ хранилища', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => markInstallGuideEarned()).not.toThrow()
  })
})
