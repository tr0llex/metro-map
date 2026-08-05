// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** Имя актуального воркера: всё остальное на origin — наследие прежних версий. */
const CURRENT_SW_FILE = '/metro-map-sw.js'
/** Не чаще одной проверки обновления в три секунды. */
const SW_UPDATE_CHECK_THROTTLE_MS = 3000

const mocks = vi.hoisted(() => ({
  updateServiceWorker: vi.fn(),
  needRefresh: false,
  options: undefined as
    | {
        onRegistered?: (r: ServiceWorkerRegistration | undefined) => void
        onRegisterError?: (e: unknown) => void
      }
    | undefined,
}))

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (options: typeof mocks.options) => {
    mocks.options = options
    return {
      needRefresh: [mocks.needRefresh, vi.fn()],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: mocks.updateServiceWorker,
    }
  },
}))

const { usePwaUpdate } = await import('./usePwaUpdate.ts')
const { readErrorLog } = await import('../utils/errorLog.ts')

/** Регистрация воркера с заданным адресом скрипта. */
const registration = (scriptURL: string) => {
  const unregister = vi.fn().mockResolvedValue(true)
  return {
    reg: {
      active: { scriptURL },
      waiting: null,
      installing: null,
      unregister,
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as ServiceWorkerRegistration,
    unregister,
  }
}

let getRegistrations: ReturnType<typeof vi.fn>
let cacheKeys: string[]
let deleteCache: ReturnType<typeof vi.fn>

/** Признак того, что dev-чистка воркера в этой сессии уже отработала. */
const DEV_CLEANED_KEY = 'metro-map-dev-sw-cleaned'

beforeEach(() => {
  window.sessionStorage.clear()
  window.localStorage.clear()
  // Отдельная разовая чистка для dev-режима сносит ВСЕ воркеры и кэши и
  // проверяется своим набором ниже — здесь она мешала бы считать вызовы.
  window.sessionStorage.setItem(DEV_CLEANED_KEY, '1')
  mocks.needRefresh = false
  mocks.options = undefined
  mocks.updateServiceWorker.mockClear()

  getRegistrations = vi.fn().mockResolvedValue([])
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistrations },
  })

  cacheKeys = []
  deleteCache = vi.fn().mockResolvedValue(true)
  vi.stubGlobal('caches', {
    keys: vi.fn(() => Promise.resolve(cacheKeys)),
    delete: deleteCache,
  })

  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'serviceWorker')
})

/**
 * Браузер держит регистрацию по имени файла, и новый воркер с другим именем
 * старую не вытесняет: та продолжает перехватывать запросы и отдавать свою
 * версию приложения.
 */
describe('чистка устаревших регистраций', () => {
  it('снимает воркер с чужим именем', async () => {
    const legacy = registration('https://metro.samoy.love/sw.js')
    getRegistrations.mockResolvedValue([legacy.reg])

    renderHook(() => usePwaUpdate())

    await waitFor(() => expect(legacy.unregister).toHaveBeenCalledTimes(1))
  })

  it('действующий воркер не трогает', async () => {
    const current = registration(`https://metro.samoy.love${CURRENT_SW_FILE}`)
    getRegistrations.mockResolvedValue([current.reg])

    renderHook(() => usePwaUpdate())

    await act(async () => {})
    expect(current.unregister).not.toHaveBeenCalled()
    expect(deleteCache).not.toHaveBeenCalled()
  })

  /**
   * Раньше здесь удалялись ВСЕ кэши origin, и вместе с наследием улетал
   * действующий precache Workbox: оболочка приложения, граф маршрутизации и
   * данные схемы. Человек оставался с установленным PWA без офлайна.
   */
  it('кэши Workbox переживают чистку', async () => {
    const legacy = registration('https://metro.samoy.love/sw.js')
    getRegistrations.mockResolvedValue([legacy.reg])
    cacheKeys = ['workbox-precache-v2-https://metro.samoy.love/', 'metro-map-v1', 'старый-кэш']

    renderHook(() => usePwaUpdate())

    await waitFor(() => expect(legacy.unregister).toHaveBeenCalled())
    expect(deleteCache.mock.calls.map((c) => c[0])).toEqual(['metro-map-v1', 'старый-кэш'])
  })

  it('без регистраций ничего не делает', async () => {
    renderHook(() => usePwaUpdate())

    await act(async () => {})
    expect(deleteCache).not.toHaveBeenCalled()
  })

  it('отказ getRegistrations не роняет хук', async () => {
    getRegistrations.mockRejectedValue(new Error('SecurityError'))

    const { result } = renderHook(() => usePwaUpdate())
    await act(async () => {})

    expect(result.current.isUpdateReady).toBe(false)
  })

  it('отказ очистки кэшей не мешает снять регистрацию', async () => {
    const legacy = registration('https://metro.samoy.love/sw.js')
    getRegistrations.mockResolvedValue([legacy.reg])
    vi.stubGlobal('caches', { keys: vi.fn().mockRejectedValue(new Error('нет доступа')) })

    renderHook(() => usePwaUpdate())

    await waitFor(() => expect(legacy.unregister).toHaveBeenCalled())
  })

  it('отказ снятия регистрации проглатывается', async () => {
    const legacy = registration('https://metro.samoy.love/sw.js')
    legacy.unregister.mockRejectedValue(new Error('уже снята'))
    getRegistrations.mockResolvedValue([legacy.reg])

    const { result } = renderHook(() => usePwaUpdate())
    await act(async () => {})

    expect(result.current.isUpdateReady).toBe(false)
  })

  /** Регистрация без воркера вообще — судить о её имени не по чему. */
  it('регистрацию без воркера не считает наследием', async () => {
    const empty = {
      active: null,
      waiting: null,
      installing: null,
      unregister: vi.fn(),
    } as unknown as ServiceWorkerRegistration
    getRegistrations.mockResolvedValue([empty])

    renderHook(() => usePwaUpdate())
    await act(async () => {})

    expect(empty.unregister).not.toHaveBeenCalled()
  })

  it('нечитаемый адрес скрипта наследием не считается', async () => {
    const broken = registration('не-адрес')
    getRegistrations.mockResolvedValue([broken.reg])

    renderHook(() => usePwaUpdate())
    await act(async () => {})

    expect(broken.unregister).not.toHaveBeenCalled()
  })

  /** Браузер без service worker — на нём приложение обязано работать как обычно. */
  it('без serviceWorker в браузере молчит', async () => {
    Reflect.deleteProperty(navigator, 'serviceWorker')

    const { result } = renderHook(() => usePwaUpdate())
    await act(async () => {})

    expect(result.current.isUpdateReady).toBe(false)
  })
})

/**
 * PWA живёт долго, и без периодической проверки человек может месяцами сидеть
 * на версии, установленной однажды.
 */
describe('проверка обновления при возвращении', () => {
  const load = () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const reg = { waiting: null, update } as unknown as ServiceWorkerRegistration
    const hook = renderHook(() => usePwaUpdate())
    act(() => {
      mocks.options?.onRegistered?.(reg)
    })
    return { ...hook, update }
  }

  it.each([
    ['focus', () => window.dispatchEvent(new Event('focus'))],
    ['pageshow', () => window.dispatchEvent(new Event('pageshow'))],
  ])('событие %s запускает проверку', (_name, fire) => {
    vi.useFakeTimers()
    const { update } = load()
    update.mockClear()

    act(() => {
      vi.advanceTimersByTime(SW_UPDATE_CHECK_THROTTLE_MS + 1)
      fire()
    })

    expect(update).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('возвращение вкладки на передний план запускает проверку', () => {
    vi.useFakeTimers()
    const { update } = load()
    update.mockClear()

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    })
    act(() => {
      vi.advanceTimersByTime(SW_UPDATE_CHECK_THROTTLE_MS + 1)
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(update).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('уход вкладки в фон проверку не запускает', () => {
    vi.useFakeTimers()
    const { update } = load()
    update.mockClear()

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    act(() => {
      vi.advanceTimersByTime(SW_UPDATE_CHECK_THROTTLE_MS + 1)
      document.dispatchEvent(new Event('visibilitychange'))
    })

    expect(update).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  /** Фокус, pageshow и visibility приходят пачкой — три проверки подряд не нужны. */
  it('пачка событий даёт одну проверку', () => {
    vi.useFakeTimers()
    const { update } = load()
    update.mockClear()

    act(() => {
      vi.advanceTimersByTime(SW_UPDATE_CHECK_THROTTLE_MS + 1)
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('pageshow'))
      window.dispatchEvent(new Event('focus'))
    })

    expect(update).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  /**
   * update() отклоняется, если регистрация мертва: воркер стал redundant или
   * её сняли. Без catch отказ всплывал бы как unhandledrejection и попадал в
   * собственный журнал ошибок.
   */
  it('мёртвая регистрация забывается молча', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const update = vi.fn().mockRejectedValue(new Error('InvalidStateError'))
    const reg = { waiting: null, update } as unknown as ServiceWorkerRegistration

    renderHook(() => usePwaUpdate())
    act(() => {
      mocks.options?.onRegistered?.(reg)
    })

    // Первая же настоящая проверка натыкается на мёртвую регистрацию.
    await act(async () => {
      vi.advanceTimersByTime(SW_UPDATE_CHECK_THROTTLE_MS + 1)
      window.dispatchEvent(new Event('focus'))
    })
    expect(update).toHaveBeenCalledTimes(1)

    // Ссылку стёрли: проверять больше нечего, и в журнал ошибок это не попадает.
    await act(async () => {
      vi.advanceTimersByTime(SW_UPDATE_CHECK_THROTTLE_MS + 1)
      window.dispatchEvent(new Event('focus'))
    })
    expect(update).toHaveBeenCalledTimes(1)
    expect(readErrorLog()).toEqual([])

    vi.useRealTimers()
  })

  it('без регистрации проверять нечего', () => {
    vi.useFakeTimers()
    renderHook(() => usePwaUpdate())

    expect(() => {
      act(() => {
        vi.advanceTimersByTime(SW_UPDATE_CHECK_THROTTLE_MS + 1)
        window.dispatchEvent(new Event('focus'))
      })
    }).not.toThrow()
    vi.useRealTimers()
  })

  it('подписки снимаются вместе с хуком', () => {
    const removeWindow = vi.spyOn(window, 'removeEventListener')
    const removeDoc = vi.spyOn(document, 'removeEventListener')
    const { unmount } = renderHook(() => usePwaUpdate())

    unmount()

    expect(removeWindow.mock.calls.some(([t]) => t === 'focus')).toBe(true)
    expect(removeDoc.mock.calls.some(([t]) => t === 'visibilitychange')).toBe(true)
  })
})

describe('отказ регистрации', () => {
  /**
   * В проде отказ нужен в журнале ошибок, а не в консоли: консоль у
   * пользователя никто не читает, а журнал он умеет отправить.
   */
  it('уезжает в журнал ошибок с указанием источника', () => {
    renderHook(() => usePwaUpdate())

    act(() => {
      mocks.options?.onRegisterError?.(new Error('SecurityError: сертификат'))
    })

    const [entry] = readErrorLog()
    expect(entry.message).toContain('SecurityError')
    expect(entry.source).toBe('service-worker-register')
  })
})

describe('недоступное хранилище сессии', () => {
  /**
   * Приватный режим: без sessionStorage право на молчаливое применение не
   * выдать. Отказ подставляем точечно — на ключ признака, а не на всё
   * хранилище: журнал ошибок и тема живут в том же API.
   */
  it('молчаливое применение не выдаётся', () => {
    const real = Storage.prototype.getItem
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (
      this: Storage,
      key: string,
    ) {
      if (key === 'metro-map-sw-cold-start-applied') throw new Error('SecurityError')
      return real.call(this, key)
    })

    renderHook(() => usePwaUpdate())
    act(() => {
      mocks.options?.onRegistered?.({
        waiting: {},
        update: vi.fn().mockResolvedValue(undefined),
      } as unknown as ServiceWorkerRegistration)
    })

    expect(mocks.updateServiceWorker).not.toHaveBeenCalled()
  })

  it('отказ хранилища не мешает отложить обновление', () => {
    const real = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === 'metro-map-update-dismissed') throw new Error('QuotaExceededError')
      real.call(this, key, value)
    })

    const { result } = renderHook(() => usePwaUpdate())
    expect(() => act(() => result.current.dismissUpdate())).not.toThrow()
  })
})

/**
 * В dev service worker только мешает: он отдаёт закэшированные модули поверх
 * свежих. Один раз за сессию сносим регистрации и кэши целиком.
 */
describe('разовая чистка в dev-режиме', () => {
  const reload = vi.fn()

  beforeEach(() => {
    window.sessionStorage.removeItem(DEV_CLEANED_KEY)
    reload.mockClear()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload },
    })
  })

  it('сносит все воркеры и кэши и перезагружает страницу', async () => {
    const legacy = registration('https://localhost/sw.js')
    getRegistrations.mockResolvedValue([legacy.reg])
    cacheKeys = ['workbox-precache-v2-x', 'metro-map-v1']

    renderHook(() => usePwaUpdate())

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    // В dev действующий precache тоже мешает: он отдаёт старые модули.
    expect(deleteCache.mock.calls.map((c) => c[0])).toContain('workbox-precache-v2-x')
    expect(window.sessionStorage.getItem(DEV_CLEANED_KEY)).toBe('1')
  })

  it('без воркеров страницу не перезагружает', async () => {
    renderHook(() => usePwaUpdate())

    await act(async () => {})
    expect(reload).not.toHaveBeenCalled()
  })

  it('во второй раз за сессию не повторяется', async () => {
    const legacy = registration('https://localhost/sw.js')
    getRegistrations.mockResolvedValue([legacy.reg])

    renderHook(() => usePwaUpdate())
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))

    renderHook(() => usePwaUpdate())
    await act(async () => {})
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('отказ чистки не роняет приложение', async () => {
    getRegistrations.mockRejectedValue(new Error('SecurityError'))

    const { result } = renderHook(() => usePwaUpdate())
    await act(async () => {})

    expect(result.current.isUpdateReady).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
})
