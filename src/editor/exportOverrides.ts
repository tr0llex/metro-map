import {
  fullGraphEdges,
  fullGraphLines,
  fullGraphStations,
  fullGraphTransferHubs,
} from '../metro/fullGraph.ts'
import type {
  EdgeOverride,
  EditorOverrides,
  EditorOverridesRingShape,
  FullGraphEdge,
  FullGraphStation,
} from '../metro/types.ts'
import type { StationOverride } from './editorTypes.ts'

export type BuildEditorOverridesInput = {
  layout: Record<string, { x: number; y: number }>
  stationOverrides: Record<string, StationOverride>
  stationHubOverrides: Record<string, string | null>
  hiddenStations: Record<string, true>
  manualStations: Record<string, FullGraphStation>
  manualEdges: Record<string, FullGraphEdge>
  edgeOverrides: Record<string, EdgeOverride>
  hubMinOverrides: Record<string, number>
  effectiveLineStationIdsById: Map<number, string[]>
  canonicalRingShapes: Record<string, EditorOverridesRingShape>
  /**
   * Зафиксировать формы колец в файле. По умолчанию false — см. комментарий
   * к `buildEditorOverrides`. Вызывающий обязан спросить это у человека явно.
   */
  includeRingShapes?: boolean
  edgeKey: (a: string, b: string) => string
}

/**
 * Сравнение строк по кодовым точкам — ровно то, что делает `sort.Strings` в Go
 * (там сравниваются байты UTF-8, а их порядок совпадает с порядком кодовых
 * точек). Штатный `Array.prototype.sort()` сортирует по кодовым ЕДИНИЦАМ UTF-16
 * и на суррогатных парах расходится с Go. Для нынешних ASCII-идентификаторов
 * разницы нет, но якорь обязан совпадать с Go по построению, а не по удаче.
 */
function compareByCodePoints(a: string, b: string): number {
  const ac = Array.from(a)
  const bc = Array.from(b)
  const n = Math.min(ac.length, bc.length)
  for (let i = 0; i < n; i += 1) {
    const diff = ac[i].codePointAt(0)! - bc[i].codePointAt(0)!
    if (diff !== 0) return diff
  }
  return ac.length - bc.length
}

export function sortStationIdsForAnchor(ids: readonly string[]): string[] {
  return [...ids].sort(compareByCodePoints)
}

type StationEntry = {
  title?: string
  lineNumericId?: number | null
  hubId?: string | null
  hidden?: boolean
  manual?: boolean
}

/**
 * Собирает содержимое normalized/editor_overrides.json из текущего состояния
 * редактора. Правило одно: в файл попадает только то, что отличается от
 * базового графа (ручные станции/рёбра выгружаются целиком).
 *
 * ЧТО НАМЕРЕННО НЕ ЭКСПОРТИРУЕТСЯ
 *
 * `grid` и `stationParams` (в том числе `theta` — угол станции на кольце).
 * В структуре `GraphOverrides` на стороне Go (`go-layout-solver/graph_overrides.go`)
 * полей `Grid` и `StationParams` нет вообще, а `json.Decoder` молча игнорирует
 * неизвестные ключи. То есть эти данные физически не могли доехать до солвера:
 * человек задавал угол станции, ничего не менялось, диагностики не было.
 * Пока Go их не читает, писать их в файл — значит держать ручку, не
 * подключённую ни к чему.
 *
 * `ringShapes` — только по явному запросу (`includeRingShapes`). Ключ Go читает,
 * но сейчас в `editor_overrides.json` его НЕТ, и формы колец подбираются
 * автоматически (`fitBestRingShape` по станциям). Автоматический экспорт добавил
 * бы ключ и молча переключил кольца с автоподгонки на жёстко заданную форму —
 * геометрия поехала бы без единого следа в выводе.
 */
export function buildEditorOverrides(input: BuildEditorOverridesInput): EditorOverrides {
  const {
    layout,
    stationOverrides,
    stationHubOverrides,
    hiddenStations,
    manualStations,
    manualEdges,
    edgeOverrides,
    hubMinOverrides,
    effectiveLineStationIdsById,
    canonicalRingShapes,
    includeRingShapes,
    edgeKey,
  } = input

  const stations: Record<string, StationEntry> = {}

  const applyStation = (s: FullGraphStation, manual: boolean) => {
    const id = s.id
    const baseTitle = s.title
    const baseLine = s.lineNumericId ?? null
    const baseHubId = s.hubId ?? null

    const stOverride = stationOverrides[id]
    const trimmedTitle = stOverride?.title?.trim()
    const overrideLine =
      stOverride && stOverride.lineNumericId !== undefined ? stOverride.lineNumericId : undefined

    const stationHidden = !!hiddenStations[id]

    const hubOverride = stationHubOverrides[id]
    let effectiveHubId: string | null
    if (hubOverride === null) effectiveHubId = null
    else if (hubOverride !== undefined) effectiveHubId = hubOverride
    else effectiveHubId = baseHubId

    if (manual) {
      const entry: StationEntry = {}

      entry.manual = true

      entry.title = trimmedTitle && trimmedTitle.length > 0 ? trimmedTitle : baseTitle

      entry.lineNumericId = overrideLine !== undefined ? overrideLine : baseLine

      entry.hubId = effectiveHubId

      if (stationHidden) {
        entry.hidden = true
      }

      stations[id] = entry
      return
    }

    const entry: StationEntry = {}

    if (trimmedTitle && trimmedTitle !== baseTitle) {
      entry.title = trimmedTitle
    }

    if (overrideLine !== undefined) {
      if (overrideLine !== baseLine) {
        entry.lineNumericId = overrideLine
      }
    }

    if (effectiveHubId !== baseHubId) {
      entry.hubId = effectiveHubId
    }

    if (stationHidden) {
      entry.hidden = true
    }

    if (Object.keys(entry).length === 0) {
      return
    }

    stations[id] = entry
  }

  for (const s of fullGraphStations) {
    applyStation(s, false)
  }
  for (const s of Object.values(manualStations)) {
    applyStation(s, true)
  }

  const lines: Record<string, { stationIds?: string[] }> = {}

  for (const line of fullGraphLines) {
    const effective = effectiveLineStationIdsById.get(line.id)
    if (!effective) continue
    const baseIds = line.stationIds
    if (effective.length === baseIds.length && effective.every((sid, idx) => sid === baseIds[idx])) {
      continue
    }
    lines[String(line.id)] = {
      stationIds: effective,
    }
  }

  const edges: Record<
    string,
    {
      fromStationId?: string
      toStationId?: string
      lineNumericId?: number | null
      medianTravelSeconds?: number
      isTransfer?: boolean
      disabled?: boolean
      manual?: boolean
    }
  > = {}

  const allBaseEdges: FullGraphEdge[] = [...fullGraphEdges]

  for (const e of allBaseEdges) {
    const key = edgeKey(e.fromStationId, e.toStationId)
    const ov = edgeOverrides[key]
    if (!ov) continue

    const entry: {
      medianTravelSeconds?: number
      isTransfer?: boolean
      disabled?: boolean
    } = {}

    if (ov.medianTravelSeconds !== undefined) {
      if (ov.medianTravelSeconds !== e.medianTravelSeconds) {
        entry.medianTravelSeconds = ov.medianTravelSeconds
      }
    }
    if (ov.isTransfer !== undefined) {
      if (ov.isTransfer !== !!e.isTransfer) {
        entry.isTransfer = ov.isTransfer
      }
    }
    if (ov.disabled !== undefined && ov.disabled) {
      entry.disabled = true
    }

    if (Object.keys(entry).length === 0) continue

    edges[key] = {
      ...edges[key],
      ...entry,
    }
  }

  for (const e of Object.values(manualEdges)) {
    const key = edgeKey(e.fromStationId, e.toStationId)
    const existing = edges[key] || {}
    edges[key] = {
      ...existing,
      fromStationId: e.fromStationId,
      toStationId: e.toStationId,
      lineNumericId: e.lineNumericId ?? null,
      medianTravelSeconds: e.medianTravelSeconds,
      isTransfer: !!e.isTransfer,
      manual: true,
    }
  }

  const hubs: Record<string, { stationIds?: string[]; minTransferSeconds?: number }> = {}

  // ЯКОРЬ ХАБА. Ключ "hub-N" привязкой не является: номер выдаётся порядком
  // обхода компонент связности при сборке графа, и любая дедупликация станций
  // его сдвигает. Однажды так и вышло — 15 оверрайдов молча осиротели, а в
  // файле не было ни одной улики о том, к какому узлу они относились.
  // Поэтому к каждому оверрайду пишется состав узла (`stationIds`), по нему
  // солвер и ищет хаб (`hubAnchorKey` в go-layout-solver/graph_overrides.go).
  //
  // Состав берётся из БАЗОВОГО графа, а не из «эффективного» состояния
  // редактора: Go сопоставляет якорь с `graph.TransferHubs`, построенным из
  // connections.json ДО применения оверрайдов. Переназначение станции в другой
  // узел (`stations[].hubId`) состав `TransferHubs` на стороне Go не меняет
  // вообще, а скрытие станций происходит уже ПОСЛЕ поиска по якорю. То есть
  // базовый состав — единственное, что Go в этот момент видит.
  const baseHubStationIds = new Map<string, readonly string[]>()
  for (const hub of fullGraphTransferHubs) {
    baseHubStationIds.set(hub.id, hub.stationIds)
  }

  // Запасной вариант — для узлов, которых в базовом графе нет (id придуман
  // редактором). Совпасть с якорем в Go он не сможет, но зато в файле остаётся
  // след состава, а солвер честно скажет «якорь не найден» вместо тихой
  // привязки по нестабильному номеру.
  const effectiveHubStationIds = () => {
    const byHub = new Map<string, string[]>()
    const add = (s: FullGraphStation) => {
      if (hiddenStations[s.id]) return
      const override = stationHubOverrides[s.id]
      let hubId: string | null
      if (override === null) hubId = null
      else if (override !== undefined) hubId = override
      else hubId = s.hubId ?? null
      if (!hubId) return
      const list = byHub.get(hubId)
      if (list) list.push(s.id)
      else byHub.set(hubId, [s.id])
    }
    for (const s of fullGraphStations) add(s)
    for (const s of Object.values(manualStations)) add(s)
    return byHub
  }
  let effectiveHubs: Map<string, string[]> | null = null

  for (const [hubId, seconds] of Object.entries(hubMinOverrides)) {
    if (!Number.isFinite(seconds)) continue

    let anchor = baseHubStationIds.get(hubId)
    if (!anchor) {
      effectiveHubs = effectiveHubs ?? effectiveHubStationIds()
      anchor = effectiveHubs.get(hubId)
    }

    const entry: { stationIds?: string[]; minTransferSeconds?: number } = {
      ...(hubs[hubId] || {}),
    }
    if (anchor && anchor.length > 0) {
      entry.stationIds = sortStationIdsForAnchor(anchor)
    }
    entry.minTransferSeconds = seconds

    hubs[hubId] = entry
  }

  const result: EditorOverrides = {
    layout,
    stations,
    lines,
    edges,
    hubs,
  }

  if (includeRingShapes && Object.keys(canonicalRingShapes).length > 0) {
    result.ringShapes = canonicalRingShapes
  }

  return result
}
