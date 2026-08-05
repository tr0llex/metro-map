// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UpdateBanner } from './UpdateBanner.tsx'

afterEach(cleanup)

describe('баннер обновления', () => {
  it('объясняет, что произошло и что предлагается', () => {
    render(<UpdateBanner onUpdate={() => {}} onLater={() => {}} />)

    expect(screen.getByText('Доступно обновление')).toBeTruthy()
    expect(screen.getByText('Обновить приложение сейчас?')).toBeTruthy()
  })

  /**
   * Отказ обязан быть равноправным действием: при registerType 'prompt' новый
   * SW ждёт явного согласия, и баннер без «Позже» не оставлял бы выбора.
   */
  it('даёт и согласиться, и отложить', () => {
    const onUpdate = vi.fn()
    const onLater = vi.fn()
    render(<UpdateBanner onUpdate={onUpdate} onLater={onLater} />)

    fireEvent.click(screen.getByRole('button', { name: 'Позже' }))
    expect(onLater).toHaveBeenCalledTimes(1)
    expect(onUpdate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Обновить' }))
    expect(onUpdate).toHaveBeenCalledTimes(1)
    expect(onLater).toHaveBeenCalledTimes(1)
  })

  /** Баннер появляется сам, без действия пользователя — о нём надо объявить. */
  it('объявляется скринридеру как статус', () => {
    render(<UpdateBanner onUpdate={() => {}} onLater={() => {}} />)

    const banner = screen.getByRole('status')
    expect(banner.getAttribute('aria-live')).toBe('polite')
  })

  /**
   * Раньше здесь стоял текстовый глиф ⟳: его рисунок зависел от системного
   * шрифта, а на части Android он подменялся тофу.
   */
  it('иконка — инлайновый svg, а не глиф шрифта', () => {
    render(<UpdateBanner onUpdate={() => {}} onLater={() => {}} />)

    const icon = document.querySelector('.update-banner-icon')
    expect(icon?.querySelector('svg')).toBeTruthy()
    expect(icon?.textContent).toBe('')
  })

  it('кнопки не сабмитят форму', () => {
    render(<UpdateBanner onUpdate={() => {}} onLater={() => {}} />)
    for (const button of screen.getAllByRole('button')) {
      expect(button.getAttribute('type')).toBe('button')
    }
  })
})
