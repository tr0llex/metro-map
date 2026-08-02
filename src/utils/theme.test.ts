// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  THEME_PREFERENCE_LABELS,
  applyThemePreference,
  readStoredThemePreference,
  subscribeSystemTheme,
  writeThemePreference,
} from './theme.ts'

const STORAGE_KEY = 'metro-map-theme'

/** Подменяет matchMedia так, чтобы можно было и «переключить систему», и слать событие. */
function stubMatchMedia(dark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>()
  const mql = {
    matches: dark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    addListener: (fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
    removeListener: (fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    dispatch: (matches: boolean) => {
      for (const fn of listeners) fn({ matches } as MediaQueryListEvent)
    },
    listenerCount: () => listeners.size,
  }
  vi.stubGlobal('matchMedia', () => mql)
  return mql
}

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('чтение и запись выбора темы', () => {
  it('без записи в хранилище — системная', () => {
    expect(readStoredThemePreference()).toBe('system')
  })

  it('мусор в хранилище трактуется как системная, а не роняет приложение', () => {
    for (const bad of ['', 'blue', '{}', 'null']) {
      window.localStorage.setItem(STORAGE_KEY, bad)
      expect(readStoredThemePreference(), bad).toBe('system')
    }
  })

  it('светлая и тёмная переживают перезагрузку', () => {
    writeThemePreference('dark')
    expect(readStoredThemePreference()).toBe('dark')
    writeThemePreference('light')
    expect(readStoredThemePreference()).toBe('light')
  })

  /** «Системная» — это ОТСУТСТВИЕ записи, а не значение 'system' в хранилище. */
  it('выбор «как в системе» стирает запись', () => {
    writeThemePreference('dark')
    writeThemePreference('system')
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(readStoredThemePreference()).toBe('system')
  })

  it('недоступное хранилище не роняет ни чтение, ни запись', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(readStoredThemePreference()).toBe('system')
    expect(() => writeThemePreference('dark')).not.toThrow()
    get.mockRestore()
    set.mockRestore()
  })
})

describe('applyThemePreference — атрибут data-theme и цвет системной строки', () => {
  it('принудительная тема ставит data-theme', () => {
    stubMatchMedia(false)
    expect(applyThemePreference('dark')).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('«как в системе» снимает атрибут и отдаёт системную тему', () => {
    stubMatchMedia(true)
    applyThemePreference('light')
    expect(applyThemePreference('system')).toBe('dark')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('без matchMedia системная тема считается светлой', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(applyThemePreference('system')).toBe('light')
  })

  it('падение matchMedia не роняет применение темы', () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('нет поддержки')
    })
    expect(applyThemePreference('system')).toBe('light')
  })

  /**
   * В index.html два meta[theme-color] с медиазапросами, и браузер берёт
   * ПЕРВЫЙ подходящий по порядку в DOM. Управляемый meta обязан стоять в самом
   * начале <head>, иначе принудительный выбор темы не перебьёт эту пару.
   */
  it('управляемый meta[theme-color] вставляется первым в head', () => {
    stubMatchMedia(false)
    const decoy = document.createElement('meta')
    decoy.setAttribute('name', 'theme-color')
    decoy.setAttribute('content', '#ffffff')
    document.head.appendChild(decoy)

    applyThemePreference('dark')

    const managed = document.head.querySelector('meta[name="theme-color"][data-theme-managed]')
    expect(managed).toBeTruthy()
    expect(document.head.firstElementChild).toBe(managed)
  })

  it('повторное применение не плодит meta, а меняет содержимое', () => {
    stubMatchMedia(false)
    applyThemePreference('dark')
    applyThemePreference('light')
    const all = document.head.querySelectorAll('meta[name="theme-color"][data-theme-managed]')
    expect(all).toHaveLength(1)
    expect(all[0].getAttribute('content')).toBe('#f5f5f7')
  })

  it('тёмная тема ставит свой цвет строки', () => {
    stubMatchMedia(false)
    applyThemePreference('dark')
    const managed = document.head.querySelector('meta[name="theme-color"][data-theme-managed]')
    expect(managed?.getAttribute('content')).toBe('#16101c')
  })
})

describe('subscribeSystemTheme', () => {
  it('сообщает о смене системной темы', () => {
    const mql = stubMatchMedia(false)
    const seen: string[] = []
    const off = subscribeSystemTheme((t) => seen.push(t))

    mql.dispatch(true)
    mql.dispatch(false)
    expect(seen).toEqual(['dark', 'light'])

    off()
    expect(mql.listenerCount()).toBe(0)
  })

  it('отписка снимает слушателя и на старом Safari-интерфейсе', () => {
    const listeners = new Set<(e: MediaQueryListEvent) => void>()
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      // addEventListener отсутствует — остаётся только устаревший addListener.
      addListener: (fn: (e: MediaQueryListEvent) => void) => listeners.add(fn),
      removeListener: (fn: (e: MediaQueryListEvent) => void) => listeners.delete(fn),
    }))

    const off = subscribeSystemTheme(() => {})
    expect(listeners.size).toBe(1)
    off()
    expect(listeners.size).toBe(0)
  })

  it('без matchMedia подписка — безопасная пустышка', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(() => subscribeSystemTheme(() => {})()).not.toThrow()
  })
})

describe('подписи выбора темы', () => {
  it('есть человекочитаемая подпись для каждого варианта', () => {
    expect(Object.keys(THEME_PREFERENCE_LABELS).sort()).toEqual(['dark', 'light', 'system'])
    for (const label of Object.values(THEME_PREFERENCE_LABELS)) expect(label.length).toBeGreaterThan(0)
  })
})
