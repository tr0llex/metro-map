// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useStationPickPopover } from './useStationPickPopover.ts'
import type { StationSelectOutcome } from '../components/MetroMap.tsx'

type Tap = (
  stationId: string,
  stationName: string,
  clientPoint: { x: number; y: number },
) => StationSelectOutcome

function setup(outcome: StationSelectOutcome) {
  const onStationTap = vi.fn<Tap>(() => outcome)
  const popoverRef = createRef<HTMLDivElement>()
  const view = renderHook(() =>
    useStationPickPopover({
      onStationTap,
      onBeforeSelect: () => {},
      popoverRef,
    }),
  )
  return { onStationTap, ...view }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('выбор станции на схеме', () => {
  // Клавиатурный путь (Enter на станции) — единственный способ выбрать станцию
  // на канвасе без указателя. Раньше выбор без точки нажатия молча терялся.
  it('доводит выбор без точки нажатия до полей маршрута', () => {
    const { onStationTap, result } = setup('from')

    let outcome: StationSelectOutcome | undefined
    act(() => {
      outcome = result.current.handleMapSelect('1/krylatskoe', 'Крылатское')
    })

    expect(onStationTap).toHaveBeenCalledTimes(1)
    expect(outcome).toBe('from')
  })

  it('без точки нажатия открывает поповер по центру экрана', () => {
    const { result } = setup('ask')

    act(() => {
      result.current.handleMapSelect('1/krylatskoe', 'Крылатское')
    })

    expect(result.current.data).toEqual({
      stationId: '1/krylatskoe',
      stationName: 'Крылатское',
      clientPoint: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
    })
  })

  // Давний клик мимо станции не должен превращать Enter в «долгое нажатие»:
  // иначе клавиатура открывала поповер вместо заполнения пустого поля.
  it('не считает выбор с клавиатуры долгим нажатием', () => {
    vi.useFakeTimers()
    const { onStationTap, result } = setup('from')

    window.dispatchEvent(
      new window.PointerEvent('pointerdown', { clientX: 100, clientY: 100 }),
    )
    vi.advanceTimersByTime(2000)
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }))

    let outcome: StationSelectOutcome | undefined
    act(() => {
      outcome = result.current.handleMapSelect('1/krylatskoe', 'Крылатское', {
        x: 100,
        y: 100,
      })
    })

    expect(onStationTap).toHaveBeenCalledTimes(1)
    expect(outcome).toBe('from')
    expect(result.current.data).toBeNull()
  })
})
