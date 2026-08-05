// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useMapVisibleInsets } from './useMapVisibleInsets.ts'

/** Всплеск после монтирования: 16 кадров подряд ловят доезжающую анимацию. */
const BURST_FRAMES = 16

type Rect = { left: number; top: number; right: number; bottom: number }

/** Ставит элемент в DOM с заданным прямоугольником: в jsdom вёрстки нет. */
function place(className: string, rect: Rect) {
  const el = document.createElement('div')
  el.className = className
  el.getBoundingClientRect = () =>
    ({
      ...rect,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }) as DOMRect
  document.body.appendChild(el)
  return el
}

/** Холст карты на весь экран 400x800. */
const placeMap = () => place('metro-map-wrapper', { left: 0, top: 0, right: 400, bottom: 800 })

/** Очередь rAF под ручным управлением: иначе всплеск не проиграть. */
let frames: FrameRequestCallback[] = []

function runFrames(count = BURST_FRAMES + 2) {
  act(() => {
    for (let i = 0; i < count; i += 1) {
      const queued = frames
      frames = []
      for (const fn of queued) fn(performance.now())
    }
  })
}

beforeEach(() => {
  frames = []
  document.body.innerHTML = ''
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => frames.push(fn))
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

const setup = (over: { isDesktop?: boolean; isRouteSheetOpen?: boolean } = {}) =>
  renderHook((props: { isDesktop: boolean; isRouteSheetOpen: boolean }) =>
    useMapVisibleInsets(props), {
    initialProps: { isDesktop: false, isRouteSheetOpen: false, ...over },
  })

describe('до измерения', () => {
  it('отступов нет', () => {
    placeMap()
    const { result } = setup()
    expect(result.current).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
  })

  /** Карта ещё не смонтирована — мерить не от чего, но и падать нельзя. */
  it('без холста карты ничего не меряет', () => {
    const { result } = setup()
    runFrames()
    expect(result.current).toEqual({ top: 0, right: 0, bottom: 0, left: 0 })
  })
})

describe('шапка', () => {
  it('съедает отступ сверху', () => {
    placeMap()
    place('app-header', { left: 0, top: 0, right: 400, bottom: 120 })

    const { result } = setup()
    runFrames()
    expect(result.current.top).toBe(120)
  })

  /**
   * Шапка сбоку от полезной области (боковая панель шире шапки) карту не
   * накрывает — и отступ сверху резать не должна.
   */
  it('не накрывающая карту шапка отступа не даёт', () => {
    placeMap()
    place('app-header', { left: 0, top: 0, right: 100, bottom: 120 })
    place('bottom-sheet', { left: 0, top: 0, right: 200, bottom: 800 })

    const { result } = setup({ isDesktop: true })
    runFrames()

    expect(result.current.left).toBe(200)
    expect(result.current.top).toBe(0)
  })

  /** Шапка выше карты (уехала за верхний край) отступа не создаёт. */
  it('шапка над картой отступа не даёт', () => {
    placeMap()
    place('app-header', { left: 0, top: -200, right: 400, bottom: -50 })

    const { result } = setup()
    runFrames()
    expect(result.current.top).toBe(0)
  })
})

describe('панели слева', () => {
  /** Боковая панель занимает левую часть — маршрут должен центроваться правее. */
  it('боковая панель съедает отступ слева', () => {
    placeMap()
    place('bottom-sheet', { left: 0, top: 0, right: 380, bottom: 800 })

    const { result } = setup({ isDesktop: true })
    runFrames()
    expect(result.current.left).toBe(380)
  })

  /** На телефоне та же шторка лежит снизу, и её отступ приходит отдельно. */
  it('нижняя шторка слева ничего не занимает', () => {
    placeMap()
    place('bottom-sheet', { left: 0, top: 400, right: 400, bottom: 800 })

    const { result } = setup({ isDesktop: false })
    runFrames()
    expect(result.current.left).toBe(0)
  })

  it('редакторская панель учитывается только когда она в DOM', () => {
    placeMap()
    const { result } = setup()
    runFrames()
    expect(result.current.left).toBe(0)

    place('hub-editor-panel', { left: 0, top: 0, right: 360, bottom: 800 })
    act(() => window.dispatchEvent(new Event('resize')))
    runFrames()
    expect(result.current.left).toBe(360)
  })

  /** Панель редактора и боковая шторка — берётся большая из двух. */
  it('из двух панелей слева побеждает широкая', () => {
    placeMap()
    place('hub-editor-panel', { left: 0, top: 0, right: 360, bottom: 800 })
    place('bottom-sheet', { left: 0, top: 0, right: 380, bottom: 800 })

    const { result } = setup({ isDesktop: true })
    runFrames()
    expect(result.current.left).toBe(380)
  })

  /** Отступ не может съесть карту целиком: иначе делить будет не на что. */
  it('отступ слева ограничен шириной карты', () => {
    placeMap()
    place('hub-editor-panel', { left: 0, top: 0, right: 9999, bottom: 800 })

    const { result } = setup()
    runFrames()
    expect(result.current.left).toBe(400)
  })
})

describe('кнопки зума', () => {
  it('съедают отступ справа', () => {
    placeMap()
    place('metro-map-zoom-controls', { left: 340, top: 600, right: 390, bottom: 700 })

    const { result } = setup()
    runFrames()
    expect(result.current.right).toBe(60)
  })
})

describe('пересчёт', () => {
  /**
   * Возвращаем ПРЕЖНИЙ объект, если ничего не изменилось: React сравнивает
   * состояние по Object.is, и новый объект с теми же числами — это перерендер
   * App, перерендер MetroMap и перезапуск автофита. А сюда мы приходим 16 раз
   * подряд на всплеске и на каждом resize/scroll.
   */
  it('при неизменных числах отдаёт ту же ссылку', () => {
    placeMap()
    place('app-header', { left: 0, top: 0, right: 400, bottom: 120 })

    const { result } = setup()
    runFrames()
    const first = result.current

    act(() => window.dispatchEvent(new Event('resize')))
    runFrames()
    expect(result.current).toBe(first)
  })

  it('изменение раскладки пересчитывает отступы', () => {
    placeMap()
    const header = place('app-header', { left: 0, top: 0, right: 400, bottom: 120 })

    const { result } = setup()
    runFrames()
    expect(result.current.top).toBe(120)

    header.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 400, bottom: 64, width: 400, height: 64 }) as DOMRect
    act(() => window.dispatchEvent(new Event('resize')))
    runFrames()
    expect(result.current.top).toBe(64)
  })

  /** Клавиатура на телефоне двигает визуальный вьюпорт, а не окно. */
  it('слушает визуальный вьюпорт', () => {
    const listeners: Record<string, () => void> = {}
    vi.stubGlobal('visualViewport', {
      addEventListener: (type: string, fn: () => void) => {
        listeners[type] = fn
      },
      removeEventListener: (type: string) => {
        delete listeners[type]
      },
    })

    placeMap()
    const { unmount } = setup()
    expect(Object.keys(listeners).sort()).toEqual(['resize', 'scroll'])

    unmount()
    expect(Object.keys(listeners)).toEqual([])
  })

  it('смена раскладки перезапускает измерение', () => {
    placeMap()
    place('bottom-sheet', { left: 0, top: 0, right: 380, bottom: 800 })

    const { result, rerender } = setup()
    runFrames()
    expect(result.current.left).toBe(0)

    rerender({ isDesktop: true, isRouteSheetOpen: false })
    runFrames()
    expect(result.current.left).toBe(380)
  })

  it('подписки снимаются вместе с хуком', () => {
    placeMap()
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = setup()

    unmount()
    expect(remove.mock.calls.some(([type]) => type === 'resize')).toBe(true)
    remove.mockRestore()
  })
})
