// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ThemeStationHint, type StationHint } from './ThemeStationHint.tsx'

afterEach(cleanup)

const hint = (over: Partial<StationHint> = {}): StationHint => ({
  id: 1,
  kind: 'to',
  text: 'Куда: Лубянка',
  ...over,
})

const node = () => document.querySelector('.theme-station-hint') as HTMLElement

describe('подтверждение выбора станции', () => {
  it('без подсказки рисует пустой док, а не пропадает из разметки', () => {
    render(<ThemeStationHint hint={null} />)
    expect(document.querySelector('.theme-station-hint-dock')).toBeTruthy()
    expect(node()).toBeNull()
  })

  it('показывает текст', () => {
    render(<ThemeStationHint hint={hint()} />)
    expect(screen.getByText('Куда: Лубянка')).toBeTruthy()
  })

  /**
   * Ради этого всё и переделывалось. Слева стоял цветной кружок с латинской
   * буквой A/B — той же, что рисуется маркером на карте. Рядом с русским
   * текстом латинская B неотличима от кириллической В и читалась как предлог:
   * на экране получалось «В Куда: Лубянка», где «В» ещё и другого цвета.
   */
  it('не содержит латинских A и B рядом с текстом', () => {
    render(<ThemeStationHint hint={hint()} />)
    expect(node().textContent).toBe('Куда: Лубянка')
    expect(document.querySelector('.theme-station-hint-badge')).toBeNull()
  })

  it('вместо буквы — точка цвета линии', () => {
    render(<ThemeStationHint hint={hint({ lineColor: '#E42313' })} />)
    const dot = document.querySelector('.theme-station-hint-dot') as HTMLElement
    expect(dot).toBeTruthy()
    expect(dot.style.backgroundColor).toBe('rgb(228, 35, 19)')
  })

  it('у отказа точки нет: он не про конкретное поле', () => {
    render(<ThemeStationHint hint={hint({ kind: 'info', text: 'Лубянка уже выбрана как «Куда»' })} />)
    expect(document.querySelector('.theme-station-hint-dot')).toBeNull()
  })

  it('без цвета линии точка остаётся, но берёт цвет по умолчанию', () => {
    render(<ThemeStationHint hint={hint({ lineColor: null })} />)
    const dot = document.querySelector('.theme-station-hint-dot') as HTMLElement
    expect(dot).toBeTruthy()
    expect(dot.style.backgroundColor).toBe('')
  })
})

describe('размещение у станции', () => {
  it('без точки тапа остаётся в доке под шапкой', () => {
    render(<ThemeStationHint hint={hint()} />)
    expect(document.querySelector('.theme-station-hint-dock--anchored')).toBeNull()
    expect(node().style.left).toBe('')
  })

  it('с точкой тапа встаёт над ней и по центру', () => {
    render(<ThemeStationHint hint={hint({ point: { x: 400, y: 500 } })} />)
    expect(document.querySelector('.theme-station-hint-dock--anchored')).toBeTruthy()
    // jsdom не считает раскладку, ширина нулевая — проверяем сам факт привязки
    // к координатам и то, что подсказка ушла ВЫШЕ точки.
    expect(node().style.top).toBe(`${500 - 44 - 0}px`)
    expect(node().style.left).toBe('400px')
  })

  /** У верхнего края места нет — подсказка обязана уйти под палец, а не за экран. */
  it('у верхней кромки переворачивается вниз', () => {
    render(<ThemeStationHint hint={hint({ point: { x: 200, y: 10 } })} />)
    expect(node().style.top).toBe(`${10 + 44}px`)
  })

  it('не вылезает за левый край', () => {
    render(<ThemeStationHint hint={hint({ point: { x: 0, y: 400 } })} />)
    expect(parseFloat(node().style.left)).toBeGreaterThanOrEqual(12)
  })

  it('не вылезает за правый край', () => {
    render(<ThemeStationHint hint={hint({ point: { x: 10_000, y: 400 } })} />)
    expect(parseFloat(node().style.left)).toBeLessThanOrEqual(window.innerWidth - 12)
  })
})
