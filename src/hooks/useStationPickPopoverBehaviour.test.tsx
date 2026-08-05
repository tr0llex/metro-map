// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { StationSelectOutcome } from '../components/MetroMap.tsx'
import { useStationPickPopover } from './useStationPickPopover.ts'

/** Долгое нажатие: «хочу выбрать поле сам». */
const LONG_PRESS_MS = 480
/** Палец всегда немного «плывёт»: сдвиг больше этого — уже не долгое нажатие. */
const LONG_PRESS_MAX_MOVE_PX = 14
const POPOVER_EXIT_MS = 160

const STATION = { id: '1/krylatskoe', name: 'Крылатское' }

type Tap = (
  stationId: string,
  stationName: string,
  clientPoint: { x: number; y: number },
) => StationSelectOutcome

/** Кадры под ручным управлением: позиция поповера меряется в кадре. */
let frames: FrameRequestCallback[] = []
const flushFrames = () =>
  act(() => {
    const queued = frames
    frames = []
    for (const fn of queued) fn(0)
  })

/** Поповер размером 220×96 — от него считаются отступы от краёв экрана. */
function popoverElement() {
  const el = document.createElement('div')
  el.getBoundingClientRect = () =>
    ({ width: 220, height: 96, left: 0, top: 0, right: 220, bottom: 96 }) as DOMRect
  document.body.appendChild(el)
  return el
}

function setup(outcome: StationSelectOutcome = 'ask') {
  const onStationTap = vi.fn<Tap>(() => outcome)
  const onBeforeSelect = vi.fn()
  const popoverRef = createRef<HTMLDivElement>() as React.RefObject<HTMLDivElement | null>
  popoverRef.current = popoverElement()

  const view = renderHook(() =>
    useStationPickPopover({ onStationTap, onBeforeSelect, popoverRef }),
  )
  return { onStationTap, onBeforeSelect, popoverRef, ...view }
}

/** Нажатие пальцем, отпущенное через heldMs со сдвигом (dx, dy). */
function press({
  at = { x: 300, y: 400 },
  heldMs = 0,
  dx = 0,
  dy = 0,
}: { at?: { x: number; y: number }; heldMs?: number; dx?: number; dy?: number } = {}) {
  window.dispatchEvent(
    new window.PointerEvent('pointerdown', { clientX: at.x, clientY: at.y }),
  )
  vi.advanceTimersByTime(heldMs)
  return { x: at.x + dx, y: at.y + dy }
}

beforeEach(() => {
  frames = []
  document.body.innerHTML = ''
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    frames.push(fn)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.stubGlobal('innerWidth', 400)
  vi.stubGlobal('innerHeight', 800)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('короткий тап', () => {
  /**
   * Пока хоть одно поле пустое, тап заполняет его сразу: первый — «Откуда»,
   * второй — «Куда». Это и есть быстрый путь, поповер тут только мешал бы.
   */
  it.each(['from', 'to', 'noop'] as const)('исход %s отдаётся наверх без поповера', (outcome) => {
    const { result, onStationTap } = setup(outcome)

    let got: StationSelectOutcome | undefined
    act(() => {
      const point = press({ heldMs: 80 })
      got = result.current.handleMapSelect(STATION.id, STATION.name, point)
    })

    expect(got).toBe(outcome)
    expect(onStationTap).toHaveBeenCalledWith(STATION.id, STATION.name, { x: 300, y: 400 })
    expect(result.current.data).toBeNull()
  })

  /**
   * Оба поля заняты: молча менять маршрут нельзя — раньше тап подменял «Куда»,
   * и маршрут перестраивался неожиданно для человека, который просто ткнул в карту.
   */
  it('при занятых полях открывает поповер', () => {
    const { result } = setup('ask')

    act(() => {
      const point = press({ heldMs: 80 })
      result.current.handleMapSelect(STATION.id, STATION.name, point)
    })

    expect(result.current.data).toMatchObject({
      stationId: STATION.id,
      stationName: STATION.name,
    })
  })

  /** Любой выбор станции — повод убрать подсказку первого запуска. */
  it('сообщает наверх о начале выбора', () => {
    const { result, onBeforeSelect } = setup('from')

    act(() => {
      result.current.handleMapSelect(STATION.id, STATION.name, { x: 10, y: 10 })
    })
    expect(onBeforeSelect).toHaveBeenCalledTimes(1)
  })
})

describe('долгое нажатие', () => {
  /** Долгое нажатие открывает поповер в любом состоянии — даже при пустых полях. */
  it('открывает поповер, минуя быстрый путь', () => {
    const { result, onStationTap } = setup('from')

    act(() => {
      const point = press({ heldMs: LONG_PRESS_MS })
      result.current.handleMapSelect(STATION.id, STATION.name, point)
    })

    expect(onStationTap).not.toHaveBeenCalled()
    expect(result.current.data).toMatchObject({ stationId: STATION.id })
  })

  it('нажатие короче порога остаётся обычным тапом', () => {
    const { result, onStationTap } = setup('from')

    act(() => {
      const point = press({ heldMs: LONG_PRESS_MS - 20 })
      result.current.handleMapSelect(STATION.id, STATION.name, point)
    })

    expect(onStationTap).toHaveBeenCalledTimes(1)
    expect(result.current.data).toBeNull()
  })

  /** Палец «плывёт» — небольшой сдвиг долгое нажатие не отменяет. */
  it('терпит дрожание пальца', () => {
    const { result, onStationTap } = setup('from')

    act(() => {
      const point = press({ heldMs: LONG_PRESS_MS, dx: 8, dy: 8 })
      result.current.handleMapSelect(STATION.id, STATION.name, point)
    })

    expect(onStationTap).not.toHaveBeenCalled()
    expect(result.current.data).toBeTruthy()
  })

  /** Заметный сдвиг — это уже перетаскивание карты, а не удержание станции. */
  it('сдвиг за порог отменяет долгое нажатие', () => {
    const { result, onStationTap } = setup('from')

    act(() => {
      const point = press({ heldMs: LONG_PRESS_MS, dx: LONG_PRESS_MAX_MOVE_PX + 5 })
      result.current.handleMapSelect(STATION.id, STATION.name, point)
    })

    expect(onStationTap).toHaveBeenCalledTimes(1)
  })

  /** Забытое нажатие (вкладка ушла в фон) удержанием не считается. */
  it('нажатие длиной в десять секунд удержанием не считается', () => {
    const { result, onStationTap } = setup('from')

    act(() => {
      const point = press({ heldMs: 10_500 })
      result.current.handleMapSelect(STATION.id, STATION.name, point)
    })

    expect(onStationTap).toHaveBeenCalledTimes(1)
  })

  /** Нажатие учитывается один раз: второй выбор подряд — обычный тап. */
  it('одно нажатие засчитывается один раз', () => {
    const { result, onStationTap } = setup('from')

    act(() => {
      const point = press({ heldMs: LONG_PRESS_MS })
      result.current.handleMapSelect(STATION.id, STATION.name, point)
    })
    act(() => {
      result.current.handleMapSelect(STATION.id, STATION.name, { x: 300, y: 400 })
    })

    expect(onStationTap).toHaveBeenCalledTimes(1)
  })
})

describe('положение поповера', () => {
  const open = (result: { current: ReturnType<typeof useStationPickPopover> }, at: { x: number; y: number }) => {
    act(() => {
      result.current.handleMapSelect(STATION.id, STATION.name, at)
    })
    flushFrames()
  }

  /** Поповер встаёт над станцией: под пальцем он закрыл бы то, по чему попали. */
  it('встаёт над точкой нажатия', () => {
    const { result } = setup('ask')
    open(result, { x: 200, y: 400 })

    // 400 - 20 (зазор) - 96 (высота) = 284
    expect(result.current.position).toEqual({ left: 100, top: 284 })
  })

  /** У верхней кромки места сверху нет — поповер переезжает под станцию. */
  it('у верхнего края переезжает вниз', () => {
    const { result } = setup('ask')
    open(result, { x: 200, y: 40 })

    expect(result.current.position!.top).toBe(60)
  })

  it('не вылезает за левый край', () => {
    const { result } = setup('ask')
    open(result, { x: 5, y: 400 })

    expect(result.current.position!.left).toBe(8)
  })

  it('не вылезает за правый край', () => {
    const { result } = setup('ask')
    open(result, { x: 395, y: 400 })

    // 400 - 8 (отступ) - 220 (ширина) = 172
    expect(result.current.position!.left).toBe(172)
  })

  it('не вылезает за нижний край', () => {
    const { result } = setup('ask')
    open(result, { x: 200, y: 795 })

    expect(result.current.position!.top).toBeLessThanOrEqual(800 - 8 - 96)
  })

  /** Пока позиция не измерена, поповер невидим — иначе он мигнёт в углу. */
  it('до измерения позиции нет', () => {
    const { result } = setup('ask')
    act(() => {
      result.current.handleMapSelect(STATION.id, STATION.name, { x: 200, y: 400 })
    })

    expect(result.current.data).toBeTruthy()
    expect(result.current.position).toBeNull()
  })

  it('без узла поповера позицию не выдумывает', () => {
    const onStationTap = vi.fn<Tap>(() => 'ask' as const)
    const popoverRef = createRef<HTMLDivElement>() as React.RefObject<HTMLDivElement | null>
    const { result } = renderHook(() =>
      useStationPickPopover({ onStationTap, onBeforeSelect: () => {}, popoverRef }),
    )

    act(() => {
      result.current.handleMapSelect(STATION.id, STATION.name, { x: 200, y: 400 })
    })
    flushFrames()

    expect(result.current.position).toBeNull()
  })
})

describe('закрытие поповера', () => {
  const openPopover = (result: { current: ReturnType<typeof useStationPickPopover> }) => {
    act(() => {
      result.current.handleMapSelect(STATION.id, STATION.name, { x: 200, y: 400 })
    })
    flushFrames()
  }

  it('по Escape — с анимацией ухода', () => {
    const { result } = setup('ask')
    openPopover(result)

    act(() => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
      // Уход поповера начинается со следующего тика, даже без задержки.
      vi.advanceTimersByTime(0)
    })
    expect(result.current.isClosing).toBe(true)
    expect(result.current.data).toBeTruthy()

    act(() => {
      vi.advanceTimersByTime(POPOVER_EXIT_MS)
    })
    expect(result.current.data).toBeNull()
    expect(result.current.isClosing).toBe(false)
  })

  it('прочие клавиши поповер не закрывают', () => {
    const { result } = setup('ask')
    openPopover(result)

    act(() => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }))
      vi.advanceTimersByTime(POPOVER_EXIT_MS * 2)
    })
    expect(result.current.data).toBeTruthy()
  })

  it('нажатием мимо поповера', () => {
    const { result } = setup('ask')
    openPopover(result)

    act(() => {
      document.body.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))
      vi.advanceTimersByTime(POPOVER_EXIT_MS)
    })
    expect(result.current.data).toBeNull()
  })

  /** Нажатие по самому поповеру — это выбор поля, а не отмена. */
  it('нажатие внутри поповера его не закрывает', () => {
    const { result, popoverRef } = setup('ask')
    openPopover(result)

    const inner = document.createElement('button')
    popoverRef.current!.appendChild(inner)

    act(() => {
      inner.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }))
      vi.advanceTimersByTime(POPOVER_EXIT_MS * 2)
    })
    expect(result.current.data).toBeTruthy()
  })

  /**
   * Поворот экрана: измеренная позиция мгновенно устаревает, и анимировать
   * уход поповера, висящего не на своём месте, незачем.
   */
  it('ресайз закрывает мгновенно, без анимации', () => {
    const { result } = setup('ask')
    openPopover(result)

    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(result.current.data).toBeNull()
    expect(result.current.isClosing).toBe(false)
  })

  /** Задержка нужна, чтобы подсветка нажатой кнопки успела проиграть. */
  it('закрытие с задержкой откладывает уход', () => {
    const { result } = setup('ask')
    openPopover(result)

    act(() => {
      result.current.closeAnimated({ delayMs: 120 })
      vi.advanceTimersByTime(100)
    })
    expect(result.current.data).toBeTruthy()
    expect(result.current.isClosing).toBe(false)

    act(() => {
      vi.advanceTimersByTime(20 + POPOVER_EXIT_MS)
    })
    expect(result.current.data).toBeNull()
  })

  /** Второй запрос на закрытие не должен породить два конкурирующих отсчёта. */
  it('повторное закрытие отменяет прежний отсчёт', () => {
    const { result } = setup('ask')
    openPopover(result)

    act(() => {
      result.current.closeAnimated({ delayMs: 500 })
      result.current.closeAnimated()
      vi.advanceTimersByTime(POPOVER_EXIT_MS)
    })
    expect(result.current.data).toBeNull()
  })

  /** Новый тап по станции обязан отменить закрытие прежнего поповера. */
  it('новый выбор отменяет незавершённое закрытие', () => {
    const { result } = setup('ask')
    openPopover(result)

    act(() => {
      result.current.closeAnimated({ delayMs: 200 })
    })
    act(() => {
      result.current.handleMapSelect('2/teatralnaya', 'Театральная', { x: 100, y: 300 })
      vi.advanceTimersByTime(500)
    })

    expect(result.current.data).toMatchObject({ stationId: '2/teatralnaya' })
  })

  it('подписки снимаются вместе с закрытым поповером', () => {
    const { result } = setup('ask')
    openPopover(result)

    const remove = vi.spyOn(window, 'removeEventListener')
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })

    expect(remove.mock.calls.some(([type]) => type === 'keydown')).toBe(true)
    remove.mockRestore()
  })
})

describe('подсветка нажатой кнопки', () => {
  /** Между нажатием и перерисовкой маршрута проходит кадр — подсветка нужна сразу. */
  it('запоминается и сбрасывается вместе с поповером', () => {
    const { result } = setup('ask')
    act(() => {
      result.current.handleMapSelect(STATION.id, STATION.name, { x: 200, y: 400 })
    })

    act(() => result.current.setPressed('to'))
    expect(result.current.pressed).toBe('to')

    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    expect(result.current.pressed).toBeNull()
  })
})
