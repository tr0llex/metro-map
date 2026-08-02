// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useEditorController } from './useEditorController.ts'
import { buildEditorPatch, hasSavableChanges } from './buildEditorPatch.ts'
import { applyEditorPatch, type DataFiles } from '../../scripts/editor/applyEditorPatch.ts'
import { fullGraphEdges, fullGraphLines, fullGraphStations } from '../metro/fullGraph.ts'
import type { EditorOverlayApi } from './editorTypes.ts'

/**
 * Путь пользователя целиком: правка в панели -> состояние контроллера ->
 * патч -> НАСТОЯЩИЕ файлы `data/`.
 *
 * Остальные наборы проверяют звенья по отдельности, и каждое из них было
 * зелёным в те дни, когда сохранить из редактора нельзя было ничего: правка
 * доходила до патча и терялась на сервере, или наоборот. Здесь звенья
 * соединены и работают на тех же данных, что лежат в репозитории.
 */

afterEach(cleanup)

// jsdom подменяет import.meta.url на http-адрес, файловый путь из него не
// собрать; корень проекта — это рабочий каталог прогона vitest.
const ROOT = process.cwd()
const RING_LINE_IDS = new Set([5, 95, 97])

function readDataFiles(): DataFiles {
  const linesDir = join(ROOT, 'data', 'lines')
  const lines: DataFiles['lines'] = {}
  for (const name of readdirSync(linesDir).filter((n) => n.endsWith('.json'))) {
    lines[name] = JSON.parse(readFileSync(join(linesDir, name), 'utf8'))
  }
  return {
    lines,
    transfers: JSON.parse(readFileSync(join(ROOT, 'data', 'transfers.json'), 'utf8')),
    layout: JSON.parse(readFileSync(join(ROOT, 'data', 'layout.json'), 'utf8')),
  }
}

const dataFiles = readDataFiles()

type Rendered = ReturnType<typeof renderHook<ReturnType<typeof useEditorController>, unknown>>
const api = (r: Rendered): EditorOverlayApi => r.result.current.overlay as EditorOverlayApi

function renderEditor() {
  const rendered = renderHook(() => useEditorController())
  act(() => {
    api(rendered).toggleEditMode()
  })
  return rendered
}

/**
 * Раскладку карта присылает через onLayoutChange; в тесте её нет, поэтому
 * подставляем координаты «как в файле» — иначе сервер отвергнет патч целиком
 * за неполноту, и проверять станет нечего.
 */
const untouchedLayout = () => {
  const layout: Record<string, { x: number; y: number }> = {}
  for (const s of fullGraphStations) {
    layout[s.id] = { x: s.sourceX as number, y: s.sourceY as number }
  }
  return layout
}

/** Что уедет в файлы прямо сейчас, из живого состояния контроллера. */
function patchOf(r: Rendered) {
  const editor = api(r)
  return buildEditorPatch({
    lines: fullGraphLines,
    stations: fullGraphStations,
    edges: fullGraphEdges,
    ringLineIds: RING_LINE_IDS,
    layout: untouchedLayout(),
    stationOverrides: editor.stationOverrides,
    edgeOverrides: editor.edgeOverrides,
    manualEdges: editor.manualEdges,
    edgeTransferKinds: editor.edgeTransferKinds,
    edgeKey: editor.edgeKey,
  })
}

const applyOf = (r: Rendered) => applyEditorPatch(dataFiles, patchOf(r).patch)

/** Станция в файле линии — там, где правка обязана оказаться. */
function stationInFiles(files: DataFiles, id: string) {
  for (const line of Object.values(files.lines)) {
    for (const st of [...line.stations, ...(line.branches ?? []).flatMap((b) => b.stations)]) {
      if (st.id === id) return st
    }
  }
  return undefined
}

const station = fullGraphStations[0]
const ride = fullGraphEdges.find((e) => !e.isTransfer && e.medianTravelSeconds % 60 !== 0)!
const transfer = fullGraphEdges.find((e) => e.isTransfer)!

/** Две станции разных линий, между которыми связи в данных нет. */
const crossLinePair = () => {
  const a = fullGraphStations.find((s) => s.lineNumericId === 1)!
  const key = (x: string, y: string) => (x < y ? `${x}|${y}` : `${y}|${x}`)
  const b = fullGraphStations.find(
    (s) =>
      s.lineNumericId === 2 &&
      !fullGraphEdges.some((e) => key(e.fromStationId, e.toStationId) === key(a.id, s.id)),
  )!
  return { a, b }
}

describe('переименование станции', () => {
  it('доезжает до файла линии', () => {
    const r = renderEditor()
    act(() => {
      api(r).changeStationTitle(station.id, 'Проверочная')
    })

    const result = applyOf(r)
    expect(stationInFiles(result.files, station.id)?.title).toBe('Проверочная')
    expect(result.changedFiles.some((f) => f.startsWith('data/lines/'))).toBe(true)
  })

  it('возврат к прежнему имени не оставляет следа в файлах', () => {
    const r = renderEditor()
    act(() => {
      api(r).changeStationTitle(station.id, 'Проверочная')
    })
    act(() => {
      api(r).changeStationTitle(station.id, station.title)
    })

    expect(hasSavableChanges(patchOf(r))).toBe(false)
    expect(applyOf(r).changedFiles).toEqual([])
  })
})

describe('время перегона', () => {
  it('пишется станции, ОТ которой идёт ход линии', () => {
    const r = renderEditor()
    act(() => {
      api(r).changeEdgeMinutes(ride, '3:33')
    })

    const patch = patchOf(r).patch
    const [key] = Object.keys(patch.rides ?? {})
    expect(patch.rides?.[key]).toBe(213)

    const from = key.split('>')[0]
    const result = applyEditorPatch(dataFiles, patch)
    expect(stationInFiles(result.files, from)?.toNextSeconds).toBe(213)
    // Обратная станция пары времени не получает: в файле оно хранится только
    // «до следующей», и запись не с той стороны сдвинула бы чужой перегон.
    const other = from === ride.fromStationId ? ride.toStationId : ride.fromStationId
    expect(stationInFiles(result.files, other)?.toNextSeconds).toBe(
      stationInFiles(dataFiles, other)?.toNextSeconds,
    )
  })

  it('перегон каждой линии находит своё место в файле', () => {
    // Сторож на расхождение обходов: ход линии в графе строит
    // `lineStationPairs`, а слоты в файле — `rideSlots`. Разойдутся на
    // ответвлениях или на замыкании кольца — и правка времени упрётся в
    // «перегона нет ни на одной линии».
    const r = renderEditor()
    const rides = fullGraphEdges.filter((e) => !e.isTransfer)
    const byLine = new Map<number, (typeof rides)[number]>()
    for (const e of rides) {
      if (e.lineNumericId != null && !byLine.has(e.lineNumericId)) byLine.set(e.lineNumericId, e)
    }

    for (const edge of byLine.values()) {
      act(() => {
        api(r).changeEdgeMinutes(edge, '2:22')
      })
    }

    const built = patchOf(r)
    expect(built.unsupported).toEqual([])
    expect(Object.keys(built.patch.rides ?? {})).toHaveLength(byLine.size)
    expect(() => applyEditorPatch(dataFiles, built.patch)).not.toThrow()
  })
})

describe('пересадка между линиями', () => {
  it('заведённая руками связь становится записью в transfers.json', () => {
    const { a, b } = crossLinePair()
    const r = renderEditor()
    const manualKey = `manual:${api(r).edgeKey(a.id, b.id)}`

    act(() => {
      api(r).setManualEdges((prev) => ({
        ...prev,
        [manualKey]: {
          fromStationId: a.id,
          toStationId: b.id,
          lineNumericId: a.lineNumericId,
          medianTravelSeconds: 180,
          isTransfer: true,
        },
      }))
    })

    const result = applyOf(r)
    expect(result.changedFiles).toContain('data/transfers.json')
    const written = result.files.transfers.transfers.find(
      (t) => t.stations.includes(a.id) && t.stations.includes(b.id),
    )
    expect(written).toBeDefined()
    expect(written?.kind).toBe('near')
  })

  it('выбранный тип уезжает в файл вместе с ней', () => {
    const { a, b } = crossLinePair()
    const r = renderEditor()
    const key = api(r).edgeKey(a.id, b.id)

    act(() => {
      api(r).setManualEdges((prev) => ({
        ...prev,
        [`manual:${key}`]: {
          fromStationId: a.id,
          toStationId: b.id,
          medianTravelSeconds: 180,
          isTransfer: true,
        },
      }))
    })
    act(() => {
      api(r).changeEdgeTransferKind(
        { fromStationId: a.id, toStationId: b.id, medianTravelSeconds: 180, isTransfer: true },
        'out_of_station',
      )
    })

    const written = applyOf(r).files.transfers.transfers.find(
      (t) => t.stations.includes(a.id) && t.stations.includes(b.id),
    )
    expect(written?.kind).toBe('out_of_station')
  })

  it('смена типа у существующей пересадки меняет только тип', () => {
    const r = renderEditor()
    const before = dataFiles.transfers.transfers.find(
      (t) => t.stations.includes(transfer.fromStationId) && t.stations.includes(transfer.toStationId),
    )
    const nextKind = (transfer.transferKind ?? 'near') === 'far' ? 'near' : 'far'

    act(() => {
      api(r).changeEdgeTransferKind(transfer, nextKind)
    })

    const result = applyOf(r)
    expect(result.changedFiles).toEqual(['data/transfers.json'])
    const after = result.files.transfers.transfers.find(
      (t) => t.stations.includes(transfer.fromStationId) && t.stations.includes(transfer.toStationId),
    )
    expect(after?.kind).toBe(nextKind)
    expect(after?.stations).toEqual(before?.stations)
  })
})

describe('undo/redo не теряет ни одной из этих правок', () => {
  it('откат снимает правку из файлов, повтор возвращает её', () => {
    const { a, b } = crossLinePair()
    const r = renderEditor()
    const manualKey = `manual:${api(r).edgeKey(a.id, b.id)}`

    act(() => {
      api(r).changeStationTitle(station.id, 'Проверочная')
    })
    act(() => {
      api(r).changeEdgeMinutes(ride, '3:33')
    })
    act(() => {
      api(r).setManualEdges((prev) => ({
        ...prev,
        [manualKey]: {
          fromStationId: a.id,
          toStationId: b.id,
          medianTravelSeconds: 180,
          isTransfer: true,
        },
      }))
    })
    act(() => {
      api(r).changeEdgeTransferKind(transfer, 'mcc')
    })

    const full = patchOf(r)
    expect(full.counts).toMatchObject({ stations: 1, rides: 1, transfers: 2 })

    // Четыре отката — до пустого состояния.
    for (let i = 0; i < 4; i += 1) {
      act(() => {
        api(r).undo()
      })
    }
    expect(hasSavableChanges(patchOf(r))).toBe(false)
    expect(applyOf(r).changedFiles).toEqual([])

    // Четыре повтора — обратно к тому же самому патчу.
    for (let i = 0; i < 4; i += 1) {
      act(() => {
        api(r).redo()
      })
    }
    expect(patchOf(r).patch).toEqual(full.patch)
  })

  /**
   * СТОРОЖ БАГА. Тип пересадки живёт отдельным состоянием, и его легко
   * забыть в `applyEditorSnapshot`: снапшот его помнит, но откат бы не
   * применял — правка «переживала» бы undo и уезжала в файл.
   */
  it('откат возвращает прежний тип пересадки в файле', () => {
    const r = renderEditor()
    const wasKind = dataFiles.transfers.transfers.find(
      (t) => t.stations.includes(transfer.fromStationId) && t.stations.includes(transfer.toStationId),
    )?.kind

    act(() => {
      api(r).changeEdgeTransferKind(transfer, 'out_of_station')
    })
    act(() => {
      api(r).undo()
    })

    const after = applyOf(r).files.transfers.transfers.find(
      (t) => t.stations.includes(transfer.fromStationId) && t.stations.includes(transfer.toStationId),
    )
    expect(after?.kind).toBe(wasKind)
    expect(applyOf(r).changedFiles).toEqual([])
  })
})

