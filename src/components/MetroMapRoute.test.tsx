// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { fullGraphStations } from '../metro/fullGraph.ts'
import { MetroMap } from './MetroMap.tsx'
import {
  calls,
  flushFrames,
  installMetroMapHarness,
  props,
} from './__tests__/metroMapHarness.tsx'

afterEach(cleanup)

/**
 * Маршрут на схеме, готовность и правки редактора.
 *
 * Схема монтируется на каждый тест: внутреннее состояние — клавиатурный
 * курсор, начатый жест, текущий масштаб — переживает перерисовку, и общий
 * рендер сделал бы тесты зависимыми по порядку. Файл выделен отдельным,
 * чтобы монтирования шли параллельно с соседними наборами карты.
 */
installMetroMapHarness()

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
