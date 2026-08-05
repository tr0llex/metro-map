// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RouteForm, type RouteSuggestionItem } from './RouteForm.tsx'

afterEach(cleanup)

/** Анимация закрытия списка. */
const EXIT_MS = 160

const suggestion = (over: Partial<RouteSuggestionItem> = {}): RouteSuggestionItem => ({
  id: '1/arbatskaya',
  title: 'Арбатская',
  color: '#d9232e',
  ...over,
})

function props(over: Partial<Parameters<typeof RouteForm>[0]> = {}) {
  return {
    fromStation: '',
    toStation: '',
    fromSuggestions: [] as RouteSuggestionItem[],
    toSuggestions: [] as RouteSuggestionItem[],
    fromSuggestionIndex: -1,
    toSuggestionIndex: -1,
    fromInputRef: createRef<HTMLInputElement>(),
    toInputRef: createRef<HTMLInputElement>(),
    onFromChange: vi.fn(),
    onToChange: vi.fn(),
    onFromKeyDown: vi.fn(),
    onToKeyDown: vi.fn(),
    onFromFocus: vi.fn(),
    onFromBlur: vi.fn(),
    onToFocus: vi.fn(),
    onToBlur: vi.fn(),
    onSelectFromSuggestion: vi.fn(),
    onSelectToSuggestion: vi.fn(),
    onSwap: vi.fn(),
    onClearFrom: vi.fn(),
    onClearTo: vi.fn(),
    isDesktop: false,
    ...over,
  }
}

const from = () => screen.getByRole('combobox', { name: 'Станция отправления' })
const to = () => screen.getByRole('combobox', { name: 'Станция назначения' })
const options = () => screen.queryAllByRole('option')

/** Список рисуется в портале по измеренному прямоугольнику поля — гоняем кадр rAF. */
let frames: FrameRequestCallback[] = []
const flushFrames = () =>
  act(() => {
    const queued = frames
    frames = []
    for (const fn of queued) fn(0)
  })

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => frames.push(fn))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  // В jsdom все прямоугольники нулевые: поле должно иметь размер, иначе список
  // окажется нулевой ширины и его нельзя будет отличить от отсутствующего.
  vi.spyOn(HTMLInputElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 20,
    top: 300,
    right: 320,
    bottom: 344,
    width: 300,
    height: 44,
    x: 20,
    y: 300,
    toJSON: () => ({}),
  } as DOMRect)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('поля ввода', () => {
  it('подписаны и для глаза, и для скринридера', () => {
    render(<RouteForm {...props()} />)

    expect(from().getAttribute('placeholder')).toBe('Откуда')
    expect(to().getAttribute('placeholder')).toBe('Куда')
  })

  /**
   * Поля не объявляли autocomplete, и браузер считал их обычным текстовым
   * вводом: поверх наших подсказок вылезал его собственный список ранее
   * введённых значений — два выпадающих списка друг на друге.
   *
   * Остальное — про мобильную клавиатуру: автокоррекция правила «Щукинская» →
   * «Щукинский», автозаглавная спорила с посимвольным поиском, проверка
   * орфографии подчёркивала красным половину схемы.
   */
  it('системные подсказки и автокоррекция выключены', () => {
    render(<RouteForm {...props()} />)

    for (const input of [from(), to()]) {
      expect(input.getAttribute('autocomplete')).toBe('off')
      expect(input.getAttribute('autocorrect')).toBe('off')
      expect(input.getAttribute('autocapitalize')).toBe('none')
      expect(input.getAttribute('spellcheck')).toBe('false')
      expect(input.getAttribute('enterkeyhint')).toBe('search')
    }
  })

  it('ввод уходит наверх', () => {
    const p = props()
    render(<RouteForm {...p} />)

    fireEvent.change(from(), { target: { value: 'Арб' } })
    expect(p.onFromChange).toHaveBeenCalledWith('Арб')

    fireEvent.change(to(), { target: { value: 'Кит' } })
    expect(p.onToChange).toHaveBeenCalledWith('Кит')
  })

  it('фокус, потеря фокуса и клавиши уходят наверх', () => {
    const p = props()
    render(<RouteForm {...p} />)

    fireEvent.focus(from())
    fireEvent.keyDown(from(), { key: 'ArrowDown' })
    fireEvent.blur(from())
    expect(p.onFromFocus).toHaveBeenCalledTimes(1)
    expect(p.onFromKeyDown).toHaveBeenCalledTimes(1)
    expect(p.onFromBlur).toHaveBeenCalledTimes(1)

    fireEvent.focus(to())
    fireEvent.keyDown(to(), { key: 'Enter' })
    fireEvent.blur(to())
    expect(p.onToFocus).toHaveBeenCalledTimes(1)
    expect(p.onToKeyDown).toHaveBeenCalledTimes(1)
    expect(p.onToBlur).toHaveBeenCalledTimes(1)
  })

  it('ссылки на поля отдаются наверх — по ним App ставит курсор', () => {
    const p = props()
    render(<RouteForm {...p} />)

    expect(p.fromInputRef.current).toBe(from())
    expect(p.toInputRef.current).toBe(to())
  })

  /** Два экземпляра формы (шторка и боковая панель) не должны делить id. */
  it('id полей и списков уникальны между экземплярами', () => {
    const { container: a } = render(<RouteForm {...props()} />)
    const { container: b } = render(<RouteForm {...props()} />)

    const idA = a.querySelector('input')!.getAttribute('aria-controls')
    const idB = b.querySelector('input')!.getAttribute('aria-controls')
    expect(idA).not.toBe(idB)
  })
})

describe('очистка полей', () => {
  it('крестик появляется только у заполненного поля', () => {
    const { rerender } = render(<RouteForm {...props()} />)
    expect(screen.queryByRole('button', { name: 'Очистить поле Откуда' })).toBeNull()

    rerender(<RouteForm {...props({ fromStation: 'Арбатская' })} />)
    expect(screen.getByRole('button', { name: 'Очистить поле Откуда' })).toBeTruthy()
  })

  it('крестик очищает своё поле', () => {
    const p = props({ fromStation: 'Арбатская', toStation: 'Китай-город' })
    render(<RouteForm {...p} />)

    fireEvent.click(screen.getByRole('button', { name: 'Очистить поле Откуда' }))
    expect(p.onClearFrom).toHaveBeenCalledTimes(1)
    expect(p.onClearTo).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Очистить поле Куда' }))
    expect(p.onClearTo).toHaveBeenCalledTimes(1)
  })
})

describe('обмен станциями', () => {
  it('кнопка меняет поля местами', () => {
    const p = props()
    render(<RouteForm {...p} />)

    fireEvent.click(screen.getByRole('button', { name: 'Поменять местами станции Откуда и Куда' }))
    expect(p.onSwap).toHaveBeenCalledTimes(1)
  })
})

describe('точка цвета линии', () => {
  it('появляется у выбранной станции и красится её линией', () => {
    render(<RouteForm {...props({ fromSelectedColor: '#d9232e' })} />)

    const dot = document.querySelector<HTMLElement>('.bottom-input-line-dot')!
    expect(dot.style.backgroundColor).toBe('rgb(217, 35, 46)')
    expect(dot.getAttribute('aria-hidden')).toBe('true')
    expect(from().className).toContain('bottom-input--with-line-dot')
  })

  it('без выбранной станции точки нет', () => {
    render(<RouteForm {...props()} />)

    expect(document.querySelector('.bottom-input-line-dot')).toBeNull()
    expect(from().className).not.toContain('bottom-input--with-line-dot')
  })
})

describe('список подсказок', () => {
  it('пока подсказок нет — списка нет', () => {
    render(<RouteForm {...props()} />)
    flushFrames()

    expect(options()).toHaveLength(0)
    expect(from().getAttribute('aria-expanded')).toBe('false')
  })

  it('показывает станции с цветом линии', () => {
    render(
      <RouteForm {...props({ fromStation: 'Арб', fromSuggestions: [suggestion()] })} />,
    )
    flushFrames()

    expect(options()).toHaveLength(1)
    expect(screen.getByRole('option').textContent).toContain('Арбатская')
    expect(from().getAttribute('aria-expanded')).toBe('true')
  })

  /** Киевская ×3, Арбатская ×2: без названия линии строки списка неразличимы. */
  it('у одноимённых станций показывает линию', () => {
    render(
      <RouteForm
        {...props({
          fromStation: 'Киев',
          fromSuggestions: [suggestion({ title: 'Киевская', lineTitle: 'Кольцевая' })],
        })}
      />,
    )
    flushFrames()

    expect(screen.getByRole('option').textContent).toContain('Кольцевая')
    expect(screen.getByRole('option').getAttribute('aria-label')).toBe('Киевская, Кольцевая')
  })

  /** У пустого поля непонятно, почему предложены именно эти шесть станций из трёхсот. */
  it('у пустого поля объясняет происхождение подсказки', () => {
    render(<RouteForm {...props({ fromSuggestions: [suggestion({ meta: 'Рядом' })] })} />)
    flushFrames()

    expect(screen.getByRole('option').textContent).toContain('Рядом')
  })

  it('оба уточнения склеиваются в одну строку', () => {
    render(
      <RouteForm
        {...props({
          fromSuggestions: [suggestion({ meta: 'Недавнее', lineTitle: 'Кольцевая' })],
        })}
      />,
    )
    flushFrames()

    expect(screen.getByRole('option').textContent).toContain('Недавнее · Кольцевая')
    expect(screen.getByRole('option').getAttribute('aria-label')).toBe(
      'Арбатская, Недавнее, Кольцевая',
    )
  })

  it('выбор строки уходит наверх со станцией', () => {
    const p = props({ fromStation: 'Арб', fromSuggestions: [suggestion()] })
    render(<RouteForm {...p} />)
    flushFrames()

    fireEvent.click(screen.getByRole('option'))
    expect(p.onSelectFromSuggestion).toHaveBeenCalledWith('1/arbatskaya')
  })

  /** Мышью список нельзя закрыть раньше выбора: blur съел бы клик. */
  it('нажатие мышью не уводит фокус из поля', () => {
    render(<RouteForm {...props({ fromSuggestions: [suggestion()] })} />)
    flushFrames()

    const mouse = fireEvent.pointerDown(screen.getByRole('option'), { pointerType: 'mouse' })
    expect(mouse).toBe(false)

    const finger = fireEvent.pointerDown(screen.getByRole('option'), { pointerType: 'touch' })
    expect(finger).toBe(true)
  })

  it('списки полей независимы', () => {
    render(
      <RouteForm
        {...props({
          fromSuggestions: [suggestion()],
          toSuggestions: [suggestion({ id: '5/kitay-gorod', title: 'Китай-город' })],
        })}
      />,
    )
    flushFrames()

    expect(screen.getAllByRole('listbox')).toHaveLength(2)
    expect(options().map((o) => o.textContent)).toEqual(['Арбатская', 'Китай-город'])
  })

  /** Заголовок списка объясняет, что в нём: результаты поиска или «недавние». */
  it('подпись списка зависит от того, введён ли запрос', () => {
    const { rerender } = render(
      <RouteForm {...props({ fromSuggestions: [suggestion()] })} />,
    )
    flushFrames()
    expect(screen.getByRole('listbox').getAttribute('aria-label')).toBe(
      'Недавние и ближайшие станции для поля Откуда',
    )

    rerender(<RouteForm {...props({ fromStation: 'Арб', fromSuggestions: [suggestion()] })} />)
    flushFrames()
    expect(screen.getByRole('listbox').getAttribute('aria-label')).toBe(
      'Подсказки для поля Откуда',
    )
  })
})

describe('навигация по списку', () => {
  const three = [
    suggestion({ id: 'a', title: 'Первая' }),
    suggestion({ id: 'b', title: 'Вторая' }),
    suggestion({ id: 'c', title: 'Третья' }),
  ]

  /**
   * A11Y: пока по списку не ходили стрелками, индекс равен -1, и раньше
   * aria-activedescendant не выставлялся вовсе — скринридер не называл ни
   * одного варианта, хотя Enter уже выбирал первый.
   */
  it('до стрелок называет ту строку, что сработает по Enter', () => {
    render(<RouteForm {...props({ fromSuggestions: three, fromSuggestionIndex: -1 })} />)
    flushFrames()

    const active = from().getAttribute('aria-activedescendant')!
    expect(document.getElementById(active)?.textContent).toContain('Первая')
  })

  it('стрелками активная строка переезжает', () => {
    render(<RouteForm {...props({ fromSuggestions: three, fromSuggestionIndex: 1 })} />)
    flushFrames()

    const active = from().getAttribute('aria-activedescendant')!
    expect(document.getElementById(active)?.textContent).toContain('Вторая')
    expect(options()[1].getAttribute('aria-selected')).toBe('true')
    expect(options()[0].getAttribute('aria-selected')).toBe('false')
    expect(options()[1].className).toContain('suggestion-item--active')
  })

  /** Индекс мог остаться от прошлого, более длинного списка. */
  it('индекс за границами списка откатывается на первую строку', () => {
    render(<RouteForm {...props({ fromSuggestions: three, fromSuggestionIndex: 99 })} />)
    flushFrames()

    const active = from().getAttribute('aria-activedescendant')!
    expect(document.getElementById(active)?.textContent).toContain('Первая')
  })

  it('без подсказок активной строки нет', () => {
    render(<RouteForm {...props()} />)
    expect(from().hasAttribute('aria-activedescendant')).toBe(false)
  })
})

describe('ничего не нашлось', () => {
  /**
   * Раньше список в этом случае просто исчезал, и опечатка была неотличима от
   * «приложение зависло»; чаще всего причина — латинская раскладка.
   */
  it('вместо исчезнувшего списка показывает подсказку про раскладку', () => {
    render(<RouteForm {...props({ fromStation: 'ap,f', fromNoMatches: true })} />)
    flushFrames()

    expect(screen.getByText('Ничего не нашлось')).toBeTruthy()
    expect(screen.getByText('Проверь раскладку клавиатуры')).toBeTruthy()
    expect(from().getAttribute('aria-expanded')).toBe('true')
  })

  it('пустое состояние строкой списка не считается', () => {
    render(<RouteForm {...props({ fromStation: 'ap,f', fromNoMatches: true })} />)
    flushFrames()

    expect(options()).toHaveLength(0)
  })
})

describe('подсказка под полем', () => {
  /**
   * Раньше об этом сообщал только общий блок ошибки под формой — далеко от
   * поля, которое надо исправить.
   */
  it('связана с полем и объявляется скринридеру', () => {
    render(<RouteForm {...props({ fromHint: 'Эта станция уже выбрана как «Куда»' })} />)

    const hintId = from().getAttribute('aria-describedby')!
    const hint = document.getElementById(hintId)!
    expect(hint.textContent).toBe('Эта станция уже выбрана как «Куда»')
    expect(hint.getAttribute('role')).toBe('status')
    expect(hint.getAttribute('aria-live')).toBe('polite')
  })

  it('без подсказки поле ни на что не ссылается', () => {
    render(<RouteForm {...props()} />)
    expect(from().hasAttribute('aria-describedby')).toBe(false)
  })

  it('поля независимы', () => {
    render(<RouteForm {...props({ toHint: 'Совпадает с «Откуда»' })} />)

    expect(from().hasAttribute('aria-describedby')).toBe(false)
    expect(to().hasAttribute('aria-describedby')).toBe(true)
  })
})

describe('положение списка', () => {
  /** Список привязан к полю: он в портале и без координат уехал бы в угол. */
  it('встаёт по прямоугольнику поля', () => {
    render(<RouteForm {...props({ fromSuggestions: [suggestion()] })} />)
    flushFrames()

    const list = screen.getByRole('listbox') as HTMLElement
    expect(list.style.position).toBe('fixed')
    expect(list.style.left).toBe('20px')
    expect(list.style.width).toBe('300px')
  })

  /**
   * На телефоне список раскрывается ВВЕРХ: снизу его накрыла бы клавиатура.
   * В боковой панели места снизу достаточно.
   */
  it('на телефоне раскрывается вверх, на десктопе вниз', () => {
    const { rerender } = render(<RouteForm {...props({ fromSuggestions: [suggestion()] })} />)
    flushFrames()
    expect(screen.getByRole('listbox').style.top).toBe('auto')
    expect(screen.getByRole('listbox').style.bottom).not.toBe('auto')

    rerender(<RouteForm {...props({ fromSuggestions: [suggestion()], isDesktop: true })} />)
    flushFrames()
    expect(screen.getByRole('listbox').style.bottom).toBe('auto')
    expect(screen.getByRole('listbox').style.top).toBe('350px')
  })

  /**
   * Потолок был 144px при восьми подсказках по 44px, а контейнер прячет
   * переполнение — до пяти вариантов из восьми нельзя было и доскроллить.
   */
  it('список ограничен по высоте и прокручивается', () => {
    render(<RouteForm {...props({ fromSuggestions: [suggestion()] })} />)
    flushFrames()

    const list = screen.getByRole('listbox') as HTMLElement
    expect(Number.parseInt(list.style.maxHeight)).toBeLessThanOrEqual(288)
    expect(list.style.overflowY).toBe('auto')
  })

  /** Клавиатура двигает визуальный вьюпорт — список обязан ехать за полем. */
  it('перемеряется на изменение вьюпорта', () => {
    render(<RouteForm {...props({ fromSuggestions: [suggestion()] })} />)
    flushFrames()

    const rect = vi.spyOn(HTMLInputElement.prototype, 'getBoundingClientRect')
    rect.mockReturnValue({
      left: 20,
      top: 100,
      right: 320,
      bottom: 144,
      width: 300,
      height: 44,
      x: 20,
      y: 100,
      toJSON: () => ({}),
    } as DOMRect)

    act(() => window.dispatchEvent(new Event('resize')))
    flushFrames()
    expect(screen.getByRole('listbox').style.bottom).toBe('674px')
  })

  it('подписки на вьюпорт снимаются вместе с формой', () => {
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(<RouteForm {...props({ fromSuggestions: [suggestion()] })} />)
    flushFrames()

    unmount()
    expect(remove.mock.calls.some(([type]) => type === 'resize')).toBe(true)
  })
})

describe('закрытие списка', () => {
  /**
   * Список исчезает не мгновенно: пока играет анимация ухода, он показывает
   * прежние строки — иначе на месте списка мигнула бы пустота.
   */
  it('на время анимации показывает прежние строки', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
    const { rerender } = render(<RouteForm {...props({ fromSuggestions: [suggestion()] })} />)
    flushFrames()

    rerender(<RouteForm {...props({ fromSuggestions: [] })} />)
    expect(screen.getByRole('listbox').className).toContain('field-suggestions--closing')
    expect(options()).toHaveLength(1)

    act(() => {
      vi.advanceTimersByTime(EXIT_MS)
    })
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  /** Список открыли снова, пока он ещё закрывался — отсчёт обязан отмениться. */
  it('возврат подсказок отменяет закрытие', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
    const { rerender } = render(<RouteForm {...props({ fromSuggestions: [suggestion()] })} />)
    flushFrames()

    rerender(<RouteForm {...props({ fromSuggestions: [] })} />)
    rerender(<RouteForm {...props({ fromSuggestions: [suggestion()] })} />)
    flushFrames()

    act(() => {
      vi.advanceTimersByTime(EXIT_MS * 2)
    })
    expect(screen.getByRole('listbox')).toBeTruthy()
    expect(screen.getByRole('listbox').className).not.toContain('--closing')
  })

  /** Незавершённый отсчёт закрытия пережил бы форму и дёрнул setState у мертвеца. */
  it('снятие формы гасит незавершённое закрытие', () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] })
    const { rerender, unmount } = render(
      <RouteForm {...props({ fromSuggestions: [suggestion()] })} />,
    )
    flushFrames()
    rerender(<RouteForm {...props({ fromSuggestions: [] })} />)

    expect(() => {
      unmount()
      vi.advanceTimersByTime(EXIT_MS * 2)
    }).not.toThrow()
  })
})
