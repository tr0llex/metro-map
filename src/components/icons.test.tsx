// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  IconClock,
  IconClose,
  IconHistory,
  IconPin,
  IconRefresh,
  IconShare,
  IconStar,
  IconSwap,
} from './icons.tsx'

afterEach(cleanup)

const ICONS = [
  ['IconSwap', IconSwap],
  ['IconStar', IconStar],
  ['IconClose', IconClose],
  ['IconPin', IconPin],
  ['IconHistory', IconHistory],
  ['IconClock', IconClock],
  ['IconRefresh', IconRefresh],
  ['IconShare', IconShare],
] as const

const svg = (container: HTMLElement) => container.querySelector('svg')!

describe.each(ICONS)('%s', (_name, Icon) => {
  /** Размер по умолчанию — кегль родителя, чтобы иконку можно было ставить в любой чип. */
  it('по умолчанию размером в 1em', () => {
    const { container } = render(<Icon />)
    expect(svg(container).getAttribute('width')).toBe('1em')
    expect(svg(container).getAttribute('height')).toBe('1em')
  })

  it('размер задаётся снаружи', () => {
    const { container } = render(<Icon size={18} />)
    expect(svg(container).getAttribute('width')).toBe('18')
    expect(svg(container).getAttribute('height')).toBe('18')
  })

  /** Иконка — украшение рядом с подписью; озвучивать её значит читать смысл дважды. */
  it('скрыта от скринридера и не ловит фокус', () => {
    const { container } = render(<Icon />)
    expect(svg(container).getAttribute('aria-hidden')).toBe('true')
    expect(svg(container).getAttribute('focusable')).toBe('false')
  })

  /** Цвет наследуется, иначе иконка не переживала бы смену темы. */
  it('красится currentColor', () => {
    const { container } = render(<Icon />)
    expect(svg(container).getAttribute('stroke')).toBe('currentColor')
  })

  it('рисует геометрию, а не пустоту', () => {
    const { container } = render(<Icon />)
    expect(svg(container).children.length).toBeGreaterThan(0)
    expect(svg(container).getAttribute('viewBox')).toBe('0 0 24 24')
  })

  it('пропускает произвольные атрибуты наружу', () => {
    const { container } = render(<Icon className="chip-icon" />)
    expect(svg(container).getAttribute('class')).toBe('chip-icon')
  })
})

describe('IconStar', () => {
  /**
   * Единственная иконка с состоянием: пустая звезда — «добавить в избранное»,
   * залитая — «уже там». Разница обязана быть видимой.
   */
  it('пустая не залита, отмеченная залита', () => {
    const { container: empty } = render(<IconStar />)
    expect(svg(empty).getAttribute('fill')).toBe('none')

    const { container: filled } = render(<IconStar filled />)
    expect(svg(filled).getAttribute('fill')).toBe('currentColor')
  })

  /** filled — состояние компонента, а не атрибут svg. */
  it('не протекает атрибутом в разметку', () => {
    const { container } = render(<IconStar filled />)
    expect(svg(container).hasAttribute('filled')).toBe(false)
  })
})
