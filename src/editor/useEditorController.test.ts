// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useEditorController } from './useEditorController.ts'
import { formatTravelTime } from './travelTime.ts'
import { fullGraphEdges, fullGraphStations } from '../metro/fullGraph.ts'
import type { EditorOverlayApi } from './editorTypes.ts'

afterEach(cleanup)

/** Хук всегда отдаёт overlay; сужаем тип, чтобы не писать `!` в каждой строке. */
type Rendered = ReturnType<typeof renderHook<ReturnType<typeof useEditorController>, unknown>>
const api = (r: Rendered): EditorOverlayApi => r.result.current.overlay as EditorOverlayApi

/** Редактор выключен по умолчанию, а история пишется только во включённом. */
function renderEditor(strict = false) {
  const rendered = renderHook(() => useEditorController(), strict ? { wrapper: StrictMode } : {})
  act(() => {
    api(rendered).toggleEditMode()
  })
  return rendered
}

const station = fullGraphStations[0]
/** Перегон с временем, не кратным 60: таких в данных 284 из 291. */
const oddRide = fullGraphEdges.find(
  (e) => !e.isTransfer && e.medianTravelSeconds % 60 !== 0,
)!

describe('история undo/redo', () => {
  it('в выключенном редакторе история пуста', () => {
    const r = renderHook(() => useEditorController())
    expect(api(r).canUndo).toBe(false)
    expect(api(r).canRedo).toBe(false)
  })

  it('первая правка делает undo доступным, а redo — нет', () => {
    const r = renderEditor()
    expect(api(r).canUndo).toBe(false)

    act(() => {
      api(r).changeStationTitle(station.id, 'Новое имя')
    })

    expect(r.result.current.stationOverrides[station.id]?.title).toBe('Новое имя')
    expect(api(r).canUndo).toBe(true)
    expect(api(r).canRedo).toBe(false)
  })

  it('undo возвращает прежнее состояние, redo — снова правку', () => {
    const r = renderEditor()

    act(() => {
      api(r).changeStationTitle(station.id, 'Новое имя')
    })
    act(() => {
      api(r).undo()
    })

    expect(r.result.current.stationOverrides[station.id]).toBeUndefined()

    act(() => {
      api(r).redo()
    })

    expect(r.result.current.stationOverrides[station.id]?.title).toBe('Новое имя')
  })

  /**
   * СТОРОЖ БАГА. undo/redo вызывали применение снапшота ПРЯМО ВНУТРИ апдейтера
   * `setEditorHistory`. React считает апдейтер чистым и в StrictMode вызывает
   * его дважды: снапшот применялся два раза и дважды поднимался
   * `editorLayoutApplyToken`. Проверяем именно в StrictMode — в обычном режиме
   * баг не виден.
   */
  it('в StrictMode одно undo применяет снапшот ровно один раз', () => {
    const r = renderEditor(true)

    act(() => {
      api(r).changeStationTitle(station.id, 'Новое имя')
    })

    const before = r.result.current.mapProps.editorLayoutApplyToken
    act(() => {
      api(r).undo()
    })

    expect(r.result.current.mapProps.editorLayoutApplyToken).toBe(before + 1)
  })

  /**
   * СТОРОЖ БАГА. Применение снапшота меняло состояние, эффект записи истории
   * запускался снова и `pushEditorHistory` обрезал ветку redo — повторить
   * отменённое становилось нечем. Ключ к починке: восстановленный снапшот
   * поверхностно равен уже лежащему в истории, и новая запись не создаётся.
   */
  it('undo не обрезает ветку redo', () => {
    const r = renderEditor()

    act(() => {
      api(r).changeStationTitle(station.id, 'Новое имя')
    })
    act(() => {
      api(r).undo()
    })

    expect(api(r).canRedo).toBe(true)
  })

  it('то же самое в StrictMode: redo переживает undo', () => {
    const r = renderEditor(true)

    act(() => {
      api(r).changeStationTitle(station.id, 'Новое имя')
    })
    act(() => {
      api(r).undo()
    })

    expect(api(r).canRedo).toBe(true)

    act(() => {
      api(r).redo()
    })

    expect(r.result.current.stationOverrides[station.id]?.title).toBe('Новое имя')
  })

  /** Новая правка после undo — это новая ветка, повторять старую нечего. */
  it('правка после undo обрезает redo', () => {
    const r = renderEditor()

    act(() => {
      api(r).changeStationTitle(station.id, 'Первое')
    })
    act(() => {
      api(r).undo()
    })
    act(() => {
      api(r).changeStationTitle(station.id, 'Второе')
    })

    expect(api(r).canRedo).toBe(false)
    expect(r.result.current.stationOverrides[station.id]?.title).toBe('Второе')
  })

  it('undo в самом начале истории ничего не ломает', () => {
    const r = renderEditor()
    act(() => {
      api(r).undo()
    })
    expect(api(r).canUndo).toBe(false)
    expect(r.result.current.stationOverrides).toEqual({})
  })

  it('выход из режима редактора очищает историю', () => {
    const r = renderEditor()

    act(() => {
      api(r).changeStationTitle(station.id, 'Новое имя')
    })
    expect(api(r).canUndo).toBe(true)

    act(() => {
      api(r).exitEditMode()
    })

    expect(api(r).canUndo).toBe(false)
    expect(api(r).canRedo).toBe(false)
  })
})

describe('время перегона', () => {
  /**
   * СТОРОЖ БАГА, ради которого переделывали формат времени. Поле было
   * целочисленным в минутах: щелчок в поле и щелчок мимо (blur без единого
   * нажатия) переписывали 173 с в 180 с. Так портились 284 перегона из 291 —
   * человек ничего не менял, а файл менялся.
   */
  it('blur без изменения текста не создаёт правку', () => {
    const r = renderEditor()

    act(() => {
      api(r).changeEdgeMinutes(oddRide, formatTravelTime(oddRide.medianTravelSeconds))
    })

    expect(r.result.current.edgeOverrides).toEqual({})
    expect(api(r).canUndo).toBe(false)
  })

  it('голые секунды, равные текущему времени, тоже не правка', () => {
    const r = renderEditor()

    act(() => {
      api(r).changeEdgeMinutes(oddRide, String(oddRide.medianTravelSeconds))
    })

    expect(r.result.current.edgeOverrides).toEqual({})
  })

  it('новое время в формате «м:сс» попадает в оверрайды посекундно', () => {
    const r = renderEditor()
    const key = api(r).edgeKey(oddRide.fromStationId, oddRide.toStationId)

    act(() => {
      api(r).changeEdgeMinutes(oddRide, '2:53')
    })

    expect(r.result.current.edgeOverrides[key]?.medianTravelSeconds).toBe(173)
  })

  it('возврат к исходному времени убирает оверрайд целиком', () => {
    const r = renderEditor()
    const key = api(r).edgeKey(oddRide.fromStationId, oddRide.toStationId)

    act(() => {
      api(r).changeEdgeMinutes(oddRide, '9:09')
    })
    expect(r.result.current.edgeOverrides[key]).toBeDefined()

    act(() => {
      api(r).changeEdgeMinutes(oddRide, formatTravelTime(oddRide.medianTravelSeconds))
    })
    expect(r.result.current.edgeOverrides[key]).toBeUndefined()
  })

  /** Мусор в поле — это «не разобрал», а не «поставь ноль». */
  it('нечитаемый ввод не создаёт правку', () => {
    const r = renderEditor()
    const key = api(r).edgeKey(oddRide.fromStationId, oddRide.toStationId)

    act(() => {
      api(r).changeEdgeMinutes(oddRide, 'abc')
    })

    expect(r.result.current.edgeOverrides[key]).toBeUndefined()
  })

  /** Стереть время у ребра, у которого уже есть другая правка, можно. */
  it('пустое поле снимает только время, оставляя прочие правки ребра', () => {
    const r = renderEditor()
    const key = api(r).edgeKey(oddRide.fromStationId, oddRide.toStationId)

    act(() => {
      api(r).toggleEdgeDisabled(oddRide)
    })
    act(() => {
      api(r).changeEdgeMinutes(oddRide, '4:00')
    })
    act(() => {
      api(r).changeEdgeMinutes(oddRide, '')
    })

    expect(r.result.current.edgeOverrides[key]).toEqual({ disabled: true })
  })
})

describe('тип пересадки', () => {
  const transfer = fullGraphEdges.find((e) => e.isTransfer)!

  /**
   * СТОРОЖ БАГА. Тип пересадки поменять было нельзя: интерфейс выводил
   * «близкая/дальняя» из времени, а в патч уходил kind из графа. Теперь выбор
   * явный и живёт отдельным состоянием — EdgeOverride из src/metro про
   * data/transfers.json ничего не знает.
   */
  it('выбранный тип запоминается по ключу ребра', () => {
    const r = renderEditor()
    const key = api(r).edgeKey(transfer.fromStationId, transfer.toStationId)

    act(() => {
      api(r).changeEdgeTransferKind(transfer, 'out_of_station')
    })

    expect(api(r).edgeTransferKinds[key]).toBe('out_of_station')
    expect(api(r).canUndo).toBe(true)
  })

  it('возврат к типу из графа убирает правку', () => {
    const r = renderEditor()
    const key = api(r).edgeKey(transfer.fromStationId, transfer.toStationId)
    const baseKind = transfer.transferKind ?? 'near'

    act(() => {
      api(r).changeEdgeTransferKind(transfer, 'mcc')
    })
    act(() => {
      api(r).changeEdgeTransferKind(transfer, baseKind)
    })

    expect(api(r).edgeTransferKinds[key]).toBeUndefined()
  })

  it('сброс правок ребра снимает и тип', () => {
    const r = renderEditor()
    const key = api(r).edgeKey(transfer.fromStationId, transfer.toStationId)

    act(() => {
      api(r).changeEdgeTransferKind(transfer, 'far')
    })
    act(() => {
      api(r).resetEdgeEdits(transfer)
    })

    expect(api(r).edgeTransferKinds[key]).toBeUndefined()
  })

  it('undo откатывает тип вместе с остальным', () => {
    const r = renderEditor()
    const key = api(r).edgeKey(transfer.fromStationId, transfer.toStationId)

    act(() => {
      api(r).changeEdgeTransferKind(transfer, 'far')
    })
    act(() => {
      api(r).undo()
    })

    expect(api(r).edgeTransferKinds[key]).toBeUndefined()
    expect(api(r).canRedo).toBe(true)
  })

  /**
   * СТОРОЖ БАГА. Переключатель был каруселью из трёх положений, и шаг
   * «близкая -> дальняя» ПЕРЕПИСЫВАЛ время до шести минут — иначе эти два
   * состояния ничем не отличались. Правка времени и правка типа — разные
   * действия, и первое не должно случаться само.
   */
  it('переключение «перегон/пересадка» не трогает время', () => {
    const r = renderEditor()
    const key = api(r).edgeKey(oddRide.fromStationId, oddRide.toStationId)

    act(() => {
      api(r).toggleEdgeTransfer(oddRide)
    })

    expect(r.result.current.edgeOverrides[key]).toEqual({ isTransfer: true })
  })

  it('обратное переключение возвращает ребро к исходному виду', () => {
    const r = renderEditor()
    const key = api(r).edgeKey(oddRide.fromStationId, oddRide.toStationId)

    act(() => {
      api(r).toggleEdgeTransfer(oddRide)
    })
    act(() => {
      api(r).toggleEdgeTransfer(oddRide)
    })

    expect(r.result.current.edgeOverrides[key]).toBeUndefined()
  })
})

describe('координаты из OSM', () => {
  const okResponse = (items: unknown[]) => ({
    ok: true,
    status: 200,
    json: async () => items,
  })

  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const urlOf = () => String(fetchMock.mock.calls[0][0])
  const queryOf = () => decodeURIComponent(new URL(urlOf()).searchParams.get('q') ?? '')

  /**
   * СТОРОЖ БАГА. Запрос был «станция метро {название}, Москва» и не находил
   * НИЧЕГО: в OSM объект зовётся просто «Боровицкая», а свободный поиск
   * Nominatim ищет эту фразу целиком, а не разбирает её как категорию.
   * Ломалось практически для каждой станции.
   */
  it('в запросе нет слов «станция метро»', async () => {
    const r = renderEditor()
    fetchMock.mockResolvedValue(okResponse([{ lat: '55.1', lon: '37.1', class: 'railway' }]))

    await act(async () => {
      await api(r).updateStationGeoFromOSM(station.id)
    })

    expect(queryOf()).not.toContain('станция метро')
    expect(queryOf()).toContain(station.title)
    expect(queryOf()).toContain('Москва')
  })

  /**
   * Кандидатов просят пять, а не один: по названию станции первой приходит
   * одноимённая улица или площадь. Метро узнаётся по классу объекта.
   */
  it('из нескольких кандидатов берётся railway, а не первый', async () => {
    const r = renderEditor()
    fetchMock.mockResolvedValue(
      okResponse([
        { lat: '55.9', lon: '37.9', class: 'highway' },
        { lat: '55.1', lon: '37.2', class: 'railway' },
      ]),
    )

    await act(async () => {
      await api(r).updateStationGeoFromOSM(station.id)
    })

    expect(r.result.current.stationOverrides[station.id]).toMatchObject({
      lat: 55.1,
      lon: 37.2,
    })
    expect(urlOf()).toContain('limit=5')
  })

  it('без railway-кандидата берётся первый ответ', async () => {
    const r = renderEditor()
    fetchMock.mockResolvedValue(okResponse([{ lat: '55.3', lon: '37.4', class: 'place' }]))

    await act(async () => {
      await api(r).updateStationGeoFromOSM(station.id)
    })

    expect(r.result.current.stationOverrides[station.id]).toMatchObject({
      lat: 55.3,
      lon: 37.4,
    })
  })

  /**
   * СТОРОЖ БАГА. Nominatim пускает один запрос в секунду. Без отдельной ветки
   * отказ выглядел как «координаты не найдены», и станцию шли искать в OSM
   * руками, хотя она там есть.
   */
  it.each([429, 403])('ответ %i объясняется как ограничение частоты', async (status) => {
    const r = renderEditor()
    fetchMock.mockResolvedValue({ ok: false, status, json: async () => [] })

    await expect(
      act(async () => {
        await api(r).updateStationGeoFromOSM(station.id)
      }),
    ).rejects.toThrow(/слишком часто/)

    expect(r.result.current.stationOverrides[station.id]).toBeUndefined()
  })

  it('прочая ошибка сервера доносится с кодом', async () => {
    const r = renderEditor()
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => [] })

    await expect(
      act(async () => {
        await api(r).updateStationGeoFromOSM(station.id)
      }),
    ).rejects.toThrow(/500/)
  })

  it('пустой ответ — это ошибка, а не молчаливый успех', async () => {
    const r = renderEditor()
    fetchMock.mockResolvedValue(okResponse([]))

    await expect(
      act(async () => {
        await api(r).updateStationGeoFromOSM(station.id)
      }),
    ).rejects.toThrow(/координаты не найдены/)
  })

  /**
   * СТОРОЖ БАГА. Сравнение «ничего не изменилось» смотрело только title и
   * lineNumericId — ровно те поля, которых эта операция не касается. У станции
   * с любым другим оверрайдом (например, переименованной) полученные
   * координаты молча выбрасывались, а тост «lat/lon обновлены» показывался:
   * снаружи это выглядело как успешная запись.
   */
  it('у переименованной станции координаты не теряются', async () => {
    const r = renderEditor()
    fetchMock.mockResolvedValue(okResponse([{ lat: '55.7', lon: '37.7', class: 'railway' }]))

    act(() => {
      api(r).changeStationTitle(station.id, 'Переименованная')
    })

    await act(async () => {
      await api(r).updateStationGeoFromOSM(station.id)
    })

    expect(r.result.current.stationOverrides[station.id]).toEqual({
      title: 'Переименованная',
      lat: 55.7,
      lon: 37.7,
    })
  })

  /**
   * СТОРОЖ БАГА. Проверка «оверрайд опустел» смотрела только title и
   * lineNumericId. Стоило вернуть линию к исходной — и запись удалялась
   * целиком вместе с координатами, которые только что пришли из OSM.
   */
  it('координаты переживают возврат линии к исходной', async () => {
    const r = renderEditor()
    fetchMock.mockResolvedValue(okResponse([{ lat: '55.7', lon: '37.7', class: 'railway' }]))

    await act(async () => {
      await api(r).updateStationGeoFromOSM(station.id)
    })

    act(() => {
      api(r).changeStationLine(station.id, '99')
    })
    act(() => {
      api(r).changeStationLine(station.id, String(station.lineNumericId))
    })

    expect(r.result.current.stationOverrides[station.id]).toEqual({ lat: 55.7, lon: 37.7 })
  })

  it('несуществующая станция отвергается до запроса', async () => {
    const r = renderEditor()

    await expect(
      act(async () => {
        await api(r).updateStationGeoFromOSM('нет-такой-станции')
      }),
    ).rejects.toThrow(/не найдена/)

    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('сброс правок', () => {
  it('сброс станции убирает её оверрайды', () => {
    const r = renderEditor()

    act(() => {
      api(r).changeStationTitle(station.id, 'Новое имя')
    })
    act(() => {
      api(r).resetStationEdits(station.id)
    })

    expect(r.result.current.stationOverrides[station.id]).toBeUndefined()
  })

  it('сброс ребра убирает и оверрайд, и ручную связь', () => {
    const r = renderEditor()
    const key = api(r).edgeKey(oddRide.fromStationId, oddRide.toStationId)

    act(() => {
      api(r).changeEdgeMinutes(oddRide, '4:00')
      api(r).setManualEdges((prev) => ({ ...prev, [`manual:${key}`]: oddRide }))
    })
    act(() => {
      api(r).resetEdgeEdits(oddRide)
    })

    expect(r.result.current.edgeOverrides[key]).toBeUndefined()
    expect(r.result.current.manualEdges[`manual:${key}`]).toBeUndefined()
  })
})
