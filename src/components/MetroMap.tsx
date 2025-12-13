import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fullGraphLines, fullGraphStations, fullGraphEdges } from '../metro/fullGraph'
import type { PositionedStation, LayoutStation } from '../metro/layoutEngine'
import { computeLayout } from '../metro/layoutEngine'
import type { FullGraphStation } from '../metro/types'

interface MetroMapProps {
  selectionMode: 'from' | 'to'
  onSelectStation: (stationId: string, stationName: string) => void
  fromStationName?: string
  toStationName?: string
  fromStationId?: string
  toStationId?: string
  /** Массив ID станций, входящих в текущий маршрут (для подсветки точек/кружков) */
  routeStationIds?: string[]
  /** Массив ключей рёбер маршрута вида "fromId|toId" (независимо от порядка) для точного рисования пути */
  routeEdgeKeys?: string[]
  /** Массив ключей рёбер маршрута, являющихся длинными пересадками (для отдельной подсветки) */
  routeLongTransferEdgeKeys?: string[]
  /** Режим редактирования схемы (drag&drop станций/хабов) */
  editMode?: boolean
  /** Включение визуального режима отладки коллизий подписей */
  collisionDebug?: boolean
  /** Колбэк для передачи наружу текущих оверрайдов координат станций */
  onLayoutChange?: (overrides: Record<string, { x: number; y: number }>) => void
  /** Колбэк при взаимодействии с картой (pan/zoom), например, чтобы сворачивать UI-шторки */
  onMapInteraction?: () => void
  /** Клик по станции в режиме редактирования для открытия окна редактирования хаба */
  onEditStationInspect?: (stationId: string) => void
  /** Оверрайды hubId для станций из редактора (App), stationId -> hubId | null */
  stationHubOverrides?: Record<string, string | null>
  /** Набор ID станций, которые следует скрыть с карты (soft delete в редакторе) */
  hiddenStationIds?: Set<string>
  /** Отступы невидимой области поверх карты (header, bottom-sheet, редактор), в px */
  visibleInsets?: { top: number; right: number; bottom: number; left: number }
  /** Переопределения названий станций по id (editor overrides) */
  stationTitleOverrides?: Record<string, string>
  /** Дополнительные станции, созданные вручную в редакторе (manualStations из App) */
  extraStations?: FullGraphStation[]
  /** Флаг блокировки взаимодействий карты (pan/zoom), когда внешний UI в режиме выбора маршрута */
  interactionsLocked?: boolean
  hubRotateCommand?: { hubId: string; direction: 'cw' | 'ccw'; token: number } | null
  /** Изменение набора выделенных станций в режиме редактора (для bulk-операций в UI) */
  onEditSelectionChange?: (selectedIds: string[]) => void
  onInitialViewportReady?: () => void
  /** Открыта ли мобильная шторка с деталями маршрута (для учёта её высоты при автофите). */
  routeSheetOpen?: boolean
}

interface ViewportState {
  scale: number
  offsetX: number
  offsetY: number
}

// Идентификаторы кольцевых линий во fullGraph: Кольцевая (5), МЦК (95), БКЛ (97)
const RING_LINE_IDS = new Set<number>([5, 95, 97])

const MIN_SCALE = 0.35
const MAX_SCALE = 3
const ROUTE_AUTO_FIT_MAX_SCALE = 1.8
// Какой зум считать комфортным стартовым (если auto-fit получается слишком мелким)
const INITIAL_PREFERRED_SCALE = 1.1
const PAN_CLAMP_VIEWPORT_FRACTION = 0.01

// Визуальные константы схемы под светлый стеклянный/Hello Kitty UI
const BASE_LINE_WIDTH = 6.4
const BASE_RING_LINE_WIDTH = 6.4
const BASE_LINE_ALPHA_NO_ROUTE = 1
const BASE_LINE_ALPHA_WITH_ROUTE = 0.3

const ROUTE_LINE_WIDTH = 7.2
const ROUTE_LINE_ALPHA = 1

const STATION_RADIUS = 5.2
const STATION_SELECTED_RADIUS = 8
const STATION_BORDER_WIDTH = 2
const STATION_FILL_COLOR = '#ffffff'
const HUB_PIE_BASE_ALPHA = 0.96
const HUB_PIE_HALO_ALPHA = 0.24
const HUB_PIE_HALO_RADIUS_MULT = 2.1
const HUB_DIM_ALPHA_WHEN_ROUTE = 0.35

const HUB_ROTATE_STEP_RAD = (Math.PI / 180) * 15

const ROUTE_PULSE_DURATION_MS = 1500
const STATION_CLICK_PULSE_DURATION_MS = 360

// Типографика подписей станций: выровнена под UI-токены
// Базовый размер соответствует --font-size-md (16px) на iPhone 14,
// цвет — уровню --color-text-secondary (#4b5563) в интерфейсе.
const LABEL_BASE_FONT_PX = 16
const LABEL_FONT_FAMILY =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const LABEL_FONT_WEIGHT = 400
const LABEL_TEXT_COLOR = '#4b5563'

const HUB_GROUPS_MIN_ZOOM = 0
const FAR_TRANSFERS_MIN_ZOOM = 0

// Внутренний флаг по умолчанию: отладочный режим коллизий подписей.
// Управляется извне через prop collisionDebug, это значение используется как дефолт.
const LABEL_COLLISION_DEBUG_DEFAULT = false

type StationLabelPlacement = {
  text: string
  x: number
  y: number
  alignRight: boolean
  /** Важность подписи: 3 — хабы, 2 — центр, 1 — средняя зона, 0 — дальняя периферия */
  importance: number
  width: number
  height: number
  lines: string[]
  stationIds: string[]
}

function computeStationLabelPlacements(
  ctx: CanvasRenderingContext2D,
  positionedStations: PositionedStation[],
  labelFontPx: number,
  segmentsByStationId: Map<string, { ax: number; ay: number; bx: number; by: number }[]>,
): StationLabelPlacement[] {
  const placements: StationLabelPlacement[] = []

  const segmentIntersectsRect = (
    seg: { ax: number; ay: number; bx: number; by: number },
    x1: number,
    y1: number,
    x2: number,
    y2: number,
  ) => {
    const minSegX = Math.min(seg.ax, seg.bx)
    const maxSegX = Math.max(seg.ax, seg.bx)
    const minSegY = Math.min(seg.ay, seg.by)
    const maxSegY = Math.max(seg.ay, seg.by)
    if (maxSegX < x1 || minSegX > x2 || maxSegY < y1 || minSegY > y2) {
      return false
    }
    return true
  }

  const hubCenters = new Map<string, { x: number; y: number }>()
  const hubCounts = new Map<string, number>()
  const stationsByHubId = new Map<string, PositionedStation[]>()

  for (const st of positionedStations) {
    if (!st.hubId) continue
    const hubId = st.hubId

    const existingCenter = hubCenters.get(hubId)
    if (!existingCenter) {
      hubCenters.set(hubId, { x: st.x, y: st.y })
      hubCounts.set(hubId, 1)
    } else {
      existingCenter.x += st.x
      existingCenter.y += st.y
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

  // Для подписей объединяем станции в пределах одного хаба: одна подпись на весь хаб
  // для каждого уникального названия, при этом внутри хаба выбираем одно
  // "главное" имя с более высоким приоритетом.
  const labelStations: PositionedStation[] = []
  const hubRepresentative = new Map<string, PositionedStation>()
  for (const st of positionedStations) {
    if (st.hubId != null) {
      const key = `${st.hubId}|${st.title.toLowerCase()}`
      if (!hubRepresentative.has(key)) {
        hubRepresentative.set(key, st)
      }
    } else {
      labelStations.push(st)
    }
  }
  for (const st of hubRepresentative.values()) {
    labelStations.push(st)
  }

  // Для каждого hubId выбираем один главный stationId по простому эвристическому правилу:
  // ближе к центру схемы (меньше расстояние до (0,0)).
  const hubMainStationId = new Map<string, string>()
  for (const st of labelStations) {
    if (st.hubId == null) continue
    const hubId = st.hubId
    const r = Math.sqrt(st.x * st.x + st.y * st.y)
    const existingId = hubMainStationId.get(hubId)
    if (!existingId) {
      hubMainStationId.set(hubId, st.id)
    } else {
      const existing = labelStations.find((s) => s.id === existingId)
      if (!existing) {
        hubMainStationId.set(hubId, st.id)
      } else {
        const er = Math.sqrt(existing.x * existing.x + existing.y * existing.y)
        if (r < er) hubMainStationId.set(hubId, st.id)
      }
    }
  }

  const drawnLabels: {
    x1: number
    y1: number
    x2: number
    y2: number
    centerX: number
    centerY: number
    width: number
    height: number
    importance: number
  }[] = []
  // Запретная зона вокруг станций и хабов: радиус зависит от размера шрифта и
  // типа узла, чтобы подписи не касались кругов станций/хабов и ближайших линий.
  const stationInfos = labelStations.map((st) => {
    const isHub = st.hubId != null
    const hubCenter = isHub && st.hubId ? hubCenters.get(st.hubId) : undefined
    const anchorX = hubCenter ? hubCenter.x : st.x
    const anchorY = hubCenter ? hubCenter.y : st.y
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
    const marginFromFont = labelFontPx * 0.45
    const diskRadius = baseRadius + marginFromFont
    return { st, priority, r, diskRadius, anchorX, anchorY, isHub }
  })

  const stationDisks = stationInfos.map((info) => ({
    x: info.anchorX,
    y: info.anchorY,
    r: info.diskRadius,
  }))

  const stationsForLabels = [...stationInfos].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority
    return a.r - b.r
  })

  const getSegmentsForLabelStation = (st: PositionedStation) => {
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

  const CENTER_RADIUS = 240
  const MIDDLE_RADIUS = 520

  for (const info of stationsForLabels) {
    const st = info.st
    const anchorX = info.anchorX
    const anchorY = info.anchorY

    const stationIdsForLabel: string[] = []
    if (st.hubId != null) {
      const hubStations = stationsByHubId.get(st.hubId)
      if (hubStations && hubStations.length > 0) {
        for (const hs of hubStations) {
          stationIdsForLabel.push(hs.id)
        }
      } else {
        stationIdsForLabel.push(st.id)
      }
    } else {
      stationIdsForLabel.push(st.id)
    }

    const label = st.title
    if (!label) continue

    const lines = splitLabelToLines(label, info.r)
    const lineHeight = labelFontPx + 2
    const lineSpacing = labelFontPx * 0.25
    let maxLineWidth = 0
    for (const ln of lines) {
      const w = ctx.measureText(ln).width
      if (w > maxLineWidth) maxLineWidth = w
    }
    const textWidth = maxLineWidth
    const textHeight = lineHeight * lines.length + lineSpacing * Math.max(0, lines.length - 1)

    const segmentsForStation = getSegmentsForLabelStation(st)

    const isRingStation = typeof st.lineId === 'number' && RING_LINE_IDS.has(st.lineId)
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

    // Набор радиальных и угловых смещений даёт десятки возможных позиций
    // (16+ уникальных направлений относительно станции), что позволяет
    // практически всегда найти вариант без пересечений.
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
      | {
          x1: number
          y1: number
          x2: number
          y2: number
          labelX: number
          labelY: number
          alignRight: boolean
          score: number
          centerX: number
          centerY: number
          width: number
          height: number
          lines: string[]
        }
      | null = null

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

          // Мягкий штраф за прохождение локальных сегментов линии через прямоугольник подписи.
          if (segmentsForStation.length > 0) {
            for (const seg of segmentsForStation) {
              if (segmentIntersectsRect(seg, x1, y1, x2, y2)) {
                score += 140
              }
            }
          }

          const preferredMaxDist = isCenterZone ? 52 : isMiddleZone ? 72 : 96
          if (distToStation > preferredMaxDist) {
            const extra = distToStation - preferredMaxDist
            score += extra * 12
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
              labelX,
              labelY,
              alignRight,
              score,
              centerX: cx,
              centerY: cy,
              width: textWidth,
              height: textHeight,
              lines,
            }
          }
        }
      }
    }

    if (bestCandidate) {
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
        text: label,
        x: bestCandidate.labelX,
        y: bestCandidate.labelY,
        alignRight: bestCandidate.alignRight,
        importance: info.priority,
        width: bestCandidate.width,
        height: bestCandidate.height,
        lines: bestCandidate.lines,
        stationIds: stationIdsForLabel,
      })
    }
  }

  return placements
}

export function MetroMap({
  selectionMode,
  onSelectStation,
  fromStationName,
  toStationName,
  fromStationId,
  toStationId,
  routeStationIds,
  routeEdgeKeys,
  routeLongTransferEdgeKeys,
  editMode = false,
  collisionDebug,
  onLayoutChange,
  onMapInteraction,
  onEditStationInspect,
  stationHubOverrides,
  hiddenStationIds,
  visibleInsets,
  stationTitleOverrides,
  extraStations,
  interactionsLocked,
  hubRotateCommand,
  onEditSelectionChange,
  onInitialViewportReady,
  routeSheetOpen = false,
}: MetroMapProps) {
  const [viewport, setViewport] = useState<ViewportState>({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  })
  const viewportRef = useRef<ViewportState>({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  })
  const lastRouteFitRef = useRef<
    { routeKey: string | null; bottomInset: number; insetKey: string } | null
  >(null)
  const wheelRafRef = useRef<number | null>(null)
  const isWheelZoomingRef = useRef(false)
  const wheelStopTimeoutRef = useRef<number | null>(null)
  const [isPanning, setIsPanning] = useState(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)
  const [hasDragged, setHasDragged] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const labelCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const pinchStartDistanceRef = useRef<number | null>(null)
  const pinchStartScaleRef = useRef<number>(1)
  const pinchCenterWorldRef = useRef<{ x: number; y: number } | null>(null)
  const pinchLastDistanceRef = useRef<number | null>(null)
  const pinchLastTimestampRef = useRef<number | null>(null)
  const pinchVelocityRef = useRef(0)
  const labelPlacementsRef = useRef<{
    stationsRef: PositionedStation[] | null
    placements: StationLabelPlacement[]
  }>({ stationsRef: null, placements: [] })
  const zoomHoldDirectionRef = useRef<1 | -1 | 0>(0)
  const zoomHoldRafRef = useRef<number | null>(null)
  const zoomHoldTimeoutRef = useRef<number | null>(null)
  const zoomSuppressClickRef = useRef(false)
  const zoomClickAnimRafRef = useRef<number | null>(null)
  const panVelocityRef = useRef<{ vx: number; vy: number }>({ vx: 0, vy: 0 })
  const panLastSampleTimeRef = useRef<number | null>(null)
  const panInertiaRafRef = useRef<number | null>(null)
  const lastTapTimeRef = useRef<number | null>(null)
  const lastTapPosRef = useRef<{ x: number; y: number } | null>(null)
  const zoomDragActiveRef = useRef(false)
  const zoomDragUsedRef = useRef(false)
  const zoomDragStartScaleRef = useRef(1)
  const zoomDragStartYRef = useRef(0)
  const zoomDragCenterClientRef = useRef<{ x: number; y: number } | null>(null)
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>(
    () => ({ width: 0, height: 0 }),
  )
  const [hasInitialViewport, setHasInitialViewport] = useState(false)
  const initialViewportReportedRef = useRef(false)

  const lastHubRotateTokenRef = useRef<number | null>(null)

  const routePulseRef = useRef<{ startedAt: number } | null>(null)
  const clickPulseRef = useRef<{ stationId: string; startedAt: number } | null>(null)
  const animationRafRef = useRef<number | null>(null)
  const [animationTick, setAnimationTick] = useState(0)
  const lastAnimationTickRef = useRef(0)

  useEffect(() => {
    return () => {
      if (animationRafRef.current != null) {
        cancelAnimationFrame(animationRafRef.current)
        animationRafRef.current = null
      }
      if (panInertiaRafRef.current != null) {
        cancelAnimationFrame(panInertiaRafRef.current)
        panInertiaRafRef.current = null
      }
    }
  }, [])

  const ensureAnimationLoop = () => {
    if (animationRafRef.current != null) return

    const loop = () => {
      const now = performance.now()
      let hasActive = false

      if (routePulseRef.current) {
        const elapsed = now - routePulseRef.current.startedAt
        if (elapsed < ROUTE_PULSE_DURATION_MS) {
          hasActive = true
        } else {
          routePulseRef.current = null
        }
      }

      if (clickPulseRef.current) {
        const elapsed = now - clickPulseRef.current.startedAt
        if (elapsed < STATION_CLICK_PULSE_DURATION_MS) {
          hasActive = true
        } else {
          clickPulseRef.current = null
        }
      }

      if (!hasActive) {
        animationRafRef.current = null
        return
      }

      const last = lastAnimationTickRef.current
      if (now - last >= 1000 / 120) {
        lastAnimationTickRef.current = now
        setAnimationTick(now)
      }

      animationRafRef.current = requestAnimationFrame(loop)
    }

    animationRafRef.current = requestAnimationFrame(loop)
  }

  useEffect(() => {
    if (routeEdgeKeys && routeEdgeKeys.length > 0) {
      routePulseRef.current = { startedAt: performance.now() }
      ensureAnimationLoop()
    } else {
      routePulseRef.current = null
    }
  }, [routeEdgeKeys, routeStationIds])

  useEffect(() => {
    viewportRef.current = viewport
  }, [viewport])

  useEffect(() => {
    return () => {
      if (wheelRafRef.current != null) {
        cancelAnimationFrame(wheelRafRef.current)
        wheelRafRef.current = null
      }
      if (wheelStopTimeoutRef.current != null) {
        window.clearTimeout(wheelStopTimeoutRef.current)
        wheelStopTimeoutRef.current = null
      }
    }
  }, [])

  // Оверрайды координат станций в редакторе: stationId -> {x,y}
  const [stationOverrides, setStationOverrides] = useState<Record<string, { x: number; y: number }>>(
    {},
  )
  const [selectedStationIds, setSelectedStationIds] = useState<string[]>([])
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null)
  const [dragStationIds, setDragStationIds] = useState<string[] | null>(null)
  const dragStartWorldRef = useRef<{ x: number; y: number } | null>(null)
  const dragInitialPositionsRef = useRef<Record<string, { x: number; y: number }>>({})

  const positionedStations = useMemo(() => {
    const hidden = hiddenStationIds
    const usedStationIds = new Set<string>()
    for (const line of fullGraphLines) {
      for (const sid of line.stationIds) usedStationIds.add(sid)
    }

    const hasPrecomputed = fullGraphStations.some(
      (s) => s.lineNumericId != null && typeof s.layoutX === 'number' && typeof s.layoutY === 'number',
    )

    if (hasPrecomputed) {
      const lineColorById = new Map<number, string>()
      for (const line of fullGraphLines) {
        lineColorById.set(line.id, line.colorHex)
      }

      const base: PositionedStation[] = []
      for (const s of fullGraphStations) {
        if (s.lineNumericId == null) continue
        if (!usedStationIds.has(s.id)) continue
        if (typeof s.layoutX !== 'number' || typeof s.layoutY !== 'number') continue
        if (hidden && hidden.has(s.id)) continue

        const color = lineColorById.get(s.lineNumericId) ?? '#000000'
        const override = stationHubOverrides?.[s.id]
        let hubId = s.hubId
        if (override === null) hubId = undefined
        else if (override !== undefined) hubId = override
        const titleOverride = stationTitleOverrides?.[s.id]
        const title = titleOverride && titleOverride.trim().length > 0 ? titleOverride : s.title
        base.push({
          id: s.id,
          title,
          lineId: s.lineNumericId,
          hubId,
          x: s.layoutX,
          y: s.layoutY,
          lineColor: color,
        })
      }

      if (extraStations && extraStations.length > 0) {
        for (const s of extraStations) {
          if (s.lineNumericId == null) continue
          if (typeof s.layoutX !== 'number' || typeof s.layoutY !== 'number') continue
          if (hidden && hidden.has(s.id)) continue

          const color = lineColorById.get(s.lineNumericId) ?? '#000000'
          const override = stationHubOverrides?.[s.id]
          let hubId = s.hubId
          if (override === null) hubId = undefined
          else if (override !== undefined) hubId = override
          const titleOverride = stationTitleOverrides?.[s.id]
          const title = titleOverride && titleOverride.trim().length > 0 ? titleOverride : s.title
          base.push({
            id: s.id,
            title,
            lineId: s.lineNumericId,
            hubId,
            x: s.layoutX,
            y: s.layoutY,
            lineColor: color,
          })
        }
      }

      // Применяем оверрайды из редактора, если они есть
      const overrideEntries = Object.entries(stationOverrides)
      if (overrideEntries.length === 0) return base

      const overridesMap = new Map<string, { x: number; y: number }>(overrideEntries)
      return base.map((st) => {
        const ov = overridesMap.get(st.id)
        return ov ? { ...st, x: ov.x, y: ov.y } : st
      })
    }

    // Теоретический fallback: если по какой-то причине нет layoutX/layoutY —
    // используем computeLayout. Сейчас, после оффлайн-пайплайна, этот путь
    // не должен использоваться.
    const layoutStations: LayoutStation[] = fullGraphStations
      .filter((s) => s.lineNumericId != null && !(hidden && hidden.has(s.id)))
      .map((s) => {
        const override = stationHubOverrides?.[s.id]
        let hubId = s.hubId
        if (override === null) hubId = undefined
        else if (override !== undefined) hubId = override
        const titleOverride = stationTitleOverrides?.[s.id]
        const title = titleOverride && titleOverride.trim().length > 0 ? titleOverride : s.title
        return { id: s.id, title, lineId: s.lineNumericId, hubId }
      })

    if (extraStations && extraStations.length > 0) {
      for (const s of extraStations) {
        if (s.lineNumericId == null) continue
        if (hidden && hidden.has(s.id)) continue
        const override = stationHubOverrides?.[s.id]
        let hubId = s.hubId
        if (override === null) hubId = undefined
        else if (override !== undefined) hubId = override
        const titleOverride = stationTitleOverrides?.[s.id]
        const title = titleOverride && titleOverride.trim().length > 0 ? titleOverride : s.title
        layoutStations.push({ id: s.id, title, lineId: s.lineNumericId, hubId })
      }
    }
    const base = computeLayout(fullGraphLines, layoutStations)

    const overrideEntries = Object.entries(stationOverrides)
    if (overrideEntries.length === 0) return base

    const overridesMap = new Map<string, { x: number; y: number }>(overrideEntries)
    return base.map((st) => {
      const ov = overridesMap.get(st.id)
      return ov ? { ...st, x: ov.x, y: ov.y } : st
    })
  }, [stationOverrides, stationHubOverrides, hiddenStationIds, stationTitleOverrides, extraStations])

  const positionedById = useMemo(() => {
    const map = new Map<string, PositionedStation>()
    for (const st of positionedStations) {
      map.set(st.id, st)
    }
    return map
  }, [positionedStations])

  const teatralnayaWorld = useMemo(() => {
    if (positionedStations.length === 0) return null
    const byId = positionedStations.find((st) => st.id === 'mos-2-2.99')
    if (byId) return { x: byId.x, y: byId.y }
    const byTitle = positionedStations.find((st) => st.title === 'Театральная')
    if (byTitle) return { x: byTitle.x, y: byTitle.y }
    return null
  }, [positionedStations])

  const selectedStationIdSet = useMemo(() => {
    return new Set(selectedStationIds)
  }, [selectedStationIds])

  useEffect(() => {
    if (!onEditSelectionChange) return
    // Вне режима редактирования считаем, что выбор пустой,
    // чтобы не тянуть "хвост" старого выделения в UI редактора.
    onEditSelectionChange(editMode ? selectedStationIds : [])
  }, [selectedStationIds, editMode, onEditSelectionChange])

  const routeStationIdSet = useMemo(() => {
    if (!routeStationIds || routeStationIds.length === 0) return new Set<string>()
    return new Set(routeStationIds)
  }, [routeStationIds])

  const routeEdgeKeySet = useMemo(() => {
    if (!routeEdgeKeys || routeEdgeKeys.length === 0) return new Set<string>()
    return new Set(routeEdgeKeys)
  }, [routeEdgeKeys])

  const routeLongTransferEdgeKeySet = useMemo(() => {
    if (!routeLongTransferEdgeKeys || routeLongTransferEdgeKeys.length === 0)
      return new Set<string>()
    return new Set(routeLongTransferEdgeKeys)
  }, [routeLongTransferEdgeKeys])

  const viewBoxSize = 600

  const corridorEdgeData = useMemo(() => {
    const corridorEdgeUsage = new Map<string, { lineIds: number[] }>()
    const corridorEdgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

    for (const line of fullGraphLines) {
      const ids = line.stationIds.filter((sid) => positionedById.has(sid))
      if (ids.length < 2) continue
      const isRing = RING_LINE_IDS.has(line.id)
      const segmentCount = isRing ? ids.length : ids.length - 1

      for (let i = 0; i < segmentCount; i += 1) {
        const aId = ids[i]
        const bId = ids[(i + 1) % ids.length]
        const key = corridorEdgeKey(aId, bId)
        let info = corridorEdgeUsage.get(key)
        if (!info) {
          info = { lineIds: [] }
          corridorEdgeUsage.set(key, info)
        }
        if (!info.lineIds.includes(line.id)) {
          info.lineIds.push(line.id)
        }
      }
    }

    return { corridorEdgeUsage, corridorEdgeKey }
  }, [positionedById])

  const hubGroups = useMemo(() => {
    const groups = new Map<string, PositionedStation[]>()
    for (const st of positionedStations) {
      if (!st.hubId) continue
      const id = st.hubId
      const arr = groups.get(id)
      if (arr) arr.push(st)
      else groups.set(id, [st])
    }
    return groups
  }, [positionedStations])

  const worldBounds = useMemo(() => {
    if (positionedStations.length === 0) return null

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity

    for (const st of positionedStations) {
      if (st.x < minX) minX = st.x
      if (st.x > maxX) maxX = st.x
      if (st.y < minY) minY = st.y
      if (st.y > maxY) maxY = st.y
    }

    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
      return null
    }

    const width = maxX - minX || 1
    const height = maxY - minY || 1
    const centerX = (minX + maxX) / 2
    const centerY = (minY + maxY) / 2

    return { minX, maxX, minY, maxY, width, height, centerX, centerY }
  }, [positionedStations])

  useEffect(() => {
    if (!editMode) return
    if (!hubRotateCommand) return

    const { hubId, direction, token } = hubRotateCommand
    if (token == null) return
    if (lastHubRotateTokenRef.current === token) return
    lastHubRotateTokenRef.current = token

    const group = positionedStations.filter((st) => st.hubId === hubId)
    if (group.length === 0) return

    let cx = 0
    let cy = 0
    for (const st of group) {
      cx += st.x
      cy += st.y
    }
    cx /= group.length
    cy /= group.length

    const angle = direction === 'cw' ? -HUB_ROTATE_STEP_RAD : HUB_ROTATE_STEP_RAD
    const cosA = Math.cos(angle)
    const sinA = Math.sin(angle)

    setStationOverrides((prev) => {
      const next = { ...prev }
      for (const st of group) {
        const dx = st.x - cx
        const dy = st.y - cy
        const rx = cx + dx * cosA - dy * sinA
        const ry = cy + dx * sinA + dy * cosA
        next[st.id] = { x: rx, y: ry }
      }
      return next
    })
  }, [hubRotateCommand, positionedStations, editMode])

  // Проекция координат Яндекс-схемы (yandexX/yandexY) в мировые координаты текущей схемы.
  // Используем аффинное преобразование: центрируем bbox Яндекса и масштабируем его
  // так, чтобы он помещался внутрь текущих worldBounds с сохранением пропорций.
  const yandexWorldById = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>()

    if (!worldBounds) return map

    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity

    const points: { id: string; x: number; y: number }[] = []

    for (const s of fullGraphStations) {
      if (s.lineNumericId == null) continue
      if (!positionedById.has(s.id)) continue
      if (typeof s.yandexX !== 'number' || typeof s.yandexY !== 'number') continue
      const x = s.yandexX
      const y = s.yandexY
      points.push({ id: s.id, x, y })
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }

    if (points.length === 0) return map
    if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
      return map
    }

    const srcWidth = maxX - minX || 1
    const srcHeight = maxY - minY || 1
    const srcCenterX = (minX + maxX) / 2
    const srcCenterY = (minY + maxY) / 2

    const dstWidth = worldBounds.width
    const dstHeight = worldBounds.height
    const dstCenterX = worldBounds.centerX
    const dstCenterY = worldBounds.centerY

    const scale = Math.min(dstWidth / srcWidth, dstHeight / srcHeight)
    if (!Number.isFinite(scale) || scale <= 0) return map

    for (const p of points) {
      const dx = (p.x - srcCenterX) * scale
      const dy = (p.y - srcCenterY) * scale
      const wx = dstCenterX + dx
      const wy = dstCenterY + dy
      map.set(p.id, { x: wx, y: wy })
    }

    return map
  }, [positionedById, worldBounds])

  const lastLayoutSnapshotRef = useRef<Record<string, { x: number; y: number }>>({})

  useEffect(() => {
    if (!onLayoutChange) return

    const snapshot: Record<string, { x: number; y: number }> = {}
    for (const st of positionedStations) {
      snapshot[st.id] = { x: st.x, y: st.y }
    }

    const prev = lastLayoutSnapshotRef.current
    let changed = false

    const prevKeys = Object.keys(prev)
    const nextKeys = Object.keys(snapshot)
    if (prevKeys.length !== nextKeys.length) {
      changed = true
    } else {
      for (const id of nextKeys) {
        const p = prev[id]
        const n = snapshot[id]
        if (!p || !n || p.x !== n.x || p.y !== n.y) {
          changed = true
          break
        }
      }
    }

    if (!changed) return

    lastLayoutSnapshotRef.current = snapshot
    onLayoutChange(snapshot)
  }, [positionedStations, onLayoutChange])

  useEffect(() => {
    if (!editMode) {
      setSelectedStationIds([])
      setSelectionAnchorId(null)
    }
  }, [editMode])

  const clampViewport = useCallback((vp: ViewportState): ViewportState => {
    // Ограничиваем масштаб
    let scale = vp.scale
    scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))

    // Если ещё не знаем границы мира или размера canvas — не трогаем pan
    if (!worldBounds || !canvasSize.width || !canvasSize.height) {
      return { scale, offsetX: vp.offsetX, offsetY: vp.offsetY }
    }

    const displayWidth = canvasSize.width
    const displayHeight = canvasSize.height

    // Используем полный размер холста: схема центрируется по Canvas,
    // а не по «свободной зоне» между UI-панелями.
    const halfViewportWorldWidth = displayWidth / scale / 2
    const halfViewportWorldHeight = displayHeight / scale / 2

    const clampHalfWorldWidth = halfViewportWorldWidth * PAN_CLAMP_VIEWPORT_FRACTION
    const clampHalfWorldHeight = halfViewportWorldHeight * PAN_CLAMP_VIEWPORT_FRACTION

    // Увеличенный отступ в мировых координатах, чтобы на краях оставалось место под подписи
    const paddingWorld = 180 / scale

    // Текущий центр экрана в мировых координатах
    let centerWorldX = -vp.offsetX / scale
    let centerWorldY = -vp.offsetY / scale

    // Разрешённый диапазон для центра, чтобы карта не «улетала» за пределы точек и линий.
    // Если видимая область по какой-то оси больше карты + паддинги,
    // просто не ограничиваем центр по этой оси (оставляем как есть),
    // чтобы на очень широких/высоких экранах не блокировать панорамирование.
    const rawMinCenterX = worldBounds.minX - paddingWorld + halfViewportWorldWidth
    const rawMaxCenterX = worldBounds.maxX + paddingWorld - halfViewportWorldWidth
    const rawMinCenterY = worldBounds.minY - paddingWorld + halfViewportWorldHeight
    const rawMaxCenterY = worldBounds.maxY + paddingWorld - halfViewportWorldHeight

    const minCenterX = worldBounds.minX - paddingWorld + clampHalfWorldWidth
    const maxCenterX = worldBounds.maxX + paddingWorld - clampHalfWorldWidth
    const minCenterY = worldBounds.minY - paddingWorld + clampHalfWorldHeight
    const maxCenterY = worldBounds.maxY + paddingWorld - clampHalfWorldHeight

    if (rawMinCenterX <= rawMaxCenterX) {
      centerWorldX = Math.min(maxCenterX, Math.max(minCenterX, centerWorldX))
    }
    if (rawMinCenterY <= rawMaxCenterY) {
      centerWorldY = Math.min(maxCenterY, Math.max(minCenterY, centerWorldY))
    }

    // Возвращаемся к offsetX/offsetY так, чтобы центр экрана
    // действительно указывал на вычисленный центр мира.
    const offsetX = -centerWorldX * scale
    const offsetY = -centerWorldY * scale

    return { scale, offsetX, offsetY }
  }, [worldBounds, canvasSize])

  useEffect(() => {
    if (editMode) return
    if (!canvasSize.width || !canvasSize.height) return
    if (!worldBounds) return

    if (routeStationIdSet.size === 0) {
      lastRouteFitRef.current = null
      return
    }

    let rafId: number | null = null

    const computeAutoFit = () => {
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity

      routeStationIdSet.forEach((id) => {
        const st = positionedById.get(id)
        if (!st) return
        if (st.x < minX) minX = st.x
        if (st.x > maxX) maxX = st.x
        if (st.y < minY) minY = st.y
        if (st.y > maxY) maxY = st.y
      })

      if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
        return
      }

      const routeWidth = maxX - minX || 1
      const routeHeight = maxY - minY || 1
      const displayWidth = canvasSize.width
      const displayHeight = canvasSize.height

      // Небольшие safety-отступы сверху и снизу, чтобы маршрут гарантированно
      // не "подлазил" под header и поднятую шторку даже с учётом ореолов/баблов.
      const headerSafeMarginPx = 10
      const bottomSafeMarginPx = 14

      // Базовые инпуты из props для десктопа и горизонтальных отступов.
      let insetTopRaw = visibleInsets?.top ?? 0
      let insetBottomRaw = visibleInsets?.bottom ?? 0
      const insetLeft = visibleInsets?.left ?? 0
      const insetRight = visibleInsets?.right ?? 0

      // На мобиле считаем вертикальные инпуты по фактической высоте хедера и шторки,
      // чтобы автофит всегда опирался на реальное окно между ними и не шёл "на шаг позади".
      if (typeof window !== 'undefined') {
        const vv = window.visualViewport
        const viewportHeightLocal = vv?.height ?? window.innerHeight
        const viewportWidthLocal = vv?.width ?? window.innerWidth
        const isMobileViewport = viewportWidthLocal < 1024

        if (isMobileViewport) {
          const headerEl = document.querySelector<HTMLElement>('.app-header')
          if (headerEl) {
            const r = headerEl.getBoundingClientRect()
            insetTopRaw = Math.max(0, Math.min(r.bottom, viewportHeightLocal))
          }

          const sheetEl = document.querySelector<HTMLElement>('.bottom-sheet')
          if (sheetEl) {
            const r = sheetEl.getBoundingClientRect()
            // Всё, что ниже верха шторки, считаем перекрытой областью.
            insetBottomRaw = Math.max(0, viewportHeightLocal - Math.max(r.top, 0))
          }
        }
      }

      const insetTop = insetTopRaw + headerSafeMarginPx
      const insetBottom = insetBottomRaw + bottomSafeMarginPx

      const visibleWidth = Math.max(50, displayWidth - insetLeft - insetRight)
      const visibleHeight = Math.max(50, displayHeight - insetTop - insetBottom)

      // Адаптивные внутренние отступы для автофита: на маленьком окне
      // уменьшаем вертикальные паддинги сильнее, чтобы маршрут занимал
      // почти всю доступную область между хедером и шторкой.
      const maxPaddingX = visibleWidth / 4
      const maxPaddingY = visibleHeight < 520 ? visibleHeight / 8 : visibleHeight / 4
      const paddingX = Math.min(80, maxPaddingX)
      const paddingY = Math.min(72, maxPaddingY)

      const scaleX = (visibleWidth - paddingX * 2) / routeWidth
      const scaleY = (visibleHeight - paddingY * 2) / routeHeight
      let targetScale = Math.min(scaleX, scaleY) * 0.9
      if (!Number.isFinite(targetScale) || targetScale <= 0) {
        targetScale = MIN_SCALE
      }
      targetScale = Math.max(MIN_SCALE, Math.min(ROUTE_AUTO_FIT_MAX_SCALE, targetScale))

      const centerWorldX = (minX + maxX) / 2
      const centerWorldY = (minY + maxY) / 2

      const screenCenterX = displayWidth / 2
      const screenCenterY = displayHeight / 2
      const visibleCenterX = insetLeft + visibleWidth / 2
      const visibleCenterY = insetTop + visibleHeight / 2

      const offsetX = visibleCenterX - screenCenterX - centerWorldX * targetScale
      const offsetY = visibleCenterY - screenCenterY - centerWorldY * targetScale

      setViewport({
        scale: targetScale,
        offsetX,
        offsetY,
      })

      const routeKey = Array.from(routeStationIdSet).join(',')
      const insetKey = `${insetTop}|${insetRight}|${insetBottom}|${insetLeft}`
      lastRouteFitRef.current = { routeKey, bottomInset: insetBottom, insetKey }
    }

    if (typeof window !== 'undefined') {
      rafId = window.requestAnimationFrame(computeAutoFit)
    } else {
      computeAutoFit()
    }

    return () => {
      if (rafId != null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(rafId)
      }
    }
  }, [
    routeStationIdSet,
    canvasSize,
    worldBounds,
    positionedById,
    visibleInsets,
    editMode,
    routeSheetOpen,
  ])

  useEffect(() => {
    if (editMode) return
    if (!canvasSize.width || !canvasSize.height) return
    if (!worldBounds) return
    if (routeStationIdSet.size > 0) return

    const name = selectionMode === 'from' ? fromStationName : toStationName
    const q = name?.trim().toLowerCase()
    if (!q) return

    const targetStation = positionedStations.find((st) => st.title.toLowerCase() === q)
    if (!targetStation) return

    const displayWidth = canvasSize.width
    const displayHeight = canvasSize.height

    const insetTop = visibleInsets?.top ?? 0
    const insetRight = visibleInsets?.right ?? 0
    const insetBottom = visibleInsets?.bottom ?? 0
    const insetLeft = visibleInsets?.left ?? 0

    const visibleWidth = Math.max(50, displayWidth - insetLeft - insetRight)
    const visibleHeight = Math.max(50, displayHeight - insetTop - insetBottom)

    const screenCenterX = displayWidth / 2
    const screenCenterY = displayHeight / 2
    const visibleCenterX = insetLeft + visibleWidth / 2
    const visibleCenterY = insetTop + visibleHeight / 2

    setViewport((prev) => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale || 1))
      const centerWorldX = targetStation.x
      const centerWorldY = targetStation.y
      const offsetX = visibleCenterX - screenCenterX - centerWorldX * scale
      const offsetY = visibleCenterY - screenCenterY - centerWorldY * scale
      return {
        scale,
        offsetX,
        offsetY,
      }
    })
  }, [
    selectionMode,
    fromStationName,
    toStationName,
    routeStationIdSet,
    canvasSize,
    worldBounds,
    positionedStations,
    visibleInsets,
    clampViewport,
    editMode,
  ])

  const zoomBy = (factor: number) => {
    setViewport((prev) => {
      const currentScale = prev.scale
      let nextScale = currentScale * factor
      nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale))
      if (nextScale === currentScale) return prev

      const centerWorldX = -prev.offsetX / currentScale
      const centerWorldY = -prev.offsetY / currentScale

      return clampViewport({
        scale: nextScale,
        offsetX: -centerWorldX * nextScale,
        offsetY: -centerWorldY * nextScale,
      })
    })
  }

  const zoomByAroundPoint = (factor: number, clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const centerX = rect.width / 2
    const centerY = rect.height / 2
    const xScreen = clientX - rect.left
    const yScreen = clientY - rect.top

    setViewport((prev) => {
      const currentScale = prev.scale
      let nextScale = currentScale * factor
      nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale))
      if (nextScale === currentScale) return prev

      const worldX = (xScreen - (centerX + prev.offsetX)) / currentScale
      const worldY = (yScreen - (centerY + prev.offsetY)) / currentScale

      const nextOffsetX = xScreen - centerX - worldX * nextScale
      const nextOffsetY = yScreen - centerY - worldY * nextScale

      return clampViewport({
        scale: nextScale,
        offsetX: nextOffsetX,
        offsetY: nextOffsetY,
      })
    })
  }

  const stopZoomClickAnimation = () => {
    if (zoomClickAnimRafRef.current != null) {
      cancelAnimationFrame(zoomClickAnimRafRef.current)
      zoomClickAnimRafRef.current = null
    }
  }

  const stepZoomHold = () => {
    if (zoomHoldDirectionRef.current === 0) {
      zoomHoldRafRef.current = null
      return
    }

    // Непрерывный зум по удержанию: небольшой шаг, чтобы движение было плавным и не слишком быстрым.
    const factorPerFrame = zoomHoldDirectionRef.current === 1 ? 1.005 : 1 / 1.005
    zoomBy(factorPerFrame)

    zoomHoldRafRef.current = requestAnimationFrame(stepZoomHold)
  }

  const startZoomHold = (direction: 1 | -1) => {
    zoomHoldDirectionRef.current = direction
    if (zoomHoldRafRef.current == null) {
      zoomHoldRafRef.current = requestAnimationFrame(stepZoomHold)
    }
  }

  const stopZoomHold = () => {
    zoomHoldDirectionRef.current = 0
    if (zoomHoldRafRef.current != null) {
      cancelAnimationFrame(zoomHoldRafRef.current)
      zoomHoldRafRef.current = null
    }
  }

  const clearZoomHoldTimeout = () => {
    if (zoomHoldTimeoutRef.current != null) {
      window.clearTimeout(zoomHoldTimeoutRef.current)
      zoomHoldTimeoutRef.current = null
    }
  }

  const scheduleZoomHold = (direction: 1 | -1) => {
    clearZoomHoldTimeout()
    zoomSuppressClickRef.current = false
    zoomHoldTimeoutRef.current = window.setTimeout(() => {
      zoomHoldTimeoutRef.current = null
      zoomSuppressClickRef.current = true
      startZoomHold(direction)
    }, 180)
  }

  const startZoomClickAnimation = (totalFactor: number) => {
    stopZoomClickAnimation()

    const duration = 280
    const startTime = performance.now()
    let lastEased = 0

    const step = (timestamp: number) => {
      const elapsed = timestamp - startTime
      const t = Math.min(1, elapsed / duration)
      const eased = 1 - (1 - t) * (1 - t) * (1 - t) // ease-out-cubic
      const delta = eased - lastEased

      if (delta > 0) {
        const frameFactor = Math.pow(totalFactor, delta)
        zoomBy(frameFactor)
        lastEased = eased
      }

      if (t < 1) {
        zoomClickAnimRafRef.current = requestAnimationFrame(step)
      } else {
        zoomClickAnimRafRef.current = null
      }
    }

    zoomClickAnimRafRef.current = requestAnimationFrame(step)
  }

  const startZoomClickAnimationAtPoint = (
    totalFactor: number,
    clientX: number,
    clientY: number,
  ) => {
    stopZoomClickAnimation()

    const duration = 280
    const startTime = performance.now()
    let lastEased = 0

    const step = (timestamp: number) => {
      const elapsed = timestamp - startTime
      const t = Math.min(1, elapsed / duration)
      const eased = 1 - (1 - t) * (1 - t) * (1 - t) // ease-out-cubic
      const delta = eased - lastEased

      if (delta > 0) {
        const frameFactor = Math.pow(totalFactor, delta)
        zoomByAroundPoint(frameFactor, clientX, clientY)
        lastEased = eased
      }

      if (t < 1) {
        zoomClickAnimRafRef.current = requestAnimationFrame(step)
      } else {
        zoomClickAnimRafRef.current = null
      }
    }

    zoomClickAnimRafRef.current = requestAnimationFrame(step)
  }

  const getWorldPointFromMouse = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    if (!canvas) return null

    const rect = canvas.getBoundingClientRect()
    const centerX = rect.width / 2
    const centerY = rect.height / 2

    const xScreen = event.clientX - rect.left
    const yScreen = event.clientY - rect.top

    const sx = xScreen - (centerX + viewport.offsetX)
    const sy = yScreen - (centerY + viewport.offsetY)

    const worldX = sx / viewport.scale
    const worldY = sy / viewport.scale
    return { x: worldX, y: worldY }
  }

  const hitTestStationAtWorldPoint = (
    worldX: number,
    worldY: number,
  ): PositionedStation | null => {
    const HIT_RADIUS = 12
    let closest: PositionedStation | null = null
    let minDistSq = HIT_RADIUS * HIT_RADIUS

    for (const st of positionedStations) {
      const dx = worldX - st.x
      const dy = worldY - st.y
      const distSq = dx * dx + dy * dy
      if (distSq <= minDistSq) {
        minDistSq = distSq
        closest = st
      }
    }

    return closest
  }

  // Подгоняем схему под доступный размер Canvas один раз при инициализации:
  // центрируем и масштабируем так, чтобы вся сеть влезла в экран с небольшим отступом.
  useEffect(() => {
    if (!worldBounds) return

    const { width: displayWidth, height: displayHeight } = canvasSize
    if (!displayWidth || !displayHeight) return
    if (hasInitialViewport) return

    const worldWidth = worldBounds.width
    const worldHeight = worldBounds.height
    const padding = 160

    const scaleX = (displayWidth - padding * 2) / worldWidth
    const scaleY = (displayHeight - padding * 2) / worldHeight
    const baseScale = Math.min(scaleX, scaleY)
    if (!Number.isFinite(baseScale) || baseScale <= 0) return

    const initialScale = Math.min(MAX_SCALE, Math.max(baseScale, INITIAL_PREFERRED_SCALE))

    const headerInsetPx = Math.min(120, displayHeight * 0.16)
    const bottomInsetPx = Math.min(320, displayHeight * 0.35)
    const insetTop = headerInsetPx
    const insetBottom = bottomInsetPx
    const insetLeft = 0
    const insetRight = 0

    const visibleWidth = Math.max(50, displayWidth - insetLeft - insetRight)
    const visibleHeight = Math.max(50, displayHeight - insetTop - insetBottom)

    const screenCenterX = displayWidth / 2
    const screenCenterY = displayHeight / 2
    const visibleCenterX = insetLeft + visibleWidth / 2
    const visibleCenterY = insetTop + visibleHeight / 2

    const centerWorldX = teatralnayaWorld ? teatralnayaWorld.x : worldBounds.centerX
    const centerWorldY = teatralnayaWorld ? teatralnayaWorld.y : worldBounds.centerY

    const offsetX = visibleCenterX - screenCenterX - centerWorldX * initialScale
    const offsetY = visibleCenterY - screenCenterY - centerWorldY * initialScale

    setViewport(
      clampViewport({
        scale: initialScale,
        offsetX,
        offsetY,
      }),
    )
    setHasInitialViewport(true)
    if (!initialViewportReportedRef.current && onInitialViewportReady) {
      initialViewportReportedRef.current = true
      onInitialViewportReady()
    }
  }, [worldBounds, canvasSize, hasInitialViewport, clampViewport, teatralnayaWorld])

  // Перерисовка схемы при изменении вьюпорта или подсветки
  useEffect(() => {
    if (!canvasSize.width || !canvasSize.height) return
    const canvas = canvasRef.current
    const labelCanvas = labelCanvasRef.current
    if (!canvas || !labelCanvas) return
    const ctx = canvas.getContext('2d')
    const labelCtx = labelCanvas.getContext('2d')
    if (!ctx || !labelCtx) return

    const now = animationTick || performance.now()

    const dpr = window.devicePixelRatio || 1

    const displayWidth = canvasSize.width || viewBoxSize
    const displayHeight = canvasSize.height || viewBoxSize

    // Подгоняем внутренний размер Canvas под CSS и DPR
    const targetWidth = Math.round(displayWidth * dpr)
    const targetHeight = Math.round(displayHeight * dpr)
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth
      canvas.height = targetHeight
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.imageSmoothingEnabled = true
        // high-quality сглаживание для отрисованных элементов
        // (Safari/WebKit игнорирует часть значений, но не портит поведение)
        ;(ctx as CanvasRenderingContext2D & { imageSmoothingQuality?: 'low' | 'medium' | 'high' })
          .imageSmoothingQuality = 'high'
      }
    }
    if (labelCanvas.width !== targetWidth || labelCanvas.height !== targetHeight) {
      labelCanvas.width = targetWidth
      labelCanvas.height = targetHeight
      const labelCtx = labelCanvas.getContext('2d')
      if (labelCtx) {
        labelCtx.imageSmoothingEnabled = true
        ;(
          labelCtx as CanvasRenderingContext2D & {
            imageSmoothingQuality?: 'low' | 'medium' | 'high'
          }
        ).imageSmoothingQuality = 'high'
      }
    }

    // Единицы рисования в CSS-пикселях
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, displayWidth, displayHeight)

    labelCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    labelCtx.clearRect(0, 0, displayWidth, displayHeight)

    const centerX = displayWidth / 2
    const centerY = displayHeight / 2

    ctx.save()
    ctx.translate(centerX + viewport.offsetX, centerY + viewport.offsetY)
    ctx.scale(viewport.scale, viewport.scale)

    const zoom = viewport.scale || 1
    const clampedZoom = Math.min(Math.max(zoom, 0.7), 2.2)
    const zoomT = (clampedZoom - 0.7) / (2.2 - 0.7)
    const stationScale = 0.95 + zoomT * 0.45
    const stationRadius = STATION_RADIUS * stationScale
    const stationSelectedRadius = STATION_SELECTED_RADIUS * stationScale

    const shouldDrawFarTransfers = zoom >= FAR_TRANSFERS_MIN_ZOOM
    const shouldDrawHubGroups = zoom >= HUB_GROUPS_MIN_ZOOM

    // Подписи рисуются в мировых координатах фиксированным размером,
    // чтобы при зуме их положение и относительный размер к схеме оставались стабильными.
    const labelFontPx = LABEL_BASE_FONT_PX

    const hasRoute = routeEdgeKeySet.size > 0 || routeStationIdSet.size > 0

    const rootStyle = window.getComputedStyle(document.documentElement)
    const strongLabelColor =
      rootStyle.getPropertyValue('--map-label-color-strong').trim() || LABEL_TEXT_COLOR
    const weakLabelColor =
      rootStyle.getPropertyValue('--map-label-color-weak').trim() || LABEL_TEXT_COLOR
    const lineHaloColor =
      rootStyle.getPropertyValue('--map-line-halo-color').trim() || 'rgba(249, 250, 251, 0.96)'
    const stationFillColor =
      rootStyle.getPropertyValue('--map-station-fill').trim() || STATION_FILL_COLOR
    const routeFallbackColor =
      rootStyle.getPropertyValue('--map-route-fallback-color').trim() || '#ec4899'
    const endpointColorA =
      rootStyle.getPropertyValue('--map-endpoint-a').trim() || '#22c1b4'
    const endpointColorB =
      rootStyle.getPropertyValue('--map-endpoint-b').trim() || '#ef4444'

    // Общие коридоры: используем уже подготовленный кеш, чтобы знать, какие рёбра делят несколько линий.
    const { corridorEdgeUsage, corridorEdgeKey } = corridorEdgeData

    // Линии (базовый слой) — с учётом общих коридоров: параллельные смещения для общих рёбер.
    for (const line of fullGraphLines) {
      const ids = line.stationIds.filter((sid) => positionedById.has(sid))
      if (ids.length < 2) continue

      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      const isRing = RING_LINE_IDS.has(line.id)
      const baseWidth = isRing ? BASE_RING_LINE_WIDTH : BASE_LINE_WIDTH
      const baseAlpha = hasRoute ? BASE_LINE_ALPHA_WITH_ROUTE : BASE_LINE_ALPHA_NO_ROUTE

      const segmentCount = isRing ? ids.length : ids.length - 1

      for (let i = 0; i < segmentCount; i += 1) {
        const aId = ids[i]
        const bId = ids[(i + 1) % ids.length]
        const a = positionedById.get(aId)
        const b = positionedById.get(bId)
        if (!a || !b) continue

        const key = corridorEdgeKey(aId, bId)
        const usage = corridorEdgeUsage.get(key)

        let offsetX = 0
        let offsetY = 0

        if (usage && usage.lineIds.length > 1) {
          const dx = b.x - a.x
          const dy = b.y - a.y
          const len = Math.sqrt(dx * dx + dy * dy)
          if (len > 1e-3) {
            const nx = -dy / len
            const ny = dx / len
            const index = usage.lineIds.indexOf(line.id)
            if (index !== -1) {
              const nLines = usage.lineIds.length
              const offsetIndex = index - (nLines - 1) / 2
              const corridorOffsetWorld = 3
              offsetX = nx * corridorOffsetWorld * offsetIndex
              offsetY = ny * corridorOffsetWorld * offsetIndex
            }
          }
        }

        // Светлый halo-подслой под основной линией
        ctx.save()
        ctx.strokeStyle = lineHaloColor
        ctx.lineWidth = baseWidth + 2.4
        ctx.globalAlpha = Math.min(1, baseAlpha * 1.35)
        ctx.beginPath()
        ctx.moveTo(a.x + offsetX, a.y + offsetY)
        ctx.lineTo(b.x + offsetX, b.y + offsetY)
        ctx.stroke()
        ctx.restore()

        // Основная цветная линия
        ctx.strokeStyle = line.colorHex
        ctx.lineWidth = baseWidth
        ctx.globalAlpha = baseAlpha
        ctx.beginPath()
        ctx.moveTo(a.x + offsetX, a.y + offsetY)
        ctx.lineTo(b.x + offsetX, b.y + offsetY)
        ctx.stroke()
      }
    }


    // Подсветка маршрута поверх базовых линий (по рёбрам маршрута)
    if (routeEdgeKeySet.size > 0) {
      let routePulseScale = 1
      let routeShadowExtra = 0

      if (routePulseRef.current) {
        const elapsed = now - routePulseRef.current.startedAt
        if (elapsed > 0 && elapsed < ROUTE_PULSE_DURATION_MS) {
          const t = elapsed / ROUTE_PULSE_DURATION_MS
          const eased = 1 - (1 - t) * (1 - t)
          routePulseScale = 1 + 0.14 * (1 - t)
          routeShadowExtra = 5 * eased
        }
      }

      ctx.save()
      ctx.shadowColor = 'rgba(236, 72, 153, 0.45)'
      ctx.shadowBlur = 8 + routeShadowExtra
      const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

      const lineRouteEdgeSet = new Set<string>()

      for (const line of fullGraphLines) {
        const ids = line.stationIds
        if (ids.length < 2) continue
        const isRing = RING_LINE_IDS.has(line.id)
        const segmentCount = isRing ? ids.length : ids.length - 1

        ctx.strokeStyle = line.colorHex
        ctx.lineWidth = ROUTE_LINE_WIDTH * routePulseScale
        ctx.globalAlpha = ROUTE_LINE_ALPHA
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()

        let inSegment = false

        for (let i = 0; i < segmentCount; i += 1) {
          const aId = ids[i]
          const bId = ids[(i + 1) % ids.length]
          const a = positionedById.get(aId)!
          const b = positionedById.get(bId)!
          const key = edgeKey(aId, bId)
          const inRoute = routeEdgeKeySet.has(key)
          if (inRoute) {
            lineRouteEdgeSet.add(key)
            if (!inSegment) {
              ctx.moveTo(a.x, a.y)
              inSegment = true
            }
            ctx.lineTo(b.x, b.y)
          } else if (inSegment) {
            ctx.stroke()
            ctx.beginPath()
            inSegment = false
          }
        }

        if (inSegment) {
          ctx.stroke()
        }
      }

      // Дополнительные участки маршрута, которые не лежат на последовательностях станций линий
      // (например, ручные рёбра между станциями) — рисуем отдельными отрезками.
      if (routeEdgeKeySet.size > 0) {
        ctx.lineWidth = ROUTE_LINE_WIDTH * routePulseScale
        ctx.globalAlpha = ROUTE_LINE_ALPHA
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'

        for (const key of routeEdgeKeySet) {
          if (lineRouteEdgeSet.has(key)) continue
          const [aId, bId] = key.split('|')
          const a = positionedById.get(aId)
          const b = positionedById.get(bId)
          if (!a || !b) continue

          const sameColor = a.lineColor && a.lineColor === b.lineColor
          ctx.strokeStyle = sameColor
            ? a.lineColor
            : a.lineColor || b.lineColor || routeFallbackColor

          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }
      }

      ctx.restore()

      // Дополнительная подсветка длинных пересадок, входящих в маршрут:
      // рисуем поверх общих far-переходов более яркий пунктир.
      if (shouldDrawFarTransfers && routeLongTransferEdgeKeySet.size > 0) {
        ctx.save()
        ctx.setLineDash([6, 5])
        ctx.lineWidth = ROUTE_LINE_WIDTH * 0.7
        ctx.strokeStyle = 'rgba(236, 72, 153, 0.98)'
        ctx.globalAlpha = 1

        const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

        for (const e of fullGraphEdges) {
          if (!e.isTransfer) continue
          const key = edgeKey(e.fromStationId, e.toStationId)
          if (!routeLongTransferEdgeKeySet.has(key)) continue

        const a = positionedById.get(e.fromStationId)
        const b = positionedById.get(e.toStationId)
        if (!a || !b) continue

        // Не подсвечиваем пересадки внутри одного хаба (near-хабы).
        const aHub = a.hubId
        const bHub = b.hubId
        if (aHub && bHub && aHub === bHub) continue

          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }

        ctx.setLineDash([])
        ctx.restore()
      }
    }

    // Близкие пересадки (near hubs) — мягкие кластеры для групп станций с общим hubId

    const drawRoundedRect = (
      context: CanvasRenderingContext2D,
      x: number,
      y: number,
      w: number,
      h: number,
      r: number,
    ) => {
      const radius = Math.min(r, w / 2, h / 2)
      context.beginPath()
      context.moveTo(x + radius, y)
      context.lineTo(x + w - radius, y)
      context.quadraticCurveTo(x + w, y, x + w, y + radius)
      context.lineTo(x + w, y + h - radius)
      context.quadraticCurveTo(x + w, y + h, x + w - radius, y + h)
      context.lineTo(x + radius, y + h)
      context.quadraticCurveTo(x, y + h, x, y + h - radius)
      context.lineTo(x, y + radius)
      context.quadraticCurveTo(x, y, x + radius, y)
      context.closePath()
    }

    if (shouldDrawHubGroups && hubGroups.size > 0) {
      ctx.save()
      for (const group of hubGroups.values()) {
        if (group.length < 2) continue

        let minX = Infinity
        let maxX = -Infinity
        let minY = Infinity
        let maxY = -Infinity
        for (const st of group) {
          if (st.x < minX) minX = st.x
          if (st.x > maxX) maxX = st.x
          if (st.y < minY) minY = st.y
          if (st.y > maxY) maxY = st.y
        }
        if (
          !Number.isFinite(minX) ||
          !Number.isFinite(maxX) ||
          !Number.isFinite(minY) ||
          !Number.isFinite(maxY)
        ) {
          continue
        }

        const pad = stationRadius * 1.6
        const w = maxX - minX + pad * 2
        const h = maxY - minY + pad * 2
        const x = minX - pad
        const y = minY - pad

        const size = group.length
        const baseRadius = Math.min(w, h) / 2.8
        const cornerRadius =
          size === 2 ? baseRadius : size === 3 ? baseRadius * 0.8 : baseRadius * 0.6

        ctx.globalAlpha = 0
        ctx.fillStyle = 'rgba(244, 114, 182, 0.35)'
        drawRoundedRect(ctx, x, y, w, h, cornerRadius)

        ctx.globalAlpha = 0
        ctx.strokeStyle = 'rgba(244, 114, 182, 0.65)'
        ctx.lineWidth = 0.8
        drawRoundedRect(ctx, x, y, w, h, cornerRadius)
      }
      ctx.restore()
    }

    // Пироговые иконки пересадочных хабов: один центр на hubId и секторы по цветам линий.
    // Угол сектора выравниваем по направлению на станции соответствующей линии,
    // чтобы кружки оказывались примерно в середине своей цветной дуги.
    if (shouldDrawHubGroups && hubGroups.size > 0) {
      ctx.save()
      const basePieRadius = stationRadius * 1.7
      const innerPieRadius = stationRadius * 0.95

      for (const group of hubGroups.values()) {
        if (!group || group.length === 0) continue

        const isActiveHub =
          !hasRoute || group.some((st) => routeStationIdSet.has(st.id))
        const hubVisibility = !hasRoute ? 1 : isActiveHub ? 1 : HUB_DIM_ALPHA_WHEN_ROUTE

        let cx = 0
        let cy = 0
        for (const st of group) {
          cx += st.x
          cy += st.y
        }
        const groupCount = group.length
        if (groupCount === 0) continue
        cx /= groupCount
        cy /= groupCount

        // Для каждой линии/цвета накапливаем усреднённый угол направления на станции.
        const colorStats = new Map<string, { sx: number; sy: number }>()
        for (const st of group) {
          const color = st.lineColor
          if (!color) continue

          const dx = st.x - cx
          const dy = st.y - cy
          const r = Math.hypot(dx, dy)
          if (!r) continue

          const ang = Math.atan2(dy, dx)
          let acc = colorStats.get(color)
          if (!acc) {
            acc = { sx: 0, sy: 0 }
            colorStats.set(color, acc)
          }
          acc.sx += Math.cos(ang)
          acc.sy += Math.sin(ang)
        }

        const colorsWithAngle: { color: string; angle: number }[] = []
        for (const [color, acc] of colorStats.entries()) {
          const angle = Math.atan2(acc.sy, acc.sx)
          colorsWithAngle.push({ color, angle })
        }
        if (colorsWithAngle.length === 0) continue

        colorsWithAngle.sort((a, b) => a.angle - b.angle)

        const outerRadius = basePieRadius
        const innerRadius = innerPieRadius
        const sectorAngle = (Math.PI * 2) / colorsWithAngle.length

        // Выбираем базовый старт так, чтобы центр первого сектора совпадал с его целевым углом.
        let startAngle = colorsWithAngle[0].angle - sectorAngle / 2

        const haloRadius = outerRadius * HUB_PIE_HALO_RADIUS_MULT
        ctx.globalAlpha = HUB_PIE_HALO_ALPHA * hubVisibility
        ctx.beginPath()
        ctx.arc(cx, cy, haloRadius, 0, Math.PI * 2)
        ctx.fillStyle = lineHaloColor
        ctx.fill()

        ctx.globalAlpha = HUB_PIE_BASE_ALPHA * hubVisibility

        const routeColors = new Set<string>()
        if (hasRoute) {
          for (const st of group) {
            if (routeStationIdSet.has(st.id) && st.lineColor) {
              routeColors.add(st.lineColor)
            }
          }
        }
        const hasRouteColors = hasRoute && routeColors.size > 0

        for (const { color } of colorsWithAngle) {
          const endAngle = startAngle + sectorAngle
          ctx.beginPath()
          ctx.moveTo(cx, cy)
          ctx.arc(cx, cy, outerRadius, startAngle, endAngle)
          ctx.closePath()

          if (hasRouteColors) {
            if (routeColors.has(color)) {
              ctx.globalAlpha = HUB_PIE_BASE_ALPHA * hubVisibility
              ctx.fillStyle = color
            } else {
              ctx.globalAlpha = HUB_PIE_BASE_ALPHA * hubVisibility * HUB_DIM_ALPHA_WHEN_ROUTE
              ctx.fillStyle = color
            }
          } else {
            ctx.globalAlpha = HUB_PIE_BASE_ALPHA * hubVisibility
            ctx.fillStyle = color
          }

          ctx.fill()
          startAngle = endAngle
        }

        ctx.globalAlpha = hubVisibility
        ctx.beginPath()
        ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2)
        ctx.fillStyle = stationFillColor
        ctx.fill()

        ctx.beginPath()
        ctx.arc(cx, cy, outerRadius, 0, Math.PI * 2)
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.16)'
        ctx.lineWidth = 1.4
        ctx.stroke()
      }

      ctx.restore()
    }

    // Дальние пересадки (far transfers) — розовый пунктир между станциями.
    // Используем transferKind, чтобы не рисовать служебные/внутрихабовые рёбра.
    if (shouldDrawFarTransfers) {
      ctx.save()
      ctx.setLineDash([4, 8])
      ctx.lineWidth = 0.9
      ctx.strokeStyle = 'rgba(236, 72, 153, 0.4)'
      for (const e of fullGraphEdges) {
        if (!e.isTransfer) continue

        const kind = e.transferKind
        if (kind === 'near' || kind === 'ignored') continue

        const a = positionedById.get(e.fromStationId)
        const b = positionedById.get(e.toStationId)
        if (!a || !b) continue

        const aHub = a.hubId
        const bHub = b.hubId

        // Если тип явно не задан, фильтруем по hubId, чтобы не рисовать
        // внутренние связи одного хаба.
        if (!kind && aHub && bHub && aHub === bHub) {
          continue
        }

        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }

      ctx.restore()
    }

    // Станции: базовые кружки поверх линий/пересадок
    ctx.globalAlpha = 1
    for (const st of positionedStations) {
      ctx.save()

      const isFrom =
        (fromStationId && st.id === fromStationId) ||
        (!fromStationId && fromStationName
          ? st.title.toLowerCase() === fromStationName.toLowerCase()
          : false)
      const isTo =
        (toStationId && st.id === toStationId) ||
        (!toStationId && toStationName
          ? st.title.toLowerCase() === toStationName.toLowerCase()
          : false)
      const isEndpointSelected = !!isFrom || !!isTo
      const isHubStation = st.hubId != null
      const isOnRouteStation = hasRoute && routeStationIdSet.has(st.id)
      const isEditorSelected = selectedStationIdSet.has(st.id)

      let stationAlpha = 1
      if (hasRoute && !isEndpointSelected && !isOnRouteStation && !isEditorSelected) {
        stationAlpha = 0.45
      }
      ctx.globalAlpha = stationAlpha

      // Базовый кружок станции
      const baseRadius =
        isHubStation && shouldDrawHubGroups && !isEndpointSelected ? stationRadius * 0.75 : stationRadius
      const baseBorderWidth = STATION_BORDER_WIDTH
      const effectiveBorderWidth =
        isEditorSelected
          ? baseBorderWidth + 0.8
          : baseBorderWidth

      ctx.beginPath()
      ctx.arc(st.x, st.y, baseRadius, 0, Math.PI * 2)
      ctx.fillStyle = stationFillColor
      ctx.strokeStyle = st.lineColor
      ctx.lineWidth = effectiveBorderWidth
      ctx.fill()
      ctx.stroke()

      // Пульс при клике по станции (feedback для редактора/карты)
      if (clickPulseRef.current && clickPulseRef.current.stationId === st.id) {
        const elapsed = now - clickPulseRef.current.startedAt
        if (elapsed > 0 && elapsed < STATION_CLICK_PULSE_DURATION_MS) {
          const t = elapsed / STATION_CLICK_PULSE_DURATION_MS
          const eased = 1 - (1 - t) * (1 - t)
          const radius = stationSelectedRadius + 4 + eased * 5
          const alpha = (1 - t) * 0.45
          ctx.beginPath()
          ctx.arc(st.x, st.y, radius, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(248, 113, 190, ${alpha.toFixed(3)})`
          ctx.lineWidth = 2
          ctx.stroke()
        }
      }

      ctx.restore()
    }

    ctx.restore()

    // Отдельный Canvas-слой для подписей станций.
    labelCtx.save()
    // Подписи станций: отключаем их в лёгком режиме (pan/wheel-zoom), чтобы разгрузить кадр.
    // При остановке взаимодействия подписи перерисуются одним полным кадром.
    if (positionedStations.length > 0) {
      const labelZoomT = Math.min(
        1,
        Math.max(0, (zoom - MIN_SCALE) / (1.4 - MIN_SCALE || 1)),
      )
      const useWeak = labelZoomT < 0.10
      const labelColor = useWeak ? weakLabelColor : strongLabelColor

      labelCtx.font = `${LABEL_FONT_WEIGHT} ${labelFontPx.toFixed(1)}px ${LABEL_FONT_FAMILY}`
      labelCtx.textBaseline = 'middle'
      labelCtx.fillStyle = labelColor
      labelCtx.globalAlpha = 1
      labelCtx.shadowColor = 'transparent'
      labelCtx.shadowBlur = 0

      // Раскладка подписей зависит только от положения станций и размера шрифта
      // в мировых координатах и не пересчитывается при зуме.
      const isWheelZooming = isWheelZoomingRef.current
      const shouldRecomputeLabelsBase =
        !labelPlacementsRef.current.stationsRef ||
        labelPlacementsRef.current.stationsRef !== positionedStations

      const shouldRecomputeLabels = !isWheelZooming && shouldRecomputeLabelsBase

      if (shouldRecomputeLabels) {
        const segmentsByStationId = new Map<
          string,
          { ax: number; ay: number; bx: number; by: number }[]
        >()

        for (const line of fullGraphLines) {
          const ids = line.stationIds.filter((sid) => positionedById.has(sid))
          if (ids.length < 2) continue

          const isRing = RING_LINE_IDS.has(line.id)
          const segmentCount = isRing ? ids.length : ids.length - 1

          for (let i = 0; i < segmentCount; i += 1) {
            const aId = ids[i]
            const bId = ids[(i + 1) % ids.length]
            const a = positionedById.get(aId)
            const b = positionedById.get(bId)
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

        labelPlacementsRef.current.placements = computeStationLabelPlacements(
          labelCtx,
          positionedStations,
          labelFontPx,
          segmentsByStationId,
        )
        labelPlacementsRef.current.stationsRef = positionedStations
      }

      const labelPlacements = labelPlacementsRef.current.placements
      const shouldShowCollisionDebug = collisionDebug ?? LABEL_COLLISION_DEBUG_DEFAULT

      // Для реальной отрисовки применяем ту же мировую трансформацию,
      // что и для линий/станций.
      labelCtx.save()
      labelCtx.translate(centerX + viewport.offsetX, centerY + viewport.offsetY)
      labelCtx.scale(viewport.scale, viewport.scale)

      const lineHeight = labelFontPx + 2
      const lineSpacing = labelFontPx * 0.25

      for (const placement of labelPlacements) {
        const text = placement.text
        if (!text) continue

        const sx = centerX + viewport.offsetX + placement.x * viewport.scale
        const sy = centerY + viewport.offsetY + placement.y * viewport.scale
        const margin = 80

        if (sx < -margin || sx > displayWidth + margin || sy < -margin || sy > displayHeight + margin) {
          continue
        }

        const importance = placement.importance ?? 0
        const onRoute =
          hasRoute &&
          placement.stationIds &&
          placement.stationIds.some((id) => routeStationIdSet.has(id))

        if (hasRoute) {
          labelCtx.fillStyle = onRoute ? strongLabelColor : weakLabelColor
        } else {
          labelCtx.fillStyle = labelColor
        }

        const baseAlpha = useWeak ? 0.7 : 0.9
        let alpha = Math.min(1, baseAlpha + importance * 0.06)
        if (hasRoute) {
          if (onRoute) {
            alpha = Math.min(1, alpha * 1.12)
          } else {
            alpha *= 0.45
          }
        }
        labelCtx.globalAlpha = alpha

        const lines = placement.lines && placement.lines.length > 0 ? placement.lines : [text]
        const totalHeight =
          lineHeight * lines.length + lineSpacing * Math.max(0, lines.length - 1)
        let currentY = placement.y - totalHeight / 2 + lineHeight / 2

        labelCtx.textAlign = placement.alignRight ? 'right' : 'left'
        for (const ln of lines) {
          if (!ln) {
            currentY += lineHeight + lineSpacing
            continue
          }
          labelCtx.fillText(ln, placement.x, currentY)
          currentY += lineHeight + lineSpacing
        }
      }

      if (shouldShowCollisionDebug) {
        // Прямоугольники ограничивающих рамок подписей.
        labelCtx.lineWidth = 0.7
        labelCtx.strokeStyle = 'rgba(37, 99, 235, 0.7)'
        for (const placement of labelPlacements) {
          const text = placement.text
          if (!text) continue
          const width = placement.width ?? labelCtx.measureText(text).width
          const height = placement.height ?? lineHeight
          const x1 = placement.alignRight ? placement.x - width : placement.x
          const y1 = placement.y - height / 2
          labelCtx.strokeRect(x1, y1, width, height)
        }

        // Приближённые диски вокруг станций, показывающие запретные зоны.
        labelCtx.strokeStyle = 'rgba(220, 38, 38, 0.7)'
        labelCtx.lineWidth = 0.8
        for (const st of positionedStations) {
          const isHub = st.hubId != null
          const baseRadius = isHub ? 14 : 10
          const radius = baseRadius + labelFontPx * 0.45
          labelCtx.beginPath()
          labelCtx.arc(st.x, st.y, radius, 0, Math.PI * 2)
          labelCtx.stroke()
        }
      }

      // Баблы A/B для выбранных конечных станций маршрута поверх всех слоёв,
      // включая подписи
      const endpointBubbleRadius = stationRadius * 2.7
      const endpointPointerLength = stationRadius * 1.4

      const drawEndpointBubbleOnLabels = (st: PositionedStation, label: 'A' | 'B') => {
        const baseColor = st.lineColor || (label === 'A' ? endpointColorA : endpointColorB)
        const cx = st.x
        // Кончик маркера указывает ровно в верхнюю границу кружка станции
        const tipY = st.y - stationRadius
        const r = endpointBubbleRadius
        const cy = tipY - (r + endpointPointerLength)

        labelCtx.save()
        labelCtx.globalAlpha = 1
        labelCtx.beginPath()
        // Круглая "шапка" маркера + небольшой указатель вниз
        labelCtx.moveTo(cx, cy - r)
        // Правая половина окружности до низа
        labelCtx.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, false)
        // Указатель к кончику
        labelCtx.quadraticCurveTo(cx + r * 0.4, cy + r * 1.1, cx, tipY)
        labelCtx.quadraticCurveTo(cx - r * 0.4, cy + r * 1.1, cx, cy + r)
        // Левая половина окружности назад к верху
        labelCtx.arc(cx, cy, r, Math.PI / 2, (3 * Math.PI) / 2, false)
        labelCtx.closePath()

        labelCtx.fillStyle = baseColor
        labelCtx.shadowColor = 'rgba(15, 23, 42, 0.25)'
        labelCtx.shadowBlur = 4
        labelCtx.fill()

        labelCtx.lineWidth = 1.4
        labelCtx.strokeStyle = 'rgba(15, 23, 42, 0.18)'
        labelCtx.stroke()

        labelCtx.shadowColor = 'transparent'
        labelCtx.shadowBlur = 0
        labelCtx.fillStyle = '#ffffff'
        // Для A/B используем более жирный и чуть больший шрифт,
        // чем базовый размер подписей
        labelCtx.font = `600 ${(LABEL_BASE_FONT_PX * 1.08).toFixed(1)}px ${LABEL_FONT_FAMILY}`
        labelCtx.textAlign = 'center'
        labelCtx.textBaseline = 'middle'
        // Смещаем букву чуть ниже геометрического центра круглой "шапки",
        // чтобы визуально она была по центру всего маркера
        const textY = cy + r * 0.05
        labelCtx.fillText(label, cx, textY)
        labelCtx.restore()
      }

      if (fromStationId) {
        const st = positionedById.get(fromStationId)
        if (st) {
          drawEndpointBubbleOnLabels(st, 'A')
        }
      }

      if (toStationId) {
        const st = positionedById.get(toStationId)
        if (st) {
          drawEndpointBubbleOnLabels(st, 'B')
        }
      }

      labelCtx.restore()
    }

    labelCtx.restore()
  }, [
    positionedStations,
    positionedById,
    viewport,
    isPanning,
    hasDragged,
    fromStationName,
    toStationName,
    fromStationId,
    toStationId,
    routeStationIdSet,
    routeEdgeKeySet,
    routeLongTransferEdgeKeySet,
    canvasSize,
    worldBounds,
    hasInitialViewport,
    editMode,
    collisionDebug,
    yandexWorldById,
    animationTick,
    corridorEdgeData,
    hubGroups,
  ])

  // Актуализируем внутренний размер при ресайзе окна / изменении доступного места
  useEffect(() => {
    const updateSize = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      setCanvasSize((prev) => {
        if (prev.width === rect.width && prev.height === rect.height) return prev
        return { width: rect.width, height: rect.height }
      })
    }

    updateSize()
    window.addEventListener('resize', updateSize)
    return () => window.removeEventListener('resize', updateSize)
  }, [])

  const stopPanInertia = () => {
    if (panInertiaRafRef.current != null) {
      cancelAnimationFrame(panInertiaRafRef.current)
      panInertiaRafRef.current = null
    }
  }

  const startPanInertia = () => {
    const { vx, vy } = panVelocityRef.current
    let speed = Math.hypot(vx, vy)
    const maxStartSpeed = 1.5
    const minStartSpeed = 0.01
    const minStopSpeed = 0.004

    // Ограничиваем только совсем экстремальные рывки, но оставляем широкий диапазон
    // для нормальных скоростей, чтобы длина инерции почти линейно зависела от speed.
    if (speed > maxStartSpeed) {
      const scale = maxStartSpeed / speed
      panVelocityRef.current = { vx: vx * scale, vy: vy * scale }
      speed = maxStartSpeed
    }

    // Для очень медленных жестов даём небольшой boost, чтобы эффект был заметен,
    // но жесты средней и высокой скорости не прижимаем к одному значению.
    if (speed > 0 && speed < minStartSpeed) {
      const scale = minStartSpeed / speed
      panVelocityRef.current = { vx: vx * scale, vy: vy * scale }
      speed = minStartSpeed
    }
    if (speed === 0) return

    stopPanInertia()

    if (wheelRafRef.current != null) {
      cancelAnimationFrame(wheelRafRef.current)
      wheelRafRef.current = null
    }

    let lastTime: number | null = null
    const friction = 0.003

    const step = (now: number) => {
      if (lastTime == null) {
        lastTime = now
        panInertiaRafRef.current = requestAnimationFrame(step)
        return
      }

      const dt = Math.min(now - lastTime, 32)
      lastTime = now

      const current = panVelocityRef.current
      const currentSpeed = Math.hypot(current.vx, current.vy)
      if (dt <= 0 || currentSpeed < minStopSpeed) {
        stopPanInertia()
        return
      }

      const decay = Math.exp(-friction * dt)
      const vxNext = current.vx * decay
      const vyNext = current.vy * decay
      panVelocityRef.current = { vx: vxNext, vy: vyNext }

      const dx = vxNext * dt
      const dy = vyNext * dt

      viewportRef.current = clampViewport({
        ...viewportRef.current,
        offsetX: viewportRef.current.offsetX + dx,
        offsetY: viewportRef.current.offsetY + dy,
      })
      setViewport(viewportRef.current)

      const nextSpeed = Math.hypot(vxNext, vyNext)
      if (nextSpeed < minStopSpeed) {
        stopPanInertia()
        return
      }

      panInertiaRafRef.current = requestAnimationFrame(step)
    }

    panInertiaRafRef.current = requestAnimationFrame(step)
  }

  const scheduleViewportCommit = () => {
    if (wheelRafRef.current != null) return
    wheelRafRef.current = requestAnimationFrame(() => {
      wheelRafRef.current = null
      setViewport(viewportRef.current)
    })
  }

  const handleWheel: React.WheelEventHandler<HTMLCanvasElement> = (event) => {
    if (interactionsLocked && !editMode) return
    if (onMapInteraction) onMapInteraction()
    const delta = -event.deltaY
    const zoomFactor = delta > 0 ? 1.1 : 0.9

    const canvas = canvasRef.current
    if (!canvas) return

    // Помечаем фазу активного wheel-зума: во время неё рендерим в лёгком режиме
    isWheelZoomingRef.current = true
    if (wheelStopTimeoutRef.current != null) {
      window.clearTimeout(wheelStopTimeoutRef.current)
      wheelStopTimeoutRef.current = null
    }

    const current = viewportRef.current
    const currentScale = current.scale
    let nextScale = currentScale * zoomFactor
    nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale))
    if (nextScale === currentScale) return

    const rect = canvas.getBoundingClientRect()
    const centerX = rect.width / 2
    const centerY = rect.height / 2
    const xScreen = event.clientX - rect.left
    const yScreen = event.clientY - rect.top

    // Помечаем фазу активного wheel-зума: во время неё рендерим в лёгком режиме
    const worldX = (xScreen - (centerX + current.offsetX)) / currentScale
    const worldY = (yScreen - (centerY + current.offsetY)) / currentScale

    const nextOffsetX = xScreen - centerX - worldX * nextScale
    const nextOffsetY = yScreen - centerY - worldY * nextScale

    viewportRef.current = clampViewport({
      scale: nextScale,
      offsetX: nextOffsetX,
      offsetY: nextOffsetY,
    })

    scheduleViewportCommit()

    wheelStopTimeoutRef.current = window.setTimeout(() => {
      isWheelZoomingRef.current = false
      // Один полный кадр после остановки скролла, чтобы пересчитать подписи/слои
      setAnimationTick(performance.now())
    }, 120)
  }

  const handleZoomIn = () => {
    if (interactionsLocked && !editMode) return
    if (onMapInteraction) onMapInteraction()
    scheduleZoomHold(1)
  }

  const handleZoomOut = () => {
    if (interactionsLocked && !editMode) return
    if (onMapInteraction) onMapInteraction()
    scheduleZoomHold(-1 as 1 | -1)
  }

  const handleMouseDown: React.MouseEventHandler<HTMLCanvasElement> = (event) => {
    if (interactionsLocked) return
    stopPanInertia()
    panVelocityRef.current = { vx: 0, vy: 0 }
    panLastSampleTimeRef.current = performance.now()
    if (onMapInteraction) onMapInteraction()
    if (editMode) {
      const world = getWorldPointFromMouse(event)
      if (world) {
        const hit = hitTestStationAtWorldPoint(world.x, world.y)
        if (hit) {
          setHasDragged(false)

          const isMeta = event.metaKey || event.ctrlKey
          const isShift = event.shiftKey

          const nextSelection = new Set<string>(selectedStationIds)

          if (isMeta) {
            if (nextSelection.has(hit.id)) nextSelection.delete(hit.id)
            else nextSelection.add(hit.id)
          } else if (isShift && selectionAnchorId) {
            const anchor = positionedById.get(selectionAnchorId)
            const target = hit
            if (anchor && target && typeof anchor.lineId === 'number' && anchor.lineId === target.lineId) {
              const line = fullGraphLines.find((l) => l.id === anchor.lineId)
              if (line) {
                const ids = line.stationIds
                const startIndex = ids.indexOf(anchor.id)
                const endIndex = ids.indexOf(target.id)
                if (startIndex >= 0 && endIndex >= 0) {
                  const from = Math.min(startIndex, endIndex)
                  const to = Math.max(startIndex, endIndex)
                  for (let i = from; i <= to; i += 1) {
                    nextSelection.add(ids[i])
                  }
                } else {
                  nextSelection.add(hit.id)
                }
              } else {
                nextSelection.add(hit.id)
              }
            } else {
              nextSelection.add(hit.id)
            }
          } else {
            nextSelection.clear()
            const idsForHit: string[] =
              hit.hubId != null
                ? positionedStations.filter((st) => st.hubId === hit.hubId).map((st) => st.id)
                : [hit.id]
            for (const id of idsForHit) {
              nextSelection.add(id)
            }
          }

          let idsToDrag = Array.from(nextSelection)
          if (idsToDrag.length === 0) {
            idsToDrag = [hit.id]
            nextSelection.add(hit.id)
          }

          setSelectedStationIds(idsToDrag)
          setSelectionAnchorId(hit.id)

          const initialPositions: Record<string, { x: number; y: number }> = {}
          for (const id of idsToDrag) {
            const st = positionedById.get(id)
            if (st) {
              initialPositions[id] = { x: st.x, y: st.y }
            }
          }

          setDragStationIds(idsToDrag)
          dragInitialPositionsRef.current = initialPositions
          dragStartWorldRef.current = world
          return
        }
      }
    }

    // Если не редактируем или не попали по станции — обычный pan
    setIsPanning(true)
    lastPointRef.current = { x: event.clientX, y: event.clientY }
    panLastSampleTimeRef.current = null
    setHasDragged(false)
  }

  const handleMouseMove: React.MouseEventHandler<HTMLCanvasElement> = (event) => {
    if (interactionsLocked && !editMode) return
    if (editMode && dragStationIds && dragStartWorldRef.current) {
      const world = getWorldPointFromMouse(event)
      if (!world) return

      const dxWorld = world.x - dragStartWorldRef.current.x
      const dyWorld = world.y - dragStartWorldRef.current.y

      if (!hasDragged) {
        const distSq = dxWorld * dxWorld + dyWorld * dyWorld
        if (distSq > 1) {
          setHasDragged(true)
        }
      }

      setStationOverrides((prev) => {
        const next = { ...prev }
        const initial = dragInitialPositionsRef.current
        for (const id of dragStationIds) {
          const base = initial[id]
          if (!base) continue
          next[id] = { x: base.x + dxWorld, y: base.y + dyWorld }
        }
        return next
      })
      return
    }

    const lastPoint = lastPointRef.current
    if (!isPanning || !lastPoint) return
    const dx = event.clientX - lastPoint.x
    const dy = event.clientY - lastPoint.y

    if (!hasDragged) {
      const distSq = dx * dx + dy * dy
      if (distSq > 9) {
        setHasDragged(true)
      }
    }

    // Обновляем скорость панорамирования для инерции
    const now = performance.now()
    const lastTime = panLastSampleTimeRef.current
    if (lastTime != null) {
      const dt = now - lastTime
      if (dt > 0) {
        const vxInst = dx / dt
        const vyInst = dy / dt
        const alpha = 0.35
        const prev = panVelocityRef.current
        panVelocityRef.current = {
          vx: prev.vx * (1 - alpha) + vxInst * alpha,
          vy: prev.vy * (1 - alpha) + vyInst * alpha,
        }
      }
    }
    panLastSampleTimeRef.current = now

    lastPointRef.current = { x: event.clientX, y: event.clientY }
    viewportRef.current = clampViewport({
      ...viewportRef.current,
      offsetX: viewportRef.current.offsetX + dx,
      offsetY: viewportRef.current.offsetY + dy,
    })
    scheduleViewportCommit()
  }

  const handleMouseUp: React.MouseEventHandler<HTMLCanvasElement> = () => {
    const hadDrag = hasDragged
    if (editMode && dragStationIds) {
      setDragStationIds(null)
      dragStartWorldRef.current = null
      dragInitialPositionsRef.current = {}
    }
    setIsPanning(false)
    lastPointRef.current = null
    if (!editMode && hadDrag) {
      startPanInertia()
    }
  }

  const handleMouseLeave: React.MouseEventHandler<HTMLCanvasElement> = () => {
    if (editMode && dragStationIds) {
      setDragStationIds(null)
      dragStartWorldRef.current = null
      dragInitialPositionsRef.current = {}
    }
    setIsPanning(false)
    lastPointRef.current = null
  }

  const getTouchPoint = (event: React.TouchEvent<HTMLCanvasElement>) => {
    const t = event.touches[0]
    return { x: t.clientX, y: t.clientY }
  }

  const getTouchDistance = (touches: React.TouchList) => {
    if (touches.length < 2) return 0
    const t1 = touches[0]
    const t2 = touches[1]
    const dx = t2.clientX - t1.clientX
    const dy = t2.clientY - t1.clientY
    return Math.sqrt(dx * dx + dy * dy)
  }

  const handleTouchStart: React.TouchEventHandler<HTMLCanvasElement> = (event) => {
    if (interactionsLocked && !editMode) return
    stopPanInertia()
    panVelocityRef.current = { vx: 0, vy: 0 }
    panLastSampleTimeRef.current = performance.now()
    if (onMapInteraction) onMapInteraction()

    if (event.touches.length === 1) {
      const touch = event.touches[0]
      const x = touch.clientX
      const y = touch.clientY

      // Double-tap + drag: если второй тап пришёл быстро и недалеко от предыдущего, запускаем zoom-drag.
      if (!editMode) {
        const now = performance.now()
        const lastTime = lastTapTimeRef.current
        const lastPos = lastTapPosRef.current
        const DOUBLE_TAP_MAX_DELAY = 320
        const DOUBLE_TAP_MAX_DIST = 40

        if (lastTime != null && lastPos) {
          const dt = now - lastTime
          const dx = x - lastPos.x
          const dy = y - lastPos.y
          const distSq = dx * dx + dy * dy

          if (dt <= DOUBLE_TAP_MAX_DELAY && distSq <= DOUBLE_TAP_MAX_DIST * DOUBLE_TAP_MAX_DIST) {
            zoomDragActiveRef.current = true
            zoomDragUsedRef.current = false
            zoomDragStartScaleRef.current = viewportRef.current.scale
            zoomDragStartYRef.current = y
            zoomDragCenterClientRef.current = { x, y }
            setHasDragged(false)
            pinchStartDistanceRef.current = null
            return
          }
        }
      }

      const world = getWorldPointFromMouse({ clientX: touch.clientX, clientY: touch.clientY })

      if (editMode && world) {
        const hit = hitTestStationAtWorldPoint(world.x, world.y)
        if (hit) {
          setHasDragged(false)
          const idsToDrag: string[] =
            hit.hubId != null
              ? positionedStations.filter((st) => st.hubId === hit.hubId).map((st) => st.id)
              : [hit.id]

          const initialPositions: Record<string, { x: number; y: number }> = {}
          for (const id of idsToDrag) {
            const st = positionedById.get(id)
            if (st) {
              initialPositions[id] = { x: st.x, y: st.y }
            }
          }

          setDragStationIds(idsToDrag)
          dragInitialPositionsRef.current = initialPositions
          dragStartWorldRef.current = world
          return
        }
      }

      const p = getTouchPoint(event)
      setIsPanning(true)
      lastPointRef.current = p
      setHasDragged(false)
      pinchStartDistanceRef.current = null
    } else if (event.touches.length === 2) {
      const distance = getTouchDistance(event.touches)
      pinchStartDistanceRef.current = distance
      pinchStartScaleRef.current = viewportRef.current.scale
      pinchLastDistanceRef.current = distance
      pinchLastTimestampRef.current = performance.now()
      pinchVelocityRef.current = 0
      const t1 = event.touches[0]
      const t2 = event.touches[1]
      const midClientX = (t1.clientX + t2.clientX) / 2
      const midClientY = (t1.clientY + t2.clientY) / 2
      const worldAtCenter = getWorldPointFromMouse({ clientX: midClientX, clientY: midClientY })
      pinchCenterWorldRef.current = worldAtCenter
      setIsPanning(false)
      lastPointRef.current = null
    }
  }

  const handleTouchMove: React.TouchEventHandler<HTMLCanvasElement> = (event) => {
    if (interactionsLocked && !editMode) return
    if (event.touches.length === 1 && zoomDragActiveRef.current) {
      const touch = event.touches[0]
      const center = zoomDragCenterClientRef.current
      if (!center) return

      const dy = touch.clientY - zoomDragStartYRef.current
      const baseScale = zoomDragStartScaleRef.current
      const SENSITIVITY = 220 // чем больше, тем медленнее меняется масштаб от вертикального движения

      // Игнорируем совсем маленькие движения, чтобы лёгкий дрожащий второй тап
      // не превращался в zoom-drag и не ломал простой double-tap.
      const ACTIVATE_THRESHOLD = 8
      if (!zoomDragUsedRef.current && Math.abs(dy) < ACTIVATE_THRESHOLD) {
        return
      }

      if (!zoomDragUsedRef.current) {
        zoomDragUsedRef.current = true
        setHasDragged(true)
      }

      let targetScale = baseScale * Math.pow(2, -dy / SENSITIVITY)
      targetScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, targetScale))

      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const centerX = rect.width / 2
      const centerY = rect.height / 2
      const xScreen = center.x - rect.left
      const yScreen = center.y - rect.top

      setViewport((prev) => {
        const currentScale = prev.scale
        if (targetScale === currentScale) return prev

        const worldX = (xScreen - (centerX + prev.offsetX)) / currentScale
        const worldY = (yScreen - (centerY + prev.offsetY)) / currentScale

        const nextOffsetX = xScreen - centerX - worldX * targetScale
        const nextOffsetY = yScreen - centerY - worldY * targetScale

        return clampViewport({
          scale: targetScale,
          offsetX: nextOffsetX,
          offsetY: nextOffsetY,
        })
      })
      return
    }
    if (event.touches.length === 1 && editMode && dragStationIds && dragStartWorldRef.current) {
      const touch = event.touches[0]
      const world = getWorldPointFromMouse({ clientX: touch.clientX, clientY: touch.clientY })
      if (!world) return

      const dxWorld = world.x - dragStartWorldRef.current.x
      const dyWorld = world.y - dragStartWorldRef.current.y

      if (!hasDragged) {
        const distSq = dxWorld * dxWorld + dyWorld * dyWorld
        if (distSq > 1) {
          setHasDragged(true)
        }
      }

      setStationOverrides((prev) => {
        const next = { ...prev }
        const initial = dragInitialPositionsRef.current
        for (const id of dragStationIds) {
          const base = initial[id]
          if (!base) continue
          next[id] = { x: base.x + dxWorld, y: base.y + dyWorld }
        }
        return next
      })
    } else if (event.touches.length === 1 && isPanning && lastPointRef.current) {
      const p = getTouchPoint(event)
      const dx = p.x - lastPointRef.current.x
      const dy = p.y - lastPointRef.current.y

      if (!hasDragged) {
        const distSq = dx * dx + dy * dy
        if (distSq > 9) {
          setHasDragged(true)
        }
      }

      // Обновляем скорость панорамирования для инерции (тач)
      const now = performance.now()
      const lastTime = panLastSampleTimeRef.current
      if (lastTime != null) {
        const dt = now - lastTime
        if (dt > 0) {
          const vxInst = dx / dt
          const vyInst = dy / dt
          const alpha = 0.35
          const prev = panVelocityRef.current
          panVelocityRef.current = {
            vx: prev.vx * (1 - alpha) + vxInst * alpha,
            vy: prev.vy * (1 - alpha) + vyInst * alpha,
          }
        }
      }
      panLastSampleTimeRef.current = now

      lastPointRef.current = p
      viewportRef.current = clampViewport({
        ...viewportRef.current,
        offsetX: viewportRef.current.offsetX + dx,
        offsetY: viewportRef.current.offsetY + dy,
      })
      scheduleViewportCommit()
    } else if (event.touches.length === 2 && pinchStartDistanceRef.current) {
      const canvas = canvasRef.current
      if (!canvas) return

      const distance = getTouchDistance(event.touches)
      if (distance <= 0) return

      const now = performance.now()
      const lastDistance = pinchLastDistanceRef.current
      const lastTime = pinchLastTimestampRef.current
      if (lastDistance != null && lastTime != null) {
        const deltaDist = distance - lastDistance
        const dt = now - lastTime
        if (dt > 0) {
          const instantVelocity = deltaDist / dt
          const alpha = 0.35
          pinchVelocityRef.current =
            pinchVelocityRef.current * (1 - alpha) + instantVelocity * alpha
        }
      }
      pinchLastDistanceRef.current = distance
      pinchLastTimestampRef.current = now

      const ratio = distance / pinchStartDistanceRef.current
      const rawNextScale = pinchStartScaleRef.current * ratio

      const rect = canvas.getBoundingClientRect()
      const centerX = rect.width / 2
      const centerY = rect.height / 2
      const t1 = event.touches[0]
      const t2 = event.touches[1]
      const midClientX = (t1.clientX + t2.clientX) / 2
      const midClientY = (t1.clientY + t2.clientY) / 2
      const xScreen = midClientX - rect.left
      const yScreen = midClientY - rect.top
      const worldAtCenter = pinchCenterWorldRef.current

      let nextScale = rawNextScale
      nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale))

      const base = viewportRef.current
      let nextViewport: ViewportState
      if (!worldAtCenter) {
        nextViewport = clampViewport({ ...base, scale: nextScale })
      } else {
        const nextOffsetX = xScreen - centerX - worldAtCenter.x * nextScale
        const nextOffsetY = yScreen - centerY - worldAtCenter.y * nextScale
        nextViewport = clampViewport({
          scale: nextScale,
          offsetX: nextOffsetX,
          offsetY: nextOffsetY,
        })
      }

      viewportRef.current = nextViewport
      scheduleViewportCommit()
    }
  }

  const handleTouchEnd: React.TouchEventHandler<HTMLCanvasElement> = (event) => {
    const hadDrag = hasDragged
    if (editMode && dragStationIds) {
      setDragStationIds(null)
      dragStartWorldRef.current = null
      dragInitialPositionsRef.current = {}
    }

    if (isPanning) {
      setIsPanning(false)
      lastPointRef.current = null
    }

    const hadPinch = pinchStartDistanceRef.current != null
    if (pinchStartDistanceRef.current) {
      pinchStartDistanceRef.current = null
    }

    if (hadPinch) {
      const velocity = pinchVelocityRef.current
      const absVelocity = Math.abs(velocity)
      const minVelocity = 0.01
      if (absVelocity > minVelocity) {
        const maxBoost = 0.35
        const boost = Math.min(maxBoost, absVelocity * 0.12)
        if (boost > 0) {
          const totalFactor = velocity > 0 ? 1 + boost : 1 / (1 + boost)
          startZoomClickAnimation(totalFactor)
        }
      }
    }

    pinchCenterWorldRef.current = null
    pinchLastDistanceRef.current = null
    pinchLastTimestampRef.current = null
    pinchVelocityRef.current = 0

    const wasZoomDrag = zoomDragUsedRef.current
    zoomDragActiveRef.current = false
    zoomDragUsedRef.current = false
    zoomDragCenterClientRef.current = null

    // Double-tap zoom (только для одиночного тапа без drag/pinch/zoom-drag и вне режима редактирования)
    if (!editMode && !hadPinch && !hadDrag && !wasZoomDrag && event.changedTouches.length === 1) {
      const touch = event.changedTouches[0]
      const x = touch.clientX
      const y = touch.clientY
      const now = performance.now()
      const lastTime = lastTapTimeRef.current
      const lastPos = lastTapPosRef.current
      const DOUBLE_TAP_MAX_DELAY = 320
      const DOUBLE_TAP_MAX_DIST = 40

      if (lastTime != null && lastPos) {
        const dt = now - lastTime
        const dx = x - lastPos.x
        const dy = y - lastPos.y
        const distSq = dx * dx + dy * dy

        if (dt <= DOUBLE_TAP_MAX_DELAY && distSq <= DOUBLE_TAP_MAX_DIST * DOUBLE_TAP_MAX_DIST) {
          // Срабатывание double-tap: зумируем к месту тапа и сбрасываем состояние.
          lastTapTimeRef.current = null
          lastTapPosRef.current = null
          const totalFactor = 2
          startZoomClickAnimationAtPoint(totalFactor, x, y)
          return
        }
      }

      // Первый тап или слишком поздний/далёкий второй тап — просто запоминаем.
      lastTapTimeRef.current = now
      lastTapPosRef.current = { x, y }
    }

    if (!editMode && hadDrag && !hadPinch && !wasZoomDrag) {
      startPanInertia()
    }
  }

  const handleStationClick = (st: PositionedStation) => {
    clickPulseRef.current = { stationId: st.id, startedAt: performance.now() }
    ensureAnimationLoop()
    if (editMode && onEditStationInspect) {
      onEditStationInspect(st.id)
    } else {
      onSelectStation(st.id, st.title)
    }
  }

  const handleClick: React.MouseEventHandler<HTMLCanvasElement> = (event) => {
    if (hasDragged) {
      return
    }

    const world = getWorldPointFromMouse(event)
    if (!world) return
    const closest = hitTestStationAtWorldPoint(world.x, world.y)
    if (closest) {
      handleStationClick(closest)
    }
  }

  return (
    <div className="metro-map-wrapper" data-selection-mode={selectionMode}>
      <canvas
        ref={canvasRef}
        className="metro-map-svg"
        width={viewBoxSize}
        height={viewBoxSize}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
        onClick={handleClick}
      />
      <canvas
        ref={labelCanvasRef}
        className="metro-map-labels"
        width={viewBoxSize}
        height={viewBoxSize}
      />
      <div className="metro-map-zoom-controls">
        <button
          type="button"
          className="metro-map-zoom-button"
          onClick={(event) => {
            event.preventDefault()
            if (interactionsLocked && !editMode) {
              return
            }
            if (zoomSuppressClickRef.current) {
              // Клик завершает удержание — не делаем дополнительный шаг.
              zoomSuppressClickRef.current = false
              return
            }
            if (onMapInteraction) onMapInteraction()
            startZoomClickAnimation(2)
          }}
          onMouseDown={(event) => {
            event.preventDefault()
            handleZoomIn()
          }}
          onMouseUp={(event) => {
            event.preventDefault()
            clearZoomHoldTimeout()
            stopZoomHold()
          }}
          onMouseLeave={(event) => {
            event.preventDefault()
            clearZoomHoldTimeout()
            stopZoomHold()
          }}
          onTouchStart={() => {
            handleZoomIn()
          }}
          onTouchEnd={() => {
            clearZoomHoldTimeout()
            stopZoomHold()
          }}
          onTouchCancel={() => {
            clearZoomHoldTimeout()
            stopZoomHold()
          }}
          aria-label="Приблизить карту"
        >
          +
        </button>
        <button
          type="button"
          className="metro-map-zoom-button"
          onClick={(event) => {
            event.preventDefault()
            if (interactionsLocked && !editMode) {
              return
            }
            if (zoomSuppressClickRef.current) {
              zoomSuppressClickRef.current = false
              return
            }
            if (onMapInteraction) onMapInteraction()
            startZoomClickAnimation(0.5)
          }}
          onMouseDown={(event) => {
            event.preventDefault()
            handleZoomOut()
          }}
          onMouseUp={(event) => {
            event.preventDefault()
            clearZoomHoldTimeout()
            stopZoomHold()
          }}
          onMouseLeave={(event) => {
            event.preventDefault()
            clearZoomHoldTimeout()
            stopZoomHold()
          }}
          onTouchStart={() => {
            handleZoomOut()
          }}
          onTouchEnd={() => {
            clearZoomHoldTimeout()
            stopZoomHold()
          }}
          onTouchCancel={() => {
            clearZoomHoldTimeout()
            stopZoomHold()
          }}
          aria-label="Отдалить карту"
        >
          −
        </button>
      </div>
    </div>
  )
}
