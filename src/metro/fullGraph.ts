import fullGraphJson from '../../normalized/fullGraph.json'
import type {
  FullGraphLine,
  FullGraphStation,
  FullGraphEdge,
  FullGraphTransferHub,
  TransferTimeSource,
} from './types'

interface RawFullGraph {
  lines: {
    id: number
    title: string
    colorHex: string
    stationIds: string[]
  }[]
  stations: {
    id: string
    title: string
    lineNumericId: number | null
    isTransfer: boolean
    hubId?: string
    lat?: number
    lon?: number
    layoutX?: number
    layoutY?: number
    yandexX?: number
    yandexY?: number
  }[]
  edges: {
    fromStationId: string
    toStationId: string
    lineNumericId?: number
    medianTravelSeconds: number
    isTransfer?: boolean
    transferKind?: string
  }[]
  transferHubs: {
    id: string
    stationIds: string[]
    minTransferSeconds: number
    source: string
  }[]
}

const raw = fullGraphJson as RawFullGraph

export const fullGraphLines: FullGraphLine[] = raw.lines.map((l) => ({
  id: l.id,
  title: l.title,
  colorHex: l.colorHex,
  stationIds: l.stationIds,
}))

export const fullGraphStations: FullGraphStation[] = raw.stations.map((s) => ({
  id: s.id,
  title: s.title,
  lineNumericId: s.lineNumericId,
  lat: s.lat,
  lon: s.lon,
  layoutX: s.layoutX,
  layoutY: s.layoutY,
  yandexX: s.yandexX,
  yandexY: s.yandexY,
  isTransfer: s.isTransfer,
  hubId: s.hubId,
}))

export const fullGraphEdges: FullGraphEdge[] = raw.edges.map((e) => ({
  fromStationId: e.fromStationId,
  toStationId: e.toStationId,
  lineNumericId: e.lineNumericId,
  medianTravelSeconds: e.medianTravelSeconds,
  isTransfer: e.isTransfer,
  transferKind: e.transferKind as FullGraphEdge['transferKind'],
}))

export const fullGraphTransferHubs: FullGraphTransferHub[] = raw.transferHubs.map((h) => ({
	id: h.id,
	stationIds: h.stationIds,
	minTransferSeconds: h.minTransferSeconds,
	source: h.source as TransferTimeSource,
}))
