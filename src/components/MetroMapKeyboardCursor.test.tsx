// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { MetroMap } from './MetroMap.tsx'
import {
  announcement,
  calls,
  canvas,
  flushFrames,
  installMetroMapHarness,
  props,
} from './__tests__/metroMapHarness.tsx'

afterEach(cleanup)

/**
 * Клавиатурный курсор по станциям.
 *
 * Схема монтируется на каждый тест: внутреннее состояние — клавиатурный
 * курсор, начатый жест, текущий масштаб — переживает перерисовку, и общий
 * рендер сделал бы тесты зависимыми по порядку. Файл выделен отдельным,
 * чтобы монтирования шли параллельно с соседними наборами карты.
 */
installMetroMapHarness()

describe('клавиатурный курсор по станциям', () => {
  /** Без входной станции стрелки некуда двигать: курсор ставится по фокусу. */
  it('фокус ставит курсор на станцию и называет её', () => {
    render(<MetroMap {...props()} />)

    fireEvent.focus(canvas())
    expect(announcement()).toBeTruthy()
    expect(canvas().getAttribute('aria-label')).toContain('выбор на станции')
  })

  it('стрелки переводят курсор на соседнюю станцию', () => {
    render(<MetroMap {...props()} />)
    fireEvent.focus(canvas())
    const first = announcement()

    fireEvent.keyDown(canvas(), { key: 'ArrowRight' })
    fireEvent.keyDown(canvas(), { key: 'ArrowRight' })
    expect(announcement()).not.toBe(first)
  })

  it.each(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])(
    'стрелка %s отменяет прокрутку страницы',
    (key) => {
      render(<MetroMap {...props()} />)
      fireEvent.focus(canvas())

      const handled = fireEvent.keyDown(canvas(), { key })
      expect(handled).toBe(false)
    },
  )

  it('уход фокуса снимает клавиатурную подсветку', () => {
    render(<MetroMap {...props()} />)
    fireEvent.focus(canvas())
    expect(canvas().getAttribute('aria-label')).toContain('выбор на станции')

    fireEvent.blur(canvas())
    flushFrames()
    // Курсор остаётся, чтобы вернуться на то же место, но подсветка снята.
    expect(calls.length).toBeGreaterThan(0)
  })

  /** Вернувшись, фокус обязан назвать ту станцию, на которой курсор остался. */
  it('повторный фокус называет прежнюю станцию', () => {
    render(<MetroMap {...props()} />)
    fireEvent.focus(canvas())
    fireEvent.keyDown(canvas(), { key: 'ArrowRight' })
    const parked = announcement()

    fireEvent.blur(canvas())
    fireEvent.focus(canvas())
    expect(announcement()).toBe(parked)
  })
})
