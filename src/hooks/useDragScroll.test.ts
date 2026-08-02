// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useDragScroll } from './useDragScroll.ts'

/**
 * Прокрутка колесом — догоняющая анимация на requestAnimationFrame, поэтому
 * сразу после события лента ещё в пути. Кадры гоняем руками: очередь копится,
 * `runFrames` проигрывает её до тех пор, пока хук не перестанет просить
 * следующий кадр (или пока не кончится лимит — страховка от вечного цикла,
 * если условие остановки в хуке однажды сломают).
 */
let frames: FrameRequestCallback[] = []

/** Один кадр анимации — чтобы поймать ленту в пути, а не в конце. */
const runOneFrame = () => {
  const queued = frames
  frames = []
  for (const frame of queued) frame(0)
}

const runFrames = (limit = 200) => {
  for (let i = 0; i < limit && frames.length > 0; i += 1) {
    const queued = frames
    frames = []
    for (const frame of queued) frame(i)
  }
  return frames.length === 0
}

/**
 * jsdom не считает раскладку: scrollWidth и clientWidth у любого элемента равны
 * нулю, и лента выглядела бы «некуда прокручивать». Подменяем оба размера, а
 * scrollLeft делаем обычным полем — присваивание в хуке должно быть видно.
 */
const makeTrack = (options: { scrollWidth: number; clientWidth: number }) => {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollWidth', { value: options.scrollWidth })
  Object.defineProperty(el, 'clientWidth', { value: options.clientWidth })
  el.scrollLeft = 0
  document.body.appendChild(el)
  return el
}

const wheel = (el: HTMLElement, init: WheelEventInit) => {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
  el.dispatchEvent(event)
  return event
}

let cleanup: (() => void) | undefined

const attach = (el: HTMLElement) => {
  const { result } = renderHook(() => useDragScroll<HTMLDivElement>())
  cleanup = result.current(el as HTMLDivElement)
}

beforeEach(() => {
  frames = []
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.push(cb)
    return frames.length
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
    frames = []
  })
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('колесо над лентой прокручивает её горизонтально', () => {
  it('вертикальный шаг едет вбок, а не по странице', () => {
    const el = makeTrack({ scrollWidth: 800, clientWidth: 300 })
    attach(el)

    const event = wheel(el, { deltaY: 120 })

    expect(event.defaultPrevented).toBe(true)
    // Рывка на весь шаг нет: за первый кадр лента проходит только часть пути.
    runOneFrame()
    expect(el.scrollLeft).toBeGreaterThan(0)
    expect(el.scrollLeft).toBeLessThan(120)

    expect(runFrames()).toBe(true)
    expect(el.scrollLeft).toBe(120)
  })

  /**
   * Щелчки колеса складываются. Считай хук путь от текущего положения, а не от
   * недокрученной цели, два быстрых щелчка проехали бы заметно меньше двухсот
   * сорока: второй отмерил бы свои 120 от середины первой анимации.
   */
  it('быстрые щелчки складываются, а не перебивают друг друга', () => {
    const el = makeTrack({ scrollWidth: 800, clientWidth: 300 })
    attach(el)

    wheel(el, { deltaY: 120 })
    wheel(el, { deltaY: 120 })

    expect(runFrames()).toBe(true)
    expect(el.scrollLeft).toBe(240)
  })

  it('строчный режим колеса (Firefox) считается в пикселях', () => {
    const el = makeTrack({ scrollWidth: 800, clientWidth: 300 })
    attach(el)

    wheel(el, { deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE })
    runFrames()

    expect(el.scrollLeft).toBe(48)
  })

  /** Shift + колесо браузер сам кладёт в deltaX — перехватывать нечего. */
  it('горизонтальный жест остаётся браузеру', () => {
    const el = makeTrack({ scrollWidth: 800, clientWidth: 300 })
    attach(el)

    const event = wheel(el, { deltaX: 40, deltaY: 0 })

    expect(el.scrollLeft).toBe(0)
    expect(event.defaultPrevented).toBe(false)
  })

  /**
   * Ради этого и написан тест: у края лента обязана отпустить событие, иначе
   * колесо над ней намертво запирает прокрутку всего экрана.
   */
  it('на упоре отдаёт прокрутку странице', () => {
    const el = makeTrack({ scrollWidth: 800, clientWidth: 300 })
    attach(el)
    el.scrollLeft = 500

    const event = wheel(el, { deltaY: 120 })

    expect(el.scrollLeft).toBe(500)
    expect(event.defaultPrevented).toBe(false)
  })

  it('перетаскивание рукой отменяет догоняющую анимацию', () => {
    const el = makeTrack({ scrollWidth: 800, clientWidth: 300 })
    attach(el)

    wheel(el, { deltaY: 120 })
    runOneFrame()
    const midway = el.scrollLeft
    expect(midway).toBeGreaterThan(0)
    el.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0 }),
    )

    expect(runFrames()).toBe(true)
    expect(el.scrollLeft).toBe(midway)
  })

  it('ленте, которая помещается целиком, колесо не мешает', () => {
    const el = makeTrack({ scrollWidth: 300, clientWidth: 300 })
    attach(el)

    const event = wheel(el, { deltaY: 120 })

    expect(el.scrollLeft).toBe(0)
    expect(event.defaultPrevented).toBe(false)
  })

  it('после размонтирования обработчик снят', () => {
    const el = makeTrack({ scrollWidth: 800, clientWidth: 300 })
    attach(el)
    cleanup?.()
    cleanup = undefined

    wheel(el, { deltaY: 120 })
    runFrames()

    expect(el.scrollLeft).toBe(0)
  })
})
