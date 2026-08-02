import fullGraphJson from '../../normalized/fullGraph.json'
import type {
  FullGraphLine,
  FullGraphStation,
  FullGraphEdge,
  FullGraphRingShape,
  FullGraphTransferHub,
  TransferTimeSource,
} from './types'

interface RawFullGraph {
  lines: {
    id: number
    title: string
    colorHex: string
    stationIds: string[]
    segments?: string[][]
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
  /** Необязательное поле: формы колец из оффлайн-солвера, ключ — ID линии строкой. */
  ringShapes?: Record<string, unknown>
}

const raw = fullGraphJson as RawFullGraph

export const fullGraphLines: FullGraphLine[] = raw.lines.map((l) => ({
  id: l.id,
  title: l.title,
  colorHex: l.colorHex,
  stationIds: l.stationIds,
  // Данные, собранные до появления ответвлений, поля не имеют: у линии без
  // ветки сегмент ровно один и совпадает со списком станций.
  segments: l.segments ?? [l.stationIds],
}))

export const fullGraphStations: FullGraphStation[] = raw.stations.map((s) => ({
  id: s.id,
  title: s.title,
  lineNumericId: s.lineNumericId,
  lat: s.lat,
  lon: s.lon,
  layoutX: s.layoutX,
  layoutY: s.layoutY,
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

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Разбирает одну форму кольца, отбрасывая всё, что не соответствует контракту. */
const parseRingShape = (value: unknown): FullGraphRingShape | null => {
  if (typeof value !== 'object' || value === null) return null
  const s = value as Record<string, unknown>
  if (!isFiniteNumber(s.cx) || !isFiniteNumber(s.cy)) return null

  if (s.kind === 'circle') {
    if (!isFiniteNumber(s.r) || s.r <= 0) return null
    return { kind: 'circle', cx: s.cx, cy: s.cy, r: s.r }
  }

  if (s.kind === 'ellipse') {
    if (!isFiniteNumber(s.rx) || !isFiniteNumber(s.ry) || s.rx <= 0 || s.ry <= 0) return null
    return { kind: 'ellipse', cx: s.cx, cy: s.cy, rx: s.rx, ry: s.ry }
  }

  return null
}

/**
 * Формы кольцевых линий из данных. Пустой объект, если поле `ringShapes`
 * отсутствует (старые данные) — тогда рантайм подгоняет форму по станциям сам.
 */
export const fullGraphRingShapes: Record<string, FullGraphRingShape> = (() => {
  const out: Record<string, FullGraphRingShape> = {}
  const src = raw.ringShapes
  if (!src || typeof src !== 'object') return out
  for (const [lineId, value] of Object.entries(src)) {
    const shape = parseRingShape(value)
    if (shape) out[lineId] = shape
  }
  return out
})()

export const fullGraphTransferHubs: FullGraphTransferHub[] = raw.transferHubs.map((h) => ({
	id: h.id,
	stationIds: h.stationIds,
	minTransferSeconds: h.minTransferSeconds,
	source: h.source as TransferTimeSource,
}))
