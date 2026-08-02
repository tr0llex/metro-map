// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HubEditorPanel } from './HubEditorPanel.tsx'
import type { FullGraphEdge, FullGraphLine, FullGraphStation } from '../metro/types'

afterEach(cleanup)

const lineOne: FullGraphLine = {
  id: 1,
  title: 'Первая',
  colorHex: '#E42313',
  stationIds: ['1/a', '1/b'],
  segments: [['1/a', '1/b']],
}
const lineTwo: FullGraphLine = {
  id: 2,
  title: 'Вторая',
  colorHex: '#4F8242',
  stationIds: ['2/a'],
  segments: [['2/a']],
}

const stationA: FullGraphStation = { id: '1/a', title: 'А', lineNumericId: 1 }
const stationB: FullGraphStation = { id: '1/b', title: 'Б', lineNumericId: 1 }
const stationC: FullGraphStation = { id: '2/a', title: 'Ц', lineNumericId: 2 }

/** Время не кратно минуте: ровно такие значения и портил старый ввод в минутах. */
const ride: FullGraphEdge = {
  fromStationId: '1/a',
  toStationId: '1/b',
  lineNumericId: 1,
  medianTravelSeconds: 173,
}

const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

function setup(over: Partial<Parameters<typeof HubEditorPanel>[0]> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onUndo: vi.fn(),
    onRedo: vi.fn(),
    onChangeStationTitle: vi.fn(),
    onChangeStationLine: vi.fn(),
    onToggleEdgeTransfer: vi.fn(),
    onChangeEdgeMinutes: vi.fn(),
    onToggleEdgeDisabled: vi.fn(),
    onSetNewEdgeTarget: vi.fn(),
    onSetManualEdges: vi.fn(),
    onSetInspectedStationId: vi.fn(),
    onFocusStation: vi.fn(),
    onResetStationEdits: vi.fn(),
    onResetEdgeEdits: vi.fn(),
  }

  const props: Parameters<typeof HubEditorPanel>[0] = {
    inspectedStation: stationA,
    inspectedLineId: 1,
    inspectedEdges: [ride],
    fullGraphLines: [lineOne, lineTwo],
    fullGraphEdges: [ride],
    stationOverrides: {},
    manualEdges: {},
    stationById: new Map([
      [stationA.id, stationA],
      [stationB.id, stationB],
      [stationC.id, stationC],
    ]),
    lineByNumericId: new Map([
      [1, lineOne],
      [2, lineTwo],
    ]),
    edgeOverrides: {},
    newEdgeTarget: '',
    findExactStationByName: () => undefined,
    edgeKey,
    canUndo: false,
    canRedo: false,
    ...handlers,
    ...over,
  }

  const view = render(<HubEditorPanel {...props} />)
  return { ...handlers, view, props }
}

const openConnections = () => fireEvent.click(screen.getByRole('button', { name: 'Связи' }))

/**
 * Поля обязательно фокусируем: jsdom не шлёт blur элементу, который фокуса не
 * держал, а вся фиксация правки висит именно на blur.
 */
function focused<T extends HTMLElement>(element: T): T {
  element.focus()
  return element
}

const timeInput = (title = 'Б') =>
  focused(screen.getByLabelText(`Время до «${title}», формат м:сс`) as HTMLInputElement)

const titleInput = () =>
  focused(document.querySelector('.hub-editor-station-title-input') as HTMLInputElement)

describe('поле времени связи', () => {
  /**
   * Поле было целочисленным в минутах и физически не могло выразить 284
   * значения из 291: 173 с показывались как «3» и записывались обратно 180 с.
   */
  it('показывает время в формате «м:сс», а не в минутах', () => {
    setup()
    openConnections()
    expect(timeInput().value).toBe('2:53')
  })

  it('учитывает правку времени из оверрайда', () => {
    setup({ edgeOverrides: { [edgeKey('1/a', '1/b')]: { medianTravelSeconds: 245 } } })
    openConnections()
    expect(timeInput().value).toBe('4:05')
  })

  /**
   * СТОРОЖ БАГА. Правка засчитывалась только по уходу фокуса: Ctrl+S прямо из
   * поля сохранял старое значение, а набранное пропадало. Enter обязан
   * фиксировать сам.
   */
  it('Enter фиксирует набранное', () => {
    const { onChangeEdgeMinutes } = setup()
    openConnections()

    fireEvent.change(timeInput(), { target: { value: '3:20' } })
    expect(onChangeEdgeMinutes).not.toHaveBeenCalled()

    fireEvent.keyDown(timeInput(), { key: 'Enter' })

    expect(onChangeEdgeMinutes).toHaveBeenCalledTimes(1)
    expect(onChangeEdgeMinutes.mock.calls[0][1]).toBe('3:20')
  })

  /**
   * СТОРОЖ БАГА. Escape чистил черновик и тут же уводил фокус, но обработчик
   * blur читал ЖИВОЕ значение поля — состояние обновиться не успевало. Отмена
   * записывала ровно то, от чего отказались.
   */
  it('Escape отменяет набранное и не создаёт правку', () => {
    const { onChangeEdgeMinutes } = setup()
    openConnections()

    fireEvent.change(timeInput(), { target: { value: '9:99' } })
    fireEvent.keyDown(timeInput(), { key: 'Escape' })

    expect(onChangeEdgeMinutes).not.toHaveBeenCalled()
    expect(timeInput().value).toBe('2:53')
  })

  it('после отменённой правки следующая всё ещё фиксируется', () => {
    const { onChangeEdgeMinutes } = setup()
    openConnections()

    fireEvent.change(timeInput(), { target: { value: '9:99' } })
    fireEvent.keyDown(timeInput(), { key: 'Escape' })
    fireEvent.change(timeInput(), { target: { value: '3:20' } })
    fireEvent.keyDown(timeInput(), { key: 'Enter' })

    expect(onChangeEdgeMinutes).toHaveBeenCalledTimes(1)
    expect(onChangeEdgeMinutes.mock.calls[0][1]).toBe('3:20')
  })

  /**
   * Щелчок в поле и щелчок мимо — не правка. Панель обязана отдать ровно ту
   * строку, что показывала: разбирает её контроллер, и совпадение с базой он
   * увидит только при точном значении.
   */
  it('blur без набора отдаёт исходную строку', () => {
    const { onChangeEdgeMinutes } = setup()
    openConnections()

    fireEvent.blur(timeInput(), { target: { value: timeInput().value } })

    expect(onChangeEdgeMinutes.mock.calls[0][1]).toBe('2:53')
  })
})

describe('название станции', () => {
  it('Enter фиксирует набранное', () => {
    const { onChangeStationTitle } = setup()

    fireEvent.change(titleInput(), { target: { value: 'Новое имя' } })
    fireEvent.keyDown(titleInput(), { key: 'Enter' })

    expect(onChangeStationTitle).toHaveBeenCalledWith('1/a', 'Новое имя')
  })

  /** Та же ловушка, что и у времени: blur после Escape видел ещё старое поле. */
  it('Escape отменяет набранное и не создаёт правку', () => {
    const { onChangeStationTitle } = setup()

    fireEvent.change(titleInput(), { target: { value: 'Опечатка' } })
    fireEvent.keyDown(titleInput(), { key: 'Escape' })

    expect(onChangeStationTitle).not.toHaveBeenCalled()
    expect(titleInput().value).toBe('А')
  })
})

describe('тип связи', () => {
  const withEdge = (edge: Partial<FullGraphEdge>) =>
    setup({ inspectedEdges: [{ ...ride, ...edge }] })

  it('обычное ребро подписано «перегон»', () => {
    withEdge({})
    openConnections()
    expect(screen.getByText('перегон')).toBeTruthy()
  })

  /**
   * Порог считается в секундах. Пока он считался в округлённых минутах,
   * пересадка в 5:31 попадала в дальние, а 6:29 — в близкие.
   */
  it('5:31 — это близкая пересадка', () => {
    withEdge({ isTransfer: true, medianTravelSeconds: 331 })
    openConnections()
    expect(screen.getByText('пересадка (близкая)')).toBeTruthy()
  })

  it('6:29 — это дальняя пересадка', () => {
    withEdge({ isTransfer: true, medianTravelSeconds: 389 })
    openConnections()
    expect(screen.getByText('пересадка (дальняя)')).toBeTruthy()
  })
})

describe('добавление связи', () => {
  it('несуществующая станция названа вслух, связь не создаётся', () => {
    const { onSetManualEdges } = setup({ newEdgeTarget: 'Хогвартс' })
    openConnections()

    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))

    expect(screen.getByText('Станция не найдена')).toBeTruthy()
    expect(onSetManualEdges).not.toHaveBeenCalled()
  })

  it('станцию нельзя соединить саму с собой', () => {
    const { onSetManualEdges } = setup({ newEdgeTarget: '1/a' })
    openConnections()

    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))

    expect(screen.getByText('Нельзя соединить станцию саму с собой')).toBeTruthy()
    expect(onSetManualEdges).not.toHaveBeenCalled()
  })

  it('уже существующее ребро не дублируется', () => {
    const { onSetManualEdges } = setup({ newEdgeTarget: '1/b' })
    openConnections()

    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))

    expect(screen.getByText(/уже есть в основной схеме/)).toBeTruthy()
    expect(onSetManualEdges).not.toHaveBeenCalled()
  })

  /** Ради этого всё и делалось: пересадку между линиями иначе не добавить. */
  it('станция другой линии превращается в ручную связь', () => {
    const { onSetManualEdges, onSetNewEdgeTarget } = setup({ newEdgeTarget: '2/a' })
    openConnections()

    fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))

    expect(onSetManualEdges).toHaveBeenCalledTimes(1)
    const updater = onSetManualEdges.mock.calls[0][0] as (
      prev: Record<string, FullGraphEdge>,
    ) => Record<string, FullGraphEdge>
    expect(updater({})).toEqual({
      [`manual:${edgeKey('1/a', '2/a')}`]: {
        fromStationId: '1/a',
        toStationId: '2/a',
        lineNumericId: 1,
        medianTravelSeconds: 180,
        isTransfer: false,
      },
    })
    expect(onSetNewEdgeTarget).toHaveBeenCalledWith('')
  })
})
