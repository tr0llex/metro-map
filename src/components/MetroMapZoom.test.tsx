// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MetroMap } from './MetroMap.tsx'
import {
  calls,
  canvas,
  flushFrames,
  installMetroMapHarness,
  props,
} from './__tests__/metroMapHarness.tsx'

afterEach(cleanup)

/**
 * Масштабирование: кнопки, удержание, колесо.
 *
 * Схема монтируется на каждый тест: внутреннее состояние — клавиатурный
 * курсор, начатый жест, текущий масштаб — переживает перерисовку, и общий
 * рендер сделал бы тесты зависимыми по порядку. Файл выделен отдельным,
 * чтобы монтирования шли параллельно с соседними наборами карты.
 */
installMetroMapHarness()

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
