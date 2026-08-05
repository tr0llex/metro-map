// @vitest-environment jsdom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useDragScroll } from './useDragScroll.ts'

/** Прокрутка начинается только после этого сдвига — иначе клик перестанет быть кликом. */
const DRAG_THRESHOLD_PX = 5

/** jsdom не считает раскладку: размеры ленты подставляем руками. */
const makeTrack = () => {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollWidth', { value: 800 })
  Object.defineProperty(el, 'clientWidth', { value: 300 })
  el.scrollLeft = 0
  document.body.appendChild(el)
  return el
}

let detach: (() => void) | undefined

const attach = (el: HTMLElement) => {
  const { result } = renderHook(() => useDragScroll<HTMLDivElement>())
  detach = result.current(el as HTMLDivElement)
}

const down = (
  el: HTMLElement,
  clientX: number,
  init: Partial<PointerEventInit> = {},
) =>
  el.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      pointerId: 1,
      pointerType: 'mouse',
      button: 0,
      clientX,
      ...init,
    }),
  )

const move = (clientX: number, pointerId = 1) =>
  window.dispatchEvent(
    new PointerEvent('pointermove', { bubbles: true, cancelable: true, pointerId, clientX }),
  )

const up = (pointerId = 1) =>
  window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId }))

const cancel = (pointerId = 1) =>
  window.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId }))

/** Клик по карточке внутри ленты — то, что перетаскивание не должно ломать. */
const clickInside = (el: HTMLElement) => {
  const card = document.createElement('button')
  el.appendChild(card)
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  card.dispatchEvent(event)
  return event
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  detach?.()
  detach = undefined
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('прокрутка ленты зажатой мышью', () => {
  /**
   * Лента прокручивалась только пальцем: мышью её было не сдвинуть, а на
   * десктопе скроллбар тонкий и наплывающий.
   */
  it('тянет ленту за курсором', () => {
    const el = makeTrack()
    attach(el)

    down(el, 200)
    move(120)

    expect(el.scrollLeft).toBe(80)
  })

  it('движение в обе стороны отслеживается', () => {
    const el = makeTrack()
    attach(el)
    el.scrollLeft = 200

    down(el, 200)
    move(260)

    expect(el.scrollLeft).toBe(140)
  })

  /** Микросдвиг есть почти в каждом клике — до порога это ещё клик. */
  it('до порога ленту не двигает', () => {
    const el = makeTrack()
    attach(el)

    down(el, 200)
    move(200 - (DRAG_THRESHOLD_PX - 1))

    expect(el.scrollLeft).toBe(0)
  })

  /** Пока тянем, браузер начинал выделять текст внутри карточек. */
  it('на время перетаскивания гасит выделение текста', () => {
    const el = makeTrack()
    attach(el)

    down(el, 200)
    move(120)

    expect(el.style.userSelect).toBe('none')
    expect(el.dataset.dragging).toBe('true')

    up()
    expect(el.style.userSelect).toBe('')
    expect(el.dataset.dragging).toBeUndefined()
  })

  it('отменяет выделение и прокрутку страницы на каждом шаге', () => {
    const el = makeTrack()
    attach(el)

    down(el, 200)
    const event = new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      clientX: 120,
    })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })
})

describe('клик после перетаскивания', () => {
  /**
   * Иначе отпускание кнопки выбирало бы тот вариант, над которым случайно
   * оказался курсор в конце движения.
   */
  it('гасится ровно один раз', () => {
    const el = makeTrack()
    attach(el)

    down(el, 200)
    move(120)
    up()

    expect(clickInside(el).defaultPrevented).toBe(true)
    // Следующий клик — уже честный выбор варианта.
    expect(clickInside(el).defaultPrevented).toBe(false)
  })

  /** Клик с микросдвигом обязан остаться кликом. */
  it('после нажатия без перетаскивания не гасится', () => {
    const el = makeTrack()
    attach(el)

    down(el, 200)
    move(198)
    up()

    expect(clickInside(el).defaultPrevented).toBe(false)
  })

  /**
   * Курсор ушёл с ленты, и «съеденного» клика не случилось — флаг обязан
   * сброситься, чтобы не погасить ни в чём не повинный следующий клик.
   */
  it('несостоявшееся подавление сбрасывается новым нажатием', () => {
    const el = makeTrack()
    attach(el)

    down(el, 200)
    move(120)
    up()

    // Клика не было: человек увёл мышь. Начинаем новое взаимодействие.
    down(el, 200)
    up()

    expect(clickInside(el).defaultPrevented).toBe(false)
  })
})

describe('чужие указатели', () => {
  /** Тач и перо прокручивают ленту сами — вмешиваться нечего. */
  it.each(['touch', 'pen'])('%s не перехватывается', (pointerType) => {
    const el = makeTrack()
    attach(el)

    down(el, 200, { pointerType })
    move(120)

    expect(el.scrollLeft).toBe(0)
  })

  /** Правая кнопка открывает контекстное меню, а не тянет ленту. */
  it('не левая кнопка ленту не тянет', () => {
    const el = makeTrack()
    attach(el)

    down(el, 200, { button: 2 })
    move(120)

    expect(el.scrollLeft).toBe(0)
  })

  it('второй палец поверх начатого жеста игнорируется', () => {
    const el = makeTrack()
    attach(el)

    down(el, 200)
    down(el, 400, { pointerId: 2 })
    move(120, 2)

    expect(el.scrollLeft).toBe(0)

    move(120, 1)
    expect(el.scrollLeft).toBe(80)
  })
})

describe('прерванный жест', () => {
  /** Системный жест перехватил указатель — лента обязана отпустить его чисто. */
  it('отмена завершает перетаскивание без подавления клика', () => {
    const el = makeTrack()
    attach(el)

    down(el, 200)
    move(120)
    cancel()

    expect(el.dataset.dragging).toBeUndefined()
    expect(el.style.userSelect).toBe('')
    expect(clickInside(el).defaultPrevented).toBe(false)
  })

  it('после отмены движение ленту уже не тянет', () => {
    const el = makeTrack()
    attach(el)

    down(el, 200)
    move(120)
    cancel()

    const at = el.scrollLeft
    move(20)
    expect(el.scrollLeft).toBe(at)
  })

  /** Лента исчезает вместе с вариантами маршрута — слушатели окна обязаны уйти. */
  it('снятие ленты посреди жеста не оставляет слушателей', () => {
    const el = makeTrack()
    attach(el)

    down(el, 200)
    move(120)
    detach?.()
    detach = undefined

    const at = el.scrollLeft
    move(20)
    expect(el.scrollLeft).toBe(at)
  })

  /** Ref-колбэк зовут с null при размонтировании — падать тут нельзя. */
  it('пустая ссылка обработчики не ставит', () => {
    const { result } = renderHook(() => useDragScroll<HTMLDivElement>())
    expect(result.current(null)).toBeUndefined()
  })
})

describe('уменьшенная анимация', () => {
  /**
   * Догоняющая анимация — украшение. Тем, кто просил движения поменьше, лента
   * должна доезжать сразу.
   */
  it('колесо доводит ленту до цели без кадров', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))

    const el = makeTrack()
    attach(el)

    el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }))

    expect(el.scrollLeft).toBe(120)
  })
})

describe('постраничное колесо', () => {
  /** Некоторые мыши и системы меряют шаг страницами экрана. */
  it('шаг считается по ширине ленты', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => frames.push(fn))

    const el = makeTrack()
    attach(el)

    el.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 1,
        deltaMode: WheelEvent.DOM_DELTA_PAGE,
      }),
    )

    for (let i = 0; i < 200 && frames.length > 0; i += 1) {
      const queued = frames.splice(0, frames.length)
      for (const fn of queued) fn(i)
    }

    // Один «экран» ленты — её clientWidth.
    expect(el.scrollLeft).toBe(300)
  })
})
