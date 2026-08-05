// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RouteHeader } from './RouteHeader.tsx'

afterEach(cleanup)

const props = {
  logoSrc: '/metro-logo.svg',
  logoAlt: 'Метро Москвы',
  headerTitle: 'Арбатская → Китай-город',
  headerChipClassName: 'app-header-chip',
  onChipClick: () => {},
  isDesktop: false,
}

describe('шапка на телефоне', () => {
  /**
   * Свёрнутая шторка прячет поля ввода, и чип остаётся единственным местом,
   * где виден выбранный маршрут.
   */
  it('показывает маршрут в чипе', () => {
    render(<RouteHeader {...props} />)
    expect(screen.getByRole('button').textContent).toBe('Арбатская → Китай-город')
  })

  it('нажатие на чип раскрывает шторку', () => {
    const onChipClick = vi.fn()
    render(<RouteHeader {...props} onChipClick={onChipClick} />)

    fireEvent.click(screen.getByRole('button'))
    expect(onChipClick).toHaveBeenCalledTimes(1)
  })

  /** Класс приходит снаружи — от него зависит подсветка незаполненного поля. */
  it('берёт класс чипа у родителя', () => {
    render(<RouteHeader {...props} headerChipClassName="app-header-chip is-empty" />)
    expect(screen.getByRole('button').className).toBe('app-header-chip is-empty')
  })

  it('названия продукта в шапке нет — оно заняло бы место маршрута', () => {
    render(<RouteHeader {...props} />)
    expect(document.body.textContent).not.toContain('Схема и маршруты')
  })
})

describe('шапка при боковой панели', () => {
  /**
   * Ради этого чип и убрали: при видимых полях ввода он дословно повторял их
   * содержимое, а его действие относилось к уже раскрытой панели.
   */
  it('вместо чипа показывает название продукта', () => {
    render(<RouteHeader {...props} isDesktop />)

    expect(screen.queryByRole('button')).toBeNull()
    expect(document.body.textContent).toContain('Метро Москвы')
    expect(document.body.textContent).toContain('Схема и маршруты')
  })

  it('маршрут в шапке не дублируется', () => {
    render(<RouteHeader {...props} isDesktop />)
    expect(document.body.textContent).not.toContain('Арбатская → Китай-город')
  })
})

describe('логотип', () => {
  it('берёт адрес и подпись у родителя в обеих раскладках', () => {
    for (const isDesktop of [false, true]) {
      render(<RouteHeader {...props} isDesktop={isDesktop} />)
      const img = screen.getByRole('img')
      expect(img.getAttribute('src')).toBe('/metro-logo.svg')
      expect(img.getAttribute('alt')).toBe('Метро Москвы')
      cleanup()
    }
  })
})
