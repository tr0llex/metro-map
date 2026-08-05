// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ErrorBoundary } from './ErrorBoundary.tsx'

afterEach(cleanup)

function Boom({ message = 'схема не отрисовалась' }: { message?: string }): never {
  throw new Error(message)
}

/**
 * React печатает пойманную ошибку сам, и сам компонент делает то же в
 * componentDidCatch. В логе теста это шум от ожидаемого падения.
 */
let consoleError: ReturnType<typeof vi.spyOn>

const reload = vi.fn()

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  reload.mockClear()
  window.localStorage.clear()

  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload },
  })
})

afterEach(() => {
  consoleError.mockRestore()
  vi.unstubAllGlobals()
})

/** Ждём микрозадачи: сброс кэша и SW асинхронный, reload — в самом конце. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('пока всё хорошо', () => {
  it('показывает приложение и ничем себя не выдаёт', () => {
    render(
      <ErrorBoundary>
        <div>схема метро</div>
      </ErrorBoundary>,
    )

    expect(screen.getByText('схема метро')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('после падения рендера', () => {
  it('вместо белого экрана показывает объяснение и выход', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )

    expect(screen.getByRole('alert')).toBeTruthy()
    expect(screen.getByText('Что-то пошло не так')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Очистить кэш и перезагрузить' })).toBeTruthy()
  })

  /** Текст ошибки нужен для отчёта, но не должен встречать пользователя. */
  it('прячет текст ошибки в раскрывающийся блок', () => {
    render(
      <ErrorBoundary>
        <Boom message="fullGraph is not defined" />
      </ErrorBoundary>,
    )

    const details = document.querySelector('details')
    expect(details).toBeTruthy()
    expect(details?.textContent).toContain('fullGraph is not defined')
    expect(details?.hasAttribute('open')).toBe(false)
  })

  it('пишет ошибку в консоль вместе со стеком компонентов', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )

    expect(
      consoleError.mock.calls.some((args) => args[0] === 'Ошибка рендера приложения:'),
    ).toBe(true)
  })
})

describe('сброс приложения', () => {
  it('стирает кэши, снимает service worker и перезагружает', async () => {
    const deleteCache = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('caches', {
      keys: vi.fn().mockResolvedValue(['workbox-precache', 'runtime']),
      delete: deleteCache,
    })

    const unregister = vi.fn().mockResolvedValue(true)
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations: vi.fn().mockResolvedValue([{ unregister }]) },
    })

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button'))
    await flush()

    expect(deleteCache.mock.calls.map((c) => c[0])).toEqual(['workbox-precache', 'runtime'])
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  /**
   * Ровно тот безвыходный цикл, ради которого очистка и добавлена: одна битая
   * запись роняла приложение при каждом построении маршрута, а перезагрузка
   * возвращала то же падение.
   */
  it('стирает сохранённые маршруты — они и есть частая причина падения', async () => {
    window.localStorage.setItem('metro-map-favorites-v1', '[битое')
    window.localStorage.setItem('metro-map-recents-v1', '[битое')
    window.localStorage.setItem('metro-map-theme', 'dark')
    window.localStorage.setItem('metro-map-install-guide-seen', '1')

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button'))
    await flush()

    expect(window.localStorage.getItem('metro-map-favorites-v1')).toBeNull()
    expect(window.localStorage.getItem('metro-map-recents-v1')).toBeNull()
  })

  /** Настройки переживают сброс: терять их незачем, а раздражает это заметно. */
  it('тему и признак «инструкцию видел» не трогает', async () => {
    window.localStorage.setItem('metro-map-theme', 'dark')
    window.localStorage.setItem('metro-map-install-guide-seen', '1')

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button'))
    await flush()

    expect(window.localStorage.getItem('metro-map-theme')).toBe('dark')
    expect(window.localStorage.getItem('metro-map-install-guide-seen')).toBe('1')
  })

  /**
   * Кнопка — единственный выход с экрана ошибки. Она обязана довести до
   * перезагрузки, даже если ни один из шагов очистки не отработал.
   */
  it('перезагружает, даже когда очистка кэша упала', async () => {
    vi.stubGlobal('caches', { keys: vi.fn().mockRejectedValue(new Error('SecurityError')) })
    vi.stubGlobal('navigator', {
      serviceWorker: { getRegistrations: vi.fn().mockRejectedValue(new Error('нет доступа')) },
    })

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button'))
    await flush()

    expect(reload).toHaveBeenCalledTimes(1)
  })

  /** Приватный режим Safari: доступ к localStorage бросает. */
  it('перезагружает, даже когда хранилище недоступно', async () => {
    vi.stubGlobal('caches', undefined)
    vi.stubGlobal('navigator', {})
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button'))
    await flush()

    expect(reload).toHaveBeenCalledTimes(1)
    vi.restoreAllMocks()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  /** Браузер без service worker вообще — на нём экран ошибки тоже обязан работать. */
  it('обходится без caches и serviceWorker', async () => {
    vi.stubGlobal('caches', undefined)
    vi.stubGlobal('navigator', { serviceWorker: undefined })

    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    )
    fireEvent.click(screen.getByRole('button'))
    await flush()

    expect(reload).toHaveBeenCalledTimes(1)
  })
})
