// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useBottomSheet } from './useBottomSheet.ts'

/** Сколько нужно протащить шторку, чтобы она осталась там, куда её тянут. */
const SHEET_COMMIT_PX = 64

/** Геометрия стенда: минимальная часть 100px, детали 400px, экран 800px. */
const MIN_HEIGHT = 100
const DETAILS_HEIGHT = 400
const VIEWPORT_HEIGHT = 800
/** openHeight = 100 + 400 = 500, значит ход шторки — ровно 400px. */
const OPEN_HEIGHT = MIN_HEIGHT + DETAILS_HEIGHT
const DRAG_RANGE = OPEN_HEIGHT - MIN_HEIGHT

/** Очередь rAF под ручным управлением: физика шторки живёт именно в кадрах. */
let frames: Array<(ts: number) => void> = []
let now = 0

function runFrames(count: number) {
  act(() => {
    for (let i = 0; i < count; i += 1) {
      const queued = frames
      frames = []
      now += 16
      for (const fn of queued) fn(now)
    }
  })
}

/** Догнать пружину до покоя: она сама перестаёт запрашивать кадры. */
const settle = () => runFrames(200)

type Refs = {
  sheetRef: React.RefObject<HTMLDivElement | null>
  minVisibleRef: React.RefObject<HTMLDivElement | null>
  detailsRef: React.RefObject<HTMLDivElement | null>
}

/** Разметка шторки: её владелец — App, хук только измеряет и двигает. */
function buildDom(detailsHeight = DETAILS_HEIGHT): Refs {
  const sheet = document.createElement('div')
  sheet.className = 'bottom-sheet'

  const inner = document.createElement('div')
  inner.className = 'bottom-sheet-inner'
  sheet.appendChild(inner)

  const minVisible = document.createElement('div')
  minVisible.className = 'bottom-sheet-min-visible'
  Object.defineProperty(minVisible, 'offsetHeight', { value: MIN_HEIGHT, configurable: true })
  inner.appendChild(minVisible)

  const details = document.createElement('div')
  details.className = 'route-details'
  Object.defineProperty(details, 'scrollHeight', { value: detailsHeight, configurable: true })
  inner.appendChild(details)

  const handle = document.createElement('button')
  handle.className = 'bottom-sheet-handle'
  inner.appendChild(handle)

  document.body.appendChild(sheet)

  const sheetRef = createRef<HTMLDivElement>() as React.RefObject<HTMLDivElement | null>
  const minVisibleRef = createRef<HTMLDivElement>() as React.RefObject<HTMLDivElement | null>
  const detailsRef = createRef<HTMLDivElement>() as React.RefObject<HTMLDivElement | null>
  sheetRef.current = sheet
  minVisibleRef.current = minVisible
  detailsRef.current = details

  return { sheetRef, minVisibleRef, detailsRef }
}

type Options = {
  isDesktop: boolean
  isDragDisabled: boolean
  hasRoute: boolean
  contentSignature: string
}

const markPerfInteraction = vi.fn()

function setup(over: Partial<Options> = {}, detailsHeight = DETAILS_HEIGHT) {
  const refs = buildDom(detailsHeight)
  const desktopBottomInsetPxRef = { current: 0 }

  const view = renderHook((props: Options) =>
    useBottomSheet({ ...props, ...refs, desktopBottomInsetPxRef, markPerfInteraction }), {
    initialProps: {
      isDesktop: false,
      isDragDisabled: false,
      hasRoute: true,
      contentSignature: 'маршрут',
      ...over,
    },
  })

  return { ...view, ...refs, desktopBottomInsetPxRef }
}

/** Точка касания: хук читает screenX/screenY и timeStamp. */
const touch = (screenY: number, screenX = 0, target?: Element) =>
  ({
    touches: [{ screenX, screenY }],
    target: target ?? document.querySelector('.bottom-sheet-inner'),
    timeStamp: (now += 16),
  }) as unknown as React.TouchEvent

const handle = () => document.querySelector('.bottom-sheet-handle')!
const sheetEl = () => document.querySelector<HTMLElement>('.bottom-sheet')!

/** Прогресс шторки виден только через её transform: React о нём не знает. */
function progress(): number {
  const m = /translate3d\(0, ([\d.-]+)px, 0\)/.exec(sheetEl().style.transform)
  if (!m) return 0
  return 1 - Number(m[1]) / DRAG_RANGE
}

beforeEach(() => {
  frames = []
  now = 0
  markPerfInteraction.mockClear()
  document.body.innerHTML = ''

  vi.stubGlobal('requestAnimationFrame', (fn: (ts: number) => void) => {
    frames.push(fn)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('innerHeight', VIEWPORT_HEIGHT)
  vi.stubGlobal('visualViewport', undefined)
  vi.stubGlobal(
    'getComputedStyle',
    () =>
      ({
        paddingTop: '0px',
        paddingBottom: '0px',
        marginTop: '0px',
        fontSize: '16px',
      }) as unknown as CSSStyleDeclaration,
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('измерение шторки', () => {
  /**
   * Без измерения высота бралась бы по контенту: шторка вылезала за экран и
   * уносила поля ввода вверх за границу (именно так ломался deep link).
   */
  it('высота считается по минимальной части и деталям', () => {
    setup()
    expect(sheetEl().style.height).toBe(`${OPEN_HEIGHT}px`)
  })

  /** Пустой блок деталей раскрывать не во что — шторка остаётся свёрнутой. */
  it('без содержимого деталей хода нет', () => {
    const { result } = setup({}, 0)

    expect(sheetEl().style.height).toBe(`${MIN_HEIGHT}px`)
    expect(result.current.getBottomInsetPx()).toBe(MIN_HEIGHT)
  })

  /** Потолок — 78% экрана: шторка не имеет права занять его целиком. */
  it('высота ограничена долей экрана', () => {
    setup({}, 5000)
    expect(sheetEl().style.height).toBe(`${VIEWPORT_HEIGHT * 0.78}px`)
  })
})

describe('отступ карты снизу', () => {
  /** Карта по нему решает, где рисовать маршрут, чтобы шторка его не накрыла. */
  it('в свёрнутом состоянии равен минимальной высоте', () => {
    const { result } = setup()
    expect(result.current.getBottomInsetPx()).toBe(MIN_HEIGHT)
  })

  it('растёт вместе с раскрытием', () => {
    const { result } = setup()

    act(() => result.current.setOpen(true))
    settle()

    expect(result.current.getBottomInsetPx()).toBe(OPEN_HEIGHT)
  })

  /** На десктопе физики нет вовсе: отступ считает useMapVisibleInsets. */
  it('на десктопе берётся снаружи', () => {
    const { result, desktopBottomInsetPxRef } = setup({ isDesktop: true })
    desktopBottomInsetPxRef.current = 42

    expect(result.current.getBottomInsetPx()).toBe(42)
  })
})

describe('открытие и закрытие', () => {
  it('на старте шторка свёрнута', () => {
    const { result } = setup()

    expect(result.current.isOpen).toBe(false)
    expect(progress()).toBe(0)
  })

  it('раскрывается до конца', () => {
    const { result } = setup()

    act(() => result.current.setOpen(true))
    expect(result.current.isOpen).toBe(true)

    settle()
    expect(progress()).toBeCloseTo(1, 2)
  })

  it('сворачивается обратно', () => {
    const { result } = setup()
    act(() => result.current.setOpen(true))
    settle()

    act(() => result.current.setOpen(false))
    settle()

    expect(result.current.isOpen).toBe(false)
    expect(progress()).toBeCloseTo(0, 2)
  })

  /** Панель быстрых маршрутов живёт внутри раскрытой шторки. */
  it('закрытие убирает панель быстрых маршрутов', () => {
    const { result } = setup()
    act(() => result.current.setOpen(true))
    act(() => result.current.setSmartSuggestionsOpen(true))
    expect(result.current.isSmartSuggestionsOpen).toBe(true)

    act(() => result.current.setOpen(false))
    expect(result.current.isSmartSuggestionsOpen).toBe(false)
  })

  it('панель быстрых маршрутов сама раскрывает шторку', () => {
    const { result } = setup()

    act(() => result.current.setSmartSuggestionsOpen(true))
    settle()

    expect(result.current.isOpen).toBe(true)
    expect(progress()).toBeCloseTo(1, 2)
  })

  /** Маршрут исчез — раскрывать нечего, шторка обязана уехать вниз. */
  it('исчезнувший маршрут сворачивает шторку', () => {
    const { result, rerender } = setup()
    act(() => result.current.setOpen(true))
    settle()

    rerender({
      isDesktop: false,
      isDragDisabled: false,
      hasRoute: false,
      contentSignature: 'пусто',
    })

    expect(result.current.isOpen).toBe(false)
    expect(progress()).toBe(0)
  })
})

describe('десктопная раскладка', () => {
  /**
   * Инлайновые height и transform ставятся из JS и переживают смену раскладки.
   * Поворот телефона в альбомную ориентацию посреди сессии оставлял боковой
   * панели высоту от нижней шторки и её же сдвиг — панель уезжала вниз.
   */
  it('снимает инлайновую геометрию нижней шторки', () => {
    const { rerender } = setup()
    expect(sheetEl().style.height).toBe(`${OPEN_HEIGHT}px`)

    rerender({
      isDesktop: true,
      isDragDisabled: false,
      hasRoute: true,
      contentSignature: 'маршрут',
    })

    expect(sheetEl().style.height).toBe('')
    expect(sheetEl().style.transform).toBe('')
  })

  it('шторку не двигает', () => {
    const { result } = setup({ isDesktop: true })

    act(() => result.current.setOpen(true))
    settle()

    expect(result.current.isOpen).toBe(true)
    expect(sheetEl().style.transform).toBe('')
  })

  it('жесты не обрабатывает', () => {
    const { result } = setup({ isDesktop: true })

    act(() => result.current.touchHandlers.onTouchStart(touch(500)))
    act(() => result.current.touchHandlers.onTouchMove(touch(200)))

    expect(markPerfInteraction).not.toHaveBeenCalled()
    expect(sheetEl().style.transform).toBe('')
  })
})

describe('перетаскивание', () => {
  const drag = (
    result: { current: ReturnType<typeof useBottomSheet> },
    from: number,
    to: number,
    target?: Element,
  ) => {
    act(() => result.current.touchHandlers.onTouchStart(touch(from, 0, target)))
    act(() => result.current.touchHandlers.onTouchMove(touch(to, 0, target)))
    runFrames(1)
    act(() => result.current.touchHandlers.onTouchEnd())
  }

  /**
   * Ручка — единственное место, где касание не может значить ничего, кроме
   * перетаскивания. Порог там не нужен: пока копятся 12px, прокрутка успевает
   * начаться и становится неотменяемой.
   */
  it('на ручке ось известна сразу, без порога', () => {
    const { result } = setup()

    act(() => result.current.touchHandlers.onTouchStart(touch(500, 0, handle())))
    act(() => result.current.touchHandlers.onTouchMove(touch(496, 0, handle())))
    runFrames(1)

    expect(progress()).toBeGreaterThan(0)
  })

  /**
   * Раньше решало абсолютное положение (`>= 0.5`): чтобы раскрыть шторку с
   * ходом 575px, надо было провести пальцем 288px — треть экрана. Спокойное
   * движение на 80–260px шторка отыгрывала за пальцем и возвращала обратно.
   */
  it('раскрывается коротким движением вверх', () => {
    const { result } = setup()

    drag(result, 500, 500 - SHEET_COMMIT_PX - 10, handle())
    settle()

    expect(result.current.isOpen).toBe(true)
    expect(progress()).toBeCloseTo(1, 2)
  })

  /** Порог симметричен: закрывается таким же коротким движением вниз. */
  it('закрывается коротким движением вниз', () => {
    const { result } = setup()
    act(() => result.current.setOpen(true))
    settle()

    drag(result, 100, 100 + SHEET_COMMIT_PX + 10, handle())
    settle()

    expect(result.current.isOpen).toBe(false)
    expect(progress()).toBeCloseTo(0, 2)
  })

  /** Путь короче порога — оставляем там, откуда взяли. */
  it('короткий рывок ничего не меняет', () => {
    const { result } = setup()

    drag(result, 500, 500 - 20, handle())
    settle()

    expect(result.current.isOpen).toBe(false)
    expect(progress()).toBeCloseTo(0, 2)
  })

  it('короткий рывок у раскрытой шторки её не закрывает', () => {
    const { result } = setup()
    act(() => result.current.setOpen(true))
    settle()

    drag(result, 100, 120, handle())
    settle()

    expect(result.current.isOpen).toBe(true)
    expect(progress()).toBeCloseTo(1, 2)
  })

  /** Горизонтальный жест — это листание вариантов маршрута, а не шторка. */
  it('горизонтальный жест шторку не двигает', () => {
    const { result } = setup()

    act(() => result.current.touchHandlers.onTouchStart(touch(500, 200)))
    act(() => result.current.touchHandlers.onTouchMove(touch(502, 260)))
    runFrames(1)

    expect(progress()).toBe(0)
  })

  /** Вертикальный порог для обычной области — 6px, а не мгновенный. */
  it('микродвижение оси не задаёт', () => {
    const { result } = setup()

    act(() => result.current.touchHandlers.onTouchStart(touch(500)))
    act(() => result.current.touchHandlers.onTouchMove(touch(497)))
    runFrames(1)

    expect(progress()).toBe(0)
  })

  /** Касание по полю ввода — это установка курсора, а не перетаскивание. */
  it('касание по полю ввода игнорируется', () => {
    const { result } = setup()
    const input = document.createElement('input')
    document.querySelector('.bottom-sheet-inner')!.appendChild(input)

    act(() => result.current.touchHandlers.onTouchStart(touch(500, 0, input)))
    act(() => result.current.touchHandlers.onTouchMove(touch(400, 0, input)))
    runFrames(1)

    expect(markPerfInteraction).not.toHaveBeenCalled()
    expect(progress()).toBe(0)
  })

  /** Экран ошибки: тянуть нечего. */
  it('при выключенном перетаскивании жест не начинается', () => {
    const { result } = setup({ isDragDisabled: true })

    act(() => result.current.touchHandlers.onTouchStart(touch(500, 0, handle())))
    act(() => result.current.touchHandlers.onTouchMove(touch(300, 0, handle())))
    runFrames(1)

    expect(progress()).toBe(0)
  })

  /** Хода нет — двигать нечего, и жест не должен начинаться вовсе. */
  it('без хода шторки жест не начинается', () => {
    const { result } = setup({}, 0)

    act(() => result.current.touchHandlers.onTouchStart(touch(500, 0, handle())))
    act(() => result.current.touchHandlers.onTouchMove(touch(300, 0, handle())))
    runFrames(1)

    // Ход нулевой, поэтому шторку вообще не сдвинули — transform не выставлен.
    expect(sheetEl().style.transform).toBe('translate3d(0, 0px, 0)')
  })

  it('перетаскивание помечает жест для отключения дорогих эффектов', () => {
    const { result } = setup()

    act(() => result.current.touchHandlers.onTouchStart(touch(500, 0, handle())))
    act(() => result.current.touchHandlers.onTouchMove(touch(400, 0, handle())))

    expect(markPerfInteraction).toHaveBeenCalled()
  })

  it('движение без начатого жеста ничего не делает', () => {
    const { result } = setup()

    act(() => result.current.touchHandlers.onTouchMove(touch(300)))
    runFrames(1)
    expect(progress()).toBe(0)
  })

  /** Быстрый бросок вверх раскрывает шторку даже коротким путём. */
  it('быстрый бросок решает вместо пути', () => {
    const { result } = setup()

    act(() => result.current.touchHandlers.onTouchStart(touch(500, 0, handle())))
    // Несколько кадров подряд с большим шагом: так набирается скорость.
    for (const y of [460, 420, 380, 340]) {
      act(() => result.current.touchHandlers.onTouchMove(touch(y, 0, handle())))
      runFrames(1)
    }
    act(() => result.current.touchHandlers.onTouchEnd())
    settle()

    expect(result.current.isOpen).toBe(true)
  })
})

describe('прерванный жест', () => {
  /** Системный жест перехватил касание — шторка обязана вернуться на место. */
  it('отмена возвращает шторку туда, откуда её взяли', () => {
    const { result } = setup()

    act(() => result.current.touchHandlers.onTouchStart(touch(500, 0, handle())))
    act(() => result.current.touchHandlers.onTouchMove(touch(300, 0, handle())))
    runFrames(1)
    expect(progress()).toBeGreaterThan(0)

    act(() => result.current.touchHandlers.onTouchCancel())
    settle()

    expect(result.current.isOpen).toBe(false)
    expect(progress()).toBeCloseTo(0, 2)
  })

  it('отмена раскрытой шторки оставляет её раскрытой', () => {
    const { result } = setup()
    act(() => result.current.setOpen(true))
    settle()

    act(() => result.current.touchHandlers.onTouchStart(touch(100, 0, handle())))
    act(() => result.current.touchHandlers.onTouchMove(touch(200, 0, handle())))
    runFrames(1)
    act(() => result.current.touchHandlers.onTouchCancel())
    settle()

    expect(result.current.isOpen).toBe(true)
    expect(progress()).toBeCloseTo(1, 2)
  })

  it('отмена без начатого жеста ничего не ломает', () => {
    const { result } = setup()

    expect(() => act(() => result.current.touchHandlers.onTouchCancel())).not.toThrow()
    expect(progress()).toBe(0)
  })
})

describe('пересчёт во время жеста', () => {
  /**
   * Мерить шторку посреди перетаскивания нельзя: layout-риды дают фризы на
   * сотни миллисекунд. Пересчёт откладывается до отпускания.
   */
  it('откладывается до конца жеста', () => {
    const { result } = setup()

    act(() => result.current.touchHandlers.onTouchStart(touch(500, 0, handle())))
    act(() => window.dispatchEvent(new Event('resize')))
    runFrames(2)

    act(() => result.current.touchHandlers.onTouchEnd())
    expect(() => runFrames(3)).not.toThrow()
    expect(sheetEl().style.height).toBe(`${OPEN_HEIGHT}px`)
  })
})

describe('прокрутка внутри шторки', () => {
  /**
   * Гонку с прокруткой можно проиграть: браузер начинает скроллить и снимает
   * cancelable. preventDefault() на таком событии Chrome печатает как
   * [Intervention] — по строке на каждый кадр движения пальца.
   */
  it('неотменяемое событие не трогаем', () => {
    const { result } = setup()
    act(() => result.current.touchHandlers.onTouchStart(touch(500, 0, handle())))

    const inner = document.querySelector('.bottom-sheet-inner')!
    const preventDefault = vi.fn()
    const event = new Event('touchmove', { cancelable: false })
    Object.defineProperty(event, 'preventDefault', { value: preventDefault })

    inner.dispatchEvent(event)
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('вертикальный жест по шторке прокрутку отменяет', () => {
    const { result } = setup()
    act(() => result.current.touchHandlers.onTouchStart(touch(500, 0, handle())))

    const inner = document.querySelector('.bottom-sheet-inner')!
    const event = new Event('touchmove', { cancelable: true })
    const preventDefault = vi.fn()
    Object.defineProperty(event, 'preventDefault', { value: preventDefault })

    inner.dispatchEvent(event)
    expect(preventDefault).toHaveBeenCalled()
  })

  /** Жеста нет — значит человек просто листает содержимое. */
  it('без начатого жеста прокрутке не мешаем', () => {
    setup()

    const inner = document.querySelector('.bottom-sheet-inner')!
    const event = new Event('touchmove', { cancelable: true })
    const preventDefault = vi.fn()
    Object.defineProperty(event, 'preventDefault', { value: preventDefault })

    inner.dispatchEvent(event)
    expect(preventDefault).not.toHaveBeenCalled()
  })
})

describe('пересчёт по изменению размеров', () => {
  it('следит за размерами шторки через ResizeObserver', () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe = observe
        disconnect = disconnect
      },
    )

    const { unmount } = setup()
    // Сама шторка, её видимая часть и блок деталей.
    expect(observe).toHaveBeenCalledTimes(3)

    unmount()
    expect(disconnect).toHaveBeenCalled()
  })

  it('подписки на окно снимаются вместе с хуком', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = setup()

    unmount()
    expect(remove.mock.calls.some(([type]) => type === 'resize')).toBe(true)
    remove.mockRestore()
  })
})
