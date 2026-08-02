// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { StationPickPopover } from './StationPickPopover.tsx'

// Без globals: true у vitest автоочистка @testing-library не включается, и
// отрисованные поповеры копятся в документе — getByRole находит несколько.
afterEach(cleanup)

type Props = Parameters<typeof StationPickPopover>[0]

function setup(over: Partial<Props> = {}) {
  const onPick = vi.fn()
  const props: Props = {
    data: { stationId: '1/krylatskoe', stationName: 'Крылатское' } as Props['data'],
    isClosing: false,
    pressed: null,
    position: { left: 100, top: 200 },
    popoverRef: createRef<HTMLDivElement>(),
    lineColor: '#0072BA',
    onPick,
    ...over,
  }
  render(<StationPickPopover {...props} />)
  return { onPick }
}

describe('поповер выбора поля', () => {
  it('показывает название станции и две кнопки', () => {
    setup()
    expect(screen.getByText('Крылатское')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Откуда/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Куда/ })).toBeTruthy()
  })

  /**
   * Кнопка показывает ровно одно слово. Прежде при занятых полях под ним
   * появлялась вторая строка «вместо …», из-за чего кнопки становились
   * двухстрочными, а поповер — вдвое выше.
   */
  it('на кнопке только «Откуда» и «Куда», без пояснений', () => {
    setup({ currentFromTitle: 'Полежаевская', currentToTitle: 'Сокольники' })

    const from = screen.getByRole('button', { name: /в поле «Откуда»/ })
    const to = screen.getByRole('button', { name: /в поле «Куда»/ })

    expect(from.textContent).toBe('Откуда')
    expect(to.textContent).toBe('Куда')
    expect(document.body.textContent).not.toContain('вместо')
  })

  /**
   * Диктору поля не видно, поэтому «Куда» без уточнения звучало бы как
   * «добавить ещё одну станцию». В подписи для него пояснение остаётся.
   */
  it('замена названа в aria-label, когда поле занято', () => {
    setup({ currentFromTitle: 'Полежаевская' })
    expect(
      screen.getByRole('button', { name: 'Поставить «Крылатское» в поле «Откуда» вместо «Полежаевская»' }),
    ).toBeTruthy()
  })

  it('у пустого поля пояснения нет', () => {
    setup()
    expect(screen.getByRole('button', { name: 'Поставить «Крылатское» в поле «Откуда»' })).toBeTruthy()
  })

  /** Замена станции на саму себя — не замена, уточнять нечего. */
  it('та же станция в поле не считается заменой', () => {
    setup({ currentFromTitle: 'Крылатское' })
    expect(screen.getByRole('button', { name: 'Поставить «Крылатское» в поле «Откуда»' })).toBeTruthy()
  })

  it('нажатие сообщает выбранное поле', () => {
    const { onPick } = setup()
    screen.getByRole('button', { name: /в поле «Куда»/ }).click()
    expect(onPick).toHaveBeenCalledWith('to')
  })

  it('нажатая кнопка помечена для мгновенной подсветки', () => {
    setup({ pressed: 'from' })
    expect(screen.getByRole('button', { name: /Откуда/ }).dataset.pressed).toBe('true')
    expect(screen.getByRole('button', { name: /Куда/ }).dataset.pressed).toBeUndefined()
  })

  /** Пока позиция не измерена, поповер не должен мигать в углу экрана. */
  it('без позиции рисуется скрытым', () => {
    setup({ position: null })
    // hidden: true — скрытые элементы getByRole по умолчанию не находит.
    const popover = screen.getByRole('dialog', { hidden: true })
    expect(popover.style.visibility).toBe('hidden')
  })

  it('цвет линии попадает в точку у названия', () => {
    setup({ lineColor: '#E42313' })
    const dot = document.querySelector('.station-pick-popover-line-dot') as HTMLElement
    expect(dot.style.backgroundColor).toBe('rgb(228, 35, 19)')
  })
})
