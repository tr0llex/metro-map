import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { FullGraphExport, FullGraphLine, FullGraphStation } from '../src/metro/types'

const KOLTSEVAYA_LINE_ID = 5
const MCC_LINE_ID = 95
const BKL_LINE_ID = 97
const RING_LINE_IDS = new Set<number>([KOLTSEVAYA_LINE_ID, MCC_LINE_ID, BKL_LINE_ID])

type Point = { x: number; y: number }

type Rect = { x1: number; y1: number; x2: number; y2: number }

type RingShape =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

const getRingShapeForLine = (
  lineId: number,
  lineStationIds: string[],
  posById: Map<string, Point>,
): RingShape | null => {
  const pts: Point[] = []
  for (const id of lineStationIds) {
    const p = posById.get(id)
    if (!p) continue
    pts.push(p)
  }
  if (pts.length < 3) return null

  let cx = 0
  let cy = 0
  for (const p of pts) {
    cx += p.x
    cy += p.y
  }
  cx /= pts.length
  cy /= pts.length

  let rSum = 0
  let sumDx2 = 0
  let sumDy2 = 0
  for (const p of pts) {
    const dx = p.x - cx
    const dy = p.y - cy
    rSum += Math.hypot(dx, dy)
    sumDx2 += dx * dx
    sumDy2 += dy * dy
  }
  const baseR = rSum / pts.length
  if (!Number.isFinite(baseR) || baseR <= 0) return null

  if (lineId === BKL_LINE_ID) {
    const varX = sumDx2 / pts.length
    const varY = sumDy2 / pts.length
    if (Number.isFinite(varX) && Number.isFinite(varY) && varX > 0 && varY > 0) {
      let ratio = Math.sqrt(varX / varY)
      if (ratio < 1.1) ratio = 1.1
      else if (ratio > 3.0) ratio = 3.0

      const den = Math.sqrt((ratio * ratio + 1) / 2)
      if (!Number.isFinite(den) || den <= 0) return null
      const s = baseR / den
      const rx = ratio * s
      const ry = s
      if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx <= 0 || ry <= 0) return null
      return { kind: 'ellipse', cx, cy, rx, ry }
    }
  }

  return { kind: 'circle', cx, cy, r: baseR }
}

const projectPointToRingShape = (shape: RingShape, x: number, y: number): Point => {
  if (shape.kind === 'circle') {
    const dx = x - shape.cx
    const dy = y - shape.cy
    const ang = Math.atan2(dy, dx)
    return { x: shape.cx + shape.r * Math.cos(ang), y: shape.cy + shape.r * Math.sin(ang) }
  }

  const dx = x - shape.cx
  const dy = y - shape.cy
  const ang = Math.atan2(dy / shape.ry, dx / shape.rx)
  return { x: shape.cx + shape.rx * Math.cos(ang), y: shape.cy + shape.ry * Math.sin(ang) }
}

const distanceToRingShape = (shape: RingShape, x: number, y: number): number => {
  const p = projectPointToRingShape(shape, x, y)
  return Math.hypot(x - p.x, y - p.y)
}

const angleDistanceRad = (a: number, b: number): number => {
  const twoPi = Math.PI * 2
  let d = a - b
  d = ((d + Math.PI) % twoPi) - Math.PI
  return Math.abs(d)
}

const rectsOverlap = (a: Rect, b: Rect) => {
  const xOverlap = !(a.x2 < b.x1 || a.x1 > b.x2)
  const yOverlap = !(a.y2 < b.y1 || a.y1 > b.y2)
  return xOverlap && yOverlap
}

const segmentIntersectsRect = (seg: { ax: number; ay: number; bx: number; by: number }, r: Rect) => {
  const minX = Math.min(seg.ax, seg.bx)
  const maxX = Math.max(seg.ax, seg.bx)
  const minY = Math.min(seg.ay, seg.by)
  const maxY = Math.max(seg.ay, seg.by)
  if (maxX < r.x1 || minX > r.x2 || maxY < r.y1 || minY > r.y2) return false

  const insideA = seg.ax >= r.x1 && seg.ax <= r.x2 && seg.ay >= r.y1 && seg.ay <= r.y2
  const insideB = seg.bx >= r.x1 && seg.bx <= r.x2 && seg.by >= r.y1 && seg.by <= r.y2
  if (insideA || insideB) return true

  const dx = seg.bx - seg.ax
  const dy = seg.by - seg.ay
  const candidates: Array<{ t: number; x: number; y: number }> = []

  if (dx !== 0) {
    const t1 = (r.x1 - seg.ax) / dx
    const t2 = (r.x2 - seg.ax) / dx
    candidates.push({ t: t1, x: r.x1, y: seg.ay + dy * t1 })
    candidates.push({ t: t2, x: r.x2, y: seg.ay + dy * t2 })
  }

  if (dy !== 0) {
    const t3 = (r.y1 - seg.ay) / dy
    const t4 = (r.y2 - seg.ay) / dy
    candidates.push({ t: t3, x: seg.ax + dx * t3, y: r.y1 })
    candidates.push({ t: t4, x: seg.ax + dx * t4, y: r.y2 })
  }

  for (const c of candidates) {
    if (c.t < 0 || c.t > 1) continue
    if (c.x >= r.x1 && c.x <= r.x2 && c.y >= r.y1 && c.y <= r.y2) return true
  }

  return false
}

const segmentToSegmentDistance = (
  a: { ax: number; ay: number; bx: number; by: number },
  b: { ax: number; ay: number; bx: number; by: number },
): number => {
  // Exact for 2D line segments when using point-to-segment distances + intersection.
  // Intersection is handled by returning 0 if any endpoint lies on the other segment.
  const a0: Point = { x: a.ax, y: a.ay }
  const a1: Point = { x: a.bx, y: a.by }
  const b0: Point = { x: b.ax, y: b.ay }
  const b1: Point = { x: b.bx, y: b.by }

  const d1 = pointToSegmentDistance(a0, b0, b1)
  const d2 = pointToSegmentDistance(a1, b0, b1)
  const d3 = pointToSegmentDistance(b0, a0, a1)
  const d4 = pointToSegmentDistance(b1, a0, a1)
  return Math.min(d1, d2, d3, d4)
}

const rectToSegmentDistance = (r: Rect, seg: { ax: number; ay: number; bx: number; by: number }): number => {
  if (segmentIntersectsRect(seg, r)) return 0

  const top = { ax: r.x1, ay: r.y1, bx: r.x2, by: r.y1 }
  const right = { ax: r.x2, ay: r.y1, bx: r.x2, by: r.y2 }
  const bottom = { ax: r.x2, ay: r.y2, bx: r.x1, by: r.y2 }
  const left = { ax: r.x1, ay: r.y2, bx: r.x1, by: r.y1 }

  return Math.min(
    segmentToSegmentDistance(seg, top),
    segmentToSegmentDistance(seg, right),
    segmentToSegmentDistance(seg, bottom),
    segmentToSegmentDistance(seg, left),
  )
}

const approxTextWidthPx = (text: string, fontPx: number) => {
  const avgChar = fontPx * 0.56
  return text.length * avgChar
}

const splitLabelToLines = (label: string, radialDist: number): string[] => {
  const maxSingleLineChars = radialDist < 260 ? 14 : 18
  if (label.length <= maxSingleLineChars) return [label]
  const words = label.split(' ').filter((w) => w.length > 0)
  if (words.length <= 1) return [label]
  let bestIndex = 1
  let bestDiff = Infinity
  for (let i = 1; i < words.length; i += 1) {
    const left = words.slice(0, i).join(' ')
    const right = words.slice(i).join(' ')
    const diff = Math.abs(left.length - right.length)
    if (diff < bestDiff) {
      bestDiff = diff
      bestIndex = i
    }
  }
  const first = words.slice(0, bestIndex).join(' ')
  const second = words.slice(bestIndex).join(' ')
  if (!first || !second) return [label]
  return [first, second]
}

const buildRingPolylineSegments = (shape: RingShape, steps: number) => {
  const segs: Array<{ ax: number; ay: number; bx: number; by: number }> = []
  const n = Math.max(8, Math.floor(steps))
  let prev: Point | null = null
  for (let i = 0; i <= n; i += 1) {
    const t = (i / n) * Math.PI * 2
    const x = shape.kind === 'circle' ? shape.cx + shape.r * Math.cos(t) : shape.cx + shape.rx * Math.cos(t)
    const y = shape.kind === 'circle' ? shape.cy + shape.r * Math.sin(t) : shape.cy + shape.ry * Math.sin(t)
    if (prev) segs.push({ ax: prev.x, ay: prev.y, bx: x, by: y })
    prev = { x, y }
  }
  return segs
}

function buildLabelStationDisks(
  graph: FullGraphExport,
  renderedPosById: Map<string, Point>,
  labelFontPx: number,
): { x: number; y: number; r: number }[] {
  const hubCenters = new Map<string, { x: number; y: number }>()
  const hubCounts = new Map<string, number>()

  for (const st of graph.stations) {
    if (!st.hubId) continue
    const p = renderedPosById.get(st.id)
    if (!p) continue
    const hubId = st.hubId
    const existing = hubCenters.get(hubId)
    if (!existing) {
      hubCenters.set(hubId, { x: p.x, y: p.y })
      hubCounts.set(hubId, 1)
    } else {
      existing.x += p.x
      existing.y += p.y
      hubCounts.set(hubId, (hubCounts.get(hubId) ?? 0) + 1)
    }
  }

  for (const [hubId, center] of hubCenters.entries()) {
    const count = hubCounts.get(hubId) || 1
    center.x /= count
    center.y /= count
    hubCenters.set(hubId, center)
  }

  const labelStations: FullGraphStation[] = []
  const hubRepresentative = new Map<string, FullGraphStation>()
  for (const st of graph.stations) {
    if (!st.title) continue
    if (st.hubId != null) {
      const key = `${st.hubId}|${st.title.toLowerCase()}`
      if (!hubRepresentative.has(key)) hubRepresentative.set(key, st)
    } else {
      labelStations.push(st)
    }
  }
  for (const st of hubRepresentative.values()) labelStations.push(st)

  const hubMainStationId = new Map<string, string>()
  for (const st of labelStations) {
    if (st.hubId == null) continue
    const p = renderedPosById.get(st.id)
    if (!p) continue
    const hubId = st.hubId
    const r = Math.sqrt(p.x * p.x + p.y * p.y)
    const existingId = hubMainStationId.get(hubId)
    if (!existingId) {
      hubMainStationId.set(hubId, st.id)
    } else {
      const existingP = renderedPosById.get(existingId)
      if (!existingP) {
        hubMainStationId.set(hubId, st.id)
      } else {
        const er = Math.sqrt(existingP.x * existingP.x + existingP.y * existingP.y)
        if (r < er) hubMainStationId.set(hubId, st.id)
      }
    }
  }

  const disks: { x: number; y: number; r: number }[] = []
  const marginFromFont = labelFontPx * 0.45
  for (const st of labelStations) {
    const p = renderedPosById.get(st.id)
    if (!p) continue

    const isHub = st.hubId != null
    const hubCenter = isHub && st.hubId ? hubCenters.get(st.hubId) : undefined
    const anchorX = hubCenter ? hubCenter.x : p.x
    const anchorY = hubCenter ? hubCenter.y : p.y
    const rr = Math.sqrt(anchorX * anchorX + anchorY * anchorY)

    let baseRadius = 10
    if (isHub && st.hubId != null) {
      const mainId = hubMainStationId.get(st.hubId)
      const isMain = mainId === st.id
      baseRadius = isMain ? 16 : 13
    } else {
      if (rr < 220) baseRadius = 10
      else if (rr < 420) baseRadius = 10
      else baseRadius = 10
    }

    const diskRadius = baseRadius + marginFromFont
    disks.push({ x: anchorX, y: anchorY, r: diskRadius })
  }

  return disks
}

type LabelPlacementSim = {
  stationId: string
  title: string
  rect: Rect
  centerX: number
  centerY: number
  distToAnchor: number
  hardOverlap: boolean
  hardOverlapStation: boolean
  localLineHit: boolean
  hadNonOverlappingCandidate: boolean
}

const effectiveStationDrawRadius = (st: FullGraphStation) => {
  const base = 5.2
  if (st.hubId != null) return base * 0.75
  return base
}

function buildSegmentsByStationId(
  graph: FullGraphExport,
  renderedPosById: Map<string, Point>,
): Map<string, { ax: number; ay: number; bx: number; by: number }[]> {
  const segmentsByStationId = new Map<string, { ax: number; ay: number; bx: number; by: number }[]>()
  for (const line of graph.lines) {
    const ids = line.stationIds.filter((sid) => renderedPosById.has(sid))
    if (ids.length < 2) continue
    for (let i = 0; i < ids.length - 1; i += 1) {
      const aId = ids[i]
      const bId = ids[i + 1]
      const a = renderedPosById.get(aId)
      const b = renderedPosById.get(bId)
      if (!a || !b) continue
      const seg = { ax: a.x, ay: a.y, bx: b.x, by: b.y }

      let listA = segmentsByStationId.get(aId)
      if (!listA) {
        listA = []
        segmentsByStationId.set(aId, listA)
      }
      listA.push(seg)

      let listB = segmentsByStationId.get(bId)
      if (!listB) {
        listB = []
        segmentsByStationId.set(bId, listB)
      }
      listB.push(seg)
    }
  }
  return segmentsByStationId
}

function simulateLabelPlacements(graph: FullGraphExport, renderedPosById: Map<string, Point>): LabelPlacementSim[] {
  const LABEL_FONT_PX = 16

  const hubCenters = new Map<string, { x: number; y: number }>()
  const hubCounts = new Map<string, number>()
  const stationsByHubId = new Map<string, FullGraphStation[]>()

  for (const st of graph.stations) {
    if (!st.hubId) continue
    const p = renderedPosById.get(st.id)
    if (!p) continue
    const hubId = st.hubId

    const existingCenter = hubCenters.get(hubId)
    if (!existingCenter) {
      hubCenters.set(hubId, { x: p.x, y: p.y })
      hubCounts.set(hubId, 1)
    } else {
      existingCenter.x += p.x
      existingCenter.y += p.y
      hubCounts.set(hubId, (hubCounts.get(hubId) ?? 0) + 1)
    }

    let hubStations = stationsByHubId.get(hubId)
    if (!hubStations) {
      hubStations = []
      stationsByHubId.set(hubId, hubStations)
    }
    hubStations.push(st)
  }

  for (const [hubId, center] of hubCenters.entries()) {
    const count = hubCounts.get(hubId) || 1
    center.x /= count
    center.y /= count
    hubCenters.set(hubId, center)
  }

  const labelStations: FullGraphStation[] = []
  const hubRepresentative = new Map<string, FullGraphStation>()
  for (const st of graph.stations) {
    if (!st.title) continue
    if (st.hubId != null) {
      const key = `${st.hubId}|${st.title.toLowerCase()}`
      if (!hubRepresentative.has(key)) hubRepresentative.set(key, st)
    } else {
      labelStations.push(st)
    }
  }
  for (const st of hubRepresentative.values()) labelStations.push(st)

  const hubMainStationId = new Map<string, string>()
  for (const st of labelStations) {
    if (st.hubId == null) continue
    const p = renderedPosById.get(st.id)
    if (!p) continue
    const hubId = st.hubId
    const r = Math.sqrt(p.x * p.x + p.y * p.y)
    const existingId = hubMainStationId.get(hubId)
    if (!existingId) {
      hubMainStationId.set(hubId, st.id)
    } else {
      const existingP = renderedPosById.get(existingId)
      if (!existingP) {
        hubMainStationId.set(hubId, st.id)
      } else {
        const er = Math.sqrt(existingP.x * existingP.x + existingP.y * existingP.y)
        if (r < er) hubMainStationId.set(hubId, st.id)
      }
    }
  }

  const stationInfos = labelStations
    .map((st) => {
      const p = renderedPosById.get(st.id)
      if (!p) return null

      const isHub = st.hubId != null
      const hubCenter = isHub && st.hubId ? hubCenters.get(st.hubId) : undefined
      const anchorX = hubCenter ? hubCenter.x : p.x
      const anchorY = hubCenter ? hubCenter.y : p.y
      const r = Math.sqrt(anchorX * anchorX + anchorY * anchorY)

      let priority = 0
      let baseRadius = 10

      if (isHub && st.hubId != null) {
        const mainId = hubMainStationId.get(st.hubId)
        const isMain = mainId === st.id
        priority = isMain ? 3 : 2
        baseRadius = isMain ? 16 : 13
      } else {
        if (r < 220) priority = 2
        else if (r < 420) priority = 1
        baseRadius = 10
      }

      const marginFromFont = LABEL_FONT_PX * 0.45
      const diskRadius = baseRadius + marginFromFont
      return { st, priority, r, diskRadius, anchorX, anchorY }
    })
    .filter((v): v is NonNullable<typeof v> => v != null)

  const stationDisks = stationInfos.map((info) => ({ x: info.anchorX, y: info.anchorY, r: info.diskRadius }))

  const stationsForLabels = [...stationInfos].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    return a.r - b.r
  })

  const segmentsByStationId = buildSegmentsByStationId(graph, renderedPosById)

  const getSegmentsForLabelStation = (st: FullGraphStation) => {
    const direct = segmentsByStationId.get(st.id) ?? []
    if (!st.hubId) return direct
    const hubStations = stationsByHubId.get(st.hubId)
    if (!hubStations || hubStations.length <= 1) return direct
    const result = [...direct]
    for (const hubSt of hubStations) {
      if (hubSt.id === st.id) continue
      const extra = segmentsByStationId.get(hubSt.id)
      if (!extra || extra.length === 0) continue
      result.push(...extra)
    }
    return result
  }

  const drawnLabels: Array<Rect & { centerX: number; centerY: number; width: number; height: number; importance: number }> = []
  const placements: LabelPlacementSim[] = []

  const CENTER_RADIUS = 240
  const MIDDLE_RADIUS = 520

  for (const info of stationsForLabels) {
    const st = info.st
    const anchorX = info.anchorX
    const anchorY = info.anchorY

    const label = st.title
    if (!label) continue

    const lines = splitLabelToLines(label, info.r)
    const lineHeight = LABEL_FONT_PX + 2
    const lineSpacing = LABEL_FONT_PX * 0.12
    let maxLineWidth = 0
    for (const ln of lines) {
      const w = approxTextWidthPx(ln, LABEL_FONT_PX)
      if (w > maxLineWidth) maxLineWidth = w
    }
    const textWidth = maxLineWidth
    const textHeight = lineHeight * lines.length + lineSpacing * Math.max(0, lines.length - 1)

    const segmentsForStation = getSegmentsForLabelStation(st)

    const isRingStation = typeof st.lineNumericId === 'number' && RING_LINE_IDS.has(st.lineNumericId)
    const baseAngles: number[] = []
    let radialAngleForStation: number | null = null

    if (!isRingStation && segmentsForStation.length > 0) {
      let sumDx = 0
      let sumDy = 0
      for (const seg of segmentsForStation) {
        const dx = seg.bx - seg.ax
        const dy = seg.by - seg.ay
        const len = Math.hypot(dx, dy) || 1
        sumDx += dx / len
        sumDy += dy / len
      }
      if (sumDx !== 0 || sumDy !== 0) {
        const tangentAngle = Math.atan2(sumDy, sumDx)
        const normalAngle = tangentAngle + Math.PI / 2
        baseAngles.push(normalAngle, normalAngle + Math.PI)
      }
    }

    if (baseAngles.length === 0) {
      const radialAngle = Math.atan2(anchorY, anchorX || 1e-6)
      baseAngles.push(radialAngle)
      radialAngleForStation = radialAngle
    }

    const isCenterZone = info.r < CENTER_RADIUS
    const isMiddleZone = !isCenterZone && info.r < MIDDLE_RADIUS

    const radiusOffsets = isCenterZone
      ? [16, 22, 28, 34, 42]
      : isMiddleZone
        ? [18, 24, 30, 38, 48, 60, 72]
        : [18, 24, 30, 38, 48, 60, 74, 92]

    const angleOffsets = [
      0,
      Math.PI / 20,
      -Math.PI / 20,
      Math.PI / 10,
      -Math.PI / 10,
      Math.PI / 6,
      -Math.PI / 6,
      Math.PI / 4,
      -Math.PI / 4,
    ]

    let bestCandidate:
      | (Rect & {
          centerX: number
          centerY: number
          width: number
          height: number
          score: number
          distToStation: number
          overlaps: boolean
          overlapsStation: boolean
          localLineHit: boolean
        })
      | null = null

    let hadNonOverlappingCandidate = false

    for (const baseAngle of baseAngles) {
      for (const rOffset of radiusOffsets) {
        for (const dAngle of angleOffsets) {
          const ang = baseAngle + dAngle

          if (isRingStation && radialAngleForStation != null) {
            const dirDot = Math.cos(ang - radialAngleForStation)
            if (dirDot < 0) continue
          }

          const px = anchorX + Math.cos(ang) * rOffset
          const py = anchorY + Math.sin(ang) * rOffset

          const alignRight = Math.cos(ang) < 0
          const labelX = px
          const labelY = py

          const x1 = alignRight ? labelX - textWidth : labelX
          const y1 = labelY - textHeight / 2
          const x2 = x1 + textWidth
          const y2 = y1 + textHeight

          const cx = (x1 + x2) / 2
          const cy = (y1 + y2) / 2
          const dx = cx - anchorX
          const dy = cy - anchorY
          const distToStation = Math.sqrt(dx * dx + dy * dy)

          let nearestOtherDist2 = Infinity
          for (const other of stationInfos) {
            if (other.st.id === st.id) continue
            const odx = other.anchorX - cx
            const ody = other.anchorY - cy
            const d2 = odx * odx + ody * ody
            if (d2 < nearestOtherDist2) nearestOtherDist2 = d2
          }
          const ownDist2 = distToStation * distToStation

          let overlaps = false
          let softRepulsionPenalty = 0
          let columnPenalty = 0

          const softGapYThreshold = textHeight * 0.5
          const softGapXThreshold = textWidth * 0.5

          const candidateRect: Rect = { x1, y1, x2, y2 }

          for (const r of drawnLabels) {
            const xOverlap = !(x2 < r.x1 || x1 > r.x2)
            const yOverlap = !(y2 < r.y1 || y1 > r.y2)

            if (xOverlap && yOverlap) {
              overlaps = true
            } else {
              if (xOverlap) {
                const gapY = y1 > r.y2 ? y1 - r.y2 : r.y1 - y2
                if (gapY < softGapYThreshold) {
                  const t = (softGapYThreshold - gapY) / Math.max(softGapYThreshold, 1)
                  softRepulsionPenalty += 260 * t
                }
              }

              if (yOverlap) {
                const gapX = x1 > r.x2 ? x1 - r.x2 : r.x1 - x2
                if (gapX < softGapXThreshold) {
                  const t = (softGapXThreshold - gapX) / Math.max(softGapXThreshold, 1)
                  softRepulsionPenalty += 220 * t
                }
              }
            }

            if (r.importance >= 2) {
              const auraPadX = r.width * 0.25
              const auraPadY = r.height * 0.35
              const ax1 = r.x1 - auraPadX
              const ay1 = r.y1 - auraPadY
              const ax2 = r.x2 + auraPadX
              const ay2 = r.y2 + auraPadY
              const inAura = !(x2 < ax1 || x1 > ax2 || y2 < ay1 || y1 > ay2)
              if (inAura) {
                softRepulsionPenalty += 900
              }
            }

            const dxCenter = Math.abs(cx - r.centerX)
            const dyCenter = Math.abs(cy - r.centerY)
            const columnWidth = Math.max(textWidth, r.width) * 0.35
            if (dxCenter < columnWidth) {
              const normDy = dyCenter / Math.max(textHeight, r.height)
              if (normDy < 3) {
                const t = (3 - normDy) / 3
                columnPenalty += 520 * t
              }
            }
          }

          const overlapsStation = stationDisks.some((d) => {
            const sx1 = d.x - d.r
            const sy1 = d.y - d.r
            const sx2 = d.x + d.r
            const sy2 = d.y + d.r
            return !(x2 < sx1 || x1 > sx2 || y2 < sy1 || y1 > sy2)
          })

          let score = rOffset
          if (overlaps) score += 8000
          if (overlapsStation) score += 8000
          if (softRepulsionPenalty > 0) score += softRepulsionPenalty
          if (columnPenalty > 0) score += columnPenalty

          if (segmentsForStation.length > 0) {
            for (const seg of segmentsForStation) {
              if (segmentIntersectsRect(seg, candidateRect)) {
                score += 140
              }
            }
          }

          let localLineHit = false
          if (segmentsForStation.length > 0) {
            for (const seg of segmentsForStation) {
              if (segmentIntersectsRect(seg, candidateRect)) {
                localLineHit = true
                break
              }
            }
          }

          const preferredMaxDist = isCenterZone ? 44 : isMiddleZone ? 60 : 84
          if (distToStation > preferredMaxDist) {
            const extra = distToStation - preferredMaxDist
            score += extra * 16
          }

          if (Number.isFinite(nearestOtherDist2) && nearestOtherDist2 + 1e-3 < ownDist2) {
            score += 4000
          }

          if (!bestCandidate || score < bestCandidate.score) {
            bestCandidate = {
              x1,
              y1,
              x2,
              y2,
              centerX: cx,
              centerY: cy,
              width: textWidth,
              height: textHeight,
              score,
              distToStation,
              overlaps,
              overlapsStation,
              localLineHit,
            }
          }

          if (!overlaps && !overlapsStation) hadNonOverlappingCandidate = true
        }
      }
    }

    if (!bestCandidate) continue

    drawnLabels.push({
      x1: bestCandidate.x1,
      y1: bestCandidate.y1,
      x2: bestCandidate.x2,
      y2: bestCandidate.y2,
      centerX: bestCandidate.centerX,
      centerY: bestCandidate.centerY,
      width: bestCandidate.width,
      height: bestCandidate.height,
      importance: info.priority,
    })

    placements.push({
      stationId: st.id,
      title: st.title,
      rect: { x1: bestCandidate.x1, y1: bestCandidate.y1, x2: bestCandidate.x2, y2: bestCandidate.y2 },
      centerX: bestCandidate.centerX,
      centerY: bestCandidate.centerY,
      distToAnchor: bestCandidate.distToStation,
      hardOverlap: bestCandidate.overlaps,
      hardOverlapStation: bestCandidate.overlapsStation,
      localLineHit: bestCandidate.localLineHit,
      hadNonOverlappingCandidate,
    })
  }

  return placements
}

function buildRawPositionMap(graph: FullGraphExport): Map<string, Point> {
  const map = new Map<string, Point>()
  for (const st of graph.stations) {
    if (!isFiniteNumber(st.layoutX) || !isFiniteNumber(st.layoutY)) continue
    map.set(st.id, { x: st.layoutX, y: st.layoutY })
  }
  return map
}

function buildRenderedPositionMap(graph: FullGraphExport, raw: Map<string, Point>): Map<string, Point> {
  const rendered = new Map<string, Point>(raw)

  const ringShapesByLineId = new Map<number, RingShape>()
  for (const line of graph.lines) {
    if (!RING_LINE_IDS.has(line.id)) continue
    const shape = getRingShapeForLine(line.id, line.stationIds, rendered)
    if (shape) ringShapesByLineId.set(line.id, shape)
  }

  if (ringShapesByLineId.size === 0) return rendered

  for (const st of graph.stations) {
    if (st.lineNumericId == null) continue
    const shape = ringShapesByLineId.get(st.lineNumericId)
    if (!shape) continue
    const p = rendered.get(st.id)
    if (!p) continue
    rendered.set(st.id, projectPointToRingShape(shape, p.x, p.y))
  }

  return rendered
}

function pointToSegmentDistance(p: Point, a: Point, b: Point): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const wx = p.x - a.x
  const wy = p.y - a.y

  const vv = vx * vx + vy * vy
  if (vv <= 1e-9) return Math.hypot(wx, wy)

  let t = (wx * vx + wy * vy) / vv
  if (t < 0) t = 0
  else if (t > 1) t = 1
  const px = a.x + t * vx
  const py = a.y + t * vy
  return Math.hypot(p.x - px, p.y - py)
}

interface StatsSummary {
  count: number
  min: number
  max: number
  mean: number
  p50: number
  p90: number
  p99: number
}

interface HistogramBin {
  from: number
  to: number
  count: number
}

interface RadialZoneStats {
  name: string
  radiusFrom: number
  radiusTo: number
  stationCount: number
  area: number
  density: number
}

interface SmallComponentInfo {
  size: number
  sampleStationIds: string[]
}

interface DuplicateTitleGroupInfo {
  title: string
  count: number
}

interface LineConnectivityInfo {
  title: string
  totalStations: number
  stationsInMainComponent: number
}

interface QualityMetrics {
  // Кольца
  ringEccentricity: Record<string, number>
  ringRadius: Record<string, number>
  ringAxisRatio: Record<string, number>
  ringOrientationDeg: Record<string, number>

  ringProjectionErrorMeanPx: Record<string, number>
  ringProjectionErrorP90Px: Record<string, number>
  ringProjectionErrorMaxPx: Record<string, number>
  
  // Плотность и перекрытия
  closePairsCount: number
  veryClosePairsCount: number
  averageStationDistance: number
  minStationDistance: number

  closePairsCountRaw: number
  veryClosePairsCountRaw: number
  averageStationDistanceRaw: number
  minStationDistanceRaw: number

  overlappingPairsCount: number
  overlappingPairsSamples: string[]
  
  // Геометрия линий
  sharpTurnsCount: number
  averageTurnAngle: number
  maxTurnAngle: number
  lineSmoothness: Record<string, number>

  // Расширенный анализ углов
  turnAngleStats: StatsSummary | null
  turnAngleHistogram: HistogramBin[]

  // Рёбра и их длины
  edgeLengthStats: StatsSummary | null
  edgeLengthHistogram: HistogramBin[]
  
  // Хабы
  hubCompactness: Record<string, number>
  hubsNotSnapped: number
  hubsWithMultipleStations: number

  hubCenterScatterStats: StatsSummary | null
  hubPieMinStationGap: number
  hubPieOverlapsStationCount: number
  hubPieOverlapsLineCount: number
  hubPieConflictSamples: string[]
  
  // Распределение пространства
  innerRingDensity: number
  outerRingDensity: number

  // Плотность станций по радиальным зонам
  radialDensityZones: RadialZoneStats[]
  
  // Октолинейность
  octilinearDeviationMean: number
  octilinearDeviationP90: number
  perfectOctilinearSegments: number
  totalOctilinearSegments: number
  
  // Масштаб
  boundingBox: { width: number; height: number; area: number }
  stationSpread: number

  minStationToLineDistance: number
  stationLineConflictsCount: number
  stationLineConflictsSamples: string[]

  labelPlacementsCount: number
  labelOverlapPairsCount: number
  labelOverlapsStationCount: number
  labelIntersectsLineCount: number
  labelDistanceStats: StatsSummary | null

  labelFallbackCount: number
  labelHardOverlapsCount: number
  labelHardStationOverlapsCount: number
  labelLocalLineHitCount: number
  labelOverlapSamples: string[]
  labelLineHitSamples: string[]
  labelStationOverlapSamples: string[]

  labelLineWorstCount: number
  labelLineWorstSamples: string[]

  stationDiskGapStats: StatsSummary | null
  stationDiskOverlapPairsCount: number
  stationDiskGapMin: number
  stationDiskGapSamples: string[]

  stationToLineBandGapStats: StatsSummary | null
  stationToLineBandOverlapCount: number
  stationToLineBandGapMin: number
  stationToLineBandSamples: string[]

  // Проблемные станции
  missingYandexCoords: number
  fallbackStationsCount: number

  // Топология графа
  componentsCount: number
  smallComponents: SmallComponentInfo[]
  stationsWithoutEdgesCount: number
  edgesWithMissingStations: number
  edgesWithMismatchedLineIds: number
  transferEdgesWithoutCommonHub: number
  transferEdgesSameLine: number
  hubsWithMissingStations: number
  hubsDisconnectedInternally: number
  duplicateTitleGroups: DuplicateTitleGroupInfo[]
  unhubbedDuplicateTitleGroups: DuplicateTitleGroupInfo[]
  graphFullyConnected: boolean
  disconnectedLines: LineConnectivityInfo[]
  partiallyDisconnectedLines: LineConnectivityInfo[]
}

type StationWithYandex = FullGraphStation & { yandexX?: number; yandexY?: number }

function computeStatsSummary(values: number[]): StatsSummary | null {
  if (values.length === 0) return null

  const sorted = [...values].sort((a, b) => a - b)
  const count = sorted.length
  const min = sorted[0]
  const max = sorted[count - 1]
  const sum = sorted.reduce((acc, v) => acc + v, 0)
  const mean = sum / count

  const percentile = (p: number) => {
    if (count === 1) return sorted[0]
    const idx = (count - 1) * p
    const lower = Math.floor(idx)
    const upper = Math.ceil(idx)
    if (lower === upper) return sorted[lower]
    const weight = idx - lower
    return sorted[lower] * (1 - weight) + sorted[upper] * weight
  }

  return {
    count,
    min,
    max,
    mean,
    p50: percentile(0.5),
    p90: percentile(0.9),
    p99: percentile(0.99),
  }
}

function buildHistogram(values: number[], bucketSize: number, maxBucket?: number): HistogramBin[] {
  if (values.length === 0) return []

  const maxValue = values.reduce((m, v) => (v > m ? v : m), 0)
  const upper = maxBucket != null ? Math.max(maxBucket, bucketSize) : maxValue
  const bucketCount = Math.max(1, Math.ceil(upper / bucketSize))
  const counts = new Array<number>(bucketCount + 1).fill(0)

  for (const v of values) {
    if (v < 0) continue
    let idx = Math.floor(v / bucketSize)
    if (idx >= bucketCount) idx = bucketCount
    counts[idx] += 1
  }

  const bins: HistogramBin[] = []
  for (let i = 0; i < bucketCount; i += 1) {
    const from = i * bucketSize
    const to = (i + 1) * bucketSize
    bins.push({ from, to, count: counts[i] })
  }

  // Хвостовой бакет для всех значений >= upper
  const tailFrom = bucketCount * bucketSize
  const tailTo = tailFrom + bucketSize
  bins.push({ from: tailFrom, to: tailTo, count: counts[bucketCount] })

  return bins
}

function calculateQualityMetrics(graph: FullGraphExport): QualityMetrics {
  const stationMap = new Map<string, FullGraphStation>()
  for (const st of graph.stations) {
    stationMap.set(st.id, st)
  }

  const lineMap = new Map<number, FullGraphLine>()
  for (const line of graph.lines) {
    lineMap.set(line.id, line)
  }

  const metrics: QualityMetrics = {
    ringEccentricity: {},
    ringRadius: {},
    ringAxisRatio: {},
    ringOrientationDeg: {},
    ringProjectionErrorMeanPx: {},
    ringProjectionErrorP90Px: {},
    ringProjectionErrorMaxPx: {},
    closePairsCount: 0,
    veryClosePairsCount: 0,
    averageStationDistance: 0,
    minStationDistance: Infinity,
    closePairsCountRaw: 0,
    veryClosePairsCountRaw: 0,
    averageStationDistanceRaw: 0,
    minStationDistanceRaw: Infinity,
    overlappingPairsCount: 0,
    overlappingPairsSamples: [],
    sharpTurnsCount: 0,
    averageTurnAngle: 0,
    maxTurnAngle: 0,
    lineSmoothness: {},
    turnAngleStats: null,
    turnAngleHistogram: [],
    edgeLengthStats: null,
    edgeLengthHistogram: [],
    hubCompactness: {},
    hubsNotSnapped: 0,
    hubsWithMultipleStations: 0,
    hubCenterScatterStats: null,
    hubPieMinStationGap: Infinity,
    hubPieOverlapsStationCount: 0,
    hubPieOverlapsLineCount: 0,
    hubPieConflictSamples: [],
    innerRingDensity: 0,
    outerRingDensity: 0,
    radialDensityZones: [],
    octilinearDeviationMean: 0,
    octilinearDeviationP90: 0,
    perfectOctilinearSegments: 0,
    totalOctilinearSegments: 0,
    boundingBox: { width: 0, height: 0, area: 0 },
    stationSpread: 0,
    minStationToLineDistance: Infinity,
    stationLineConflictsCount: 0,
    stationLineConflictsSamples: [],

    labelPlacementsCount: 0,
    labelOverlapPairsCount: 0,
    labelOverlapsStationCount: 0,
    labelIntersectsLineCount: 0,
    labelDistanceStats: null,

    labelFallbackCount: 0,
    labelHardOverlapsCount: 0,
    labelHardStationOverlapsCount: 0,
    labelLocalLineHitCount: 0,
    labelOverlapSamples: [],
    labelLineHitSamples: [],
    labelStationOverlapSamples: [],

    labelLineWorstCount: 0,
    labelLineWorstSamples: [],

    stationDiskGapStats: null,
    stationDiskOverlapPairsCount: 0,
    stationDiskGapMin: Infinity,
    stationDiskGapSamples: [],

    stationToLineBandGapStats: null,
    stationToLineBandOverlapCount: 0,
    stationToLineBandGapMin: Infinity,
    stationToLineBandSamples: [],
    missingYandexCoords: 0,
    fallbackStationsCount: 0,
    componentsCount: 0,
    smallComponents: [],
    stationsWithoutEdgesCount: 0,
    edgesWithMissingStations: 0,
    edgesWithMismatchedLineIds: 0,
    transferEdgesWithoutCommonHub: 0,
    transferEdgesSameLine: 0,
    hubsWithMissingStations: 0,
    hubsDisconnectedInternally: 0,
    duplicateTitleGroups: [],
    unhubbedDuplicateTitleGroups: [],
    graphFullyConnected: false,
    disconnectedLines: [],
    partiallyDisconnectedLines: [],
  }

  const rawPosById = buildRawPositionMap(graph)
  const renderedPosById = buildRenderedPositionMap(graph, rawPosById)

  const ringShapesByLineId = new Map<number, RingShape>()
  for (const line of graph.lines) {
    if (!RING_LINE_IDS.has(line.id)) continue
    const shape = getRingShapeForLine(line.id, line.stationIds, renderedPosById)
    if (shape) ringShapesByLineId.set(line.id, shape)
  }

  // 1. Анализ колец
  for (const ringId of [KOLTSEVAYA_LINE_ID, MCC_LINE_ID, BKL_LINE_ID]) {
    const line = lineMap.get(ringId)
    if (!line) continue

    const rawCoords: Point[] = []
    const renderedCoords: Point[] = []
    for (const sid of line.stationIds) {
      const rawP = rawPosById.get(sid)
      if (rawP) rawCoords.push(rawP)
      const renP = renderedPosById.get(sid)
      if (renP) renderedCoords.push(renP)
    }
    if (rawCoords.length < 3 || renderedCoords.length < 3) continue

    const shape = getRingShapeForLine(line.id, line.stationIds, renderedPosById)
    if (!shape) continue

    const projectionErrors: number[] = []
    for (const sid of line.stationIds) {
      const rawP = rawPosById.get(sid)
      if (!rawP) continue
      const projected = projectPointToRingShape(shape, rawP.x, rawP.y)
      projectionErrors.push(Math.hypot(rawP.x - projected.x, rawP.y - projected.y))
    }
    projectionErrors.sort((a, b) => a - b)
    const meanErr =
      projectionErrors.length > 0
        ? projectionErrors.reduce((a, b) => a + b, 0) / projectionErrors.length
        : 0
    const p90Err =
      projectionErrors.length > 0
        ? projectionErrors[Math.floor((projectionErrors.length - 1) * 0.9)]
        : 0
    const maxErr = projectionErrors.length > 0 ? projectionErrors[projectionErrors.length - 1] : 0

    metrics.ringProjectionErrorMeanPx[line.title] = meanErr
    metrics.ringProjectionErrorP90Px[line.title] = p90Err
    metrics.ringProjectionErrorMaxPx[line.title] = maxErr

    if (shape.kind === 'circle') {
      const radii: number[] = []
      for (const p of renderedCoords) {
        radii.push(Math.hypot(p.x - shape.cx, p.y - shape.cy))
      }
      const r = shape.r
      const variance = radii.reduce((sum, rr) => sum + (rr - r) ** 2, 0) / radii.length
      const stdDev = Math.sqrt(variance)
      metrics.ringEccentricity[line.title] = r > 0 ? stdDev / r : 0
      metrics.ringRadius[line.title] = r
      metrics.ringAxisRatio[line.title] = 1
      metrics.ringOrientationDeg[line.title] = 0
    } else {
      const errs: number[] = []
      for (const p of renderedCoords) {
        const proj = projectPointToRingShape(shape, p.x, p.y)
        errs.push(Math.hypot(p.x - proj.x, p.y - proj.y))
      }
      const mean = errs.length > 0 ? errs.reduce((a, b) => a + b, 0) / errs.length : 0
      const denom = Math.sqrt(shape.rx * shape.ry)
      metrics.ringEccentricity[line.title] = denom > 0 ? mean / denom : 0
      metrics.ringRadius[line.title] = Math.sqrt(shape.rx * shape.ry)
      metrics.ringAxisRatio[line.title] = shape.rx >= shape.ry ? shape.rx / shape.ry : shape.ry / shape.rx
      metrics.ringOrientationDeg[line.title] = 0
    }
  }

  // 2. Анализ близости станций
  const stationsWithCoords: FullGraphStation[] = []
  for (const st of graph.stations) {
    if (renderedPosById.has(st.id)) {
      stationsWithCoords.push(st)
    }
  }

  // Соседние станции по линии считаем «ожидаемо близкими» — их длина
  // уже анализируется через edgeLengthStats. Для метрики близких пар
  // интереснее конфликтующие пары между разными линиями/хабами.
  const neighborPairs = new Set<string>()
  const neighborKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

  for (const line of graph.lines) {
    const ids = line.stationIds
    if (ids.length < 2) continue
    const isRing = RING_LINE_IDS.has(line.id)
    const segmentCount = isRing ? ids.length : ids.length - 1
    for (let i = 0; i < segmentCount; i += 1) {
      const a = ids[i]
      const b = ids[(i + 1) % ids.length]
      neighborPairs.add(neighborKey(a, b))
    }
  }

  const edgeLengths: number[] = []
  for (const edge of graph.edges) {
    const a = renderedPosById.get(edge.fromStationId)
    const b = renderedPosById.get(edge.toStationId)
    if (!a || !b) continue

    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.sqrt(dx * dx + dy * dy)

    if (dist > 0) {
      edgeLengths.push(dist)
    }
  }

  if (edgeLengths.length > 0) {
    metrics.edgeLengthStats = computeStatsSummary(edgeLengths)
    metrics.edgeLengthHistogram = buildHistogram(edgeLengths, 20, 200)
  }

  const distances: number[] = []
  const distancesRaw: number[] = []

  const diskGaps: number[] = []
  const MIN_DISTANCE = 40 // Минимальное желаемое расстояние
  const VERY_CLOSE_DISTANCE = 20 // Очень близко

  // Считаем станции без координат Яндекса (не привязаны к реальному лейауту).
  metrics.missingYandexCoords = graph.stations.reduce((acc, st) => {
    const station = st as StationWithYandex
    const hasYandex = typeof station.yandexX === 'number' && typeof station.yandexY === 'number'
    return acc + (hasYandex ? 0 : 1)
  }, 0)

  for (let i = 0; i < stationsWithCoords.length; i += 1) {
    for (let j = i + 1; j < stationsWithCoords.length; j += 1) {
      const a = stationsWithCoords[i]
      const b = stationsWithCoords[j]

      const pa = renderedPosById.get(a.id)
      const pb = renderedPosById.get(b.id)
      if (!pa || !pb) continue

      // Пропускаем пары внутри одного хаба: они «слиплись» нарочно и
      // не должны считаться конфликтом расстояний.
      if (a.hubId && a.hubId === b.hubId) continue

      // Пропускаем соседей по линии: их расстояние анализируется отдельно
      // через edgeLengthStats и edgeLengthHistogram.
      const key = neighborKey(a.id, b.id)
      if (neighborPairs.has(key)) continue

      const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y)
      
      if (dist > 0) {
        distances.push(dist)
        if (dist < MIN_DISTANCE) metrics.closePairsCount += 1
        if (dist < VERY_CLOSE_DISTANCE) metrics.veryClosePairsCount += 1
        if (dist < metrics.minStationDistance) metrics.minStationDistance = dist

        const ra = effectiveStationDrawRadius(a)
        const rb = effectiveStationDrawRadius(b)
        const gap = dist - (ra + rb)
        diskGaps.push(gap)
        if (gap < metrics.stationDiskGapMin) metrics.stationDiskGapMin = gap
        if (gap < 0) metrics.stationDiskOverlapPairsCount += 1
        if (metrics.stationDiskGapSamples.length < 20 && gap < 2) {
          metrics.stationDiskGapSamples.push(
            `${a.title} (${a.id}) ↔ ${b.title} (${b.id}) gap=${gap.toFixed(1)}px`,
          )
        }

        if (dist < 1) {
          metrics.overlappingPairsCount += 1
          if (metrics.overlappingPairsSamples.length < 15) {
            metrics.overlappingPairsSamples.push(`${a.title} (${a.id}) <-> ${b.title} (${b.id}) d=${dist.toFixed(2)}`)
          }
        }
      }

      const ra = rawPosById.get(a.id)
      const rb = rawPosById.get(b.id)
      if (ra && rb) {
        const distRaw = Math.hypot(ra.x - rb.x, ra.y - rb.y)
        if (distRaw > 0) {
          distancesRaw.push(distRaw)
          if (distRaw < MIN_DISTANCE) metrics.closePairsCountRaw += 1
          if (distRaw < VERY_CLOSE_DISTANCE) metrics.veryClosePairsCountRaw += 1
          if (distRaw < metrics.minStationDistanceRaw) metrics.minStationDistanceRaw = distRaw
        }
      }
    }
  }

  if (distances.length > 0) {
    metrics.averageStationDistance = distances.reduce((a, b) => a + b, 0) / distances.length
  }

  if (distancesRaw.length > 0) {
    metrics.averageStationDistanceRaw =
      distancesRaw.reduce((a, b) => a + b, 0) / distancesRaw.length
  }

  // 3. Анализ геометрии линий
  const turnAngles: number[] = []
  const octDeviations: number[] = []

  for (const line of graph.lines) {
    if (RING_LINE_IDS.has(line.id)) continue
    const ids = line.stationIds
    if (ids.length < 3) continue

    let lineTurnSum = 0
    let lineTurnCount = 0

    for (let i = 1; i < ids.length - 1; i += 1) {
      const pPrev = renderedPosById.get(ids[i - 1])
      const pCur = renderedPosById.get(ids[i])
      const pNext = renderedPosById.get(ids[i + 1])
      if (!pPrev || !pCur || !pNext) continue

      const dx1 = pCur.x - pPrev.x
      const dy1 = pCur.y - pPrev.y
      const dx2 = pNext.x - pCur.x
      const dy2 = pNext.y - pCur.y

      const angle1 = Math.atan2(dy1, dx1)
      const angle2 = Math.atan2(dy2, dx2)
      let angleDiff = angle2 - angle1

      while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI
      while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI

      const angleDeg = Math.abs((angleDiff * 180) / Math.PI)
      turnAngles.push(angleDeg)
      lineTurnSum += angleDeg
      lineTurnCount += 1

      if (angleDeg > 120) metrics.sharpTurnsCount += 1
      if (angleDeg > metrics.maxTurnAngle) metrics.maxTurnAngle = angleDeg

      // Октолинейность: проверяем, насколько близко к 0/45/90/135
      const octilinearAngles = [0, 45, 90, 135, 180, 225, 270, 315].map((a) => (a * Math.PI) / 180)
      const segmentAngle = Math.atan2(dy1, dx1)
      let minDev = Infinity
      for (const octAngle of octilinearAngles) {
        const dev = angleDistanceRad(segmentAngle, octAngle)
        if (dev < minDev) minDev = dev
      }
      const devDeg = (minDev * 180) / Math.PI
      octDeviations.push(devDeg)
      metrics.totalOctilinearSegments += 1
      if (devDeg < 5) metrics.perfectOctilinearSegments += 1
    }

    if (lineTurnCount > 0) {
      metrics.lineSmoothness[line.title] = lineTurnSum / lineTurnCount
    }
  }

  if (turnAngles.length > 0) {
    metrics.averageTurnAngle = turnAngles.reduce((a, b) => a + b, 0) / turnAngles.length
    metrics.turnAngleStats = computeStatsSummary(turnAngles)
    metrics.turnAngleHistogram = buildHistogram(turnAngles, 15, 180)
  }

  if (octDeviations.length > 0) {
    octDeviations.sort((a, b) => a - b)
    metrics.octilinearDeviationMean =
      octDeviations.reduce((a, b) => a + b, 0) / octDeviations.length
    metrics.octilinearDeviationP90 = octDeviations[Math.floor((octDeviations.length - 1) * 0.9)]
  }

  // 4. Анализ хабов
  for (const hub of graph.transferHubs) {
    if (hub.stationIds.length > 2) metrics.hubsWithMultipleStations += 1

    const hubStations = hub.stationIds
      .map((id) => stationMap.get(id))
      .filter((st) => st && renderedPosById.has(st.id)) as FullGraphStation[]

    if (hubStations.length < 2) continue

    // Проверяем компактность хаба
    let maxDist = 0
    for (let i = 0; i < hubStations.length; i += 1) {
      for (let j = i + 1; j < hubStations.length; j += 1) {
        const a = hubStations[i]
        const b = hubStations[j]
        const pa = renderedPosById.get(a.id)
        const pb = renderedPosById.get(b.id)
        if (!pa || !pb) continue

        const dist = Math.hypot(pa.x - pb.x, pa.y - pb.y)
        if (dist > maxDist) maxDist = dist
      }
    }

    metrics.hubCompactness[hub.id] = maxDist

    // Если хаб не компактный (станции далеко друг от друга). Порог берём
    // заметно больше минимального шага между станциями внутри пирога
    // (dMin=16px => типичный maxDist порядка 20–24px).
    if (maxDist > 26) {
      metrics.hubsNotSnapped += 1
    }
  }

  // Hub metrics synchronized with UI pie center
  const hubGroupsByHubId = new Map<string, FullGraphStation[]>()
  for (const st of graph.stations) {
    if (!st.hubId) continue
    if (!renderedPosById.has(st.id)) continue
    let list = hubGroupsByHubId.get(st.hubId)
    if (!list) {
      list = []
      hubGroupsByHubId.set(st.hubId, list)
    }
    list.push(st)
  }

  const hubScatterDistances: number[] = []
  const hubPieRadius = 5.2 * 1.7
  const lineHalfWidth = 6.4 / 2

  // Build all line segments (including ring polyline) for hub pie collision checks
  const allLineSegmentsForHubs: { ax: number; ay: number; bx: number; by: number; lineId: number }[] = []
  for (const line of graph.lines) {
    const ids = line.stationIds.filter((sid: string) => renderedPosById.has(sid))
    if (ids.length < 2) continue
    if (RING_LINE_IDS.has(line.id)) {
      const shape = ringShapesByLineId.get(line.id)
      if (shape) {
        for (const seg of buildRingPolylineSegments(shape, 120)) {
          allLineSegmentsForHubs.push({ ...seg, lineId: line.id })
        }
      }
      continue
    }
    for (let i = 0; i < ids.length - 1; i += 1) {
      const a = renderedPosById.get(ids[i])
      const b = renderedPosById.get(ids[i + 1])
      if (!a || !b) continue
      allLineSegmentsForHubs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, lineId: line.id })
    }
  }

  for (const [hubId, group] of hubGroupsByHubId.entries()) {
    if (!group || group.length < 2) continue

    let cx = 0
    let cy = 0
    for (const st of group) {
      const p = renderedPosById.get(st.id)
      if (!p) continue
      cx += p.x
      cy += p.y
    }
    cx /= group.length
    cy /= group.length

    for (const st of group) {
      const p = renderedPosById.get(st.id)
      if (!p) continue
      hubScatterDistances.push(Math.hypot(p.x - cx, p.y - cy))
    }

    // pie vs stations (non-hub)
    for (const st of stationsWithCoords) {
      if (st.hubId && st.hubId === hubId) continue
      const p = renderedPosById.get(st.id)
      if (!p) continue
      const r = effectiveStationDrawRadius(st)
      const d = Math.hypot(p.x - cx, p.y - cy) - (hubPieRadius + r)
      if (d < metrics.hubPieMinStationGap) metrics.hubPieMinStationGap = d
      if (d < 0) {
        metrics.hubPieOverlapsStationCount += 1
        if (metrics.hubPieConflictSamples.length < 20) {
          metrics.hubPieConflictSamples.push(
            `hub=${hubId} pie∩station ${st.title} (${st.id}) gap=${d.toFixed(1)}px`,
          )
        }
        break
      }
    }

    // pie vs lines
    for (const seg of allLineSegmentsForHubs) {
      // if segment endpoints are within this hub, skip
      // (approximation: if any endpoint belongs to hub group)
      // We skip by station ids only for known endpoints; here we don't store ids, so keep conservative.
      const dCenter = pointToSegmentDistance({ x: cx, y: cy }, { x: seg.ax, y: seg.ay }, { x: seg.bx, y: seg.by })
      const gap = dCenter - (hubPieRadius + lineHalfWidth)
      if (gap < 0) {
        metrics.hubPieOverlapsLineCount += 1
        if (metrics.hubPieConflictSamples.length < 20) {
          const lineTitle = lineMap.get(seg.lineId)?.title ?? String(seg.lineId)
          metrics.hubPieConflictSamples.push(
            `hub=${hubId} pie∩line ${lineTitle} gap=${gap.toFixed(1)}px`,
          )
        }
        break
      }
    }
  }

  metrics.hubCenterScatterStats = computeStatsSummary(hubScatterDistances)

  // 5. Анализ плотности
  const koltsevayaLine = lineMap.get(KOLTSEVAYA_LINE_ID)
  if (koltsevayaLine) {
    const ringCoords: { x: number; y: number }[] = []
    for (const sid of koltsevayaLine.stationIds) {
      const p = renderedPosById.get(sid)
      if (p) ringCoords.push({ x: p.x, y: p.y })
    }
    if (ringCoords.length >= 3) {
      let cx = 0
      let cy = 0
      for (const p of ringCoords) {
        cx += p.x
        cy += p.y
      }
      cx /= ringCoords.length
      cy /= ringCoords.length

      let rSum = 0
      for (const p of ringCoords) {
        const dx = p.x - cx
        const dy = p.y - cy
        rSum += Math.sqrt(dx * dx + dy * dy)
      }
      const ringRadius = rSum / ringCoords.length

      const innerBorder = ringRadius * 0.95
      const outerBorder = ringRadius * 1.5

      let innerCount = 0
      let outerCount = 0
      const innerArea = Math.PI * innerBorder * innerBorder
      const outerArea = Math.PI * (outerBorder * outerBorder - innerBorder * innerBorder)

      for (const st of stationsWithCoords) {
        if (st.lineNumericId != null && RING_LINE_IDS.has(st.lineNumericId)) continue
        const p = renderedPosById.get(st.id)
        if (!p) continue

        const dx = p.x - cx
        const dy = p.y - cy
        const r = Math.sqrt(dx * dx + dy * dy)

        if (r < innerBorder) innerCount += 1
        if (r > innerBorder && r < outerBorder) outerCount += 1
      }

      metrics.innerRingDensity = innerCount / innerArea
      metrics.outerRingDensity = outerCount / outerArea
    }
  }

  // 6. Bounding box и распределение
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (const st of stationsWithCoords) {
    const p = renderedPosById.get(st.id)
    if (!p) continue
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }

  // Считаем количество станций, оказавшихся ровно в левом верхнем углу bounding box —
  // это хорошая эвристика для фолбэк-координаты (например, (188.7, -50)).
  for (const st of stationsWithCoords) {
    const p = renderedPosById.get(st.id)
    if (!p) continue
    if (p.x === minX && p.y === minY) {
      metrics.fallbackStationsCount += 1
    }
  }

  metrics.boundingBox.width = maxX - minX
  metrics.boundingBox.height = maxY - minY
  metrics.boundingBox.area = metrics.boundingBox.width * metrics.boundingBox.height

  // Станции на единицу площади
  if (metrics.boundingBox.area > 0) {
    metrics.stationSpread = stationsWithCoords.length / metrics.boundingBox.area
  }

  if (stationsWithCoords.length > 0) {
    let cxAll = 0
    let cyAll = 0

    for (const st of stationsWithCoords) {
      const p = renderedPosById.get(st.id)
      if (!p) continue
      cxAll += p.x
      cyAll += p.y
    }

    cxAll /= stationsWithCoords.length
    cyAll /= stationsWithCoords.length

    const radii: number[] = []
    for (const st of stationsWithCoords) {
      const p = renderedPosById.get(st.id)
      if (!p) continue
      const dx = p.x - cxAll
      const dy = p.y - cyAll
      radii.push(Math.sqrt(dx * dx + dy * dy))
    }

    if (radii.length > 0) {
      const maxRadius = radii.reduce((m, r) => (r > m ? r : m), 0)
      if (maxRadius > 0) {
        const zoneCount = 4
        const step = maxRadius / zoneCount
        const counts = new Array<number>(zoneCount).fill(0)

        for (const r of radii) {
          let idx = Math.floor(r / step)
          if (idx >= zoneCount) idx = zoneCount - 1
          if (idx < 0) idx = 0
          counts[idx] += 1
        }

        metrics.radialDensityZones = []

        for (let i = 0; i < zoneCount; i += 1) {
          const radiusFrom = i * step
          const radiusTo = (i + 1) * step
          const area = Math.PI * (radiusTo * radiusTo - radiusFrom * radiusFrom)
          const stationCount = counts[i]
          const density = area > 0 ? stationCount / area : 0
          const name = i === 0 ? 'center' : i === zoneCount - 1 ? 'outer' : `ring_${i + 1}`

          metrics.radialDensityZones.push({
            name,
            radiusFrom,
            radiusTo,
            stationCount,
            area,
            density,
          })
        }
      }
    }
  }

  // 6b. Станция слишком близко к линиям (геометрический конфликт).
  const segments: { aId: string; bId: string; a: Point; b: Point; lineId: number }[] = []
  for (const line of graph.lines) {
    const ids = line.stationIds.filter((sid) => renderedPosById.has(sid))
    if (ids.length < 2) continue
    const isRing = RING_LINE_IDS.has(line.id)
    if (isRing) continue
    const segmentCount = ids.length - 1
    for (let i = 0; i < segmentCount; i += 1) {
      const aId = ids[i]
      const bId = ids[(i + 1) % ids.length]
      const a = renderedPosById.get(aId)
      const b = renderedPosById.get(bId)
      if (!a || !b) continue
      segments.push({ aId, bId, a, b, lineId: line.id })
    }
  }

  const STATION_RADIUS = 5.2
  const LINE_HALF_WIDTH = 6.4 / 2
  const CLEARANCE = STATION_RADIUS + LINE_HALF_WIDTH + 2

  for (const st of stationsWithCoords) {
    const p = renderedPosById.get(st.id)
    if (!p) continue

    let best = Infinity
    let bestSeg: { aId: string; bId: string; lineId: number } | null = null
    let bestRing: { lineId: number } | null = null
    for (const seg of segments) {
      if (seg.aId === st.id || seg.bId === st.id) continue

      const aSt = stationMap.get(seg.aId)
      const bSt = stationMap.get(seg.bId)
      if (st.hubId && aSt?.hubId && st.hubId === aSt.hubId) continue
      if (st.hubId && bSt?.hubId && st.hubId === bSt.hubId) continue

      const d = pointToSegmentDistance(p, seg.a, seg.b)
      if (d < best) {
        best = d
        bestSeg = { aId: seg.aId, bId: seg.bId, lineId: seg.lineId }
        bestRing = null
      }
    }

    if (ringShapesByLineId.size > 0) {
      for (const [lineId, shape] of ringShapesByLineId.entries()) {
        if (st.lineNumericId === lineId) continue
        const d = distanceToRingShape(shape, p.x, p.y)
        if (d < best) {
          best = d
          bestSeg = null
          bestRing = { lineId }
        }
      }
    }

    if (best < metrics.minStationToLineDistance) metrics.minStationToLineDistance = best
    if (best < CLEARANCE) {
      metrics.stationLineConflictsCount += 1
      if (metrics.stationLineConflictsSamples.length < 20) {
        if (bestSeg) {
          const lineTitle = lineMap.get(bestSeg.lineId)?.title ?? String(bestSeg.lineId)
          metrics.stationLineConflictsSamples.push(
            `${st.title} (${st.id}) -> line=${lineTitle} seg=${bestSeg.aId}..${bestSeg.bId} d=${best.toFixed(1)}`,
          )
        } else if (bestRing) {
          const lineTitle = lineMap.get(bestRing.lineId)?.title ?? String(bestRing.lineId)
          metrics.stationLineConflictsSamples.push(
            `${st.title} (${st.id}) -> ring=${lineTitle} d=${best.toFixed(1)}`,
          )
        }
      }
    }
  }

  // 6c. Симуляция размещения подписей (как в UI) и метрики коллизий.
  const labelFontPx = 16
  const labelPlacements = simulateLabelPlacements(graph, renderedPosById)
  metrics.labelPlacementsCount = labelPlacements.length

  if (labelPlacements.length > 0) {
    const labelDistances: number[] = []
    for (const p of labelPlacements) labelDistances.push(p.distToAnchor)
    metrics.labelDistanceStats = computeStatsSummary(labelDistances)

    for (const p of labelPlacements) {
      if (!p.hadNonOverlappingCandidate) metrics.labelFallbackCount += 1
      if (p.hardOverlap) {
        metrics.labelHardOverlapsCount += 1
        if (metrics.labelOverlapSamples.length < 20) {
          metrics.labelOverlapSamples.push(`${p.title} (${p.stationId}) overlap`)
        }
      }
      if (p.hardOverlapStation) {
        metrics.labelHardStationOverlapsCount += 1
        if (metrics.labelStationOverlapSamples.length < 20) {
          metrics.labelStationOverlapSamples.push(`${p.title} (${p.stationId}) overlapStation`)
        }
      }
      if (p.localLineHit) {
        metrics.labelLocalLineHitCount += 1
        if (metrics.labelLineHitSamples.length < 20) {
          metrics.labelLineHitSamples.push(`${p.title} (${p.stationId}) localLineHit`)
        }
      }
    }

    for (let i = 0; i < labelPlacements.length; i += 1) {
      const a = labelPlacements[i]
      for (let j = i + 1; j < labelPlacements.length; j += 1) {
        const b = labelPlacements[j]
        if (rectsOverlap(a.rect, b.rect)) metrics.labelOverlapPairsCount += 1
      }
    }

    const stationDisksForLabels = buildLabelStationDisks(graph, renderedPosById, labelFontPx)
    const allSegments: { ax: number; ay: number; bx: number; by: number }[] = []

    for (const line of graph.lines) {
      const ids = line.stationIds.filter((sid: string) => renderedPosById.has(sid))
      if (ids.length < 2) continue

      if (RING_LINE_IDS.has(line.id)) {
        const shape = ringShapesByLineId.get(line.id)
        if (shape) {
          allSegments.push(...buildRingPolylineSegments(shape, 72))
        }
        continue
      }

      for (let i = 0; i < ids.length - 1; i += 1) {
        const a = renderedPosById.get(ids[i])
        const b = renderedPosById.get(ids[i + 1])
        if (!a || !b) continue
        allSegments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y })
      }
    }

    for (const lp of labelPlacements) {
      const overlapsStation = stationDisksForLabels.some((d) => {
        const sx1 = d.x - d.r
        const sy1 = d.y - d.r
        const sx2 = d.x + d.r
        const sy2 = d.y + d.r
        return !(lp.rect.x2 < sx1 || lp.rect.x1 > sx2 || lp.rect.y2 < sy1 || lp.rect.y1 > sy2)
      })
      if (overlapsStation) metrics.labelOverlapsStationCount += 1

      let hits = false
      for (const seg of allSegments) {
        if (segmentIntersectsRect(seg, lp.rect)) {
          hits = true
          break
        }
      }
      if (hits) metrics.labelIntersectsLineCount += 1
    }

    // Worst labels by gap to line band (bbox → line centerline distance minus half width)
    const lineHalfWidth = 6.4 / 2
    const perLabelWorst: { stationId: string; title: string; gap: number }[] = []
    for (const lp of labelPlacements) {
      let bestDist = Infinity
      for (const seg of allSegments) {
        const d = rectToSegmentDistance(lp.rect, seg)
        if (d < bestDist) bestDist = d
        if (bestDist === 0) break
      }
      const gap = bestDist - lineHalfWidth
      perLabelWorst.push({ stationId: lp.stationId, title: lp.title, gap })
    }
    perLabelWorst.sort((a, b) => a.gap - b.gap)
    const TOP_N = 15
    metrics.labelLineWorstCount = Math.min(TOP_N, perLabelWorst.length)
    for (const w of perLabelWorst.slice(0, TOP_N)) {
      metrics.labelLineWorstSamples.push(`${w.title} (${w.stationId}) gap=${w.gap.toFixed(1)}px`)
    }
  }

  // Station to line band gap stats (disk vs band)
  const stationToBandGaps: number[] = []
  for (const st of stationsWithCoords) {
    const p = renderedPosById.get(st.id)
    if (!p) continue

    let best = Infinity
    // non-ring polylines
    for (const seg of segments) {
      if (seg.aId === st.id || seg.bId === st.id) continue

      const aSt = stationMap.get(seg.aId)
      const bSt = stationMap.get(seg.bId)
      if (st.hubId && aSt?.hubId && st.hubId === aSt.hubId) continue
      if (st.hubId && bSt?.hubId && st.hubId === bSt.hubId) continue

      const d = pointToSegmentDistance(p, seg.a, seg.b)
      if (d < best) best = d
    }

    // ring curves
    for (const [lineId, shape] of ringShapesByLineId.entries()) {
      if (st.lineNumericId === lineId) continue
      const d = distanceToRingShape(shape, p.x, p.y)
      if (d < best) best = d
    }

    if (!Number.isFinite(best)) continue
    const gap = best - (effectiveStationDrawRadius(st) + lineHalfWidth)
    stationToBandGaps.push(gap)
    if (gap < metrics.stationToLineBandGapMin) metrics.stationToLineBandGapMin = gap
    if (gap < 0) metrics.stationToLineBandOverlapCount += 1
    if (metrics.stationToLineBandSamples.length < 20 && gap < 2) {
      metrics.stationToLineBandSamples.push(`${st.title} (${st.id}) gap=${gap.toFixed(1)}px`)
    }
  }
  metrics.stationToLineBandGapStats = computeStatsSummary(stationToBandGaps)

  // 7. Топологическая проверка графа: компоненты, рёбра, хабы, дубли названий

  // Строим неориентированную смежность по всем рёбрам.
  const adjacency = new Map<string, string[]>()
  for (const st of graph.stations) {
    adjacency.set(st.id, [])
  }

  let edgesWithMissingStations = 0
  let edgesWithMismatchedLineIds = 0
  let transferEdgesWithoutCommonHub = 0
  let transferEdgesSameLine = 0

  for (const edge of graph.edges) {
    const from = stationMap.get(edge.fromStationId)
    const to = stationMap.get(edge.toStationId)
    if (!from || !to) {
      edgesWithMissingStations += 1
      continue
    }

    const fromNeighbors = adjacency.get(from.id)
    const toNeighbors = adjacency.get(to.id)
    if (fromNeighbors && toNeighbors) {
      fromNeighbors.push(to.id)
      toNeighbors.push(from.id)
    }

    if (!edge.isTransfer && typeof edge.lineNumericId === 'number') {
      const ln = edge.lineNumericId
      const fromLn = from.lineNumericId
      const toLn = to.lineNumericId
      if (fromLn !== ln || toLn !== ln) {
        edgesWithMismatchedLineIds += 1
      }
    }

    if (edge.isTransfer) {
      if (
        typeof from.lineNumericId === 'number' &&
        typeof to.lineNumericId === 'number' &&
        from.lineNumericId === to.lineNumericId
      ) {
        transferEdgesSameLine += 1
      }

      const hubA = from.hubId ?? null
      const hubB = to.hubId ?? null
      if (!hubA || !hubB || hubA !== hubB) {
        transferEdgesWithoutCommonHub += 1
      }
    }
  }

  // Компоненты связности и изолированные станции.
  const visited = new Set<string>()
  let componentsCount = 0
  const smallComponents: SmallComponentInfo[] = []
  const components: string[][] = []
  let stationsWithoutEdgesCount = 0

  for (const [id, neighbors] of adjacency.entries()) {
    if (neighbors.length === 0) stationsWithoutEdgesCount += 1
    if (visited.has(id)) continue

    componentsCount += 1
    const stack: string[] = [id]
    visited.add(id)
    const component: string[] = []

    while (stack.length > 0) {
      const v = stack.pop() as string
      component.push(v)
      const ns = adjacency.get(v) || []
      for (const n of ns) {
        if (!visited.has(n)) {
          visited.add(n)
          stack.push(n)
        }
      }
    }

    if (component.length <= 5 && smallComponents.length < 10) {
      smallComponents.push({ size: component.length, sampleStationIds: component })
    }
    components.push(component)
  }

  const disconnectedLines: LineConnectivityInfo[] = []
  const partiallyDisconnectedLines: LineConnectivityInfo[] = []

  if (components.length > 0) {
    let mainIndex = 0
    let mainSize = components[0].length
    for (let i = 1; i < components.length; i += 1) {
      const size = components[i].length
      if (size > mainSize) {
        mainSize = size
        mainIndex = i
      }
    }

    const mainSet = new Set<string>(components[mainIndex])

    for (const line of graph.lines) {
      const ids = line.stationIds
      if (!ids || ids.length === 0) continue

      let inMain = 0
      for (const sid of ids) {
        if (mainSet.has(sid)) inMain += 1
      }

      const info: LineConnectivityInfo = {
        title: line.title,
        totalStations: ids.length,
        stationsInMainComponent: inMain,
      }

      if (inMain === 0) {
        disconnectedLines.push(info)
      } else if (inMain < ids.length) {
        partiallyDisconnectedLines.push(info)
      }
    }
  }

  // Проверка хабов: согласованность stationIds и связность по пересадочным рёбрам.
  let hubsWithMissingStations = 0
  let hubsDisconnectedInternally = 0

  for (const hub of graph.transferHubs) {
    const hubStations = hub.stationIds
    if (hubStations.length === 0) continue

    let hasMissing = false
    for (const sid of hubStations) {
      const st = stationMap.get(sid)
      if (!st || st.hubId !== hub.id) {
        hasMissing = true
        break
      }
    }
    if (hasMissing) {
      hubsWithMissingStations += 1
      continue
    }

    if (hubStations.length < 2) continue

    const hubSet = new Set<string>(hubStations)
    const hubAdj = new Map<string, string[]>()
    for (const sid of hubStations) hubAdj.set(sid, [])

    for (const edge of graph.edges) {
      if (!edge.isTransfer) continue
      const a = edge.fromStationId
      const b = edge.toStationId
      if (!hubSet.has(a) || !hubSet.has(b)) continue
      const aList = hubAdj.get(a)
      const bList = hubAdj.get(b)
      if (aList && bList) {
        aList.push(b)
        bList.push(a)
      }
    }

    const nonIsolated = hubStations.filter((sid) => (hubAdj.get(sid) || []).length > 0)
    if (nonIsolated.length === 0) {
      hubsDisconnectedInternally += 1
      continue
    }

    const start = nonIsolated[0]
    const seen = new Set<string>([start])
    const stackHub: string[] = [start]

    while (stackHub.length > 0) {
      const v = stackHub.pop() as string
      const ns = hubAdj.get(v) || []
      for (const n of ns) {
        if (!seen.has(n)) {
          seen.add(n)
          stackHub.push(n)
        }
      }
    }

    let disconnected = false
    for (const sid of nonIsolated) {
      if (!seen.has(sid)) {
        disconnected = true
        break
      }
    }
    if (disconnected) {
      hubsDisconnectedInternally += 1
    }
  }

  // Дублирующиеся названия станций и кандидаты на хабы.
  const titleGroups = new Map<string, FullGraphStation[]>()
  for (const st of graph.stations) {
    const list = titleGroups.get(st.title)
    if (list) list.push(st)
    else titleGroups.set(st.title, [st])
  }

  const duplicateTitleGroups: DuplicateTitleGroupInfo[] = []
  const unhubbedDuplicateTitleGroups: DuplicateTitleGroupInfo[] = []

  for (const [title, group] of titleGroups.entries()) {
    if (group.length <= 1) continue

    const info: DuplicateTitleGroupInfo = { title, count: group.length }
    if (duplicateTitleGroups.length < 30) {
      duplicateTitleGroups.push(info)
    }

    const hubSet = new Set<string>(group.map((s) => s.hubId || ''))
    if (hubSet.size > 1 || hubSet.has('')) {
      if (unhubbedDuplicateTitleGroups.length < 30) {
        unhubbedDuplicateTitleGroups.push(info)
      }
    }
  }

  metrics.componentsCount = componentsCount
  metrics.smallComponents = smallComponents
  metrics.stationsWithoutEdgesCount = stationsWithoutEdgesCount
  metrics.edgesWithMissingStations = edgesWithMissingStations
  metrics.edgesWithMismatchedLineIds = edgesWithMismatchedLineIds
  metrics.transferEdgesWithoutCommonHub = transferEdgesWithoutCommonHub
  metrics.transferEdgesSameLine = transferEdgesSameLine
  metrics.hubsWithMissingStations = hubsWithMissingStations
  metrics.hubsDisconnectedInternally = hubsDisconnectedInternally
  metrics.duplicateTitleGroups = duplicateTitleGroups
  metrics.unhubbedDuplicateTitleGroups = unhubbedDuplicateTitleGroups
  metrics.graphFullyConnected = componentsCount === 1
  metrics.disconnectedLines = disconnectedLines
  metrics.partiallyDisconnectedLines = partiallyDisconnectedLines

  return metrics
}

function printMetrics(metrics: QualityMetrics, graph: FullGraphExport) {
  console.log('═══════════════════════════════════════════════════════════')
  console.log('  РАСШИРЕННЫЙ АНАЛИЗ КАЧЕСТВА СХЕМЫ МЕТРО')
  console.log('═══════════════════════════════════════════════════════════\n')

  // Кольца
  console.log('📐 КОЛЬЦА:')
  for (const [name, ecc] of Object.entries(metrics.ringEccentricity)) {
    const radius = metrics.ringRadius[name] || 0
    const axisRatio = metrics.ringAxisRatio[name]
    const orientation = metrics.ringOrientationDeg[name]
    const projMean = metrics.ringProjectionErrorMeanPx[name] ?? 0
    const projP90 = metrics.ringProjectionErrorP90Px[name] ?? 0
    const projMax = metrics.ringProjectionErrorMaxPx[name] ?? 0
    let quality: string

    // Для БКЛ считаем основной критерий — «хороший горизонтальный эллипс».
    if (name.toLowerCase().includes('большая кольцевая')) {
      if (
        typeof axisRatio === 'number' &&
        typeof orientation === 'number' &&
        axisRatio >= 1.15 &&
        axisRatio <= 1.6 &&
        orientation < 30
      ) {
        quality = '✅ ХОРОШО'
      } else if (
        typeof axisRatio === 'number' &&
        typeof orientation === 'number' &&
        axisRatio >= 1.05 &&
        axisRatio <= 1.8 &&
        orientation < 45
      ) {
        quality = '⚠️  БЛИЗКО'
      } else {
        quality = '❌ ФОРМА СИЛЬНО ОТЛИЧАЕТСЯ'
      }
    } else {
      // Для Кольцевой и МЦК оцениваем «круговость» по эксцентриситету,
      // но с более мягкими порогами.
      if (ecc < 0.03) quality = '✅ ИДЕАЛЬНО'
      else if (ecc < 0.06) quality = '✅ ХОРОШО'
      else if (ecc < 0.12) quality = '⚠️  СРЕДНЕ'
      else quality = '❌ ПЛОХО'
    }

    let shapeInfo = ''
    if (typeof axisRatio === 'number' && typeof orientation === 'number') {
      let form = ''
      if (axisRatio < 1.15) form = 'почти круг'
      else if (axisRatio < 1.6) form = 'умеренный эллипс'
      else form = 'сильно вытянутый эллипс'

      const dir = orientation < 30 ? 'гориз.' : orientation > 60 ? 'вертик.' : 'наклон.'
      shapeInfo = `, ось=${axisRatio.toFixed(2)}×, ориентация=${orientation.toFixed(1)}° (${dir}, ${form})`
    }

    console.log(
      `  ${name}: радиус=${radius.toFixed(1)}px, эксцентриситет=${(ecc * 100).toFixed(
        2,
      )}% ${quality}${shapeInfo} | projection Δ(mean/p90/max)=${projMean.toFixed(1)}/${projP90.toFixed(1)}/${projMax.toFixed(1)}px`,
    )
  }
  console.log()

  if (metrics.stationDiskGapStats) {
    const s = metrics.stationDiskGapStats
    console.log('🟣 CLEARANCE station↔station (disk gap):')
    console.log(
      `  min=${metrics.stationDiskGapMin.toFixed(1)}px, overlaps=${metrics.stationDiskOverlapPairsCount}, mean=${s.mean.toFixed(
        1,
      )}px, p90=${s.p90.toFixed(1)}px`,
    )
    if (metrics.stationDiskGapSamples.length > 0) {
      console.log('  Примеры:')
      for (const s of metrics.stationDiskGapSamples) console.log(`    ${s}`)
    }
    console.log()
  }

  if (metrics.stationToLineBandGapStats) {
    const s = metrics.stationToLineBandGapStats
    console.log('🟠 CLEARANCE station↔line (disk vs band gap):')
    console.log(
      `  min=${metrics.stationToLineBandGapMin.toFixed(1)}px, overlaps=${metrics.stationToLineBandOverlapCount}, mean=${s.mean.toFixed(
        1,
      )}px, p90=${s.p90.toFixed(1)}px`,
    )
    if (metrics.stationToLineBandSamples.length > 0) {
      console.log('  Примеры:')
      for (const s of metrics.stationToLineBandSamples) console.log(`    ${s}`)
    }
    console.log()
  }

  if (metrics.labelDistanceStats) {
    const s = metrics.labelDistanceStats
    console.log('🏷️ ПОДПИСИ (SIM):')
    console.log(`  Всего подписей: ${metrics.labelPlacementsCount}`)
    console.log(
      `  Overlap-пар: ${metrics.labelOverlapPairsCount}, label∩station: ${metrics.labelOverlapsStationCount}, label∩line: ${metrics.labelIntersectsLineCount}`,
    )
    console.log(
      `  Fallback(no clean candidate): ${metrics.labelFallbackCount}, hardOverlap: ${metrics.labelHardOverlapsCount}, hardStationOverlap: ${metrics.labelHardStationOverlapsCount}, localLineHit: ${metrics.labelLocalLineHitCount}`,
    )
    console.log(
      `  dist(anchor→label): mean=${s.mean.toFixed(1)}px, p90=${s.p90.toFixed(1)}px, max=${s.max.toFixed(1)}px`,
    )
    if (metrics.labelOverlapSamples.length > 0) {
      console.log('  Примеры overlap:')
      for (const s of metrics.labelOverlapSamples) console.log(`    ${s}`)
    }
    if (metrics.labelStationOverlapSamples.length > 0) {
      console.log('  Примеры overlapStation:')
      for (const s of metrics.labelStationOverlapSamples) console.log(`    ${s}`)
    }
    if (metrics.labelLineHitSamples.length > 0) {
      console.log('  Примеры localLineHit:')
      for (const s of metrics.labelLineHitSamples) console.log(`    ${s}`)
    }
    if (metrics.labelLineWorstSamples.length > 0) {
      console.log(`  Top-${metrics.labelLineWorstCount} worst label∩line (gap):`)
      for (const s of metrics.labelLineWorstSamples) console.log(`    ${s}`)
    }
    console.log()
  }

  // Плотность
  console.log('📊 ПЛОТНОСТЬ И РАССТОЯНИЯ:')
  console.log(`  Среднее расстояние между станциями: ${metrics.averageStationDistance.toFixed(1)}px`)
  console.log(
    `  Минимальное расстояние: ${metrics.minStationDistance.toFixed(1)}px ${metrics.minStationDistance < 8 ? '⚠️  СЛИШКОМ БЛИЗКО!' : metrics.minStationDistance < 12 ? '⚠️  БЛИЗКО' : '✅'}`,
  )
  console.log(
    `  Близких пар (<40px): ${metrics.closePairsCount} ${metrics.closePairsCount > 120 ? '⚠️  МНОГО' : '✅'}`,
  )
  console.log(
    `  Очень близких пар (<20px): ${metrics.veryClosePairsCount} ${metrics.veryClosePairsCount > 50 ? '⚠️  КРИТИЧНО!' : '✅'}`,
  )
  console.log(
    `  Перекрывающихся пар (<1px): ${metrics.overlappingPairsCount} ${metrics.overlappingPairsCount > 0 ? '⚠️' : '✅'}`,
  )
  if (metrics.overlappingPairsSamples.length > 0) {
    console.log('  Примеры перекрытий:')
    for (const s of metrics.overlappingPairsSamples) console.log(`    ${s}`)
  }
  console.log(
    `  (RAW) близких пар (<40px): ${metrics.closePairsCountRaw}, очень близких (<20px): ${metrics.veryClosePairsCountRaw}, min=${metrics.minStationDistanceRaw.toFixed(1)}px`,
  )
  console.log()

  // Координаты и фолбэки
  console.log('🧭 КООРДИНАТЫ И ФОЛБЭКИ:')
  console.log(`  Станций без координат Яндекса: ${metrics.missingYandexCoords}`)
  console.log(
    `  Станций в фолбэк-точке (minX,minY): ${metrics.fallbackStationsCount} ${
      metrics.fallbackStationsCount > 0 ? '⚠️  ЕСТЬ ПРОБЛЕМНЫЕ ТОЧКИ' : '✅'
    }`,
  )
  console.log()

  // Геометрия
  console.log('📐 ГЕОМЕТРИЯ ЛИНИЙ:')
  console.log(`  Резких поворотов (>120°): ${metrics.sharpTurnsCount} ${metrics.sharpTurnsCount > 30 ? '⚠️  МНОГО' : '✅'}`)
  console.log(`  Средний угол поворота: ${metrics.averageTurnAngle.toFixed(1)}°`)
  console.log(
    `  Максимальный угол поворота: ${metrics.maxTurnAngle.toFixed(1)}° ${metrics.maxTurnAngle > 179.9 ? '⚠️  СЛИШКОМ РЕЗКИЙ' : '✅'}`,
  )
  console.log(
    `  Октолинейность: ${metrics.perfectOctilinearSegments}/${metrics.totalOctilinearSegments} сегментов dev<5°, meanDev=${metrics.octilinearDeviationMean.toFixed(2)}°, p90Dev=${metrics.octilinearDeviationP90.toFixed(2)}°`,
  )
  
  console.log('\n  Гладкость линий:')
  const sortedSmoothness = Object.entries(metrics.lineSmoothness)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  for (const [line, smoothness] of sortedSmoothness) {
    const quality = smoothness < 30 ? '✅' : smoothness < 60 ? '⚠️' : '❌'
    console.log(`    ${line}: ${smoothness.toFixed(1)}° ${quality}`)
  }
  console.log()

  if (metrics.edgeLengthStats) {
    const s = metrics.edgeLengthStats
    console.log('📏 РЁБРА И ДЛИНЫ:')
    console.log(`  Рёбер с геометрией: ${s.count}`)
    console.log(
      `  Средняя длина перегона: ${s.mean.toFixed(1)}px (median=${s.p50.toFixed(
        1,
      )}px, p90=${s.p90.toFixed(1)}px, max=${s.max.toFixed(1)}px)`,
    )
    if (metrics.edgeLengthHistogram.length > 0) {
      console.log('  Гистограмма длин (px):')
      for (const bin of metrics.edgeLengthHistogram) {
        console.log(
          `    ${bin.from.toFixed(0)}–${bin.to.toFixed(0)}: ${bin.count}`,
        )
      }
    }
    console.log()
  }

  if (metrics.turnAngleStats) {
    const s = metrics.turnAngleStats
    console.log('📐 РАСПРЕДЕЛЕНИЕ УГЛОВ ПОВОРОТОВ:')
    console.log(
      `  Средний угол: ${s.mean.toFixed(1)}° (median=${s.p50.toFixed(
        1,
      )}°, p90=${s.p90.toFixed(1)}°, max=${s.max.toFixed(1)}°)`,
    )
    if (metrics.turnAngleHistogram.length > 0) {
      console.log('  Гистограмма углов (°):')
      for (const bin of metrics.turnAngleHistogram) {
        console.log(
          `    ${bin.from.toFixed(0)}–${bin.to.toFixed(0)}: ${bin.count}`,
        )
      }
    }
    console.log()
  }

  if (metrics.radialDensityZones.length > 0) {
    console.log('📊 ПЛОТНОСТЬ ПО РАДИАЛЬНЫМ ЗОНАМ:')
    for (const zone of metrics.radialDensityZones) {
      console.log(
        `  ${zone.name}: r=[${zone.radiusFrom.toFixed(
          1,
        )}; ${zone.radiusTo.toFixed(1)}], станции=${zone.stationCount}, плотность=${(
          zone.density * 10000
        ).toFixed(3)} на 10k px²`,
      )
    }
    const centerZone = metrics.radialDensityZones[0]
    const outerZone =
      metrics.radialDensityZones[metrics.radialDensityZones.length - 1]
    if (centerZone && outerZone && outerZone.density > 0) {
      const ratio = centerZone.density / outerZone.density
      let quality: string
      if (ratio < 3) {
        quality = '⚠️  центр почти как окраина (мало контраста)'
      } else if (ratio <= 8) {
        quality = '✅ в пределах нормы (центр заметно плотнее окраин)'
      } else {
        quality = '⚠️  центр перегружен относительно окраин'
      }
      console.log(
        `  Отношение плотности центр/окраина: ${ratio.toFixed(2)} ${quality}`,
      )
    }
    console.log()
  }

  // Хабы
  console.log('🔗 ХАБЫ:')
  console.log(`  Всего хабов: ${graph.transferHubs.length}`)
  console.log(`  Хабы с 3+ станциями: ${metrics.hubsWithMultipleStations}`)
  console.log(
    `  Некомпактных хабов (>26px): ${metrics.hubsNotSnapped} ${metrics.hubsNotSnapped > 0 ? '⚠️  НЕКОТОРЫЕ НЕ СЛИПЛИСЬ' : '✅'}`,
  )

  if (metrics.hubCenterScatterStats) {
    const s = metrics.hubCenterScatterStats
    console.log(
      `  Hub-center scatter: mean=${s.mean.toFixed(1)}px, p90=${s.p90.toFixed(1)}px, max=${s.max.toFixed(1)}px`,
    )
    console.log(
      `  Hub pie conflicts: pie∩stations=${metrics.hubPieOverlapsStationCount}, pie∩lines=${metrics.hubPieOverlapsLineCount}, minGap(station)=${metrics.hubPieMinStationGap.toFixed(
        1,
      )}px`,
    )
    if (metrics.hubPieConflictSamples.length > 0) {
      console.log('  Примеры pie-конфликтов:')
      for (const s of metrics.hubPieConflictSamples) console.log(`    ${s}`)
    }
  }
  
  console.log('\n  Компактность хабов:')
  const sortedHubs = Object.entries(metrics.hubCompactness)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
  for (const [hubId, compactness] of sortedHubs) {
    const quality = compactness < 5 ? '✅ СЛИПЛИСЬ' : compactness < 20 ? '⚠️  БЛИЗКО' : '❌ ДАЛЕКО'
    console.log(`    ${hubId}: ${compactness.toFixed(1)}px ${quality}`)
  }
  console.log()

  // Масштаб
  console.log('📏 МАСШТАБ И РАСПРЕДЕЛЕНИЕ:')
  console.log(`  Bounding box: ${metrics.boundingBox.width.toFixed(0)}×${metrics.boundingBox.height.toFixed(0)}px`)
  console.log(`  Площадь: ${metrics.boundingBox.area.toFixed(0)}px²`)
  console.log(`  Плотность станций: ${(metrics.stationSpread * 10000).toFixed(2)} станций на 10k px²`)
  console.log(
    `  min(station→line)=${metrics.minStationToLineDistance.toFixed(1)}px, конфликтов (d<${(5.2 + 6.4 / 2 + 2).toFixed(
      1,
    )}): ${metrics.stationLineConflictsCount} ${metrics.stationLineConflictsCount > 0 ? '⚠️' : '✅'}`,
  )
  if (metrics.stationLineConflictsSamples.length > 0) {
    console.log('  Примеры station→line конфликтов:')
    for (const s of metrics.stationLineConflictsSamples) console.log(`    ${s}`)
  }
  console.log()

  // Топология графа
  console.log('🕸 ТОПОЛОГИЯ ГРАФА:')
  console.log(`  Компонент связности: ${metrics.componentsCount}`)
  console.log(
    `  Граф полностью связен: ${
      metrics.graphFullyConnected ? '✅ ДА (с любой станции можно добраться до любой)' : '⚠️  НЕТ (есть изолированные компоненты)'
    }`,
  )
  if (metrics.smallComponents.length > 0) {
    console.log('  Маленькие компоненты:')
    for (const comp of metrics.smallComponents) {
      console.log(
        `    size=${comp.size}, станции=${comp.sampleStationIds.join(', ')}`,
      )
    }
  }
  console.log(
    `  Станций без рёбер: ${metrics.stationsWithoutEdgesCount} ${
      metrics.stationsWithoutEdgesCount > 0 ? '⚠️  есть изолированные станции' : '✅'
    }`,
  )
  console.log(
    `  Рёбер с отсутствующими станциями: ${metrics.edgesWithMissingStations} ${
      metrics.edgesWithMissingStations > 0 ? '⚠️  висячие рёбра' : '✅'
    }`,
  )
  console.log(
    `  Рёбер с несовпадающими lineNumericId: ${metrics.edgesWithMismatchedLineIds} ${
      metrics.edgesWithMismatchedLineIds > 0 ? '⚠️  возможные ошибки линий' : '✅'
    }`,
  )
  console.log(
    `  Пересадочных рёбер без общего hubId: ${metrics.transferEdgesWithoutCommonHub} ${
      metrics.transferEdgesWithoutCommonHub > 0 ? '⚠️  пересадки мимо hubId' : '✅'
    }`,
  )
  console.log(
    `  Пересадочных рёбер на одной линии: ${metrics.transferEdgesSameLine} ${
      metrics.transferEdgesSameLine > 0 ? '⚠️  возможные дубли станции на линии' : '✅'
    }`,
  )
  console.log(
    `  Хабы с отсутствующими/несогласованными станциями: ${metrics.hubsWithMissingStations} ${
      metrics.hubsWithMissingStations > 0 ? '⚠️' : '✅'
    }`,
  )
  console.log(
    `  Хабы с несвязанными станциями (по пересадочным рёбрам): ${metrics.hubsDisconnectedInternally} ${
      metrics.hubsDisconnectedInternally > 0 ? '⚠️' : '✅'
    }`,
  )

  if (metrics.disconnectedLines.length > 0) {
    console.log('\n  Несвязанные линии (полностью вне основной компоненты):')
    for (const info of metrics.disconnectedLines) {
      console.log(
        `    ${info.title}: станций=${info.totalStations}, в основной компоненте=${info.stationsInMainComponent}`,
      )
    }
  }

  if (metrics.partiallyDisconnectedLines.length > 0) {
    console.log('\n  Линии, частично не связанные с основной компонентой:')
    for (const info of metrics.partiallyDisconnectedLines.slice(0, 10)) {
      console.log(
        `    ${info.title}: в основной компоненте=${info.stationsInMainComponent}/${info.totalStations}`,
      )
    }
  }

  if (metrics.duplicateTitleGroups.length > 0) {
    console.log('\n  Дублирующиеся названия станций:')
    for (const info of metrics.duplicateTitleGroups.slice(0, 10)) {
      console.log(`    ${info.title}: ${info.count} узла(ов)`)        
    }
  }

  if (metrics.unhubbedDuplicateTitleGroups.length > 0) {
    console.log('\n  Дубли без общего hubId (кандидаты на пересадочные хабы):')
    for (const info of metrics.unhubbedDuplicateTitleGroups.slice(0, 10)) {
      console.log(`    ${info.title}: ${info.count} узла(ов)`)        
    }
  }

  console.log()
}

function analyzeLayout() {
  const projectRoot = process.cwd()
  const graphPath = join(projectRoot, 'normalized', 'fullGraph.json')
  const graph: FullGraphExport = JSON.parse(readFileSync(graphPath, 'utf8'))

  const metrics = calculateQualityMetrics(graph)
  printMetrics(metrics, graph)
  
  // Сохраняем метрики в JSON для дальнейшего анализа
  const metricsPath = join(projectRoot, 'normalized', 'layout_metrics.json')
  writeFileSync(metricsPath, JSON.stringify(metrics, null, 2), 'utf8')
  console.log(`Метрики сохранены в: ${metricsPath}`)
}

analyzeLayout()

