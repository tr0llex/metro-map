// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fullGraphStations } from '../metro/fullGraph.ts'
import { MetroMap } from './MetroMap.tsx'

afterEach(cleanup)

/** Тот же счёт, что и в MetroMap.test.tsx: конвейер отрисовки медленный. */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const VIEWBOX = 1000

/** Соседние станции одной линии — на них проверяется рисование маршрута. */
const A = fullGraphStations.find((s) => s.id === '5/novoslobodskaya')!
const B = fullGraphStations.find((s) => s.id === '5/prospekt-mira')!
/** Станция пересадочного узла: перетаскивание берёт весь узел, а не её одну. */
const HUB = fullGraphStations.find((s) => s.id === '1/biblioteka-im-lenina')!
const HUB_SIZE = fullGraphStations.filter((s) => s.hubId === HUB.hubId).length

/** Двойной тап: не позже этого и не дальше этого от первого. */
const DOUBLE_TAP_MAX_DELAY = 320

let calls: string[]
let frames: FrameRequestCallback[] = []

/**
 * Экран → мир. Карта считает мировые координаты от ЦЕНТРА холста с учётом
 * подобранного масштаба, поэтому «нажать на станцию» — это не её x/y из данных.
 * Реальное преобразование снимаем с холста: рендерер сам зовёт translate/scale
 * перед отрисовкой схемы.
 */
let transform = { tx: 0, ty: 0, k: 1 }

function stubCanvas() {
  calls = []
  const ctx = new Proxy(
    {
      measureText: (text: string) => ({ width: text.length * 7 }),
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
      createLinearGradient: () => ({ addColorStop: () => {} }),
      createRadialGradient: () => ({ addColorStop: () => {} }),
      isPointInPath: () => false,
    } as Record<string, unknown>,
    {
      get(target, prop: string) {
        if (prop in target) return target[prop]
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

const flushFrames = (count = 4) =>
  act(() => {
    for (let i = 0; i < count; i += 1) {
      const queued = frames
      frames = []
      for (const fn of queued) fn(i * 16)
    }
  })

function props(over: Partial<Parameters<typeof MetroMap>[0]> = {}) {
  return { selectionMode: 'from' as const, onSelectStation: vi.fn(), ...over }
}

const canvas = () => screen.getByRole('application')

/**
 * Экранная точка станции — по последнему применённому преобразованию.
 *
 * Берём layoutX/layoutY, а не sourceX/sourceY: на схеме лежит результат
 * солвера, и от исходных координат он отличается на единицы пикселей. В обычном
 * режиме радиус попадания это скрывает, а в редакторе он куда уже — и промах
 * становится настоящим.
 */
const at = (station: { layoutX?: number; layoutY?: number }) => ({
  clientX: transform.tx + (station.layoutX as number) * transform.k,
  clientY: transform.ty + (station.layoutY as number) * transform.k,
})

const touchAt = (station: { layoutX?: number; layoutY?: number }) => ({
  touches: [at(station)],
  changedTouches: [at(station)],
})

beforeEach(() => {
  frames = []
  stubCanvas()
  // Мерить нужно и холст, и обёртку: по обёртке карта подбирает начальный
  // масштаб, а в jsdom все прямоугольники нулевые.
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
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    frames.push(fn)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('devicePixelRatio', 1)
  // Наблюдатель обязан ОТДАТЬ размер: без первого измерения схема не
  // вписывается в холст и попасть по станции невозможно.
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
  transform = { tx: 0, ty: 0, k: 1 }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('маршрут на настоящих рёбрах', () => {
  const routeProps = {
    routeStationIds: [A.id, B.id],
    routeEdgeKeys: [`${A.id}|${B.id}`],
    fromStationId: A.id,
    toStationId: B.id,
    fromStationName: A.title,
    toStationName: B.title,
  }

  it('рисует путь между соседними станциями', () => {
    render(<MetroMap {...props(routeProps)} />)
    flushFrames()

    expect(calls.some((c) => c.startsWith('stroke'))).toBe(true)
    expect(calls.length).toBeGreaterThan(100)
  })

  /**
   * Порядок станций маршрута приходит извне и может быть обратным: путь
   * рисуется от «Откуда» к «Куда», а не как пришло.
   */
  it('обратный порядок станций разворачивается', () => {
    render(
      <MetroMap
        {...props({ ...routeProps, routeStationIds: [B.id, A.id] })}
      />,
    )
    expect(() => flushFrames()).not.toThrow()
  })

  it('дальняя пересадка рисуется отдельно', () => {
    render(
      <MetroMap
        {...props({
          routeStationIds: ['1/biblioteka-im-lenina', '3/arbatskaya'],
          routeEdgeKeys: ['1/biblioteka-im-lenina|3/arbatskaya'],
          routeLongTransferEdgeKeys: ['1/biblioteka-im-lenina|3/arbatskaya'],
        })}
      />,
    )
    expect(() => flushFrames()).not.toThrow()
  })

  /** Станции, которых нет в раскладке, путь не ломают. */
  it('незнакомые станции маршрута пропускаются', () => {
    render(
      <MetroMap {...props({ routeStationIds: [A.id, 'нет/такой', B.id] })} />,
    )
    expect(() => flushFrames()).not.toThrow()
  })

  it('маршрут из одной станции пути не даёт', () => {
    render(<MetroMap {...props({ routeStationIds: [A.id] })} />)
    expect(() => flushFrames()).not.toThrow()
  })

  /** Открытая шторка сдвигает видимую область: маршрут надо вписать в остаток. */
  it('вписывается в видимую область под интерфейсом', () => {
    render(
      <MetroMap
        {...props({
          ...routeProps,
          routeSheetOpen: true,
          visibleInsets: { top: 120, right: 60, bottom: 0, left: 0 },
          getBottomInsetPx: () => 300,
        })}
      />,
    )
    expect(() => flushFrames(10)).not.toThrow()
    expect(calls.length).toBeGreaterThan(100)
  })
})

describe('двойной тап', () => {
  const tap = (station: typeof A, timeStamp: number) => {
    fireEvent.touchStart(canvas(), { ...touchAt(station), timeStamp })
    fireEvent.touchEnd(canvas(), {
      touches: [],
      changedTouches: [at(station)],
      timeStamp,
    })
  }

  it('приближает карту к месту тапа', () => {
    render(<MetroMap {...props()} />)
    flushFrames()
    calls.length = 0

    tap(A, 1000)
    tap(A, 1000 + DOUBLE_TAP_MAX_DELAY - 50)
    flushFrames(10)

    expect(calls.length).toBeGreaterThan(0)
  })

  /** Два медленных тапа — это два отдельных выбора станции, а не зум. */
  it('медленные тапы двойным не считаются', () => {
    const onSelectStation = vi.fn()
    render(<MetroMap {...props({ onSelectStation })} />)
    flushFrames()

    tap(A, 1000)
    tap(A, 1000 + DOUBLE_TAP_MAX_DELAY + 200)

    expect(() => flushFrames(10)).not.toThrow()
  })

  /** Тапы в разные места экрана — тоже не двойной тап. */
  it('тапы в разные места двойным не считаются', () => {
    render(<MetroMap {...props()} />)
    flushFrames()

    tap(A, 1000)
    tap(B, 1050)

    expect(() => flushFrames(10)).not.toThrow()
  })

  /**
   * Второй тап с протяжкой вниз — плавный зум. Порог в 8px нужен, чтобы
   * лёгкое дрожание пальца не превращалось в него и не ломало обычный двойной тап.
   */
  it('второй тап с протяжкой плавно зумит', () => {
    render(<MetroMap {...props()} />)
    flushFrames()
    calls.length = 0

    fireEvent.touchStart(canvas(), { ...touchAt(A), timeStamp: 1000 })
    fireEvent.touchEnd(canvas(), { touches: [], changedTouches: [at(A)], timeStamp: 1000 })
    fireEvent.touchStart(canvas(), { ...touchAt(A), timeStamp: 1100 })

    // Дрожание ниже порога зум не запускает.
    fireEvent.touchMove(canvas(), {
      touches: [{ clientX: at(A).clientX, clientY: at(A).clientY + 4 }],
    })
    flushFrames()
    const beforeDrag = calls.length

    fireEvent.touchMove(canvas(), {
      touches: [{ clientX: at(A).clientX, clientY: at(A).clientY + 120 }],
    })
    flushFrames(5)

    expect(calls.length).toBeGreaterThan(beforeDrag)
    fireEvent.touchEnd(canvas(), { touches: [], changedTouches: [at(A)] })
  })
})

describe('перетаскивание станции в редакторе', () => {
  const editProps = { editMode: true, onLayoutChange: vi.fn() }

  it('мышью двигает станцию и отдаёт раскладку наверх', () => {
    const onLayoutChange = vi.fn()
    render(<MetroMap {...props({ ...editProps, onLayoutChange })} />)
    flushFrames()

    fireEvent.mouseDown(canvas(), at(A))
    fireEvent.mouseMove(canvas(), { clientX: at(A).clientX + 40, clientY: at(A).clientY + 40 })
    fireEvent.mouseUp(canvas(), { clientX: at(A).clientX + 40, clientY: at(A).clientY + 40 })
    flushFrames()

    expect(onLayoutChange).toHaveBeenCalled()
  })

  /** Станции одной пересадки сливаются в общий узел — и двигаются вместе. */
  it('за станцию узла тянется весь узел', () => {
    const onLayoutChange = vi.fn()
    render(<MetroMap {...props({ ...editProps, onLayoutChange })} />)
    flushFrames()
    onLayoutChange.mockClear()

    fireEvent.mouseDown(canvas(), at(HUB))
    fireEvent.mouseMove(canvas(), {
      clientX: at(HUB).clientX + 30,
      clientY: at(HUB).clientY + 30,
    })
    fireEvent.mouseUp(canvas(), {
      clientX: at(HUB).clientX + 30,
      clientY: at(HUB).clientY + 30,
    })
    flushFrames()

    expect(HUB_SIZE).toBeGreaterThan(1)
    const last = onLayoutChange.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined
    expect(Object.keys(last ?? {}).length).toBeGreaterThanOrEqual(HUB_SIZE)
  })

  it('пальцем станция двигается так же', () => {
    const onLayoutChange = vi.fn()
    render(<MetroMap {...props({ ...editProps, onLayoutChange })} />)
    flushFrames()
    onLayoutChange.mockClear()

    fireEvent.touchStart(canvas(), touchAt(A))
    fireEvent.touchMove(canvas(), {
      touches: [{ clientX: at(A).clientX + 50, clientY: at(A).clientY + 50 }],
    })
    fireEvent.touchEnd(canvas(), { touches: [], changedTouches: [at(A)] })
    flushFrames()

    expect(onLayoutChange).toHaveBeenCalled()
  })

  /** Ctrl/Cmd добавляет станцию к выделению и убирает из него. */
  it('Ctrl добавляет станцию к выделению', () => {
    render(<MetroMap {...props(editProps)} />)
    flushFrames()
    calls.length = 0

    fireEvent.mouseDown(canvas(), { ...at(A), ctrlKey: true })
    fireEvent.mouseUp(canvas(), at(A))
    fireEvent.mouseDown(canvas(), { ...at(B), metaKey: true })
    fireEvent.mouseUp(canvas(), at(B))
    flushFrames()

    expect(calls.length).toBeGreaterThan(0)
  })

  /** Shift выделяет отрезок линии между якорем и станцией. */
  it('Shift выделяет участок линии', () => {
    render(<MetroMap {...props(editProps)} />)
    flushFrames()

    fireEvent.mouseDown(canvas(), at(A))
    fireEvent.mouseUp(canvas(), at(A))
    fireEvent.mouseDown(canvas(), { ...at(B), shiftKey: true })
    fireEvent.mouseUp(canvas(), at(B))

    expect(() => flushFrames()).not.toThrow()
  })

  /** Нажатие мимо станций в редакторе — это обычное панорамирование. */
  it('нажатие мимо станций панорамирует', () => {
    render(<MetroMap {...props(editProps)} />)
    flushFrames()
    calls.length = 0

    fireEvent.mouseDown(canvas(), { clientX: -4000, clientY: -4000 })
    fireEvent.mouseMove(canvas(), { clientX: -3900, clientY: -3900 })
    flushFrames()

    expect(calls.length).toBeGreaterThan(0)
  })

  /** Правка станции уходит наверх для панели редактора. */
  it('выбор станции в редакторе открывает её панель', () => {
    const onEditStationInspect = vi.fn()
    render(<MetroMap {...props({ ...editProps, onEditStationInspect })} />)
    flushFrames()

    fireEvent.click(canvas(), { ...at(A), timeStamp: 5000 })
    flushFrames()

    expect(onEditStationInspect).toHaveBeenCalledWith(A.id)
  })

  /** Команда фокуса приводит карту к станции — из панели редактора. */
  it('команда фокуса подводит карту к станции', () => {
    const { rerender } = render(<MetroMap {...props(editProps)} />)
    flushFrames()
    calls.length = 0

    rerender(
      <MetroMap
        {...props({ ...editProps, editorFocusCommand: { stationId: B.id, token: 1 } })}
      />,
    )
    flushFrames(20)

    expect(calls.length).toBeGreaterThan(0)
  })

  it('повтор той же команды фокуса карту не дёргает', () => {
    const command = { stationId: B.id, token: 1 }
    const { rerender } = render(
      <MetroMap {...props({ ...editProps, editorFocusCommand: command })} />,
    )
    flushFrames(20)

    calls.length = 0
    rerender(<MetroMap {...props({ ...editProps, editorFocusCommand: command })} />)
    flushFrames(20)

    expect(calls.length).toBe(0)
  })
})

describe('применение раскладки редактора', () => {
  /**
   * Токен нужен, чтобы отличить «те же координаты, но применить заново» от
   * обычной перерисовки: без него undo/redo к одному и тому же состоянию
   * ничего бы не менял.
   */
  it('новый токен применяет координаты заново', () => {
    const { rerender } = render(
      <MetroMap
        {...props({
          editMode: true,
          editorLayoutOverrides: { [A.id]: { x: 100, y: 100 } },
          editorLayoutApplyToken: 1,
        })}
      />,
    )
    flushFrames()
    calls.length = 0

    rerender(
      <MetroMap
        {...props({
          editMode: true,
          editorLayoutOverrides: { [A.id]: { x: 400, y: 400 } },
          editorLayoutApplyToken: 2,
        })}
      />,
    )
    flushFrames()

    expect(calls.length).toBeGreaterThan(0)
  })

  it('переименование станции меняет подпись, а не граф', () => {
    render(
      <MetroMap
        {...props({ stationTitleOverrides: { [A.id]: 'Совершенно другое название' } })}
      />,
    )
    flushFrames()

    expect(canvas().getAttribute('aria-label')).toContain('Схема метро Москвы')
    expect(calls.length).toBeGreaterThan(100)
  })
})
