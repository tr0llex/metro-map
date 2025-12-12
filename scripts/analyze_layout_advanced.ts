import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { FullGraphExport, FullGraphLine, FullGraphStation } from '../src/metro/types'

const KOLTSEVAYA_LINE_ID = 5
const MCC_LINE_ID = 95
const BKL_LINE_ID = 97
const RING_LINE_IDS = new Set<number>([KOLTSEVAYA_LINE_ID, MCC_LINE_ID, BKL_LINE_ID])

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
  
  // Плотность и перекрытия
  closePairsCount: number
  veryClosePairsCount: number
  averageStationDistance: number
  minStationDistance: number
  
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
  
  // Распределение пространства
  innerRingDensity: number
  outerRingDensity: number

  // Плотность станций по радиальным зонам
  radialDensityZones: RadialZoneStats[]
  
  // Октолинейность
  octilinearDeviation: number
  perfectOctilinearSegments: number
  
  // Масштаб
  boundingBox: { width: number; height: number; area: number }
  stationSpread: number

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
    closePairsCount: 0,
    veryClosePairsCount: 0,
    averageStationDistance: 0,
    minStationDistance: Infinity,
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
    innerRingDensity: 0,
    outerRingDensity: 0,
    radialDensityZones: [],
    octilinearDeviation: 0,
    perfectOctilinearSegments: 0,
    boundingBox: { width: 0, height: 0, area: 0 },
    stationSpread: 0,
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

  // 1. Анализ колец
  for (const ringId of [KOLTSEVAYA_LINE_ID, MCC_LINE_ID, BKL_LINE_ID]) {
    const line = lineMap.get(ringId)
    if (!line) continue

    const coords: { x: number; y: number }[] = []
    for (const sid of line.stationIds) {
      const st = stationMap.get(sid)
      if (st && typeof st.layoutX === 'number' && typeof st.layoutY === 'number') {
        coords.push({ x: st.layoutX, y: st.layoutY })
      }
    }
    if (coords.length < 3) continue

    let cx = 0
    let cy = 0
    for (const p of coords) {
      cx += p.x
      cy += p.y
    }
    cx /= coords.length
    cy /= coords.length

    let rSum = 0
    let rMin = Infinity
    let rMax = -Infinity
    const radii: number[] = []
    let sxx = 0
    let syy = 0
    let sxy = 0
    
    for (const p of coords) {
      const dx = p.x - cx
      const dy = p.y - cy
      const r = Math.sqrt(dx * dx + dy * dy)
      rSum += r
      radii.push(r)
      if (r < rMin) rMin = r
      if (r > rMax) rMax = r
      sxx += dx * dx
      syy += dy * dy
      sxy += dx * dy
    }
    
    const radius = rSum / coords.length
    
    // Стандартное отклонение радиуса
    const variance = radii.reduce((sum, r) => sum + (r - radius) ** 2, 0) / radii.length
    const stdDev = Math.sqrt(variance)
    const normalizedStdDev = stdDev / radius

    metrics.ringEccentricity[line.title] = normalizedStdDev
    metrics.ringRadius[line.title] = radius

    let axisRatio = 1
    let orientationDeg = 0

    if (coords.length > 1) {
      const n = coords.length
      const meanFactor = 1 / n
      sxx *= meanFactor
      syy *= meanFactor
      sxy *= meanFactor

      const diff = sxx - syy
      const discr = Math.sqrt(Math.max(0, diff * diff + 4 * sxy * sxy))
      const trace = sxx + syy
      const lambda1 = 0.5 * (trace + discr)
      const lambda2 = 0.5 * (trace - discr)

      if (lambda1 > 0 && lambda2 > 0) {
        const rawRatio = Math.sqrt(lambda1 / lambda2)
        axisRatio = rawRatio >= 1 ? rawRatio : 1 / rawRatio

        const angleRad = 0.5 * Math.atan2(2 * sxy, diff)
        let deg = (angleRad * 180) / Math.PI
        deg = Math.abs(deg)
        if (deg > 90) deg = 180 - deg
        orientationDeg = deg
      }
    }

    metrics.ringAxisRatio[line.title] = axisRatio
    metrics.ringOrientationDeg[line.title] = orientationDeg
  }

  // 2. Анализ близости станций
  const stationsWithCoords: FullGraphStation[] = []
  for (const st of graph.stations) {
    if (typeof st.layoutX === 'number' && typeof st.layoutY === 'number') {
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
    for (let i = 0; i < ids.length - 1; i += 1) {
      const a = ids[i]
      const b = ids[i + 1]
      neighborPairs.add(neighborKey(a, b))
    }
  }

  const edgeLengths: number[] = []
  for (const edge of graph.edges) {
    const from = stationMap.get(edge.fromStationId)
    const to = stationMap.get(edge.toStationId)
    if (
      !from ||
      !to ||
      typeof from.layoutX !== 'number' ||
      typeof from.layoutY !== 'number' ||
      typeof to.layoutX !== 'number' ||
      typeof to.layoutY !== 'number'
    ) {
      continue
    }

    const dx = to.layoutX - from.layoutX
    const dy = to.layoutY - from.layoutY
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
      if (!a.layoutX || !a.layoutY || !b.layoutX || !b.layoutY) continue

      // Пропускаем пары внутри одного хаба: они «слиплись» нарочно и
      // не должны считаться конфликтом расстояний.
      if (a.hubId && a.hubId === b.hubId) continue

      // Пропускаем соседей по линии: их расстояние анализируется отдельно
      // через edgeLengthStats и edgeLengthHistogram.
      const key = neighborKey(a.id, b.id)
      if (neighborPairs.has(key)) continue

      const dist = Math.sqrt(
        (a.layoutX - b.layoutX) ** 2 + (a.layoutY - b.layoutY) ** 2,
      )
      
      if (dist > 0) {
        distances.push(dist)
        if (dist < MIN_DISTANCE) metrics.closePairsCount += 1
        if (dist < VERY_CLOSE_DISTANCE) metrics.veryClosePairsCount += 1
        if (dist < metrics.minStationDistance) metrics.minStationDistance = dist
      }
    }
  }

  if (distances.length > 0) {
    metrics.averageStationDistance = distances.reduce((a, b) => a + b, 0) / distances.length
  }

  // 3. Анализ геометрии линий
  const turnAngles: number[] = []

  for (const line of graph.lines) {
    if (RING_LINE_IDS.has(line.id)) continue
    const ids = line.stationIds
    if (ids.length < 3) continue

    let lineTurnSum = 0
    let lineTurnCount = 0

    for (let i = 1; i < ids.length - 1; i += 1) {
      const prev = stationMap.get(ids[i - 1])
      const cur = stationMap.get(ids[i])
      const next = stationMap.get(ids[i + 1])
      if (
        !prev ||
        !cur ||
        !next ||
        typeof prev.layoutX !== 'number' ||
        typeof prev.layoutY !== 'number' ||
        typeof cur.layoutX !== 'number' ||
        typeof cur.layoutY !== 'number' ||
        typeof next.layoutX !== 'number' ||
        typeof next.layoutY !== 'number'
      ) {
        continue
      }

      const dx1 = cur.layoutX - prev.layoutX
      const dy1 = cur.layoutY - prev.layoutY
      const dx2 = next.layoutX - cur.layoutX
      const dy2 = next.layoutY - cur.layoutY

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
        const dev = Math.abs(segmentAngle - octAngle)
        const normalizedDev = Math.min(dev, 2 * Math.PI - dev)
        if (normalizedDev < minDev) minDev = normalizedDev
      }
      const devDeg = (minDev * 180) / Math.PI
      metrics.octilinearDeviation += devDeg
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

  // 4. Анализ хабов
  for (const hub of graph.transferHubs) {
    if (hub.stationIds.length > 2) metrics.hubsWithMultipleStations += 1

    const hubStations = hub.stationIds
      .map((id) => stationMap.get(id))
      .filter((st) => st && typeof st.layoutX === 'number' && typeof st.layoutY === 'number') as FullGraphStation[]

    if (hubStations.length < 2) continue

    // Проверяем компактность хаба
    let maxDist = 0
    for (let i = 0; i < hubStations.length; i += 1) {
      for (let j = i + 1; j < hubStations.length; j += 1) {
        const a = hubStations[i]
        const b = hubStations[j]
        if (!a.layoutX || !a.layoutY || !b.layoutX || !b.layoutY) continue

        const dist = Math.sqrt(
          (a.layoutX - b.layoutX) ** 2 + (a.layoutY - b.layoutY) ** 2,
        )
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

  // 5. Анализ плотности
  const koltsevayaLine = lineMap.get(KOLTSEVAYA_LINE_ID)
  if (koltsevayaLine) {
    const ringCoords: { x: number; y: number }[] = []
    for (const sid of koltsevayaLine.stationIds) {
      const st = stationMap.get(sid)
      if (st && typeof st.layoutX === 'number' && typeof st.layoutY === 'number') {
        ringCoords.push({ x: st.layoutX, y: st.layoutY })
      }
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
        if (!st.layoutX || !st.layoutY) continue

        const dx = st.layoutX - cx
        const dy = st.layoutY - cy
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
    if (!st.layoutX || !st.layoutY) continue
    if (st.layoutX < minX) minX = st.layoutX
    if (st.layoutX > maxX) maxX = st.layoutX
    if (st.layoutY < minY) minY = st.layoutY
    if (st.layoutY > maxY) maxY = st.layoutY
  }

  // Считаем количество станций, оказавшихся ровно в левом верхнем углу bounding box —
  // это хорошая эвристика для фолбэк-координаты (например, (188.7, -50)).
  for (const st of stationsWithCoords) {
    if (!st.layoutX || !st.layoutY) continue
    if (st.layoutX === minX && st.layoutY === minY) {
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
      if (typeof st.layoutX !== 'number' || typeof st.layoutY !== 'number') continue
      cxAll += st.layoutX
      cyAll += st.layoutY
    }

    cxAll /= stationsWithCoords.length
    cyAll /= stationsWithCoords.length

    const radii: number[] = []
    for (const st of stationsWithCoords) {
      if (typeof st.layoutX !== 'number' || typeof st.layoutY !== 'number') continue
      const dx = st.layoutX - cxAll
      const dy = st.layoutY - cyAll
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
      )}% ${quality}${shapeInfo}`,
    )
  }
  console.log()

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
  console.log(`  Октолинейность: ${metrics.perfectOctilinearSegments} идеальных сегментов, среднее отклонение=${(metrics.octilinearDeviation / 100).toFixed(2)}°`)
  
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

