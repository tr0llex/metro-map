// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SplashScreen } from './SplashScreen.tsx'

afterEach(cleanup)

const dialog = () => screen.getByRole('dialog')

describe('заставка', () => {
  it('представляет приложение', () => {
    render(<SplashScreen isDone={false} onDone={() => {}} onHidden={() => {}} />)

    expect(screen.getByRole('heading').textContent).toBe('Метро Москвы')
    expect(document.body.textContent).toContain('схема и маршруты')
  })

  /**
   * Прежняя версия рендерила шестнадцать сердец старого бренда, две звезды,
   * орбиту и десять искр; половина была скрыта стилями. Осталось восемь узлов
   * фирменного знака — и они заданы разметкой, а не случайным числом.
   */
  it('фоновых узлов ровно восемь и у каждого свой класс', () => {
    render(<SplashScreen isDone={false} onDone={() => {}} onHidden={() => {}} />)

    const nodes = Array.from(document.querySelectorAll('.app-splash-node'))
    expect(nodes).toHaveLength(8)
    expect(nodes.map((n) => n.className)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `app-splash-node app-splash-node--${n}`),
    )
  })
})

describe('пропуск заставки', () => {
  it('по нажатию', () => {
    const onDone = vi.fn()
    render(<SplashScreen isDone={false} onDone={onDone} onHidden={() => {}} />)

    fireEvent.click(dialog())
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  /** С клавиатуры заставка обязана пропускаться теми же клавишами, что и любой диалог. */
  it.each(['Enter', ' ', 'Escape'])('по клавише %s', (key) => {
    const onDone = vi.fn()
    render(<SplashScreen isDone={false} onDone={onDone} onHidden={() => {}} />)

    fireEvent.keyDown(dialog(), { key })
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('прочие клавиши заставку не трогают', () => {
    const onDone = vi.fn()
    render(<SplashScreen isDone={false} onDone={onDone} onHidden={() => {}} />)

    fireEvent.keyDown(dialog(), { key: 'a' })
    fireEvent.keyDown(dialog(), { key: 'Tab' })
    expect(onDone).not.toHaveBeenCalled()
  })

  it('заставка получает фокус — иначе клавиатура до неё не дошла бы', () => {
    render(<SplashScreen isDone={false} onDone={() => {}} onHidden={() => {}} />)
    expect(dialog().getAttribute('tabindex')).toBe('0')
  })
})

describe('снятие с монтирования', () => {
  /**
   * Пока анимация исчезновения не доиграла, заставка обязана оставаться в DOM:
   * снять её раньше — значит показать скачок вместо перехода.
   */
  it('о завершении анимации сообщает только после isDone', () => {
    const onHidden = vi.fn()
    const { rerender } = render(
      <SplashScreen isDone={false} onDone={() => {}} onHidden={onHidden} />,
    )

    fireEvent.transitionEnd(dialog())
    expect(onHidden).not.toHaveBeenCalled()

    rerender(<SplashScreen isDone onDone={() => {}} onHidden={onHidden} />)
    fireEvent.transitionEnd(dialog())
    expect(onHidden).toHaveBeenCalledTimes(1)
  })

  /**
   * Внутри заставки анимированы восемь узлов и карточка. Без проверки цели
   * первый же доигравший узел снимал бы заставку целиком.
   */
  it('анимация вложенного узла заставку не снимает', () => {
    const onHidden = vi.fn()
    render(<SplashScreen isDone onDone={() => {}} onHidden={onHidden} />)

    fireEvent.transitionEnd(document.querySelector('.app-splash-node')!)
    expect(onHidden).not.toHaveBeenCalled()
  })

  it('признак «скрыта» отражён классом', () => {
    const { rerender } = render(
      <SplashScreen isDone={false} onDone={() => {}} onHidden={() => {}} />,
    )
    expect(dialog().className).toBe('app-splash')

    rerender(<SplashScreen isDone onDone={() => {}} onHidden={() => {}} />)
    expect(dialog().className).toBe('app-splash app-splash--hidden')
  })
})
