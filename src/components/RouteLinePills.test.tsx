// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { RouteLinePills } from './RouteLinePills.tsx'

afterEach(cleanup)

const items = () => Array.from(document.querySelectorAll('.route-line-pills-item'))
const root = () => document.querySelector('.route-line-pills')

describe('полоска цветов линий', () => {
  it('рисует по кружку на каждый цвет в порядке маршрута', () => {
    render(<RouteLinePills colors={['#d9232e', '#0078bf', '#4fb14e']} />)

    const styles = items().map((el) => (el as HTMLElement).style.backgroundColor)
    expect(styles).toEqual(['rgb(217, 35, 46)', 'rgb(0, 120, 191)', 'rgb(79, 177, 78)'])
  })

  /** Маршрут без пересадок — один цвет, полоска всё равно нужна. */
  it('одного цвета достаточно', () => {
    render(<RouteLinePills colors={['#d9232e']} />)
    expect(items()).toHaveLength(1)
  })

  /**
   * Пустой список — это не «полоска без кружков», а отсутствие полоски:
   * пустой контейнер добавил бы в вёрстку отступы вокруг ничего.
   */
  it('без цветов не рисует ничего', () => {
    const { container } = render(<RouteLinePills colors={[]} />)
    expect(container.innerHTML).toBe('')
  })

  /**
   * Цвета в маршруте повторяются (кольцо → ветка → то же кольцо), поэтому
   * ключ обязан включать позицию — иначе React уронил бы дубликаты.
   */
  it('повторяющиеся цвета не схлопываются', () => {
    render(<RouteLinePills colors={['#d9232e', '#0078bf', '#d9232e']} />)
    expect(items()).toHaveLength(3)
  })

  it('добавляет класс родителя к своему', () => {
    render(<RouteLinePills colors={['#d9232e']} className="route-option-pills" />)
    expect(root()?.className).toBe('route-line-pills route-option-pills')
  })

  it('без класса родителя лишнего пробела в классе нет', () => {
    render(<RouteLinePills colors={['#d9232e']} />)
    expect(root()?.className).toBe('route-line-pills')
  })

  /** Полоска дублирует то, что уже сказано текстом маршрута. */
  it('скрыта от скринридера', () => {
    render(<RouteLinePills colors={['#d9232e']} />)
    expect(root()?.getAttribute('aria-hidden')).toBe('true')
  })
})
