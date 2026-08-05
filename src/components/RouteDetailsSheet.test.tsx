// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RouteResult } from '../metro/types.ts'
import { RouteDetailsSheet, type DecoratedSegment } from './RouteDetailsSheet.tsx'

afterEach(cleanup)

const route = (over: Partial<RouteResult> = {}): RouteResult =>
  ({ totalMinutes: 24, transfersCount: 1, ...over }) as RouteResult

const ride = (over: Partial<Extract<DecoratedSegment, { type: 'ride' }>> = {}): DecoratedSegment => ({
  type: 'ride',
  key: 'ride-1',
  fromTitle: 'Арбатская',
  toTitle: 'Курская',
  lineColor: '#0078bf',
  stationTitles: ['Площадь Революции', 'Курская'],
  travelMinutes: 6.4,
  ...over,
})

const transfer = (
  over: Partial<Extract<DecoratedSegment, { type: 'transfer' }>> = {},
): DecoratedSegment => ({
  type: 'transfer',
  key: 'transfer-1',
  fromTitle: 'Курская',
  toTitle: 'Чкаловская',
  fromLineColor: '#0078bf',
  toLineColor: '#99a3a4',
  travelMinutes: 3.2,
  isFar: false,
  ...over,
})

function props(over: Partial<Parameters<typeof RouteDetailsSheet>[0]> = {}) {
  return {
    routeResult: route(),
    routeAlternatives: [route()],
    activeRouteIndex: 0,
    onChangeActiveRoute: vi.fn(),
    errorMessage: null,
    isDesktop: false,
    isRouteSheetOpen: true,
    decoratedSegments: [ride()] as DecoratedSegment[],
    ...over,
  }
}

const steps = () => Array.from(document.querySelectorAll('.route-step'))
const details = () => document.querySelector('.bottom-route-details')

describe('когда шторке нечего показывать', () => {
  it('без маршрута деталей нет', () => {
    const { container } = render(<RouteDetailsSheet {...props({ routeResult: null })} />)
    expect(container.innerHTML).toBe('')
  })

  /** Экран ошибки заменяет детали целиком: показывать оба сразу — противоречие. */
  it('при ошибке детали уступают место сообщению', () => {
    const { container } = render(
      <RouteDetailsSheet {...props({ errorMessage: 'Маршрут не найден' })} />,
    )
    expect(container.innerHTML).toBe('')
  })
})

describe('сводка маршрута', () => {
  it('показывает время и число пересадок', () => {
    render(<RouteDetailsSheet {...props()} />)

    expect(document.querySelector('.summary-time')?.textContent).toContain('24 мин')
    expect(document.querySelector('.summary-transfers')?.textContent).toBe('1 пересадка')
  })

  /** Русские числительные: «1 пересадка», «2 пересадки», «5 пересадок». */
  it.each([
    [0, 'Без пересадок'],
    [1, '1 пересадка'],
    [2, '2 пересадки'],
    [5, '5 пересадок'],
  ])('%i пересадок склоняется как «%s»', (count, expected) => {
    render(<RouteDetailsSheet {...props({ routeResult: route({ transfersCount: count }) })} />)
    expect(document.querySelector('.summary-transfers')?.textContent).toBe(expected)
  })

  it('время прибытия показывает, когда оно известно', () => {
    const { rerender } = render(<RouteDetailsSheet {...props()} />)
    expect(document.querySelector('.summary-arrival')).toBeNull()

    rerender(<RouteDetailsSheet {...props({ arrivalTimeLabel: '14:32' })} />)
    expect(document.querySelector('.summary-arrival')?.textContent).toContain('14:32')
  })
})

describe('шаги маршрута', () => {
  it('поездку описывает станциями и временем', () => {
    render(<RouteDetailsSheet {...props()} />)

    expect(document.querySelector('.step-title')?.textContent).toBe(
      'Поезд: Арбатская → Курская',
    )
    expect(document.querySelector('.step-meta')?.textContent).toContain('2 станции')
    expect(document.querySelector('.step-meta')?.textContent).toContain('6 мин')
  })

  it('перечисляет промежуточные станции', () => {
    render(<RouteDetailsSheet {...props()} />)

    const names = Array.from(document.querySelectorAll('.step-station-name')).map(
      (el) => el.textContent,
    )
    expect(names).toEqual(['Площадь Революции', 'Курская'])
  })

  /**
   * Без --step-line-color весь список промежуточных станций был серым и не
   * связывался с веткой поездки.
   */
  it('красит шаг и точки станций цветом линии', () => {
    render(<RouteDetailsSheet {...props()} />)

    const step = steps()[0] as HTMLElement
    expect(step.style.getPropertyValue('--step-line-color')).toBe('#0078bf')
    expect(
      (document.querySelector('.line-pill') as HTMLElement).style.backgroundColor,
    ).toBe('rgb(0, 120, 191)')
  })

  it('без цвета линии шаг остаётся нейтральным', () => {
    render(
      <RouteDetailsSheet {...props({ decoratedSegments: [ride({ lineColor: undefined })] })} />,
    )

    const step = steps()[0] as HTMLElement
    expect(step.style.getPropertyValue('--step-line-color')).toBe('')
    expect((document.querySelector('.line-pill') as HTMLElement).style.backgroundColor).toBe('')
  })

  it('пересадку показывает двумя цветами и своим временем', () => {
    render(<RouteDetailsSheet {...props({ decoratedSegments: [transfer()] })} />)

    expect(document.querySelector('.step-title')?.textContent).toBe(
      'Пересадка: Курская → Чкаловская',
    )
    expect(document.querySelector('.step-meta')?.textContent).toContain('Переход')
    expect(document.querySelector('.step-meta')?.textContent).toContain('3 мин')

    const halves = Array.from(document.querySelectorAll('.line-pill-half')) as HTMLElement[]
    expect(halves.map((h) => h.style.backgroundColor)).toEqual([
      'rgb(0, 120, 191)',
      'rgb(153, 163, 164)',
    ])
  })

  /** Дальний переход — отдельная история: он может занять больше, чем перегон. */
  it('дальний переход называется своим именем', () => {
    render(<RouteDetailsSheet {...props({ decoratedSegments: [transfer({ isFar: true })] })} />)

    expect(document.querySelector('.step-title')?.textContent).toContain('Дальний переход')
    expect(document.querySelector('.step-meta')?.textContent).toContain('Дальний переход')
  })

  it('пересадка без цветов линий не падает', () => {
    render(
      <RouteDetailsSheet
        {...props({
          decoratedSegments: [transfer({ fromLineColor: undefined, toLineColor: undefined })],
        })}
      />,
    )

    const halves = Array.from(document.querySelectorAll('.line-pill-half')) as HTMLElement[]
    expect(halves.map((h) => h.style.backgroundColor)).toEqual(['', ''])
  })

  it('поездки и пересадки идут в заданном порядке', () => {
    render(
      <RouteDetailsSheet
        {...props({
          decoratedSegments: [ride(), transfer(), ride({ key: 'ride-2' })],
        })}
      />,
    )

    expect(steps()).toHaveLength(3)
    expect(steps()[1].className).toContain('route-step--transfer')
  })

  /** Индекс шага уезжает в стили: по нему шаги проявляются каскадом, а не разом. */
  it('шаги нумеруются для каскадной анимации', () => {
    render(
      <RouteDetailsSheet {...props({ decoratedSegments: [ride(), transfer()] })} />,
    )

    expect((steps()[0] as HTMLElement).style.getPropertyValue('--stagger-index')).toBe('0')
    expect((steps()[1] as HTMLElement).style.getPropertyValue('--stagger-index')).toBe('1')
  })
})

describe('перезапуск анимации шагов', () => {
  const list = () => document.querySelector('.route-steps')

  /** Ключ списка меняется — React пересоздаёт узлы, и анимация играет заново. */
  it('раскрытие шторки проигрывает шаги заново', () => {
    const { rerender } = render(<RouteDetailsSheet {...props({ isRouteSheetOpen: false })} />)
    const before = list()

    rerender(<RouteDetailsSheet {...props({ isRouteSheetOpen: true })} />)
    expect(list()).not.toBe(before)
    expect(list()?.className).toContain('route-steps--animate')
  })

  it('смена варианта маршрута тоже', () => {
    const { rerender } = render(<RouteDetailsSheet {...props()} />)
    const before = list()

    rerender(<RouteDetailsSheet {...props({ activeRouteIndex: 1 })} />)
    expect(list()).not.toBe(before)
  })

  /** У свёрнутой шторки анимации не видно — перезапускать её незачем. */
  it('у свёрнутой шторки смена варианта анимацию не трогает', () => {
    const { rerender } = render(
      <RouteDetailsSheet {...props({ isRouteSheetOpen: false })} />,
    )
    const before = list()

    rerender(
      <RouteDetailsSheet {...props({ isRouteSheetOpen: false, activeRouteIndex: 1 })} />,
    )
    expect(list()).toBe(before)
    expect(list()?.className).not.toContain('route-steps--animate')
  })

  it('состояние шторки отражено классом', () => {
    const { rerender } = render(<RouteDetailsSheet {...props()} />)
    expect(details()?.className).toContain('bottom-route-details--open')

    rerender(<RouteDetailsSheet {...props({ isRouteSheetOpen: false })} />)
    expect(details()?.className).toContain('bottom-route-details--closed')
  })
})

describe('варианты маршрута', () => {
  const three = [
    route({ totalMinutes: 24, transfersCount: 1 }),
    route({ totalMinutes: 27, transfersCount: 0 }),
    route({ totalMinutes: 31, transfersCount: 2 }),
  ]

  /** На телефоне ленту вариантов рисует шторка, а не этот блок. */
  it('лента показывается только в боковой панели', () => {
    const { rerender } = render(
      <RouteDetailsSheet {...props({ routeAlternatives: three })} />,
    )
    expect(document.querySelector('.route-choices-desktop')).toBeNull()

    rerender(<RouteDetailsSheet {...props({ routeAlternatives: three, isDesktop: true })} />)
    expect(document.querySelectorAll('.route-choice-chip')).toHaveLength(3)
  })

  /** Единственный вариант выбирать не из чего. */
  it('при одном варианте ленты нет', () => {
    render(<RouteDetailsSheet {...props({ isDesktop: true })} />)
    expect(document.querySelector('.route-choices-desktop')).toBeNull()
  })

  it('активный вариант выделен', () => {
    render(
      <RouteDetailsSheet
        {...props({ routeAlternatives: three, isDesktop: true, activeRouteIndex: 1 })}
      />,
    )

    const chips = Array.from(document.querySelectorAll('.route-choice-chip'))
    expect(chips[1].className).toContain('bottom-route-chip--active')
    expect(chips[0].className).not.toContain('bottom-route-chip--active')
  })

  it('выбор варианта уходит наверх', () => {
    const p = props({ routeAlternatives: three, isDesktop: true })
    render(<RouteDetailsSheet {...p} />)

    fireEvent.click(document.querySelectorAll('.route-choice-chip')[2])
    expect(p.onChangeActiveRoute).toHaveBeenCalledWith(2)
  })

  /** Скринридер обязан различать варианты: у них одинаковая иконка и разметка. */
  it('каждый вариант подписан временем и пересадками', () => {
    render(<RouteDetailsSheet {...props({ routeAlternatives: three, isDesktop: true })} />)

    const labels = Array.from(document.querySelectorAll('.route-choice-chip')).map((c) =>
      c.getAttribute('aria-label'),
    )
    expect(labels).toEqual([
      'Выбрать маршрут: ~24 мин, 1 пересадка',
      'Выбрать маршрут: ~27 мин, без пересадок',
      'Выбрать маршрут: ~31 мин, 2 пересадки',
    ])
  })

  /** В метро вариант опознают по цветам веток, а не по числу пересадок. */
  it('вариант показывает цвета своих линий', () => {
    render(
      <RouteDetailsSheet
        {...props({
          routeAlternatives: three,
          isDesktop: true,
          routeLineColors: [['#d9232e'], ['#0078bf', '#4fb14e'], []],
        })}
      />,
    )

    const chips = Array.from(document.querySelectorAll('.route-choice-chip'))
    expect(chips[0].querySelectorAll('.route-line-pills-item')).toHaveLength(1)
    expect(chips[1].querySelectorAll('.route-line-pills-item')).toHaveLength(2)
    expect(chips[2].querySelector('.route-line-pills')).toBeNull()
  })

  it('без цветов линий вариант всё равно рисуется', () => {
    render(<RouteDetailsSheet {...props({ routeAlternatives: three, isDesktop: true })} />)
    expect(document.querySelectorAll('.route-choice-chip')).toHaveLength(3)
  })
})

describe('действия над маршрутом', () => {
  /** Кнопки необязательны: в редакторе и в прод-сборке набор действий разный. */
  it('без обработчиков кнопок нет', () => {
    render(<RouteDetailsSheet {...props()} />)

    expect(screen.queryByRole('button', { name: /Поделиться/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /избранн/ })).toBeNull()
  })

  it('делится маршрутом', () => {
    const onShareRoute = vi.fn()
    render(<RouteDetailsSheet {...props({ onShareRoute })} />)

    fireEvent.click(screen.getByRole('button', { name: 'Поделиться ссылкой на маршрут' }))
    expect(onShareRoute).toHaveBeenCalledTimes(1)
  })

  it('результат «Поделиться» объявляется скринридеру', () => {
    const { rerender } = render(<RouteDetailsSheet {...props({ onShareRoute: vi.fn() })} />)

    const hint = screen.getByRole('status')
    expect(hint.getAttribute('aria-live')).toBe('polite')
    expect(hint.textContent).toBe('')

    rerender(
      <RouteDetailsSheet
        {...props({ onShareRoute: vi.fn(), shareHint: 'Ссылка на маршрут скопирована' })}
      />,
    )
    expect(screen.getByRole('status').textContent).toBe('Ссылка на маршрут скопирована')
  })

  it('добавляет и убирает маршрут из избранного', () => {
    const onToggleFavoriteRoute = vi.fn()
    const { rerender } = render(
      <RouteDetailsSheet {...props({ onToggleFavoriteRoute })} />,
    )

    const add = screen.getByRole('button', { name: 'Добавить маршрут в избранное' })
    expect(add.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(add)
    expect(onToggleFavoriteRoute).toHaveBeenCalledTimes(1)

    rerender(
      <RouteDetailsSheet {...props({ onToggleFavoriteRoute, isFavoriteRoute: true })} />,
    )
    const remove = screen.getByRole('button', { name: 'Убрать маршрут из избранного' })
    expect(remove.getAttribute('aria-pressed')).toBe('true')
    expect(remove.className).toContain('route-favorite-button--active')
  })

  /** Залитая звезда — единственный видимый признак «маршрут уже в избранном». */
  it('звезда залита только у избранного маршрута', () => {
    const { rerender } = render(
      <RouteDetailsSheet {...props({ onToggleFavoriteRoute: vi.fn() })} />,
    )
    expect(
      document.querySelector('.route-favorite-button svg')?.getAttribute('fill'),
    ).toBe('none')

    rerender(
      <RouteDetailsSheet
        {...props({ onToggleFavoriteRoute: vi.fn(), isFavoriteRoute: true })}
      />,
    )
    expect(
      document.querySelector('.route-favorite-button svg')?.getAttribute('fill'),
    ).toBe('currentColor')
  })
})

describe('связь с высотой шторки', () => {
  /** По этому узлу шторка меряет, насколько высоко ей раскрываться. */
  it('отдаёт ссылку на блок деталей наверх', () => {
    const detailsRef = { current: null as HTMLDivElement | null }
    render(<RouteDetailsSheet {...props({ detailsRef })} />)

    expect(detailsRef.current).toBe(details())
  })

  it('принимает стили от шторки', () => {
    render(<RouteDetailsSheet {...props({ detailsStyle: { marginTop: '12px' } })} />)
    expect((details() as HTMLElement).style.marginTop).toBe('12px')
  })
})
