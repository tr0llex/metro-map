// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Регрессия, ради которой этот файл и написан: при `registerType: 'prompt'`
 * обычная перезагрузка страницы НЕ применяет ожидающее обновление — новый
 * воркер так и стоит в waiting, а старый продолжает отдавать закэшированную
 * версию. Человек жмёт F5 сколько угодно и остаётся на старом приложении.
 *
 * Лечение живёт в usePwaUpdate: если обновление уже ждало в момент регистрации
 * (значит, это свежая загрузка страницы, ломать нечего) — применяем молча.
 */

const mocks = vi.hoisted(() => ({
  updateServiceWorker: vi.fn(),
  setNeedRefresh: vi.fn(),
  needRefresh: false,
  /** Опции последнего вызова useRegisterSW — через них тест дёргает onRegistered. */
  options: undefined as
    | { onRegistered?: (r: ServiceWorkerRegistration | undefined) => void }
    | undefined,
}))

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (options: { onRegistered?: (r: ServiceWorkerRegistration | undefined) => void }) => {
    mocks.options = options
    return {
      needRefresh: [mocks.needRefresh, mocks.setNeedRefresh],
      offlineReady: [false, vi.fn()],
      updateServiceWorker: mocks.updateServiceWorker,
    }
  },
}))

const { usePwaUpdate } = await import('./usePwaUpdate.ts')

/** Регистрация с ожидающим воркером — состояние «обновление скачано и стоит в очереди». */
const regWithWaiting = () =>
  ({ waiting: {}, update: vi.fn().mockResolvedValue(undefined) }) as unknown as ServiceWorkerRegistration

const regWithoutWaiting = () =>
  ({ waiting: null, update: vi.fn().mockResolvedValue(undefined) }) as unknown as ServiceWorkerRegistration

/** Имитация загрузки страницы: монтируем хук и отдаём ему регистрацию SW. */
const loadPage = (registration: ServiceWorkerRegistration) => {
  const hook = renderHook(() => usePwaUpdate())
  act(() => {
    mocks.options?.onRegistered?.(registration)
  })
  return hook
}

/** Новый воркер доустановился: библиотека поднимает needRefresh на следующем рендере. */
const setNeedRefresh = (value: boolean, rerender: () => void) => {
  mocks.needRefresh = value
  act(() => {
    rerender()
  })
}

/**
 * Уводит часы за окно «страница только что загрузилась»: дальше обновление
 * считается найденным посреди работы и требует согласия человека.
 */
const passLoadWindow = () => {
  act(() => {
    vi.advanceTimersByTime(60_000)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  window.sessionStorage.clear()
  mocks.needRefresh = false
  mocks.options = undefined
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('usePwaUpdate — обновление на холодном старте', () => {
  it('ожидающее обновление применяется перезагрузкой страницы', () => {
    loadPage(regWithWaiting())

    expect(mocks.updateServiceWorker).toHaveBeenCalledWith(true)
  })

  it('без ожидающего воркера ничего молча не применяется', () => {
    loadPage(regWithoutWaiting())

    expect(mocks.updateServiceWorker).not.toHaveBeenCalled()
  })

  it('регистрации нет — молчим, а не падаем', () => {
    expect(() => loadPage(undefined as unknown as ServiceWorkerRegistration)).not.toThrow()
    expect(mocks.updateServiceWorker).not.toHaveBeenCalled()
  })

  /**
   * Флаг в sessionStorage — защита от петли: если активация почему-то не
   * доводится до конца, вторая регистрация в той же вкладке не должна
   * запускать перезагрузку снова.
   */
  it('в одной вкладке применяется один раз — без петли перезагрузок', () => {
    loadPage(regWithWaiting())
    expect(mocks.updateServiceWorker).toHaveBeenCalledTimes(1)

    act(() => {
      mocks.options?.onRegistered?.(regWithWaiting())
    })

    expect(mocks.updateServiceWorker).toHaveBeenCalledTimes(1)
  })

  /** Новая вкладка — чистый sessionStorage, значит обновление снова применимо. */
  it('в новой вкладке обновление применяется заново', () => {
    loadPage(regWithWaiting())
    expect(mocks.updateServiceWorker).toHaveBeenCalledTimes(1)

    window.sessionStorage.clear()
    loadPage(regWithWaiting())

    expect(mocks.updateServiceWorker).toHaveBeenCalledTimes(2)
  })
})

/**
 * Главный сценарий поломки «жму F5, а версия старая».
 *
 * Когда обновление выкатили, пока вкладка была закрыта, в момент регистрации
 * `waiting` ещё пуст: браузер только начал качать новый воркер. Тот встаёт в
 * очередь через долю секунды ПОСЛЕ onRegistered. Проверки одним снимком этого
 * не видят, и свежая загрузка страницы получает баннер вместо обновления —
 * хотя ломать на только что загруженной странице нечего.
 */
describe('usePwaUpdate — обновление, найденное на загрузке страницы', () => {
  it('приехавшее сразу после регистрации применяется само, без баннера', () => {
    const { result, rerender } = loadPage(regWithoutWaiting())
    expect(mocks.updateServiceWorker).not.toHaveBeenCalled()

    // Новый воркер доустановился и встал в waiting — уже после onRegistered.
    setNeedRefresh(true, rerender)

    expect(mocks.updateServiceWorker).toHaveBeenCalledWith(true)
    expect(result.current.isUpdateReady).toBe(false)
  })

  it('применяется один раз, даже если needRefresh придёт повторно', () => {
    const { rerender } = loadPage(regWithoutWaiting())

    setNeedRefresh(true, rerender)
    rerender()
    rerender()

    expect(mocks.updateServiceWorker).toHaveBeenCalledTimes(1)
  })

  it('окно загрузки не перебивает защиту от петли перезагрузок', () => {
    loadPage(regWithWaiting())
    expect(mocks.updateServiceWorker).toHaveBeenCalledTimes(1)

    // Та же вкладка: обновление уже применялось, второй заход молчит.
    const { rerender } = loadPage(regWithoutWaiting())
    setNeedRefresh(true, rerender)

    expect(mocks.updateServiceWorker).toHaveBeenCalledTimes(1)
  })
})

describe('usePwaUpdate — обновление посреди сессии', () => {
  it('показывает баннер, а не меняет версию на лету', () => {
    const { result, rerender } = loadPage(regWithoutWaiting())
    passLoadWindow()
    setNeedRefresh(true, rerender)

    expect(result.current.isUpdateReady).toBe(true)
    expect(mocks.updateServiceWorker).not.toHaveBeenCalled()
  })

  it('кнопка баннера применяет обновление', () => {
    const { result, rerender } = loadPage(regWithoutWaiting())
    passLoadWindow()
    setNeedRefresh(true, rerender)

    act(() => {
      result.current.applyUpdate()
    })

    expect(mocks.updateServiceWorker).toHaveBeenCalledWith(true)
  })

  it('отложенное обновление прячет баннер до конца сессии', () => {
    const { result, rerender } = loadPage(regWithoutWaiting())
    passLoadWindow()
    setNeedRefresh(true, rerender)

    act(() => {
      result.current.dismissUpdate()
    })
    rerender()

    expect(result.current.isUpdateReady).toBe(false)
  })

  /**
   * «Отложил» относится к конкретному обновлению: следующая версия обязана
   * показать баннер снова, иначе человек больше никогда его не увидит.
   */
  it('после применения флаг «отложено» снимается', () => {
    const { result, rerender } = loadPage(regWithoutWaiting())
    passLoadWindow()
    setNeedRefresh(true, rerender)

    act(() => {
      result.current.dismissUpdate()
    })
    rerender()
    expect(result.current.isUpdateReady).toBe(false)

    setNeedRefresh(false, rerender)
    setNeedRefresh(true, rerender)

    expect(result.current.isUpdateReady).toBe(true)
  })
})
