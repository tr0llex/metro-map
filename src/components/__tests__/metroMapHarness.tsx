// Общий стенд для тестов схемы.
//
// Лежит в __tests__/ намеренно: этот путь уже исключён из покрытия
// (см. vite.config.ts), а по имени файла vitest не считает его набором тестов.
// Так стенд один на все файлы карты, и делить их можно свободно.
//
// Делить приходится. Раскладка подписей считается на КАЖДОМ монтировании —
// её useMemo не зависит от пропсов маршрута, — а под инструментацией покрытия
// v8 этот числовой цикл идёт в десять раз медленнее (тот же эффект описан в
// ci.yml для scripts/quality). Тесты внутри одного файла vitest выполняет
// последовательно, поэтому сорок монтирований в одном файле — это сорок
// раскладок подряд на одном ядре. Разложенные по файлам, они идут параллельно.
import { act, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'

import type { MetroMap } from '../MetroMap.tsx'

/** Размер холста в разметке — по нему считаются мировые координаты. */
export const VIEWBOX = 1000

/**
 * Вызовы рисующих методов канваса за текущий тест.
 *
 * Массив переиспользуется между тестами (чистится, а не пересоздаётся), чтобы
 * ссылка на него оставалась годной в модуле теста после импорта.
 */
export const calls: string[] = []

/**
 * Экран → мир. Карта считает мировые координаты от ЦЕНТРА холста с учётом
 * подобранного масштаба, поэтому «кликнуть по станции» — это не её x/y из
 * данных. Реальное преобразование снимаем с холста: рендерер сам зовёт
 * translate/scale перед отрисовкой схемы.
 */
const transform = { tx: 0, ty: 0, k: 1 }

let frames: FrameRequestCallback[] = []

/**
 * Канвас в jsdom не рисует: getContext возвращает null, и весь конвейер
 * отрисовки молча не исполняется. Подменяем контекст болванкой, которая
 * принимает любые вызовы и умеет мерить текст — иначе раскладка подписей
 * делит на ширину, которой нет.
 */
function stubCanvas() {
  const ctx = new Proxy(
    {
      canvas: null as unknown,
      measureText: (text: string) => ({ width: text.length * 7 }),
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      isPointInPath: () => false,
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        // Всё остальное — рисующие методы и присваиваемые свойства стиля.
        return (...args: unknown[]) => {
          calls.push(`${prop}(${args.length})`)
          if (prop === 'translate') {
            transform.tx = args[0] as number
            transform.ty = args[1] as number
          }
          if (prop === 'scale') transform.k = args[0] as number
        }
      },
      set(target, prop: string, value) {
        target[prop] = value
        return true
      },
    },
  )

  HTMLCanvasElement.prototype.getContext = vi.fn(
    () => ctx,
  ) as unknown as HTMLCanvasElement['getContext']
}

/**
 * Размеры элементов. Мерить нужно и холст, и обёртку: по обёртке карта
 * подбирает начальный масштаб, а в jsdom все прямоугольники нулевые — без
 * этого схема так и не вписывается, и попасть по станции невозможно.
 */
function stubRects() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: VIEWBOX,
    bottom: VIEWBOX,
    width: VIEWBOX,
    height: VIEWBOX,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
}

/** Кадры под ручным управлением и наблюдатель размеров, который реально мерит. */
function stubAnimationAndObserver() {
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    frames.push(fn)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('devicePixelRatio', 1)
  // Наблюдатель обязан ОТДАТЬ размер: без первого измерения карта не вписывает
  // схему в холст и остаётся в единичном масштабе.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      cb: ResizeObserverCallback
      constructor(cb: ResizeObserverCallback) {
        this.cb = cb
      }
      observe(el: Element) {
        this.cb(
          [{ target: el, contentRect: { width: VIEWBOX, height: VIEWBOX } }] as never,
          this as never,
        )
      }
      unobserve() {}
      disconnect() {}
    },
  )
}

/**
 * Ставит окружение схемы на каждый тест файла.
 *
 * Таймаут поднят, потому что под покрытием конвейер отрисовки не укладывается
 * в стандартные пять секунд.
 */
export function installMetroMapHarness(): void {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

  beforeEach(() => {
    frames = []
    calls.length = 0
    transform.tx = 0
    transform.ty = 0
    transform.k = 1

    stubCanvas()
    stubRects()

    stubAnimationAndObserver()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
}

/**
 * То же окружение, но один раз на файл.
 *
 * Нужно там, где схема монтируется единожды и тесты только читают её вывод:
 * `beforeAll` выполняется РАНЬШЕ любого `beforeEach`, поэтому с потестовой
 * установкой монтирование пришлось бы на голое окружение — без канваса и без
 * размеров, то есть схема не вписалась бы в холст.
 */
export function installMetroMapHarnessOnce(): void {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

  beforeAll(() => {
    frames = []
    calls.length = 0
    transform.tx = 0
    transform.ty = 0
    transform.k = 1

    stubCanvas()
    stubRects()
    stubAnimationAndObserver()
  })

  afterAll(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
}

/** Проиграть накопленные кадры анимации. */
export const flushFrames = (count = 4) =>
  act(() => {
    for (let i = 0; i < count; i += 1) {
      const queued = frames
      frames = []
      for (const fn of queued) fn(i * 16)
    }
  })

/** Сколько кадров ещё ждёт очереди — по этому видно, остановилась ли анимация. */
export const pendingFrames = () => frames.length

export function props(
  over: Partial<Parameters<typeof MetroMap>[0]> = {},
): Parameters<typeof MetroMap>[0] {
  return {
    selectionMode: 'from' as const,
    onSelectStation: vi.fn(),
    ...over,
  }
}

export const canvas = () => screen.getByRole('application')
export const announcement = () => screen.getByRole('status').textContent

/**
 * Экранная точка станции — по последнему применённому преобразованию.
 *
 * Берём layoutX/layoutY, а не sourceX/sourceY: на схеме лежит результат
 * солвера, и от исходных координат он отличается на единицы пикселей. В обычном
 * режиме радиус попадания это скрывает, а в редакторе он куда уже — и промах
 * становится настоящим.
 */
export const at = (station: { layoutX?: number; layoutY?: number }) => ({
  clientX: transform.tx + (station.layoutX as number) * transform.k,
  clientY: transform.ty + (station.layoutY as number) * transform.k,
})

export const touchAt = (station: { layoutX?: number; layoutY?: number }) => ({
  touches: [at(station)],
  changedTouches: [at(station)],
})
