import { describe, expect, it } from 'vitest'

import { fullGraphStations } from '../metro/fullGraph.ts'
import { useNoopEditorController } from './noopEditorController.ts'

describe('заглушка редактора для прод-сборки', () => {
  it('отдаёт базовый граф без единой правки', () => {
    const c = useNoopEditorController()

    expect(c.editMode).toBe(false)
    expect(c.allStations).toBe(fullGraphStations)
    expect(c.stationOverrides).toEqual({})
    expect(c.edgeOverrides).toEqual({})
    expect(c.manualEdges).toEqual({})
  })

  /** Оверлея нет — вместе с ним из прод-бандла исчезает весь редакторский UI. */
  it('редакторского оверлея не существует', () => {
    expect(useNoopEditorController().overlay).toBeNull()
  })

  it('индексы станций покрывают весь граф', () => {
    const c = useNoopEditorController()

    expect(c.stationById.size).toBe(fullGraphStations.length)
    expect(c.stationTitleById.size).toBe(fullGraphStations.length)

    const sample = fullGraphStations[0]
    expect(c.stationById.get(sample.id)).toBe(sample)
    expect(c.stationTitleById.get(sample.id)).toBe(sample.title)
  })

  /**
   * Ради этого заглушка и написана на константах: MetroMap мемоизирован по
   * ссылкам пропсов, и новый объект на каждый рендер сбрасывал бы мемоизацию
   * самого дорогого компонента приложения.
   */
  it('на каждый вызов возвращает те же самые ссылки', () => {
    const first = useNoopEditorController()
    const second = useNoopEditorController()

    expect(second).toBe(first)
    expect(second.mapProps).toBe(first.mapProps)
    expect(second.stationById).toBe(first.stationById)
    expect(second.stationTitleById).toBe(first.stationTitleById)
    expect(second.stationOverrides).toBe(first.stationOverrides)
  })

  it('карте передаёт выключённый редактор и пустые правки', () => {
    const { mapProps } = useNoopEditorController()

    expect(mapProps.editMode).toBe(false)
    expect(mapProps.collisionDebug).toBe(false)
    expect(mapProps.editorLayoutOverrides).toEqual({})
    expect(mapProps.stationTitleOverrides).toEqual({})
    expect(mapProps.editorLayoutApplyToken).toBe(0)
    expect(mapProps.editorFocusCommand).toBeNull()
  })

  /** Колбэки обязаны быть вызываемыми: карта дёргает их, не спрашивая режим. */
  it('колбэки карты — безопасные пустышки', () => {
    const { mapProps } = useNoopEditorController()

    expect(() => mapProps.onLayoutChange({})).not.toThrow()
    expect(() => mapProps.onEditStationInspect('1/1')).not.toThrow()
  })
})
