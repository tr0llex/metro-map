// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fullGraphStations } from '../metro/fullGraph.ts'
import { MetroMap } from './MetroMap.tsx'
import {
  at,
  calls,
  canvas,
  flushFrames,
  installMetroMapHarness,
  pendingFrames,
  props,
} from './__tests__/metroMapHarness.tsx'

afterEach(cleanup)

/**
 * Выбор станции указателем и панорамирование.
 *
 * Схема монтируется на каждый тест: внутреннее состояние — клавиатурный
 * курсор, начатый жест, текущий масштаб — переживает перерисовку, и общий
 * рендер сделал бы тесты зависимыми по порядку. Файл выделен отдельным,
 * чтобы монтирования шли параллельно с соседними наборами карты.
 */
installMetroMapHarness()

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
    expect(pendingFrames()).toBe(0)

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
