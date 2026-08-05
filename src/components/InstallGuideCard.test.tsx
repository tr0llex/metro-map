// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { InstallGuideCard, type InstallGuidePlatform } from './InstallGuideCard.tsx'

afterEach(cleanup)

const steps = () =>
  Array.from(document.querySelectorAll('.install-guide-steps li')).map((el) => el.textContent)

const closeButton = () => screen.getByRole('button', { name: 'Понятно' })

describe('инструкция по установке', () => {
  it('объясняет, зачем ставить приложение', () => {
    render(<InstallGuideCard platform="ios" onClose={() => {}} />)

    expect(screen.getByRole('heading').textContent).toBe('Поставь метро как приложение')
    expect(document.body.textContent).toContain('офлайн')
  })

  /**
   * Шаги установки у платформ разные, и общая инструкция «найди в меню» на
   * iOS не работает вовсе: там пункт спрятан в шите «Поделиться».
   */
  it.each([
    ['ios', 'Safari на iPhone или iPad', 'Поделиться'],
    ['android', 'Chrome на Android', 'Chrome'],
    ['desktop', 'Настольный браузер', 'адресной строки'],
    ['unknown', 'Ваш браузер', 'меню браузера'],
  ] as const)('для %s даёт свои шаги', (platform, chip, hint) => {
    render(<InstallGuideCard platform={platform as InstallGuidePlatform} onClose={() => {}} />)

    expect(document.querySelector('.install-guide-platform-chip')?.textContent).toBe(chip)
    expect(steps().join(' ')).toContain(hint)
    expect(steps()).toHaveLength(3)
  })

  /** Карточка — модальный диалог; связь заголовка с ролью держится на id. */
  it('заголовок и подпись связаны с диалогом', () => {
    render(<InstallGuideCard platform="ios" onClose={() => {}} />)

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')

    const titleId = dialog.getAttribute('aria-labelledby')!
    const subtitleId = dialog.getAttribute('aria-describedby')!
    expect(document.getElementById(titleId)?.textContent).toBe('Поставь метро как приложение')
    expect(document.getElementById(subtitleId)?.textContent).toContain('главном экране')
  })

  /**
   * Две карточки на странице одновременно не живут, но id всё равно обязан
   * быть уникальным: useId — единственное, что это гарантирует.
   */
  it('id заголовков уникальны между экземплярами', () => {
    const { container: a } = render(<InstallGuideCard platform="ios" onClose={() => {}} />)
    const { container: b } = render(<InstallGuideCard platform="ios" onClose={() => {}} />)

    expect(a.querySelector('[role=dialog]')!.getAttribute('aria-labelledby')).not.toBe(
      b.querySelector('[role=dialog]')!.getAttribute('aria-labelledby'),
    )
  })

  it('закрывается кнопкой', () => {
    const onClose = vi.fn()
    render(<InstallGuideCard platform="ios" onClose={onClose} />)

    fireEvent.click(closeButton())
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

/**
 * A11Y-7. Карточка объявлена модальной, но фокус не держала: Tab уводил на
 * кнопки зума карты, тумблер темы и чип шапки — на весь фон, который для
 * скринридера обязан быть недоступен. Собственная кнопка «Понятно» за восемь
 * нажатий Tab так и не достигалась, Escape тоже ничего не делал.
 */
describe('ловушка фокуса', () => {
  it('фокус уходит на кнопку сразу при открытии', () => {
    render(<InstallGuideCard platform="ios" onClose={() => {}} />)
    expect(document.activeElement).toBe(closeButton())
  })

  it('Escape закрывает', () => {
    const onClose = vi.fn()
    render(<InstallGuideCard platform="ios" onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  /**
   * В карточке фокусируемый элемент один, поэтому Tab обязан возвращать на
   * него же — иначе следующим нажатием фокус уедет на фон.
   */
  it('Tab не выпускает фокус наружу', () => {
    render(<InstallGuideCard platform="ios" onClose={() => {}} />)

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(closeButton())

    fireEvent.keyDown(document, { key: 'Shift', shiftKey: true })
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(closeButton())
  })

  /**
   * Мышью по фону фокус уезжает наружу — Tab обязан втянуть его обратно.
   *
   * offsetParent в jsdom всегда null, поэтому фильтр видимости выбросил бы все
   * элементы карточки и до втягивания дело не дошло бы; подменяем его.
   */
  it('фокус, уехавший на фон, возвращается в карточку', () => {
    const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get() {
        return document.body
      },
    })

    const outside = document.createElement('button')
    document.body.appendChild(outside)

    render(<InstallGuideCard platform="ios" onClose={() => {}} />)
    outside.focus()
    expect(document.activeElement).toBe(outside)

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(closeButton())

    outside.remove()
    if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetParent
  })

  /**
   * Тот же путь, но с shift: фокус снаружи возвращается на первый элемент
   * независимо от направления обхода.
   */
  it('видимые элементы карточки зацикливают Tab внутри неё', () => {
    const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get() {
        return document.body
      },
    })

    render(<InstallGuideCard platform="ios" onClose={() => {}} />)

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(closeButton())

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(closeButton())

    if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent)
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetParent
  })

  /** Клавиши, к карточке не относящиеся, проходят мимо неё. */
  it('прочие клавиши не перехватываются', () => {
    const onClose = vi.fn()
    render(<InstallGuideCard platform="ios" onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'a' })
    fireEvent.keyDown(document, { key: 'ArrowDown' })
    expect(onClose).not.toHaveBeenCalled()
  })

  /** Человек вернулся туда, откуда открыл карточку, а не в начало страницы. */
  it('после закрытия фокус возвращается на прежний элемент', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()

    const { unmount } = render(<InstallGuideCard platform="ios" onClose={() => {}} />)
    expect(document.activeElement).toBe(closeButton())

    unmount()
    expect(document.activeElement).toBe(opener)

    opener.remove()
  })

  /** Подписка на document обязана сниматься вместе с карточкой. */
  it('снятая карточка на Escape не отзывается', () => {
    const onClose = vi.fn()
    const { unmount } = render(<InstallGuideCard platform="ios" onClose={onClose} />)
    unmount()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
