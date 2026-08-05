// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fullGraphStations } from '../metro/fullGraph.ts'
import { MetroMap } from './MetroMap.tsx'

afterEach(cleanup)

/**
 * Каждый тест прогоняет весь конвейер отрисовки: 304 станции, 386 рёбер и
 * раскладка подписей. Под инструментацией покрытия это уходит за стандартные
 * пять секунд, и файл падал по таймауту только в `test:unit`.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

/** Размер холста в разметке — по нему считаются мировые координаты. */
const VIEWBOX = 1000

/**
 * Канвас в jsdom не рисует: getContext возвращает null, и весь конвейер
 * отрисовки молча не исполняется. Подменяем контекст болванкой, которая
 * принимает любые вызовы и умеет мерить текст — иначе раскладка подписей
 * делит на ширину, которой нет.
 */
function stubCanvas() {
  const calls: string[] = []
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

  return { ctx, calls }
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

let frames: FrameRequestCallback[] = []
const flushFrames = (count = 4) =>
  act(() => {
    for (let i = 0; i < count; i += 1) {
      const queued = frames
      frames = []
      for (const fn of queued) fn(i * 16)
    }
  })

function props(over: Partial<Parameters<typeof MetroMap>[0]> = {}) {
  return {
    selectionMode: 'from' as const,
    onSelectStation: vi.fn(),
    ...over,
  }
}

const canvas = () => screen.getByRole('application')
const announcement = () => screen.getByRole('status').textContent

let calls: string[]

/**
 * Экран → мир. Карта считает мировые координаты от ЦЕНТРА холста с учётом
 * подобранного масштаба, поэтому «кликнуть по станции» — это не её x/y из
 * данных. Реальное преобразование снимаем с холста: рендерер сам зовёт
 * translate/scale перед отрисовкой схемы.
 */
let transform = { tx: 0, ty: 0, k: 1 }

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

beforeEach(() => {
  frames = []
  ;({ calls } = stubCanvas())
  stubRects()
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
  transform = { tx: 0, ty: 0, k: 1 }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('разметка схемы', () => {
  /**
   * Холстов два: на основном линии и станции, на верхнем — подписи. Второй
   * скрыт от скринридера: он дублирует то, что уже сказано текстовой
   * альтернативой.
   */
  it('рисует холст схемы и холст подписей', () => {
    const { container } = render(<MetroMap {...props()} />)

    const canvases = container.querySelectorAll('canvas')
    expect(canvases).toHaveLength(2)
    expect(canvases[1].getAttribute('aria-hidden')).toBe('true')
  })

  it('режим выбора виден в разметке — от него зависит подсветка', () => {
    const { container, rerender } = render(<MetroMap {...props()} />)
    expect(container.querySelector('.metro-map-wrapper')?.getAttribute('data-selection-mode')).toBe(
      'from',
    )

    rerender(<MetroMap {...props({ selectionMode: 'to' })} />)
    expect(container.querySelector('.metro-map-wrapper')?.getAttribute('data-selection-mode')).toBe(
      'to',
    )
  })

  /** Собственно отрисовка: без неё канвас остался бы пустым прямоугольником. */
  it('что-то рисует на холсте', () => {
    render(<MetroMap {...props()} />)
    flushFrames()

    expect(calls.length).toBeGreaterThan(100)
    expect(calls.some((c) => c.startsWith('stroke'))).toBe(true)
    expect(calls.some((c) => c.startsWith('arc'))).toBe(true)
  })
})

/**
 * A11Y-1. Canvas для скринридера — пустое место. Даём ему роль, имя, описание,
 * фокусируемость и «курсор» по станциям.
 */
describe('текстовая альтернатива', () => {
  it('схема представлена как интерактивное приложение', () => {
    render(<MetroMap {...props()} />)

    expect(canvas().getAttribute('aria-roledescription')).toBe('Интерактивная схема метро')
    expect(canvas().getAttribute('tabindex')).toBe('0')
  })

  it('описание перечисляет размер схемы и способ управления', () => {
    render(<MetroMap {...props()} />)

    const hint = document.getElementById(canvas().getAttribute('aria-describedby')!)!
    expect(hint.textContent).toContain(`${fullGraphStations.length} станций`)
    expect(hint.textContent).toContain('стрелки переводят')
    expect(hint.textContent).toContain('Откуда')
  })

  it('описание меняет пример под текущий режим выбора', () => {
    const { rerender } = render(<MetroMap {...props({ selectionMode: 'to' })} />)
    const hintId = canvas().getAttribute('aria-describedby')!
    expect(document.getElementById(hintId)!.textContent).toContain('станцию как «Куда»')

    rerender(<MetroMap {...props({ selectionMode: 'from' })} />)
    expect(document.getElementById(hintId)!.textContent).toContain('станцию как «Откуда»')
  })

  it('имя схемы сообщает, что уже выбрано', () => {
    const { rerender } = render(<MetroMap {...props()} />)
    expect(canvas().getAttribute('aria-label')).toContain('откуда: не выбрано')
    expect(canvas().getAttribute('aria-label')).toContain('куда: не выбрано')

    rerender(
      <MetroMap
        {...props({ fromStationName: 'Арбатская', toStationName: 'Китай-город' })}
      />,
    )
    expect(canvas().getAttribute('aria-label')).toContain('откуда: Арбатская')
    expect(canvas().getAttribute('aria-label')).toContain('куда: Китай-город')
  })

  it('имя схемы сообщает и о построенном маршруте', () => {
    render(
      <MetroMap
        {...props({ routeStationIds: fullGraphStations.slice(0, 5).map((s) => s.id) })}
      />,
    )
    expect(canvas().getAttribute('aria-label')).toContain('построен маршрут из 5 станций')
  })
})

describe('клавиатурная навигация', () => {
  /** Без входной станции стрелки некуда двигать: курсор ставится по фокусу. */
  it('фокус ставит курсор на станцию и называет её', () => {
    render(<MetroMap {...props()} />)

    fireEvent.focus(canvas())
    expect(announcement()).toBeTruthy()
    expect(canvas().getAttribute('aria-label')).toContain('выбор на станции')
  })

  it('стрелки переводят курсор на соседнюю станцию', () => {
    render(<MetroMap {...props()} />)
    fireEvent.focus(canvas())
    const first = announcement()

    fireEvent.keyDown(canvas(), { key: 'ArrowRight' })
    fireEvent.keyDown(canvas(), { key: 'ArrowRight' })
    expect(announcement()).not.toBe(first)
  })

  it.each(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])(
    'стрелка %s отменяет прокрутку страницы',
    (key) => {
      render(<MetroMap {...props()} />)
      fireEvent.focus(canvas())

      const handled = fireEvent.keyDown(canvas(), { key })
      expect(handled).toBe(false)
    },
  )

  /**
   * Раньше здесь безусловно сообщался успех — даже когда выбор вообще не
   * доходил до полей. Объявляем то, что случилось на самом деле.
   */
  it.each([
    ['from', 'выбрана как «Откуда»'],
    ['to', 'выбрана как «Куда»'],
    ['ask', 'оба поля заняты'],
  ] as const)('исход выбора %s объявляется своими словами', (outcome, expected) => {
    const onSelectStation = vi.fn(() => outcome)
    render(<MetroMap {...props({ onSelectStation })} />)

    fireEvent.focus(canvas())
    fireEvent.keyDown(canvas(), { key: 'Enter' })

    expect(onSelectStation).toHaveBeenCalled()
    expect(announcement()).toContain(expected)
  })

  it('пробел выбирает станцию так же, как Enter', () => {
    const onSelectStation = vi.fn(() => 'from' as const)
    render(<MetroMap {...props({ onSelectStation })} />)

    fireEvent.focus(canvas())
    fireEvent.keyDown(canvas(), { key: ' ' })
    expect(onSelectStation).toHaveBeenCalledTimes(1)
  })

  /** Enter без курсора выбирать нечего — и падать тут нельзя. */
  it('Enter без курсора ничего не выбирает', () => {
    const onSelectStation = vi.fn()
    render(<MetroMap {...props({ onSelectStation })} />)

    fireEvent.keyDown(canvas(), { key: 'Enter' })
    expect(onSelectStation).not.toHaveBeenCalled()
  })

  it.each(['+', '=', '-', '_'])('клавиша %s меняет масштаб', (key) => {
    render(<MetroMap {...props()} />)
    flushFrames()
    calls.length = 0

    const handled = fireEvent.keyDown(canvas(), { key })
    flushFrames()

    expect(handled).toBe(false)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('посторонние клавиши схему не трогают', () => {
    const onSelectStation = vi.fn()
    render(<MetroMap {...props({ onSelectStation })} />)
    fireEvent.focus(canvas())

    const handled = fireEvent.keyDown(canvas(), { key: 'a' })
    expect(handled).toBe(true)
    expect(onSelectStation).not.toHaveBeenCalled()
  })

  it('уход фокуса снимает клавиатурную подсветку', () => {
    render(<MetroMap {...props()} />)
    fireEvent.focus(canvas())
    expect(canvas().getAttribute('aria-label')).toContain('выбор на станции')

    fireEvent.blur(canvas())
    flushFrames()
    // Курсор остаётся, чтобы вернуться на то же место, но подсветка снята.
    expect(calls.length).toBeGreaterThan(0)
  })

  /** Вернувшись, фокус обязан назвать ту станцию, на которой курсор остался. */
  it('повторный фокус называет прежнюю станцию', () => {
    render(<MetroMap {...props()} />)
    fireEvent.focus(canvas())
    fireEvent.keyDown(canvas(), { key: 'ArrowRight' })
    const parked = announcement()

    fireEvent.blur(canvas())
    fireEvent.focus(canvas())
    expect(announcement()).toBe(parked)
  })

  /** Уже выбранная станция — не отказ приложения, и сказать надо именно это. */
  it('повторный выбор той же станции объясняется', () => {
    const onSelectStation = vi.fn(() => 'noop' as const)
    render(<MetroMap {...props({ onSelectStation })} />)

    fireEvent.focus(canvas())
    fireEvent.keyDown(canvas(), { key: 'Enter' })
    expect(announcement()).toBeTruthy()
  })
})

describe('выбор станции мышью', () => {
  const STATION = fullGraphStations.find((s) => s.id === '5/novoslobodskaya')!

  const clickAtStation = (timeStamp = 5000) => {
    fireEvent.click(canvas(), { ...at(STATION), timeStamp })
  }

  it('клик мимо станций ничего не выбирает', () => {
    const onSelectStation = vi.fn()
    render(<MetroMap {...props({ onSelectStation })} />)
    flushFrames()

    fireEvent.click(canvas(), { clientX: -5000, clientY: -5000, timeStamp: 5000 })
    expect(onSelectStation).not.toHaveBeenCalled()
  })

  it('клик по станции отдаёт её наверх вместе с точкой', () => {
    const onSelectStation = vi.fn()
    render(<MetroMap {...props({ onSelectStation })} />)
    flushFrames()

    clickAtStation()

    expect(onSelectStation).toHaveBeenCalledTimes(1)
    const [id, name, point] = onSelectStation.mock.calls[0]
    expect(id).toBe(STATION.id)
    expect(name).toBe(STATION.title)
    expect(point).toMatchObject({ x: expect.any(Number), y: expect.any(Number) })
  })

  /**
   * Тап пальцем приходит и как touchend, и как click. Второй обязан быть
   * съеден, иначе одно касание выбирает станцию дважды.
   */
  it('касание не выбирает станцию дважды', () => {
    const onSelectStation = vi.fn()
    render(<MetroMap {...props({ onSelectStation })} />)
    flushFrames()

    const point = at(STATION)
    fireEvent.touchStart(canvas(), { touches: [point], timeStamp: 4000 })
    fireEvent.touchEnd(canvas(), { touches: [], changedTouches: [point], timeStamp: 4050 })
    clickAtStation(4100)

    expect(onSelectStation).toHaveBeenCalledTimes(1)
  })

  /** Перетаскивание карты не должно заканчиваться выбором станции под пальцем. */
  it('после перетаскивания клик не выбирает', () => {
    const onSelectStation = vi.fn()
    render(<MetroMap {...props({ onSelectStation })} />)
    flushFrames()

    fireEvent.mouseDown(canvas(), { clientX: 500, clientY: 500 })
    fireEvent.mouseMove(canvas(), { clientX: 300, clientY: 300 })
    fireEvent.mouseMove(canvas(), { clientX: 100, clientY: 100 })
    fireEvent.mouseUp(canvas(), { clientX: 100, clientY: 100 })
    clickAtStation()

    expect(onSelectStation).not.toHaveBeenCalled()
  })
})

describe('панорамирование', () => {
  it('перетаскивание мышью двигает схему', () => {
    render(<MetroMap {...props()} />)
    flushFrames()
    calls.length = 0

    fireEvent.mouseDown(canvas(), { clientX: 500, clientY: 500 })
    fireEvent.mouseMove(canvas(), { clientX: 400, clientY: 420 })
    flushFrames()

    expect(calls.length).toBeGreaterThan(0)
  })

  /**
   * Курсор ушёл за пределы холста — жест обязан закончиться там же, иначе
   * схема продолжит ездить за мышью, которой на ней уже нет. Доигрывающая
   * инерция это не отменяет: она сама останавливается.
   */
  it('уход курсора за холст завершает жест', () => {
    render(<MetroMap {...props()} />)
    flushFrames()

    fireEvent.mouseDown(canvas(), { clientX: 500, clientY: 500 })
    fireEvent.mouseMove(canvas(), { clientX: 400, clientY: 400 })
    fireEvent.mouseLeave(canvas())

    // Инерция доигрывает и сама перестаёт запрашивать кадры.
    flushFrames(200)
    expect(frames).toHaveLength(0)

    // Дальше движение мыши схему уже не тащит.
    calls.length = 0
    fireEvent.mouseMove(canvas(), { clientX: 100, clientY: 100 })
    flushFrames()
    expect(calls.length).toBe(0)
  })

  it('движение без нажатой кнопки схему не двигает', () => {
    render(<MetroMap {...props()} />)
    flushFrames()
    calls.length = 0

    fireEvent.mouseMove(canvas(), { clientX: 100, clientY: 100 })
    flushFrames()
    expect(calls.length).toBe(0)
  })

  it('перетаскивание пальцем работает так же', () => {
    render(<MetroMap {...props()} />)
    flushFrames()
    calls.length = 0

    fireEvent.touchStart(canvas(), { touches: [{ clientX: 500, clientY: 500 }] })
    fireEvent.touchMove(canvas(), { touches: [{ clientX: 420, clientY: 460 }] })
    flushFrames()
    fireEvent.touchEnd(canvas(), { touches: [], changedTouches: [{ clientX: 420, clientY: 460 }] })

    expect(calls.length).toBeGreaterThan(0)
  })

  it('прерванное касание не оставляет схему в жесте', () => {
    render(<MetroMap {...props()} />)
    flushFrames()

    fireEvent.touchStart(canvas(), { touches: [{ clientX: 500, clientY: 500 }] })
    fireEvent.touchCancel(canvas(), { touches: [] })

    calls.length = 0
    fireEvent.touchMove(canvas(), { touches: [{ clientX: 100, clientY: 100 }] })
    flushFrames()
    expect(calls.length).toBe(0)
  })

  /** Щипок двумя пальцами — масштаб, а не панорамирование. */
  it('щипок двумя пальцами меняет масштаб', () => {
    render(<MetroMap {...props()} />)
    flushFrames()
    calls.length = 0

    fireEvent.touchStart(canvas(), {
      touches: [
        { clientX: 400, clientY: 500 },
        { clientX: 600, clientY: 500 },
      ],
    })
    fireEvent.touchMove(canvas(), {
      touches: [
        { clientX: 300, clientY: 500 },
        { clientX: 700, clientY: 500 },
      ],
    })
    flushFrames()

    expect(calls.length).toBeGreaterThan(0)
  })
})

describe('кнопки масштаба', () => {
  const zoomIn = () => screen.getByRole('button', { name: 'Приблизить карту' })
  const zoomOut = () => screen.getByRole('button', { name: 'Отдалить карту' })

  it('обе кнопки подписаны', () => {
    render(<MetroMap {...props()} />)
    expect(zoomIn()).toBeTruthy()
    expect(zoomOut()).toBeTruthy()
  })

  it('нажатие приближает', () => {
    render(<MetroMap {...props()} />)
    flushFrames()
    calls.length = 0

    fireEvent.click(zoomIn())
    flushFrames(10)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('нажатие отдаляет', () => {
    render(<MetroMap {...props()} />)
    flushFrames()
    calls.length = 0

    fireEvent.click(zoomOut())
    flushFrames(10)
    expect(calls.length).toBeGreaterThan(0)
  })

  /** Непрерывный зум начинается не сразу: 180 мс отличают удержание от клика. */
  const HOLD_DELAY_MS = 180

  it('удержание зумит непрерывно', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
    render(<MetroMap {...props()} />)
    flushFrames()
    calls.length = 0

    fireEvent.mouseDown(zoomIn())
    // До порога это ещё обычный клик, а не удержание.
    act(() => {
      vi.advanceTimersByTime(HOLD_DELAY_MS - 1)
    })
    flushFrames(5)
    expect(calls.length).toBe(0)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    flushFrames(10)
    expect(calls.length).toBeGreaterThan(0)

    fireEvent.mouseUp(zoomIn())
    vi.useRealTimers()
  })

  it('удержание пальцем тоже', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
    render(<MetroMap {...props()} />)
    flushFrames()
    calls.length = 0

    fireEvent.touchStart(zoomOut())
    act(() => {
      vi.advanceTimersByTime(HOLD_DELAY_MS)
    })
    flushFrames(10)
    expect(calls.length).toBeGreaterThan(0)

    fireEvent.touchEnd(zoomOut())
    vi.useRealTimers()
  })

  /** Клик, завершивший удержание, не должен добавлять ещё один шаг зума. */
  it('после удержания клик лишнего шага не делает', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
    render(<MetroMap {...props()} />)
    flushFrames()

    fireEvent.mouseDown(zoomIn())
    act(() => {
      vi.advanceTimersByTime(HOLD_DELAY_MS)
    })
    flushFrames(10)
    fireEvent.mouseUp(zoomIn())

    calls.length = 0
    fireEvent.click(zoomIn())
    flushFrames(5)
    expect(calls.length).toBe(0)
    vi.useRealTimers()
  })

  it('уход курсора с кнопки останавливает удержание', () => {
    render(<MetroMap {...props()} />)
    flushFrames()

    fireEvent.mouseDown(zoomIn())
    fireEvent.mouseLeave(zoomIn())
    expect(() => flushFrames(10)).not.toThrow()
  })

  it('сообщает наверх о взаимодействии со схемой', () => {
    const onMapInteraction = vi.fn()
    render(<MetroMap {...props({ onMapInteraction })} />)
    flushFrames()

    fireEvent.click(zoomIn())
    expect(onMapInteraction).toHaveBeenCalled()
  })
})

describe('колесо мыши', () => {
  /**
   * Слушатель ставится вручную с passive: false — иначе браузер не даёт
   * отменить прокрутку страницы, и колесо над схемой листало бы её.
   */
  it('масштабирует схему и не листает страницу', () => {
    render(<MetroMap {...props()} />)
    flushFrames()
    calls.length = 0

    const event = new Event('wheel', { cancelable: true, bubbles: true })
    Object.assign(event, { deltaY: -240, clientX: 500, clientY: 500 })
    act(() => {
      canvas().dispatchEvent(event)
    })
    flushFrames(10)

    expect(event.defaultPrevented).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
  })
})

describe('маршрут на схеме', () => {
  const routeIds = fullGraphStations.slice(0, 6).map((s) => s.id)

  it('подсвечивает станции маршрута', () => {
    const { rerender } = render(<MetroMap {...props()} />)
    flushFrames()
    const plain = calls.length

    calls.length = 0
    rerender(<MetroMap {...props({ routeStationIds: routeIds })} />)
    flushFrames()

    expect(calls.length).toBeGreaterThan(0)
    expect(plain).toBeGreaterThan(0)
  })

  it('рисует рёбра маршрута и дальние переходы', () => {
    render(
      <MetroMap
        {...props({
          routeStationIds: routeIds,
          routeEdgeKeys: [`${routeIds[0]}|${routeIds[1]}`],
          routeLongTransferEdgeKeys: [`${routeIds[1]}|${routeIds[2]}`],
        })}
      />,
    )
    flushFrames()

    expect(calls.some((c) => c.startsWith('stroke'))).toBe(true)
  })

  it('выбранные станции отмечаются на схеме', () => {
    render(
      <MetroMap
        {...props({
          fromStationId: fullGraphStations[0].id,
          toStationId: fullGraphStations[10].id,
          fromStationName: fullGraphStations[0].title,
          toStationName: fullGraphStations[10].title,
        })}
      />,
    )
    flushFrames()

    expect(calls.length).toBeGreaterThan(100)
  })
})

describe('готовность схемы', () => {
  /** По этому сигналу снимается заставка: без него UI ждал бы страховочный таймаут. */
  it('сообщает наверх, что viewport готов', () => {
    const onInitialViewportReady = vi.fn()
    render(<MetroMap {...props({ onInitialViewportReady })} />)
    flushFrames(10)

    expect(onInitialViewportReady).toHaveBeenCalled()
  })

  /** Сигнал одноразовый: заставку снимают один раз, а перерисовок — сотни. */
  it('о готовности сообщает ровно один раз', () => {
    const onInitialViewportReady = vi.fn()
    const { rerender } = render(<MetroMap {...props({ onInitialViewportReady })} />)
    flushFrames(10)

    rerender(
      <MetroMap
        {...props({ onInitialViewportReady, routeStationIds: [fullGraphStations[0].id] })}
      />,
    )
    flushFrames(10)

    expect(onInitialViewportReady).toHaveBeenCalledTimes(1)
  })
})

describe('режим редактора', () => {
  it('отладка коллизий подписей не роняет отрисовку', () => {
    render(<MetroMap {...props({ editMode: true, collisionDebug: true })} />)
    expect(() => flushFrames()).not.toThrow()
    expect(calls.length).toBeGreaterThan(0)
  })

  it('переименование станции применяется без пересборки графа', () => {
    const id = fullGraphStations[0].id
    render(
      <MetroMap {...props({ stationTitleOverrides: { [id]: 'Переименованная' } })} />,
    )
    flushFrames()

    expect(calls.length).toBeGreaterThan(0)
  })

  it('правки раскладки применяются', () => {
    const id = fullGraphStations[0].id
    const { rerender } = render(<MetroMap {...props()} />)
    flushFrames()

    rerender(
      <MetroMap
        {...props({
          editMode: true,
          editorLayoutOverrides: { [id]: { x: 100, y: 100 } },
          editorLayoutApplyToken: 1,
        })}
      />,
    )
    expect(() => flushFrames()).not.toThrow()
  })
})

describe('снятие схемы', () => {
  it('висящих кадров и подписок не оставляет', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(<MetroMap {...props()} />)
    flushFrames()

    unmount()
    expect(() => flushFrames(5)).not.toThrow()
    remove.mockRestore()
  })
})
