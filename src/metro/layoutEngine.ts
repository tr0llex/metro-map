import type { FullGraphLine } from './types'

export interface LayoutStation {
  id: string
  title: string
  lineId: number | null
  hubId?: string
}

export interface PositionedStation extends LayoutStation {
  x: number
  y: number
  lineColor: string
}

// Layout в духе Яндекс.Метро:
// - кольцевые линии (Кольцевая, БКЛ, МЦК) рисуются по окружностям
// - остальные линии расходятся радиально от центра

interface LayoutParams {
  innerRingRadius: number
  ringGap: number
  radialStartRadius: number
  radialStep: number
}

const defaultLayoutParams: LayoutParams = {
  innerRingRadius: 170,
  ringGap: 40,
  radialStartRadius: 40,
  radialStep: 18,
}

// Идентификаторы кольцевых линий во fullGraph: Кольцевая (id=5) и МЦК (id=12)
const RING_LINE_IDS = new Set<number>([5, 95, 97])

const RING_BASE_START_ANGLE = -Math.PI / 2
const RING_ANGLE_OFFSETS = new Map<number, number>([
  [5, 0],
  [95, 0],
  [97, 0],
])

const RADIAL_SNAP_STEP = Math.PI / 4
const MAX_LOCAL_BEND = Math.PI / 12

export function computeLayout(
  lines: FullGraphLine[],
  stations: LayoutStation[],
  params: LayoutParams = defaultLayoutParams,
): PositionedStation[] {
  if (lines.length === 0 || stations.length === 0) return []

  const { innerRingRadius, ringGap, radialStartRadius, radialStep } = params

  // Карта id станции -> базовая информация (title и т.п.).
  const stationById = new Map<string, LayoutStation>()
  for (const st of stations) {
    stationById.set(st.id, st)
  }

  // Для каждой линии берём порядок станций из line.stationIds и
  // формируем свой список LayoutStation c lineId = line.id.
  const lineToStations = new Map<number, LayoutStation[]>()
  for (const line of lines) {
    const list: LayoutStation[] = []
    for (const sid of line.stationIds) {
      const base = stationById.get(sid)
      if (!base) continue
      list.push({ ...base, lineId: line.id })
    }
    if (list.length > 0) {
      lineToStations.set(line.id, list)
    }
  }

  const result: PositionedStation[] = []
  const positionedById = new Map<string, { x: number; y: number }>()
  const hubCenterById = new Map<string, { x: number; y: number }>()

  // 1. Кольцевые линии: выкладываем станции по окружностям
  const ringLineIds = Array.from(lineToStations.keys()).filter((id) => RING_LINE_IDS.has(id))
  ringLineIds.sort((a, b) => a - b)

  ringLineIds.forEach((lineId, index) => {
    const lineStations = lineToStations.get(lineId) ?? []
    const line = lines.find((l) => l.id === lineId)
    if (!line || lineStations.length === 0) return

    const radius = innerRingRadius + index * ringGap
    const count = lineStations.length
    if (count === 0) return

    const baseStartAngle = RING_BASE_START_ANGLE + (RING_ANGLE_OFFSETS.get(lineId) ?? 0)

    lineStations.forEach((st, i) => {
      const angle = baseStartAngle + (2 * Math.PI * i) / count
      const x = radius * Math.cos(angle)
      const y = radius * Math.sin(angle)

      result.push({
        ...st,
        x,
        y,
        lineColor: line.colorHex,
      })

      positionedById.set(st.id, { x, y })
      if (st.hubId && !hubCenterById.has(st.hubId)) {
        hubCenterById.set(st.hubId, { x, y })
      }
    })
  })

  // 2. Радиальные линии: всё, что не кольца
  const radialLineIds = Array.from(lineToStations.keys()).filter(
    (id) => !RING_LINE_IDS.has(id),
  )
  radialLineIds.sort((a, b) => a - b)

  const radialAngleStep = (2 * Math.PI) / Math.max(radialLineIds.length, 1)

  radialLineIds.forEach((lineId, radialIndex) => {
    const lineStations = lineToStations.get(lineId) ?? []
    const line = lines.find((l) => l.id === lineId)
    if (!line || lineStations.length === 0) return

    const baseAngle = radialIndex * radialAngleStep - Math.PI / 2
    const snappedBaseAngle = Math.round(baseAngle / RADIAL_SNAP_STEP) * RADIAL_SNAP_STEP

    // Небольшой псевдослучайный поворот для каждой ветки (до ~7.5°)
    const jitter = 0

    // Чередуем "направление" изгиба радиальных веток, чтобы картинка была более симметрична
    const directionSign = radialIndex % 2 === 0 ? 1 : -1

    const count = lineStations.length
    const denom = Math.max(count - 1, 1)

    // Предвычисляем якорные точки для станции (pinned или центр хаба)
    const anchors: ({ x: number; y: number } | null)[] = new Array(count).fill(null)
    for (let idx = 0; idx < count; idx += 1) {
      const st = lineStations[idx]
      let anchor: { x: number; y: number } | null = null
      const pinned = positionedById.get(st.id)
      if (pinned) {
        anchor = pinned
      } else if (st.hubId) {
        const hubCenter = hubCenterById.get(st.hubId)
        if (hubCenter) {
          anchor = hubCenter
        }
      }
      anchors[idx] = anchor
    }

    for (let idx = 0; idx < count; idx += 1) {
      const st = lineStations[idx]
      const t = idx / denom // 0..1

      let x: number
      let y: number

      const anchor = anchors[idx]
      if (anchor) {
        // Точка совпадает с уже выложенной станцией или центром хаба
        x = anchor.x
        y = anchor.y
      } else {
        // Пытаемся найти ближайшие якоря слева и справа
        let prevIdx = idx - 1
        while (prevIdx >= 0 && !anchors[prevIdx]) prevIdx -= 1
        let nextIdx = idx + 1
        while (nextIdx < count && !anchors[nextIdx]) nextIdx += 1

        if (prevIdx >= 0 && nextIdx < count && anchors[prevIdx] && anchors[nextIdx]) {
          // Интерполяция по хорде между двумя якорями
          const a = anchors[prevIdx]!
          const b = anchors[nextIdx]!
          const localT = (idx - prevIdx) / (nextIdx - prevIdx)
          x = a.x + (b.x - a.x) * localT
          y = a.y + (b.y - a.y) * localT
        } else {
          // Хвосты до первой и после последней опоры — fallback к радиальной формуле
          const maxLocalBend = MAX_LOCAL_BEND
          const localBend = (t - 0.5) * 2 * maxLocalBend * directionSign

          const angle = snappedBaseAngle + jitter + localBend

          // Нелинейное распределение радиусов: ближе к центру станции
          // размещаются чуть плотнее, а на окраинах шаги становятся больше.
          const denomForRadius = Math.max(count - 1, 1)
          const tRadius = idx / denomForRadius
          const easedRadiusT = tRadius * tRadius * 0.7 + tRadius * 0.3
          const radius = radialStartRadius + easedRadiusT * radialStep * denomForRadius

          x = radius * Math.cos(angle)
          y = radius * Math.sin(angle)
        }
      }

      result.push({
        ...st,
        x,
        y,
        lineColor: line.colorHex,
      })
      positionedById.set(st.id, { x, y })
      if (st.hubId && !hubCenterById.has(st.hubId)) {
        hubCenterById.set(st.hubId, { x, y })
      }
    }
  })

  // 3. Компактная геометрия для пересадочных хабов (пары/тройки/четвёрки)
  // После выкладки по кольцам/радиалам слегка переупаковываем группы станций с одним hubId,
  // чтобы они образовывали читаемые фигуры вокруг общего центра: пару, треугольник или квадрат.
  const hubGroups = new Map<string, PositionedStation[]>()
  for (const st of result) {
    if (!st.hubId) continue
    const key = st.hubId
    const list = hubGroups.get(key)
    if (list) list.push(st)
    else hubGroups.set(key, [st])
  }

  const pairRadius = 8
  const clusterRadius = 9

  for (const group of hubGroups.values()) {
    const size = group.length
    if (size < 2 || size > 4) continue

    let cx = 0
    let cy = 0
    for (const st of group) {
      cx += st.x
      cy += st.y
    }
    cx /= size
    cy /= size

    const radialAngle = Math.atan2(cy, cx) || 0
    const radialDx = Math.cos(radialAngle)
    const radialDy = Math.sin(radialAngle)
    const perpDx = -radialDy
    const perpDy = radialDx

    if (size === 2) {
      const offsets = [-1, 1]
      for (let i = 0; i < 2; i += 1) {
        const sign = offsets[i]
        const offX = perpDx * pairRadius * sign
        const offY = perpDy * pairRadius * sign
        const st = group[i]
        st.x = cx + offX
        st.y = cy + offY
      }
    } else if (size === 3) {
      // Равносторонний треугольник вокруг центра, одна вершина вдоль радиального направления.
      for (let i = 0; i < 3; i += 1) {
        const angle = radialAngle + ((i - 1) * (2 * Math.PI)) / 3
        const offX = Math.cos(angle) * clusterRadius
        const offY = Math.sin(angle) * clusterRadius
        const st = group[i]
        st.x = cx + offX
        st.y = cy + offY
      }
    } else if (size === 4) {
      // 2x2 квадрат/ромб в базисе (radial, perpendicular)
      const combos: [number, number][] = [
        [-1, -1],
        [-1, 1],
        [1, -1],
        [1, 1],
      ]
      const main = clusterRadius
      const side = clusterRadius
      for (let i = 0; i < 4; i += 1) {
        const [sx, sy] = combos[i]
        const offX = radialDx * main * sx + perpDx * side * sy
        const offY = radialDy * main * sx + perpDy * side * sy
        const st = group[i]
        st.x = cx + offX
        st.y = cy + offY
      }
    }
  }

  return result
}
