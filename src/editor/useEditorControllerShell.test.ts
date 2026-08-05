// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fullGraphLines, fullGraphStations } from '../metro/fullGraph.ts'
import type { EditorOverlayApi } from './editorTypes.ts'
import { useEditorController } from './useEditorController.ts'

afterEach(cleanup)

/** Сколько висит тост редактора. */
const TOAST_MS = 2200

type Rendered = ReturnType<typeof renderHook<ReturnType<typeof useEditorController>, unknown>>
const api = (r: Rendered): EditorOverlayApi => r.result.current.overlay as EditorOverlayApi

const station = fullGraphStations[0]
const other = fullGraphStations.find((s) => s.title !== station.title)!

function renderEditor() {
  const r = renderHook(() => useEditorController())
  act(() => {
    api(r).toggleEditMode()
  })
  return r
}

const key = (k: string, over: Partial<KeyboardEventInit> = {}) =>
  new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...over })

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('режим редактора', () => {
  it('выключен по умолчанию и включается кнопкой', () => {
    const r = renderHook(() => useEditorController())
    expect(r.result.current.editMode).toBe(false)

    act(() => api(r).toggleEditMode())
    expect(r.result.current.editMode).toBe(true)
    expect(r.result.current.mapProps.editMode).toBe(true)
  })

  it('выход из режима закрывает и панель станции', () => {
    const r = renderEditor()
    act(() => api(r).setInspectedStationId(station.id))
    expect(api(r).inspectedStation?.id).toBe(station.id)

    act(() => api(r).exitEditMode())
    expect(r.result.current.editMode).toBe(false)
  })

  it('отладка коллизий переключается и уходит в карту', () => {
    const r = renderEditor()
    expect(r.result.current.mapProps.collisionDebug).toBe(false)

    act(() => api(r).toggleCollisionDebug())
    expect(r.result.current.mapProps.collisionDebug).toBe(true)
  })
})

describe('горячие клавиши', () => {
  it('Ctrl+E включает и выключает редактор', () => {
    const r = renderHook(() => useEditorController())

    act(() => {
      window.dispatchEvent(key('e', { ctrlKey: true }))
    })
    expect(r.result.current.editMode).toBe(true)

    act(() => {
      window.dispatchEvent(key('E', { metaKey: true }))
    })
    expect(r.result.current.editMode).toBe(false)
  })

  /** Escape закрывает сначала панель станции, и только потом сам режим. */
  it('Escape закрывает панель, затем режим', () => {
    const r = renderEditor()
    act(() => api(r).setInspectedStationId(station.id))

    act(() => {
      window.dispatchEvent(key('Escape'))
    })
    expect(api(r).inspectedStation).toBeNull()
    expect(r.result.current.editMode).toBe(true)

    act(() => {
      window.dispatchEvent(key('Escape'))
    })
    expect(r.result.current.editMode).toBe(false)
  })

  it('Escape вне режима редактора ничего не делает', () => {
    const r = renderHook(() => useEditorController())

    act(() => {
      window.dispatchEvent(key('Escape'))
    })
    expect(r.result.current.editMode).toBe(false)
  })

  it('Ctrl+D переключает отладку коллизий', () => {
    const r = renderEditor()

    act(() => {
      window.dispatchEvent(key('d', { ctrlKey: true }))
    })
    expect(r.result.current.mapProps.collisionDebug).toBe(true)
  })

  /** Вне режима редактора Ctrl+D принадлежит браузеру («в закладки»). */
  it('Ctrl+D вне режима редактора не перехватывается', () => {
    const r = renderHook(() => useEditorController())

    act(() => {
      window.dispatchEvent(key('D', { ctrlKey: true }))
    })
    expect(r.result.current.mapProps.collisionDebug).toBe(false)
  })

  /** В поле ввода буквы принадлежат тексту, а не редактору схемы. */
  it.each(['INPUT', 'TEXTAREA'])('в поле %s клавиши не перехватываются', (tag) => {
    const r = renderHook(() => useEditorController())
    const field = document.createElement(tag)
    document.body.appendChild(field)

    act(() => {
      field.dispatchEvent(key('e', { ctrlKey: true }))
    })
    expect(r.result.current.editMode).toBe(false)
    field.remove()
  })

  it('в редактируемом блоке тоже', () => {
    const r = renderHook(() => useEditorController())
    const field = document.createElement('div')
    Object.defineProperty(field, 'isContentEditable', { value: true })
    document.body.appendChild(field)

    act(() => {
      field.dispatchEvent(key('e', { ctrlKey: true }))
    })
    expect(r.result.current.editMode).toBe(false)
    field.remove()
  })

  it('без модификатора буква редактор не включает', () => {
    const r = renderHook(() => useEditorController())

    act(() => {
      window.dispatchEvent(key('e'))
    })
    expect(r.result.current.editMode).toBe(false)
  })
})

describe('панель станции', () => {
  it('до выбора станции панели нет', () => {
    const r = renderEditor()

    expect(api(r).inspectedStation).toBeNull()
    expect(api(r).inspectedEdges).toEqual([])
    expect(api(r).inspectedLineId).toBeNull()
  })

  it('выбор станции поднимает её линию и рёбра', () => {
    const r = renderEditor()
    act(() => api(r).setInspectedStationId(station.id))

    expect(api(r).inspectedStation?.id).toBe(station.id)
    expect(api(r).inspectedLineId).toBe(station.lineNumericId)
    expect(api(r).inspectedEdges.length).toBeGreaterThan(0)
    for (const edge of api(r).inspectedEdges) {
      expect([edge.fromStationId, edge.toStationId]).toContain(station.id)
    }
  })

  /** Ручная связь — такое же ребро станции, и в панели она обязана быть видна. */
  it('ручные связи попадают в список рёбер', () => {
    const r = renderEditor()
    act(() => api(r).setInspectedStationId(station.id))
    const before = api(r).inspectedEdges.length

    const manualKey = api(r).edgeKey(station.id, other.id)
    act(() =>
      api(r).setManualEdges(() => ({
        [manualKey]: {
          fromStationId: station.id,
          toStationId: other.id,
          medianTravelSeconds: 120,
          isTransfer: true,
        },
      })),
    )

    expect(api(r).inspectedEdges.length).toBe(before + 1)
  })

  /** Ручная связь, дублирующая ребро графа, второй строкой не показывается. */
  it('дубль существующего ребра не задваивается', () => {
    const r = renderEditor()
    act(() => api(r).setInspectedStationId(station.id))
    const existing = api(r).inspectedEdges[0]
    const before = api(r).inspectedEdges.length

    const dupKey = api(r).edgeKey(existing.fromStationId, existing.toStationId)
    act(() => api(r).setManualEdges(() => ({ [dupKey]: existing })))

    expect(api(r).inspectedEdges.length).toBe(before)
  })

  it('ручные связи чужих станций в панель не попадают', () => {
    const r = renderEditor()
    act(() => api(r).setInspectedStationId(station.id))
    const before = api(r).inspectedEdges.length

    const far = fullGraphStations.at(-1)!
    act(() =>
      api(r).setManualEdges(() => ({
        [api(r).edgeKey(other.id, far.id)]: {
          fromStationId: other.id,
          toStationId: far.id,
          medianTravelSeconds: 120,
          isTransfer: true,
        },
      })),
    )

    expect(api(r).inspectedEdges.length).toBe(before)
  })
})

describe('правка станции', () => {
  it('переименование уходит и в оверрайды, и в подписи карты', () => {
    const r = renderEditor()
    act(() => api(r).changeStationTitle(station.id, '  Новое имя  '))

    expect(r.result.current.stationOverrides[station.id]?.title).toBe('Новое имя')
    expect(r.result.current.mapProps.stationTitleOverrides[station.id]).toBe('Новое имя')
    expect(r.result.current.stationTitleById.get(station.id)).toBe('Новое имя')
  })

  /** Пустое имя — это не переименование, а возврат к исходному. */
  it('пустое имя подписи карты не засоряет', () => {
    const r = renderEditor()
    act(() => api(r).changeStationTitle(station.id, '   '))

    expect(r.result.current.mapProps.stationTitleOverrides[station.id]).toBeUndefined()
  })

  it('смена линии меняет линию в панели', () => {
    const r = renderEditor()
    const otherLine = fullGraphLines.find((l) => l.id !== station.lineNumericId)!

    act(() => api(r).setInspectedStationId(station.id))
    act(() => api(r).changeStationLine(station.id, String(otherLine.id)))

    expect(r.result.current.stationOverrides[station.id]?.lineNumericId).toBe(otherLine.id)
    expect(api(r).inspectedLineId).toBe(otherLine.id)
  })

  it('линия отдаётся в карту по номеру линии, а не по названию', () => {
    const r = renderEditor()
    expect(api(r).lineByNumericId.get(fullGraphLines[0].id)?.title).toBe(fullGraphLines[0].title)
  })
})

describe('поиск станции по точному имени', () => {
  it('находит станцию, не различая регистр', () => {
    const r = renderEditor()

    expect(api(r).findExactStationByName(station.title.toUpperCase())?.id).toBe(station.id)
    expect(api(r).findExactStationByName(`  ${station.title}  `)?.id).toBe(station.id)
  })

  /** Переименованную станцию ищут по НОВОМУ имени: старого на схеме уже нет. */
  it('учитывает переименование', () => {
    const r = renderEditor()
    act(() => api(r).changeStationTitle(station.id, 'Совершенно другое'))

    expect(api(r).findExactStationByName('Совершенно другое')?.id).toBe(station.id)
  })

  it('пустой запрос и незнакомое имя ничего не находят', () => {
    const r = renderEditor()

    expect(api(r).findExactStationByName('   ')).toBeUndefined()
    expect(api(r).findExactStationByName('Станция, которой нет')).toBeUndefined()
  })
})

describe('фокус на станции', () => {
  /** Команда одноразовая: карта отличает новый запрос по возрастающему токену. */
  it('каждый запрос получает новый токен', () => {
    const r = renderEditor()
    expect(r.result.current.mapProps.editorFocusCommand).toBeNull()

    act(() => api(r).focusStation(station.id))
    const first = r.result.current.mapProps.editorFocusCommand!
    expect(first.stationId).toBe(station.id)

    act(() => api(r).focusStation(station.id))
    expect(r.result.current.mapProps.editorFocusCommand!.token).toBeGreaterThan(first.token)
  })
})

describe('тост редактора', () => {
  it('сообщение появляется и гаснет само', () => {
    const r = renderEditor()
    expect(api(r).toast).toBeNull()

    act(() => api(r).resetStationEdits(station.id))
    expect(api(r).toast).toBe('Изменения станции сброшены')

    act(() => {
      vi.advanceTimersByTime(TOAST_MS)
    })
    expect(api(r).toast).toBeNull()
  })

  /** Второе сообщение обязано продлить показ, а не погаснуть по старому отсчёту. */
  it('следующее сообщение перезапускает отсчёт', () => {
    const r = renderEditor()
    const edge = (() => {
      act(() => api(r).setInspectedStationId(station.id))
      return api(r).inspectedEdges[0]
    })()

    act(() => api(r).resetStationEdits(station.id))
    act(() => {
      vi.advanceTimersByTime(TOAST_MS - 200)
    })
    act(() => api(r).resetEdgeEdits(edge))

    act(() => {
      vi.advanceTimersByTime(300)
    })
    expect(api(r).toast).toBe('Изменения ребра сброшены')

    act(() => {
      vi.advanceTimersByTime(TOAST_MS)
    })
    expect(api(r).toast).toBeNull()
  })

  /** Таймер тоста переживал размонтирование и дёргал setState у мертвеца. */
  it('незавершённый отсчёт снимается вместе с хуком', () => {
    const r = renderEditor()
    act(() => api(r).resetStationEdits(station.id))

    const clearTimeout = vi.spyOn(window, 'clearTimeout')
    r.unmount()
    expect(clearTimeout).toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('раскладка из карты', () => {
  /**
   * Карта присылает раскладку потоком во время перетаскивания. Забирать её
   * на каждый кадр — значит перерисовывать приложение шестьдесят раз в секунду,
   * поэтому она копится в ref и снимается опросом.
   */
  it('доезжает до состояния не мгновенно, а пачкой', () => {
    const r = renderEditor()
    const overrides = { [station.id]: { x: 10, y: 20 } }

    act(() => r.result.current.mapProps.onLayoutChange(overrides))
    expect(api(r).lastLayoutOverrides).toEqual({})

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(api(r).lastLayoutOverrides).toEqual(overrides)
  })

  /** Те же числа новой ссылкой не должны перерисовывать приложение. */
  it('повтор тех же координат состояние не меняет', () => {
    const r = renderEditor()
    const overrides = { [station.id]: { x: 10, y: 20 } }

    act(() => r.result.current.mapProps.onLayoutChange(overrides))
    act(() => {
      vi.advanceTimersByTime(200)
    })
    const first = api(r).lastLayoutOverrides

    act(() => r.result.current.mapProps.onLayoutChange({ [station.id]: { x: 10, y: 20 } }))
    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(api(r).lastLayoutOverrides).toBe(first)
  })

  /** В проде редактора нет, и вечный опрос зря жёг бы батарею. */
  it('вне режима редактора раскладка не собирается', () => {
    const r = renderHook(() => useEditorController())

    act(() => r.result.current.mapProps.onLayoutChange({ [station.id]: { x: 10, y: 20 } }))
    act(() => {
      vi.advanceTimersByTime(500)
    })

    expect(api(r).lastLayoutOverrides).toEqual({})
  })
})
