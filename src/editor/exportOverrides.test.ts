import { describe, expect, it } from 'vitest'
import {
  buildEditorOverrides,
  sortStationIdsForAnchor,
  type BuildEditorOverridesInput,
} from './exportOverrides'
import { fullGraphTransferHubs } from '../metro/fullGraph'

const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

function makeInput(over: Partial<BuildEditorOverridesInput> = {}): BuildEditorOverridesInput {
  return {
    layout: { 'mos-1-1.54': { x: 10, y: 20 } },
    stationOverrides: {},
    stationHubOverrides: {},
    hiddenStations: {},
    manualStations: {},
    manualEdges: {},
    edgeOverrides: {},
    hubMinOverrides: {},
    effectiveLineStationIdsById: new Map(),
    canonicalRingShapes: {
      '95': { kind: 'ellipse', cx: 100, cy: 100, rx: 50, ry: 40 },
    },
    edgeKey,
    ...over,
  }
}

describe('buildEditorOverrides — состав экспортируемого файла', () => {
  it('не пишет grid и stationParams: солвер таких полей не читает', () => {
    const result = buildEditorOverrides(makeInput())
    expect(result).not.toHaveProperty('grid')
    expect(result).not.toHaveProperty('stationParams')
  })

  it('по умолчанию НЕ пишет ringShapes — кольца остаются на автоподгонке', () => {
    // Молчаливое добавление ключа переключало геометрию колец с подгонки по
    // станциям на жёстко заданную форму.
    const result = buildEditorOverrides(makeInput())
    expect(result).not.toHaveProperty('ringShapes')
  })

  it('пишет ringShapes только по явному запросу', () => {
    const result = buildEditorOverrides(makeInput({ includeRingShapes: true }))
    expect(result.ringShapes).toEqual({
      '95': { kind: 'ellipse', cx: 100, cy: 100, rx: 50, ry: 40 },
    })
  })

  it('при пустых формах колец ключ не появляется даже по запросу', () => {
    const result = buildEditorOverrides(
      makeInput({ includeRingShapes: true, canonicalRingShapes: {} }),
    )
    expect(result).not.toHaveProperty('ringShapes')
  })

  it('каждый оверрайд хаба несёт якорь stationIds из базового графа', () => {
    // Ключ "hub-N" нестабилен: номер выдаётся порядком обхода компонент, и
    // дедупликация станций его сдвигает. Без якоря правка молча уезжает на
    // чужой узел — так уже осиротели 15 записей.
    const hub = fullGraphTransferHubs.find((h) => h.stationIds.length >= 2)!
    const result = buildEditorOverrides(makeInput({ hubMinOverrides: { [hub.id]: 300 } }))

    expect(result.hubs[hub.id]).toEqual({
      stationIds: [...hub.stationIds].sort(),
      minTransferSeconds: 300,
    })
    expect(result.hubs[hub.id].stationIds).toHaveLength(hub.stationIds.length)
  })

  it('якорь отсортирован — Go считает канонический ключ по sort.Strings', () => {
    // hubAnchorKey в go-layout-solver/graph_overrides.go сортирует состав и
    // склеивает через \x00. Значит, порядок в файле роли не играет, но
    // отсортированный список делает совпадение видимым глазом при ревью.
    for (const hub of fullGraphTransferHubs) {
      const result = buildEditorOverrides(makeInput({ hubMinOverrides: { [hub.id]: 240 } }))
      const ids = result.hubs[hub.id].stationIds!
      expect(ids).toEqual(sortStationIdsForAnchor(hub.stationIds))
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('сортировка якоря идёт по кодовым точкам, а не по кодовым единицам UTF-16', () => {
    // sort.Strings в Go сравнивает байты UTF-8, их порядок = порядок кодовых
    // точек. Штатный sort() сравнивает единицы UTF-16 и на суррогатных парах
    // ставит эмодзи ПЕРЕД U+FF21, что разошлось бы с якорем солвера.
    const ids = ['\u{1F600}', 'Ａ']
    expect(sortStationIdsForAnchor(ids)).toEqual(['Ａ', '\u{1F600}'])
  })

  it('для придуманного редактором хаба якорь берётся из эффективного состава', () => {
    const result = buildEditorOverrides(
      makeInput({
        hubMinOverrides: { 'hub-invented': 300 },
        stationHubOverrides: { 'mos-5-5.55': 'hub-invented', 'mos-1-1.54': 'hub-invented' },
      }),
    )
    expect(result.hubs['hub-invented'].stationIds).toEqual(['mos-1-1.54', 'mos-5-5.55'])
  })

  it('нечисловое minTransferSeconds не попадает в файл', () => {
    const result = buildEditorOverrides(makeInput({ hubMinOverrides: { 'hub-1': Number.NaN } }))
    expect(result.hubs).toEqual({})
  })

  it('обязательные разделы на месте', () => {
    const result = buildEditorOverrides(makeInput())
    expect(Object.keys(result).sort()).toEqual(['edges', 'hubs', 'layout', 'lines', 'stations'])
    expect(result.layout).toEqual({ 'mos-1-1.54': { x: 10, y: 20 } })
  })
})
