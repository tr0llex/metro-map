import { fullGraphEdges, fullGraphLines, fullGraphStations } from '../metro/fullGraph.ts'
import type {
  EdgeOverride,
  EditorOverrides,
  EditorOverridesGrid,
  EditorOverridesRingShape,
  EditorOverridesStationLayoutParams,
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
  canonicalGrid: EditorOverridesGrid
  canonicalRingShapes: Record<string, EditorOverridesRingShape>
  canonicalStationParams: Record<string, EditorOverridesStationLayoutParams>
  edgeKey: (a: string, b: string) => string
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
    canonicalGrid,
    canonicalRingShapes,
    canonicalStationParams,
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

  const hubs: Record<string, { minTransferSeconds?: number }> = {}

  for (const [hubId, seconds] of Object.entries(hubMinOverrides)) {
    if (!Number.isFinite(seconds)) continue
    hubs[hubId] = {
      ...(hubs[hubId] || {}),
      minTransferSeconds: seconds,
    }
  }

  return {
    layout,
    stations,
    lines,
    edges,
    hubs,

    grid: canonicalGrid,
    ringShapes: canonicalRingShapes,
    stationParams: canonicalStationParams,
  }
}
