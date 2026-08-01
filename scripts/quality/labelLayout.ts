/**
 * Порт computeStationLabelPlacements из src/components/MetroMap.tsx.
 *
 * Метрики подписей обязаны считаться по РЕЗУЛЬТАТУ реальной раскладки, а не по
 * абстрактным прямоугольникам, иначе цифры не будут соответствовать картинке.
 * Единственное отличие от рантайма — ширина текста берётся из приближения
 * measureText() (в Node нет Canvas).
 *
 * Порядок обхода, набор кандидатов и все веса штрафов сохранены 1:1.
 */

import { RING_LINE_IDS, type RenderModel, type RenderedStation, type Segment } from './render.ts'
import { measureText } from './textMetrics.ts'

export interface LabelPlacement {
  text: string
  x: number
  y: number
  alignRight: boolean
  importance: number
  width: number
  height: number
  lines: string[]
  stationIds: string[]
  anchorX: number
  anchorY: number
  /**
   * Расстояние от якоря подписи до центра схемы — та самая величина, по которой
   * раскладка выбрала зону. Метрика labels.detached берёт её отсюда, чтобы
   * зонирование метрики физически не могло разойтись с зонированием раскладки.
   */
  zoneRadius: number
  rect: { x1: number; y1: number; x2: number; y2: number }
}

import {
  ALIGN_MODES,
  CANDIDATE_ANGLES,
  EJECT_PASSES,
  NODE_RADIUS_HUB,
  NODE_RADIUS_STATION,
  PRIORITY_CENTER_RADIUS,
  PRIORITY_MIDDLE_RADIUS,
  REFINE_PASSES,
  SegmentBuckets,
  W,
  anglesSortedByMisfit,
  lineVariantsFor,
  neighborReach,
  pointRectDistance,
  preferredMaxDist,
  radiusOffsetsForZone,
  resolveZoneCenter,
  splitLabelToLines,
} from './labelGeom.ts'

/** Прямоугольник уже размещённой подписи — то, что видят остальные подписи. */
interface DrawnLabel {
  x1: number
  y1: number
  x2: number
  y2: number
  centerX: number
  centerY: number
  width: number
  height: number
  importance: number
}

function makeStaticCache(size: number): Float64Array {
  const arr = new Float64Array(size)
  arr.fill(Number.NaN)
  return arr
}

export function computeLabelPlacements(model: RenderModel, fontPx: number): LabelPlacement[] {
  const positioned = model.stations

  // Зоны схемы (и вся «радиальная» геометрия раскладки) считаются от центра
  // схемы, а не от начала координат: солвер не центрирует раскладку в (0,0).
  const zoneCenter = resolveZoneCenter(model.ringShapes, positioned)

  const hubCenters = new Map<string, { x: number; y: number }>()
  const hubCounts = new Map<string, number>()
  const stationsByHubId = model.hubGroups

  for (const st of positioned) {
    if (!st.hubId) continue
    const c = hubCenters.get(st.hubId)
    if (!c) {
      hubCenters.set(st.hubId, { x: st.x, y: st.y })
      hubCounts.set(st.hubId, 1)
    } else {
      c.x += st.x
      c.y += st.y
      hubCounts.set(st.hubId, (hubCounts.get(st.hubId) ?? 0) + 1)
    }
  }
  for (const [hubId, c] of hubCenters) {
    const n = hubCounts.get(hubId) || 1
    hubCenters.set(hubId, { x: c.x / n, y: c.y / n })
  }

  const labelStations: RenderedStation[] = []
  const hubRepresentative = new Map<string, RenderedStation>()
  for (const st of positioned) {
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
    const r = Math.hypot(st.x - zoneCenter.x, st.y - zoneCenter.y)
    const existingId = hubMainStationId.get(st.hubId)
    if (!existingId) {
      hubMainStationId.set(st.hubId, st.id)
      continue
    }
    const existing = labelStations.find((s) => s.id === existingId)
    if (!existing || r < Math.hypot(existing.x - zoneCenter.x, existing.y - zoneCenter.y)) {
      hubMainStationId.set(st.hubId, st.id)
    }
  }

  const stationInfos = labelStations.map((st) => {
    const isHub = st.hubId != null
    const hubCenter = isHub && st.hubId ? hubCenters.get(st.hubId) : undefined
    const anchorX = hubCenter ? hubCenter.x : st.x
    const anchorY = hubCenter ? hubCenter.y : st.y
    const r = Math.hypot(anchorX - zoneCenter.x, anchorY - zoneCenter.y)
    let priority = 0
    if (isHub && st.hubId != null) {
      priority = hubMainStationId.get(st.hubId) === st.id ? 3 : 2
    } else if (r < PRIORITY_CENTER_RADIUS) priority = 2
    else if (r < PRIORITY_MIDDLE_RADIUS) priority = 1
    return { st, priority, r, anchorX, anchorY }
  })

  // Кружки всех нарисованных станций — ровно то, что проверяет метрика
  // labels.coverStations (координаты станции, а не центр хаба).
  const nodes = positioned.map((st) => ({
    id: st.id,
    x: st.x,
    y: st.y,
    radius: st.hubId ? NODE_RADIUS_HUB : NODE_RADIUS_STATION,
  }))

  const ordered = [...stationInfos].sort((a, b) =>
    b.priority !== a.priority ? b.priority - a.priority : a.r - b.r,
  )

  const segmentsFor = (st: RenderedStation): Segment[] => {
    const direct = model.segmentsByStationId.get(st.id) ?? []
    if (!st.hubId) return direct
    const hubStations = stationsByHubId.get(st.hubId)
    if (!hubStations || hubStations.length <= 1) return direct
    const result = [...direct]
    for (const hs of hubStations) {
      if (hs.id === st.id) continue
      const extra = model.segmentsByStationId.get(hs.id)
      if (extra) result.push(...extra)
    }
    return result
  }

  const segmentBuckets = new SegmentBuckets(model.segments)

  interface Prepared {
    info: (typeof stationInfos)[number]
    stationIds: string[]
    variants: { lines: string[]; width: number; height: number; deviation: number }[]
    /** Углы-кандидаты, отсортированные по «неудобству» (см. anglesSortedByMisfit). */
    angles: { ang: number; misfit: number }[]
    radialAngle: number | null
    isRing: boolean
    radiusOffsets: number[]
    preferred: number
    nearNodes: { x: number; y: number; radius: number }[]
    nearAnchors: { x: number; y: number }[]
    /** Насколько далеко от станции вообще может оказаться прямоугольник подписи. */
    reach: number
    /**
     * Кеш «статических» штрафов кандидата (узлы, неоднозначность, пересечения
     * с линиями). Геометрия кандидата от прохода к проходу не меняется, а
     * линии и станции неподвижны — значит эти слагаемые считаются один раз.
     * NaN = ещё не считали. Ключ — candidateKey().
     */
    staticCache: Float64Array
  }

  const lineHeight = fontPx + 2
  const lineSpacing = fontPx * 0.12

  const prepared: Prepared[] = []
  for (const info of ordered) {
    const st = info.st
    if (!st.title) continue

    const stationIds =
      st.hubId != null && (stationsByHubId.get(st.hubId)?.length ?? 0) > 0
        ? stationsByHubId.get(st.hubId)!.map((s) => s.id)
        : [st.id]
    const ownNodeIds = new Set(stationIds)

    const defaultLines = splitLabelToLines(st.title, info.r)
    const variants = lineVariantsFor(st.title, info.r).map((lines) => {
      let width = 0
      for (const ln of lines) width = Math.max(width, measureText(ln, fontPx))
      const height = lineHeight * lines.length + lineSpacing * Math.max(0, lines.length - 1)
      const deviation = lines.length === defaultLines.length ? 0 : W.lineBreakDeviation
      return { lines, width, height, deviation }
    })

    const segmentsForStation = segmentsFor(st)
    const isRing = RING_LINE_IDS.has(st.lineId)
    const baseAngles: number[] = []
    let radialAngle: number | null = null

    if (!isRing && segmentsForStation.length > 0) {
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
        const normalAngle = Math.atan2(sumDy, sumDx) + Math.PI / 2
        baseAngles.push(normalAngle, normalAngle + Math.PI)
      }
    }
    if (baseAngles.length === 0) {
      radialAngle = Math.atan2(
        info.anchorY - zoneCenter.y,
        info.anchorX - zoneCenter.x || 1e-6,
      )
      baseAngles.push(radialAngle)
    }

    // Насколько далеко от якоря может уехать прямоугольник подписи:
    // максимум радиального смещения плюс габариты самого широкого варианта.
    const radiusOffsets = radiusOffsetsForZone(info.r)
    let maxWidth = 0
    let maxHeight = 0
    for (const v of variants) {
      if (v.width > maxWidth) maxWidth = v.width
      if (v.height > maxHeight) maxHeight = v.height
    }
    const reach = radiusOffsets[radiusOffsets.length - 1] + maxWidth + maxHeight

    // Префильтры-надмножества: всё, что дальше, на штраф повлиять не может.
    const nodeReach = reach + NODE_RADIUS_HUB + W.clearanceGap
    const nearNodes: { x: number; y: number; radius: number }[] = []
    for (const n of nodes) {
      if (ownNodeIds.has(n.id)) continue
      if (Math.abs(n.x - info.anchorX) > nodeReach) continue
      if (Math.abs(n.y - info.anchorY) > nodeReach) continue
      nearNodes.push({ x: n.x, y: n.y, radius: n.radius })
    }
    const anchorReach = 2 * reach
    const nearAnchors: { x: number; y: number }[] = []
    for (const o of stationInfos) {
      if (o.st.id === st.id) continue
      if (Math.abs(o.anchorX - info.anchorX) > anchorReach) continue
      if (Math.abs(o.anchorY - info.anchorY) > anchorReach) continue
      nearAnchors.push({ x: o.anchorX, y: o.anchorY })
    }

    prepared.push({
      info,
      stationIds,
      variants,
      angles: anglesSortedByMisfit(CANDIDATE_ANGLES, baseAngles),
      radialAngle,
      isRing,
      radiusOffsets,
      preferred: preferredMaxDist(info.r),
      nearNodes,
      nearAnchors,
      reach,
      staticCache: makeStaticCache(
        variants.length * radiusOffsets.length * CANDIDATE_ANGLES.length * ALIGN_MODES.length,
      ),
    })
  }

  const slots: (DrawnLabel | null)[] = prepared.map(() => null)
  const chosen: (LabelPlacement | null)[] = prepared.map(() => null)

  /** Зафиксировать выбранную позицию подписи. */
  const finish = (
    index: number,
    best: LabelPlacement & { score: number; drawn: DrawnLabel },
  ): void => {
    const { score: _score, drawn, ...rest } = best
    void _score
    slots[index] = drawn
    chosen[index] = rest
  }

  /** Подбор лучшей позиции подписи с учётом всех уже размещённых, кроме себя. */
  const placeOne = (index: number): void => {
    const p = prepared[index]
    const info = p.info
    const anchorX = info.anchorX
    const anchorY = info.anchorY

    const neighbors: DrawnLabel[] = []
    for (let j = 0; j < slots.length; j += 1) {
      if (j === index) continue
      const s = slots[j]
      if (!s) continue
      const reach = neighborReach(p.reach, s.width, s.height)
      if (Math.abs(s.centerX - anchorX) < reach && Math.abs(s.centerY - anchorY) < reach) {
        neighbors.push(s)
      }
    }

    let best: (LabelPlacement & { score: number; drawn: DrawnLabel }) | null = null

    const nAngles = p.angles.length
    const nModes = ALIGN_MODES.length

    for (let vi = 0; vi < p.variants.length; vi += 1) {
      const variant = p.variants[vi]
      const textWidth = variant.width
      const textHeight = variant.height
      const softGapYThreshold = textHeight * 0.5
      const softGapXThreshold = textWidth * 0.5

      for (let ri = 0; ri < p.radiusOffsets.length; ri += 1) {
        const rOffset = p.radiusOffsets[ri]
        for (let ai = 0; ai < nAngles; ai += 1) {
          const candidate = p.angles[ai]
          const ang = candidate.ang
          if (p.isRing && p.radialAngle != null) {
            if (Math.cos(ang - p.radialAngle) < 0) continue
          }

          const angleCost = candidate.misfit * W.angleMisfit + variant.deviation

          const px = anchorX + Math.cos(ang) * rOffset
          const py = anchorY + Math.sin(ang) * rOffset

          const candidateBase = ((vi * p.radiusOffsets.length + ri) * nAngles + ai) * nModes

          for (const mode of ALIGN_MODES) {
            const x1 = mode === 0 ? px : mode === 1 ? px - textWidth : px - textWidth / 2
            const y1 = py - textHeight / 2
            const x2 = x1 + textWidth
            const y2 = y1 + textHeight
            const cx = (x1 + x2) / 2
            const cy = (y1 + y2) / 2

            const distToStation = Math.hypot(cx - anchorX, cy - anchorY)
            let score = angleCost + distToStation * W.distLinear
            if (distToStation > p.preferred) {
              const over = distToStation - p.preferred
              score += W.detachedStep + over * over * W.detachedQuad
            }
            // Ранний отсев: остальные слагаемые неотрицательны, поэтому кандидат
            // с таким «дешёвым» счётом уже не может обойти найденный максимум.
            if (best && score >= best.score) continue

            let overlaps = false
            let soft = 0
            for (const r of neighbors) {
              const xOverlap = !(x2 < r.x1 || x1 > r.x2)
              const yOverlap = !(y2 < r.y1 || y1 > r.y2)
              if (xOverlap && yOverlap) {
                overlaps = true
              } else {
                if (xOverlap) {
                  const gapY = y1 > r.y2 ? y1 - r.y2 : r.y1 - y2
                  if (gapY < softGapYThreshold) {
                    soft +=
                      W.softRepulsionY *
                      ((softGapYThreshold - gapY) / Math.max(softGapYThreshold, 1))
                  }
                }
                if (yOverlap) {
                  const gapX = x1 > r.x2 ? x1 - r.x2 : r.x1 - x2
                  if (gapX < softGapXThreshold) {
                    soft +=
                      W.softRepulsionX *
                      ((softGapXThreshold - gapX) / Math.max(softGapXThreshold, 1))
                  }
                }
              }
              if (r.importance >= 2) {
                const auraPadX = r.width * 0.25
                const auraPadY = r.height * 0.35
                const inAura = !(
                  x2 < r.x1 - auraPadX ||
                  x1 > r.x2 + auraPadX ||
                  y2 < r.y1 - auraPadY ||
                  y1 > r.y2 + auraPadY
                )
                if (inAura) soft += W.aura
              }
              const columnWidth = Math.max(textWidth, r.width) * 0.35
              if (Math.abs(cx - r.centerX) < columnWidth) {
                const normDy = Math.abs(cy - r.centerY) / Math.max(textHeight, r.height)
                if (normDy < 3) soft += W.column * ((3 - normDy) / 3)
              }
            }
            if (overlaps) score += W.labelOverlap
            score += soft
            if (best && score >= best.score) continue

            const cacheKey = candidateBase + mode
            let staticCost = p.staticCache[cacheKey]
            if (Number.isNaN(staticCost)) {
              staticCost = 0
              for (const n of p.nearNodes) {
                const d = pointRectDistance(n.x, n.y, x1, y1, x2, y2) - n.radius
                if (d <= 0) {
                  staticCost += W.coverStation
                  break
                }
                if (d < W.clearanceGap) {
                  staticCost += W.clearance * ((W.clearanceGap - d) / W.clearanceGap)
                }
              }
              for (const a of p.nearAnchors) {
                const d2 = (a.x - cx) ** 2 + (a.y - cy) ** 2
                if (d2 + 1e-3 < distToStation * distToStation) {
                  staticCost += W.ambiguous
                  break
                }
              }
              const crossing = segmentBuckets.countCrossingLines(x1, y1, x2, y2)
              if (crossing > 0) {
                staticCost += W.lineCrossFirst + (crossing - 1) * W.lineCrossMore
              }
              p.staticCache[cacheKey] = staticCost
            }
            score += staticCost
            if (best && score >= best.score) continue

            best = {
              score,
              text: info.st.title,
              x: mode === 1 ? px : x1,
              y: py,
              alignRight: mode === 1,
              importance: info.priority,
              width: textWidth,
              height: textHeight,
              lines: variant.lines,
              stationIds: p.stationIds,
              anchorX,
              anchorY,
              zoneRadius: info.r,
              rect: { x1, y1, x2, y2 },
              drawn: {
                x1,
                y1,
                x2,
                y2,
                centerX: cx,
                centerY: cy,
                width: textWidth,
                height: textHeight,
                importance: info.priority,
              },
            }
          }
        }
      }
    }

    if (best) finish(index, best)
  }

  // Фаза 1 — жадная раскладка в порядке приоритета.
  for (let i = 0; i < prepared.length; i += 1) placeOne(i)

  // Фаза 2 — координатный спуск: каждая подпись перекладывается заново, уже
  // видя ВСЕ остальные (а не только более приоритетные). Позиция из фазы 1
  // всегда входит в набор кандидатов, поэтому её штраф не может вырасти.
  for (let pass = 0; pass < REFINE_PASSES; pass += 1) {
    for (let i = 0; i < prepared.length; i += 1) placeOne(i)
  }

  // Фаза 3 — «расталкивание». Координатный спуск двигает подписи по одной и
  // потому не умеет разменивать: подпись-дефект не может занять чистое место
  // просто потому, что там уже стоит сосед, которому это место не нужно.
  // Здесь дефектная подпись пробует ВЫСЕЛИТЬ ровно одного соседа: сосед
  // снимается, обе подписи перекладываются обычным placeOne, и размен
  // принимается, только если суммарное число дефектов строго уменьшилось.
  // Порядок обхода фиксирован, случайности нет — результат детерминирован.
  //
  // Дефект здесь — ровно то, что считают метрики labels.detached и
  // labels.crossedByLines: подпись дальше допуска своей зоны или перечёркнута
  // хотя бы одной линией. Наложения подписей в этот счёт не входят: они и так
  // стоят 24000 и ни один кандидат с наложением не выигрывает у обычного.
  const isDefect = (index: number): boolean => {
    const s = slots[index]
    if (!s) return true
    const p = prepared[index]
    const dx = s.centerX - p.info.anchorX
    const dy = s.centerY - p.info.anchorY
    if (Math.hypot(dx, dy) > p.preferred) return true
    return segmentBuckets.countCrossingLines(s.x1, s.y1, s.x2, s.y2) > 0
  }

  for (let pass = 0; pass < EJECT_PASSES; pass += 1) {
    let improved = false
    for (let i = 0; i < prepared.length; i += 1) {
      if (!isDefect(i)) continue
      const p = prepared[i]
      const anchorX = p.info.anchorX
      const anchorY = p.info.anchorY
      let maxWidth = 0
      let maxHeight = 0
      for (const v of p.variants) {
        if (v.width > maxWidth) maxWidth = v.width
        if (v.height > maxHeight) maxHeight = v.height
      }
      for (let j = 0; j < prepared.length; j += 1) {
        if (j === i) continue
        const s = slots[j]
        if (!s) continue
        // Выселять имеет смысл только тех, кто реально мешает: чей прямоугольник
        // вообще способен пересечься с подписью i, поставленной В ДОПУСКЕ.
        // Более широкий neighborReach() дал бы в центре по сотне кандидатов на
        // подпись и на порядок больше работы без единого лишнего размена.
        if (Math.abs(s.centerX - anchorX) >= p.preferred + (maxWidth + s.width) / 2) continue
        if (Math.abs(s.centerY - anchorY) >= p.preferred + (maxHeight + s.height) / 2) continue

        // Двигаются только i и j, остальные подписи стоят на месте — значит
        // изменение общего числа дефектов равно изменению по этой паре.
        const before = 1 + (isDefect(j) ? 1 : 0)
        const slotI = slots[i]
        const slotJ = slots[j]
        const chosenI = chosen[i]
        const chosenJ = chosen[j]

        slots[j] = null
        chosen[j] = null
        placeOne(i)
        placeOne(j)

        if ((isDefect(i) ? 1 : 0) + (isDefect(j) ? 1 : 0) < before) {
          improved = true
          if (!isDefect(i)) break
        } else {
          slots[i] = slotI
          slots[j] = slotJ
          chosen[i] = chosenI
          chosen[j] = chosenJ
        }
      }
    }
    if (!improved) break
  }

  const placements: LabelPlacement[] = []
  for (const c of chosen) if (c) placements.push(c)
  return placements
}
