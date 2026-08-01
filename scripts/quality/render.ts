/**
 * Модель отрисовки: воспроизводит то, что реально рисует src/components/MetroMap.tsx.
 *
 * Ключевые факты про рантайм (проверены по коду MetroMap.tsx):
 *  1. Позиции берутся из station.layoutX/layoutY (ветка hasPrecomputed) и НЕ
 *     модифицируются: проекция станций колец перенесена в оффлайн-солвер, поэтому
 *     нарисованная позиция станции равна layoutX/layoutY (rawX/rawY === x/y).
 *  2. Кольцевые линии рисуются как ctx.arc/ctx.ellipse, а не как ломаная по станциям.
 *     Форма берётся из fullGraph.json → ringShapes; если поля нет (старые данные) —
 *     фолбэк на подгонку по станциям (getRingShapeForLine).
 *  3. Общие коридоры (ребро, принадлежащее нескольким линиям) разводятся
 *     параллельным сдвигом на 3px * (index - (n-1)/2).
 */

import type { RawGraph, RawStation } from './types.ts'
import {
  getRingShapeForLine,
  pointOnShape,
  projectPointToRingShape,
  resolveRingShapeForLine,
  type Pt,
  type RingShape,
} from './ringShape.ts'

export { getRingShapeForLine, projectPointToRingShape, resolveRingShapeForLine }
export type { Pt, RingShape }

export const RING_LINE_IDS = new Set<number>([5, 95, 97])

// --- визуальные константы, скопированные из MetroMap.tsx ---
export const BASE_LINE_WIDTH = 6.4
export const STATION_RADIUS_BASE = 5.2
export const STATION_BORDER_WIDTH = 2
export const LABEL_BASE_FONT_PX = 16
export const CORRIDOR_OFFSET_WORLD = 3

/**
 * Опорный зум для метрик — INITIAL_PREFERRED_SCALE из MetroMap.tsx (стартовый вид).
 * stationScale считается той же формулой, что в drawFrame.
 */
export const REFERENCE_ZOOM = 1.1
const clampedZoom = Math.min(Math.max(REFERENCE_ZOOM, 0.7), 2.2)
const zoomT = (clampedZoom - 0.7) / (2.2 - 0.7)
export const STATION_SCALE = 0.95 + zoomT * 0.45

/** Радиус кружка обычной станции в мировых координатах. */
export const STATION_RADIUS = STATION_RADIUS_BASE * STATION_SCALE
/** Радиус кружка станции внутри хаба (рисуется мельче). */
export const HUB_STATION_RADIUS = STATION_RADIUS * 0.75
/** Внешний радиус «пирога» хаба. */
export const HUB_PIE_RADIUS = STATION_RADIUS * 1.7
/** Полуширина линии. */
export const LINE_HALF_WIDTH = BASE_LINE_WIDTH / 2

export interface RenderedStation {
  id: string
  title: string
  lineId: number
  hubId?: string
  /** Позиция из данных (layoutX/layoutY). */
  rawX: number
  rawY: number
  /** Позиция на экране. Сейчас всегда совпадает с rawX/rawY: рантайм не двигает станции. */
  x: number
  y: number
  lineColor: string
}

export interface Segment {
  ax: number
  ay: number
  bx: number
  by: number
  lineId: number
  /** id станций-концов; для сэмплированного кольца — пустая строка. */
  aId: string
  bId: string
}

export interface RenderModel {
  graph: RawGraph
  stations: RenderedStation[]
  byId: Map<string, RenderedStation>
  ringShapes: Map<number, RingShape>
  /** Все нарисованные сегменты линий (кольца — сэмплированы по аналитической форме). */
  segments: Segment[]
  /** Сегменты, инцидентные станции — так же, как labelSegmentsByStationId в рантайме. */
  segmentsByStationId: Map<string, Segment[]>
  /** Станции хаба (по эффективным координатам). */
  hubGroups: Map<string, RenderedStation[]>
  lineTitleById: Map<number, string>
}

const RING_SAMPLES = 360

export function buildRenderModel(graph: RawGraph): RenderModel {
  const lineColorById = new Map<number, string>()
  const lineTitleById = new Map<number, string>()
  for (const line of graph.lines) {
    lineColorById.set(line.id, line.colorHex)
    lineTitleById.set(line.id, line.title)
  }

  const usedStationIds = new Set<string>()
  for (const line of graph.lines) for (const sid of line.stationIds) usedStationIds.add(sid)

  const usable = (s: RawStation) =>
    s.lineNumericId != null &&
    usedStationIds.has(s.id) &&
    typeof s.layoutX === 'number' &&
    typeof s.layoutY === 'number'

  const rawPositions = new Map<string, Pt>()
  for (const s of graph.stations) {
    if (!usable(s)) continue
    rawPositions.set(s.id, { x: s.layoutX as number, y: s.layoutY as number })
  }

  // Форма кольца — из данных, если она там есть; иначе фолбэк-подгонка по станциям.
  // Ровно та же логика, что в resolveRingShapeForLine рантайма.
  const ringShapes = new Map<number, RingShape>()
  for (const line of graph.lines) {
    if (!RING_LINE_IDS.has(line.id)) continue
    const shape = resolveRingShapeForLine(
      line.id,
      line.stationIds,
      rawPositions,
      graph.ringShapes,
    )
    if (shape) ringShapes.set(line.id, shape)
  }

  const stations: RenderedStation[] = []
  for (const s of graph.stations) {
    if (!usable(s)) continue
    const rawX = s.layoutX as number
    const rawY = s.layoutY as number
    // Проекции нет: рантайм рисует станцию ровно там, где её положил солвер.
    const p = { x: rawX, y: rawY }
    stations.push({
      id: s.id,
      title: s.title,
      lineId: s.lineNumericId,
      hubId: s.hubId,
      rawX,
      rawY,
      x: p.x,
      y: p.y,
      lineColor: lineColorById.get(s.lineNumericId) ?? '#000000',
    })
  }

  const byId = new Map<string, RenderedStation>()
  for (const st of stations) byId.set(st.id, st)

  // --- общие коридоры: та же логика, что в corridorEdgeData ---
  const corridorKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const corridorUsage = new Map<string, number[]>()
  for (const line of graph.lines) {
    const ids = line.stationIds.filter((sid) => byId.has(sid))
    if (ids.length < 2) continue
    const segmentCount = RING_LINE_IDS.has(line.id) ? ids.length : ids.length - 1
    for (let i = 0; i < segmentCount; i += 1) {
      const key = corridorKey(ids[i], ids[(i + 1) % ids.length])
      let arr = corridorUsage.get(key)
      if (!arr) {
        arr = []
        corridorUsage.set(key, arr)
      }
      if (!arr.includes(line.id)) arr.push(line.id)
    }
  }

  const segments: Segment[] = []
  const segmentsByStationId = new Map<string, Segment[]>()
  const pushIncident = (sid: string, seg: Segment) => {
    let arr = segmentsByStationId.get(sid)
    if (!arr) {
      arr = []
      segmentsByStationId.set(sid, arr)
    }
    arr.push(seg)
  }

  for (const line of graph.lines) {
    const ids = line.stationIds.filter((sid) => byId.has(sid))
    if (ids.length < 2) continue
    const isRing = RING_LINE_IDS.has(line.id)
    const shape = isRing ? ringShapes.get(line.id) : undefined

    if (shape) {
      // Кольцо рисуется аналитической кривой — сэмплируем её как ломаную.
      for (let i = 0; i < RING_SAMPLES; i += 1) {
        const t0 = (i / RING_SAMPLES) * Math.PI * 2
        const t1 = ((i + 1) / RING_SAMPLES) * Math.PI * 2
        const a = pointOnShape(shape, t0)
        const b = pointOnShape(shape, t1)
        segments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, lineId: line.id, aId: '', bId: '' })
      }
      // Для раскладки подписей рантайм использует хорды между станциями.
      for (let i = 0; i < ids.length; i += 1) {
        const a = byId.get(ids[i])!
        const b = byId.get(ids[(i + 1) % ids.length])!
        const seg: Segment = {
          ax: a.x, ay: a.y, bx: b.x, by: b.y, lineId: line.id, aId: a.id, bId: b.id,
        }
        pushIncident(a.id, seg)
        pushIncident(b.id, seg)
      }
      continue
    }

    const segmentCount = isRing ? ids.length : ids.length - 1
    for (let i = 0; i < segmentCount; i += 1) {
      const a = byId.get(ids[i])!
      const b = byId.get(ids[(i + 1) % ids.length])!
      let offX = 0
      let offY = 0
      const usage = corridorUsage.get(corridorKey(a.id, b.id))
      if (usage && usage.length > 1) {
        const dx = b.x - a.x
        const dy = b.y - a.y
        const len = Math.hypot(dx, dy)
        const index = usage.indexOf(line.id)
        if (len > 1e-3 && index !== -1) {
          const offsetIndex = index - (usage.length - 1) / 2
          offX = (-dy / len) * CORRIDOR_OFFSET_WORLD * offsetIndex
          offY = (dx / len) * CORRIDOR_OFFSET_WORLD * offsetIndex
        }
      }
      const seg: Segment = {
        ax: a.x + offX, ay: a.y + offY, bx: b.x + offX, by: b.y + offY,
        lineId: line.id, aId: a.id, bId: b.id,
      }
      segments.push(seg)
      pushIncident(a.id, seg)
      pushIncident(b.id, seg)
    }
  }

  const hubGroups = new Map<string, RenderedStation[]>()
  for (const st of stations) {
    if (!st.hubId) continue
    const arr = hubGroups.get(st.hubId)
    if (arr) arr.push(st)
    else hubGroups.set(st.hubId, [st])
  }

  return { graph, stations, byId, ringShapes, segments, segmentsByStationId, hubGroups, lineTitleById }
}
