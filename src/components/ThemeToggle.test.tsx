// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ThemeToggle } from './ThemeToggle.tsx'

afterEach(cleanup)

/** Системная тема в jsdom: matchMedia там не реализован, подставляем свой. */
function mockSystemTheme(dark: boolean) {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: dark && query.includes('dark'),
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  )
}

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  mockSystemTheme(false)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const button = () => screen.getByRole('button')

describe('переключатель темы', () => {
  /**
   * Ради этого всё и переделывалось: ряд «как в системе / светлая / тёмная»
   * занимал треть верхней кромки ради настройки, к которой обращаются раз за
   * всё время.
   */
  it('это одна кнопка, а не ряд вариантов', () => {
    render(<ThemeToggle />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('варианта «как в системе» в интерфейсе нет', () => {
    render(<ThemeToggle />)
    expect(document.body.textContent).not.toContain('системе')
    expect(button().getAttribute('aria-label')).not.toContain('системе')
  })

  /** Пока кнопку не трогали, тема берётся у системы: атрибута на <html> нет. */
  it('на первом запуске тему не навязывает', () => {
    mockSystemTheme(true)
    render(<ThemeToggle />)
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('под светлой системой предлагает тёмную', () => {
    render(<ThemeToggle />)
    expect(button().dataset.themeNext).toBe('dark')
    expect(button().getAttribute('aria-label')).toBe('Включить тёмную тему')
  })

  it('под тёмной системой предлагает светлую', () => {
    mockSystemTheme(true)
    render(<ThemeToggle />)
    expect(button().dataset.themeNext).toBe('light')
    expect(button().getAttribute('aria-label')).toBe('Включить светлую тему')
  })

  it('нажатие фиксирует явную тему на <html> и в хранилище', () => {
    render(<ThemeToggle />)
    fireEvent.click(button())

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(window.localStorage.getItem('metro-map-theme')).toBe('dark')
  })

  /** После нажатия кнопка обязана предлагать обратный переход, а не тот же. */
  it('второе нажатие возвращает светлую', () => {
    render(<ThemeToggle />)
    fireEvent.click(button())
    expect(button().dataset.themeNext).toBe('light')

    fireEvent.click(button())
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(button().dataset.themeNext).toBe('dark')
  })

  it('сохранённая тема поднимается при следующем запуске', () => {
    window.localStorage.setItem('metro-map-theme', 'dark')
    render(<ThemeToggle />)

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(button().dataset.themeNext).toBe('light')
  })
})
