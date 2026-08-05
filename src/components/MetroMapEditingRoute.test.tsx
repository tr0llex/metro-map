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

/** Двойной тап: не позже этого и не дальше этого от первого. */
const DOUBLE_TAP_MAX_DELAY = 320

/**
 * Маршрут на настоящих рёбрах и двойной тап.
 *
 * Монтирование потестовое: жесты и правки раскладки оставляют состояние в
 * рефах карты. Файл выделен отдельным, чтобы идти параллельно с соседними.
 */
installMetroMapHarness()

describe('маршрут на настоящих рёбрах', () => {
  const routeProps = {
    routeStationIds: [A.id, B.id],
    routeEdgeKeys: [`${A.id}|${B.id}`],
    fromStationId: A.id,
    toStationId: B.id,
    fromStationName: A.title,
    toStationName: B.title,
  }

  it('рисует путь между соседними станциями', () => {
    render(<MetroMap {...props(routeProps)} />)
    flushFrames()

    expect(calls.some((c) => c.startsWith('stroke'))).toBe(true)
    expect(calls.length).toBeGreaterThan(100)
  })

  /**
   * Порядок станций маршрута приходит извне и может быть обратным: путь
   * рисуется от «Откуда» к «Куда», а не как пришло.
   */
  it('обратный порядок станций разворачивается', () => {
    render(
      <MetroMap
        {...props({ ...routeProps, routeStationIds: [B.id, A.id] })}
      />,
    )
    expect(() => flushFrames()).not.toThrow()
  })

  it('дальняя пересадка рисуется отдельно', () => {
    render(
      <MetroMap
        {...props({
          routeStationIds: ['1/biblioteka-im-lenina', '3/arbatskaya'],
          routeEdgeKeys: ['1/biblioteka-im-lenina|3/arbatskaya'],
          routeLongTransferEdgeKeys: ['1/biblioteka-im-lenina|3/arbatskaya'],
        })}
      />,
    )
    expect(() => flushFrames()).not.toThrow()
  })

  /** Станции, которых нет в раскладке, путь не ломают. */
  it('незнакомые станции маршрута пропускаются', () => {
    render(
      <MetroMap {...props({ routeStationIds: [A.id, 'нет/такой', B.id] })} />,
    )
    expect(() => flushFrames()).not.toThrow()
  })

  it('маршрут из одной станции пути не даёт', () => {
    render(<MetroMap {...props({ routeStationIds: [A.id] })} />)
    expect(() => flushFrames()).not.toThrow()
  })

  /** Открытая шторка сдвигает видимую область: маршрут надо вписать в остаток. */
  it('вписывается в видимую область под интерфейсом', () => {
    render(
      <MetroMap
        {...props({
          ...routeProps,
          routeSheetOpen: true,
          visibleInsets: { top: 120, right: 60, bottom: 0, left: 0 },
          getBottomInsetPx: () => 300,
        })}
      />,
    )
    expect(() => flushFrames(10)).not.toThrow()
    expect(calls.length).toBeGreaterThan(100)
  })
})

describe('двойной тап', () => {
  const tap = (station: typeof A, timeStamp: number) => {
    fireEvent.touchStart(canvas(), { ...touchAt(station), timeStamp })
    fireEvent.touchEnd(canvas(), {
      touches: [],
      changedTouches: [at(station)],
      timeStamp,
    })
  }

  it('приближает карту к месту тапа', () => {
    render(<MetroMap {...props()} />)
    flushFrames()
    calls.length = 0

    tap(A, 1000)
    tap(A, 1000 + DOUBLE_TAP_MAX_DELAY - 50)
    flushFrames(10)

    expect(calls.length).toBeGreaterThan(0)
  })

  /** Два медленных тапа — это два отдельных выбора станции, а не зум. */
  it('медленные тапы двойным не считаются', () => {
    const onSelectStation = vi.fn()
    render(<MetroMap {...props({ onSelectStation })} />)
    flushFrames()

    tap(A, 1000)
    tap(A, 1000 + DOUBLE_TAP_MAX_DELAY + 200)

    expect(() => flushFrames(10)).not.toThrow()
  })

  /** Тапы в разные места экрана — тоже не двойной тап. */
  it('тапы в разные места двойным не считаются', () => {
    render(<MetroMap {...props()} />)
    flushFrames()

    tap(A, 1000)
    tap(B, 1050)

    expect(() => flushFrames(10)).not.toThrow()
  })

  /**
   * Второй тап с протяжкой вниз — плавный зум. Порог в 8px нужен, чтобы
   * лёгкое дрожание пальца не превращалось в него и не ломало обычный двойной тап.
   */
  it('второй тап с протяжкой плавно зумит', () => {
    render(<MetroMap {...props()} />)
    flushFrames()
    calls.length = 0

    fireEvent.touchStart(canvas(), { ...touchAt(A), timeStamp: 1000 })
    fireEvent.touchEnd(canvas(), { touches: [], changedTouches: [at(A)], timeStamp: 1000 })
    fireEvent.touchStart(canvas(), { ...touchAt(A), timeStamp: 1100 })

    // Дрожание ниже порога зум не запускает.
    fireEvent.touchMove(canvas(), {
      touches: [{ clientX: at(A).clientX, clientY: at(A).clientY + 4 }],
    })
    flushFrames()
    const beforeDrag = calls.length

    fireEvent.touchMove(canvas(), {
      touches: [{ clientX: at(A).clientX, clientY: at(A).clientY + 120 }],
    })
    flushFrames(5)

    expect(calls.length).toBeGreaterThan(beforeDrag)
    fireEvent.touchEnd(canvas(), { touches: [], changedTouches: [at(A)] })
  })
})
