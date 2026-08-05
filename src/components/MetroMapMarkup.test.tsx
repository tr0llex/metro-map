// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { fullGraphStations } from '../metro/fullGraph.ts'
import { MetroMap } from './MetroMap.tsx'
import {
  calls,
  canvas,
  flushFrames,
  installMetroMapHarnessOnce,
  props,
} from './__tests__/metroMapHarness.tsx'

/**
 * Разметка схемы и её текстовая альтернатива.
 *
 * Схема монтируется ОДИН раз на весь файл: все проверки здесь только читают
 * вывод, а монтирование стоит дорого — на нём считается раскладка подписей по
 * 304 станциям. Где нужны другие пропсы, идёт `rerender`: раскладка от пропсов
 * маршрута не зависит, её useMemo переживает смену пропсов, и повторный рендер
 * обходится в доли монтирования.
 */
installMetroMapHarnessOnce()

let view: ReturnType<typeof render>

beforeAll(() => {
  view = render(<MetroMap {...props()} />)
  flushFrames()
})

afterAll(cleanup)

/** Вернуть схему к пропсам по умолчанию — тесты не должны зависеть от порядка. */
const reset = () => view.rerender(<MetroMap {...props()} />)

describe('разметка схемы', () => {
  /**
   * Холстов два: на основном линии и станции, на верхнем — подписи. Второй
   * скрыт от скринридера: он дублирует то, что уже сказано текстовой
   * альтернативой.
   */
  it('рисует холст схемы и холст подписей', () => {
    reset()

    const canvases = view.container.querySelectorAll('canvas')
    expect(canvases).toHaveLength(2)
    expect(canvases[1].getAttribute('aria-hidden')).toBe('true')
  })

  it('режим выбора виден в разметке — от него зависит подсветка', () => {
    reset()
    const wrapper = () =>
      view.container.querySelector('.metro-map-wrapper')?.getAttribute('data-selection-mode')
    expect(wrapper()).toBe('from')

    view.rerender(<MetroMap {...props({ selectionMode: 'to' })} />)
    expect(wrapper()).toBe('to')
  })

  /** Собственно отрисовка: без неё канвас остался бы пустым прямоугольником. */
  it('что-то рисует на холсте', () => {
    // calls накоплены единственным монтированием в beforeAll.
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
    reset()

    expect(canvas().getAttribute('aria-roledescription')).toBe('Интерактивная схема метро')
    expect(canvas().getAttribute('tabindex')).toBe('0')
  })

  it('описание перечисляет размер схемы и способ управления', () => {
    reset()

    const hint = document.getElementById(canvas().getAttribute('aria-describedby')!)!
    expect(hint.textContent).toContain(`${fullGraphStations.length} станций`)
    expect(hint.textContent).toContain('стрелки переводят')
    expect(hint.textContent).toContain('Откуда')
  })

  it('описание меняет пример под текущий режим выбора', () => {
    view.rerender(<MetroMap {...props({ selectionMode: 'to' })} />)
    const hintId = canvas().getAttribute('aria-describedby')!
    expect(document.getElementById(hintId)!.textContent).toContain('станцию как «Куда»')

    view.rerender(<MetroMap {...props({ selectionMode: 'from' })} />)
    expect(document.getElementById(hintId)!.textContent).toContain('станцию как «Откуда»')
  })

  it('имя схемы сообщает, что уже выбрано', () => {
    reset()
    expect(canvas().getAttribute('aria-label')).toContain('откуда: не выбрано')
    expect(canvas().getAttribute('aria-label')).toContain('куда: не выбрано')

    view.rerender(
      <MetroMap {...props({ fromStationName: 'Арбатская', toStationName: 'Китай-город' })} />,
    )
    expect(canvas().getAttribute('aria-label')).toContain('откуда: Арбатская')
    expect(canvas().getAttribute('aria-label')).toContain('куда: Китай-город')
  })

  it('имя схемы сообщает и о построенном маршруте', () => {
    view.rerender(
      <MetroMap {...props({ routeStationIds: fullGraphStations.slice(0, 5).map((s) => s.id) })} />,
    )
    expect(canvas().getAttribute('aria-label')).toContain('построен маршрут из 5 станций')
  })
})
