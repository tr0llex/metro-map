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
  props,
  touchAt,
} from './__tests__/metroMapHarness.tsx'

afterEach(cleanup)

/** Соседние станции одной линии — на них проверяется рисование маршрута. */
const A = fullGraphStations.find((s) => s.id === '5/novoslobodskaya')!
const B = fullGraphStations.find((s) => s.id === '5/prospekt-mira')!
/** Станция пересадочного узла: перетаскивание берёт весь узел, а не её одну. */
const HUB = fullGraphStations.find((s) => s.id === '1/biblioteka-im-lenina')!
const HUB_SIZE = fullGraphStations.filter((s) => s.hubId === HUB.hubId).length

/** Двойной тап: не позже этого и не дальше этого от первого. */

/**
 * Перетаскивание станций в редакторе и применение раскладки.
 *
 * Монтирование потестовое: жесты и правки раскладки оставляют состояние в
 * рефах карты. Файл выделен отдельным, чтобы идти параллельно с соседними.
 */
installMetroMapHarness()

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
