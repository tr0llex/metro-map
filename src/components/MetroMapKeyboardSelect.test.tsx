// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
 * Выбор станции и масштаб с клавиатуры.
 *
 * Схема монтируется на каждый тест: внутреннее состояние — клавиатурный
 * курсор, начатый жест, текущий масштаб — переживает перерисовку, и общий
 * рендер сделал бы тесты зависимыми по порядку. Файл выделен отдельным,
 * чтобы монтирования шли параллельно с соседними наборами карты.
 */
installMetroMapHarness()

describe('выбор станции и масштаб с клавиатуры', () => {
  /**
   * Раньше здесь безусловно сообщался успех — даже когда выбор вообще не
   * доходил до полей. Объявляем то, что случилось на самом деле.
   */
  it.each([
    ['from', 'выбрана как «Откуда»'],
    ['to', 'выбрана как «Куда»'],
    ['ask', 'оба поля заняты'],
  ] as const)('исход выбора %s объявляется своими словами', (outcome, expected) => {
    const onSelectStation = vi.fn(() => outcome)
    render(<MetroMap {...props({ onSelectStation })} />)

    fireEvent.focus(canvas())
    fireEvent.keyDown(canvas(), { key: 'Enter' })

    expect(onSelectStation).toHaveBeenCalled()
    expect(announcement()).toContain(expected)
  })

  it('пробел выбирает станцию так же, как Enter', () => {
    const onSelectStation = vi.fn(() => 'from' as const)
    render(<MetroMap {...props({ onSelectStation })} />)

    fireEvent.focus(canvas())
    fireEvent.keyDown(canvas(), { key: ' ' })
    expect(onSelectStation).toHaveBeenCalledTimes(1)
  })

  /** Enter без курсора выбирать нечего — и падать тут нельзя. */
  it('Enter без курсора ничего не выбирает', () => {
    const onSelectStation = vi.fn()
    render(<MetroMap {...props({ onSelectStation })} />)

    fireEvent.keyDown(canvas(), { key: 'Enter' })
    expect(onSelectStation).not.toHaveBeenCalled()
  })

  it.each(['+', '=', '-', '_'])('клавиша %s меняет масштаб', (key) => {
    render(<MetroMap {...props()} />)
    flushFrames()
    calls.length = 0

    const handled = fireEvent.keyDown(canvas(), { key })
    flushFrames()

    expect(handled).toBe(false)
    expect(calls.length).toBeGreaterThan(0)
  })

  it('посторонние клавиши схему не трогают', () => {
    const onSelectStation = vi.fn()
    render(<MetroMap {...props({ onSelectStation })} />)
    fireEvent.focus(canvas())

    const handled = fireEvent.keyDown(canvas(), { key: 'a' })
    expect(handled).toBe(true)
    expect(onSelectStation).not.toHaveBeenCalled()
  })

  /** Уже выбранная станция — не отказ приложения, и сказать надо именно это. */
  it('повторный выбор той же станции объясняется', () => {
    const onSelectStation = vi.fn(() => 'noop' as const)
    render(<MetroMap {...props({ onSelectStation })} />)

    fireEvent.focus(canvas())
    fireEvent.keyDown(canvas(), { key: 'Enter' })
    expect(announcement()).toBeTruthy()
  })
})
