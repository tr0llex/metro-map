// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RouteResult } from '../metro/types.ts'
import { useRouteWorker } from './useRouteWorker.ts'

const TIMEOUT_MS = 9000
const FIRST_TIMEOUT_MS = 30000
const SHOW_DELAY_MS = 220
const MIN_VISIBLE_MS = 420
const MAX_ALTERNATIVES = 6

type Posted = {
  type: string
  requestId: number
  fromId: string
  toId: string
  maxAlternatives: number
  edgeOverrides: unknown
  extraEdges: unknown[]
}

/**
 * Воркера в jsdom нет. Подменяем классом, который запоминает отправленное и
 * позволяет ответить руками — расчёт маршрута здесь не проверяется, только
 * транспорт до него.
 */
class FakeWorker {
  static instances: FakeWorker[] = []

  posted: Posted[] = []
  terminated = false
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(msg: Posted) {
    this.posted.push(msg)
  }

  terminate() {
    this.terminated = true
  }

  /** Ответ воркера — как он приходит в onmessage. */
  reply(data: unknown) {
    act(() => {
      this.onmessage?.({ data } as MessageEvent)
    })
  }

  fail() {
    act(() => {
      this.onerror?.()
    })
  }
}

const worker = () => FakeWorker.instances[FakeWorker.instances.length - 1]

const ctx = (over: Partial<Parameters<ReturnType<typeof useRouteWorker>['postRoute']>[0]> = {}) => ({
  fromId: '1/arbatskaya',
  toId: '5/kitay-gorod',
  fromTitleEffective: 'Арбатская',
  toTitleEffective: 'Китай-город',
  isDesktop: false,
  ...over,
})

const NO_OVERRIDES = { edgeOverrides: {}, extraEdges: [] }

const routes = [{ totalMinutes: 12 }] as unknown as RouteResult[]

let onRoutes: ReturnType<typeof vi.fn>
let onError: ReturnType<typeof vi.fn>

const setup = () => renderHook(() => useRouteWorker({ onRoutes, onError }))

beforeEach(() => {
  vi.useFakeTimers()
  FakeWorker.instances = []
  vi.stubGlobal('Worker', FakeWorker)
  onRoutes = vi.fn()
  onError = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const tick = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms)
  })

describe('жизненный цикл воркера', () => {
  /**
   * Ради этого обработчики и держатся в ref. Раньше эффект создания воркера
   * зависел от коллбэков, а те пересоздавались при смене isDesktop — на широком
   * экране флаг переключается сразу после монтирования, воркер пересоздавался
   * посреди расчёта, и маршрут молча терялся.
   */
  it('создаётся один раз и переживает смену коллбэков', () => {
    const { rerender } = setup()
    expect(FakeWorker.instances).toHaveLength(1)

    onRoutes = vi.fn()
    onError = vi.fn()
    rerender()
    rerender()

    expect(FakeWorker.instances).toHaveLength(1)
    expect(worker().terminated).toBe(false)
  })

  it('снимается вместе с хуком', () => {
    const { result, unmount } = setup()
    expect(result.current.hasWorker()).toBe(true)

    unmount()
    expect(worker().terminated).toBe(true)
  })

  /** Без воркера отправлять некуда, и вызывающий обязан это узнать. */
  it('после снятия отправка отвечает отказом', () => {
    const { result, unmount } = setup()
    unmount()

    expect(result.current.hasWorker()).toBe(false)
    expect(result.current.postRoute(ctx(), NO_OVERRIDES)).toBe(false)
  })
})

describe('отправка запроса', () => {
  it('передаёт станции, правки и число альтернатив', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), { edgeOverrides: { 'a|b': {} }, extraEdges: [{ id: 'x' }] })
    })

    const msg = worker().posted[0]
    expect(msg.type).toBe('route')
    expect(msg.fromId).toBe('1/arbatskaya')
    expect(msg.toId).toBe('5/kitay-gorod')
    expect(msg.maxAlternatives).toBe(MAX_ALTERNATIVES)
    expect(msg.edgeOverrides).toEqual({ 'a|b': {} })
    expect(msg.extraEdges).toEqual([{ id: 'x' }])
  })

  it('нумерует запросы возрастающе', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })

    const [first, second] = worker().posted
    expect(second.requestId).toBeGreaterThan(first.requestId)
  })

  /** Кнопка «Повторить» переигрывает именно последний запрос. */
  it('запоминает последний запрос', () => {
    const { result } = setup()
    expect(result.current.getLastRequest()).toBeNull()

    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
      result.current.postRoute(ctx({ toId: '2/teatralnaya' }), NO_OVERRIDES)
    })

    expect(result.current.getLastRequest()).toEqual({
      fromId: '1/arbatskaya',
      toId: '2/teatralnaya',
    })
  })
})

describe('ответ воркера', () => {
  it('непустой результат уходит наверх вместе с контекстом запроса', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })

    worker().reply({ type: 'routeResult', requestId: 1, routes })

    expect(onRoutes).toHaveBeenCalledTimes(1)
    expect(onRoutes.mock.calls[0][0].fromTitleEffective).toBe('Арбатская')
    expect(onRoutes.mock.calls[0][1]).toBe(routes)
    expect(onError).not.toHaveBeenCalled()
  })

  /** Пустой список — это не успех: маршрута между станциями нет. */
  it('пустой результат превращается в ошибку', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })

    worker().reply({ type: 'routeResult', requestId: 1, routes: [] })

    expect(onRoutes).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('Маршрут между этими станциями не найден.')
  })

  it('отсутствующий список маршрутов тоже считается ошибкой', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })

    worker().reply({ type: 'routeResult', requestId: 1 })
    expect(onError).toHaveBeenCalledWith('Маршрут между этими станциями не найден.')
  })

  it('текст ошибки воркера показывается как есть', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })

    worker().reply({ type: 'routeError', requestId: 1, errorMessage: 'Станция не найдена' })
    expect(onError).toHaveBeenCalledWith('Станция не найдена')
  })

  it('ошибка без текста заменяется общей', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })

    worker().reply({ type: 'routeError', requestId: 1, errorMessage: '' })
    expect(onError).toHaveBeenCalledWith('Маршрут между этими станциями не найден.')
  })

  /**
   * Быстрый тап по станциям: пока считался первый маршрут, человек выбрал
   * другой. Ответ на отменённый запрос не имеет права перерисовать экран.
   */
  it('ответ на отменённый запрос игнорируется', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
      result.current.postRoute(ctx({ toId: '2/teatralnaya' }), NO_OVERRIDES)
    })

    worker().reply({ type: 'routeResult', requestId: 1, routes })
    expect(onRoutes).not.toHaveBeenCalled()

    worker().reply({ type: 'routeResult', requestId: 2, routes })
    expect(onRoutes).toHaveBeenCalledTimes(1)
    expect(onRoutes.mock.calls[0][0].toId).toBe('2/teatralnaya')
  })

  it('сообщения не от воркера маршрутов не трогают состояние', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })

    worker().reply(null)
    worker().reply({ type: 'routeResult' })
    worker().reply({ type: 'routeResult', requestId: 'первый' })

    expect(onRoutes).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('падение самого воркера объясняется пользователю', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })

    worker().fail()

    expect(onError).toHaveBeenCalledWith(
      'Не удалось построить маршрут: расчёт завершился с ошибкой. Попробуй ещё раз.',
    )
    // Запрос вычищен: опоздавший ответ уже ничего не перерисует.
    worker().reply({ type: 'routeResult', requestId: 1, routes })
    expect(onRoutes).not.toHaveBeenCalled()
  })
})

describe('сторожевой таймаут', () => {
  /**
   * Первый запрос особый: воркер отвечает только после загрузки графа отдельным
   * ассетом, и на холодном старте PWA девяти секунд не хватает. Текст ошибки
   * тоже свой — «данные ещё грузятся», а не «расчёт завис».
   */
  it('первому запросу даёт тридцать секунд и свой текст', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })

    tick(TIMEOUT_MS + 1)
    expect(onError).not.toHaveBeenCalled()

    tick(FIRST_TIMEOUT_MS - TIMEOUT_MS)
    expect(onError).toHaveBeenCalledWith(
      'Данные схемы всё ещё загружаются. Проверь связь и попробуй ещё раз.',
    )
  })

  /** Воркер уже отвечал — значит граф загружен, и дальше действует обычный бюджет. */
  it('после первого ответа переходит на девять секунд', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })
    worker().reply({ type: 'routeResult', requestId: 1, routes })

    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })
    tick(TIMEOUT_MS)

    expect(onError).toHaveBeenCalledWith(
      'Расчёт маршрута занял слишком много времени. Попробуй ещё раз.',
    )
  })

  /** Опоздавший ответ обязан быть уже никому не нужен. */
  it('потерянный запрос снимается из ожидания', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })
    tick(FIRST_TIMEOUT_MS)

    worker().reply({ type: 'routeResult', requestId: 1, routes })
    expect(onRoutes).not.toHaveBeenCalled()
  })

  it('успевший ответ таймаут отменяет', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })
    worker().reply({ type: 'routeResult', requestId: 1, routes })

    tick(FIRST_TIMEOUT_MS * 2)
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('индикатор расчёта', () => {
  /**
   * Обычный расчёт укладывается в единицы миллисекунд: показывать скелетон
   * сразу — значит мигать пользователю в лицо на каждый запрос.
   */
  it('на быстром расчёте не появляется вовсе', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })
    expect(result.current.isRouteLoading).toBe(false)

    tick(SHOW_DELAY_MS - 50)
    worker().reply({ type: 'routeResult', requestId: 1, routes })

    tick(SHOW_DELAY_MS)
    expect(result.current.isRouteLoading).toBe(false)
  })

  it('на затянувшемся расчёте появляется', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })

    tick(SHOW_DELAY_MS)
    expect(result.current.isRouteLoading).toBe(true)
  })

  /** Появившись, индикатор обязан продержаться — иначе он мигнёт и исчезнет. */
  it('появившись, держится минимум 420 мс', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })
    tick(SHOW_DELAY_MS)
    worker().reply({ type: 'routeResult', requestId: 1, routes })

    tick(MIN_VISIBLE_MS - 100)
    expect(result.current.isRouteLoading).toBe(true)

    tick(100)
    expect(result.current.isRouteLoading).toBe(false)
  })

  /** Индикатор гасится и при успехе, и при ошибке, и при отмене — залипнуть не может. */
  it('гаснет и после ошибки', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })
    tick(SHOW_DELAY_MS)

    worker().reply({ type: 'routeError', requestId: 1, errorMessage: 'нет пути' })
    tick(MIN_VISIBLE_MS)
    expect(result.current.isRouteLoading).toBe(false)
  })

  it('гасится вручную, не трогая содержимое ответа', () => {
    const { result } = setup()
    act(() => {
      result.current.postRoute(ctx(), NO_OVERRIDES)
    })
    tick(SHOW_DELAY_MS)

    act(() => result.current.stopRouteLoading())
    tick(MIN_VISIBLE_MS)

    expect(result.current.isRouteLoading).toBe(false)
    // Сторожевой таймер снят вместе с индикатором.
    tick(FIRST_TIMEOUT_MS)
    expect(onError).not.toHaveBeenCalled()
  })
})

describe('разрешение на deep link', () => {
  /** Ссылка обязана открыть маршрут ровно один раз, а не на каждый рендер. */
  it('выдаётся один раз на живой воркер', () => {
    const { result } = setup()

    expect(result.current.claimDeepLinkSlot()).toBe(true)
    expect(result.current.claimDeepLinkSlot()).toBe(false)
  })

  /**
   * Пересоздание воркера (в том числе двойной монтаж в StrictMode) сбрасывает
   * разрешение — иначе ссылка потерялась бы вместе с первым воркером.
   */
  it('сбрасывается вместе с воркером', () => {
    const first = setup()
    expect(first.result.current.claimDeepLinkSlot()).toBe(true)
    first.unmount()

    const second = setup()
    expect(second.result.current.claimDeepLinkSlot()).toBe(true)
  })
})
