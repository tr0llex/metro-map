/**
 * Категория «Геометрия»: читаемость самой схемы — зазоры, октолинейность,
 * длины перегонов, изломы, пересечения линий.
 */

import {
  LINE_HALF_WIDTH,
  RING_LINE_IDS,
  STATION_BORDER_WIDTH,
  STATION_RADIUS,
  type RenderModel,
  type Segment,
} from '../render.ts'
import {
  SegmentGrid,
  octilinearDeviationDeg,
  percentile,
  pointSegDistance,
  segmentsIntersect,
} from '../geom.ts'
import { makeMetric, type MetricResult, type Offender } from '../types.ts'

/** Минимальный зазор между центрами двух кружков станций, чтобы они не слиплись. */
export const MIN_STATION_GAP = STATION_RADIUS * 2 + STATION_BORDER_WIDTH
/** Минимальный зазор от центра станции до чужой линии. */
export const MIN_STATION_LINE_GAP = STATION_RADIUS + LINE_HALF_WIDTH + 1.5
/** Отклонение от 45° сетки, которое ещё считаем октолинейным. */
export const OCTILINEAR_TOLERANCE_DEG = 5

export function geometryMetrics(model: RenderModel): MetricResult[] {
  const out: MetricResult[] = []
  const stations = model.stations

  // --- 1. Слипшиеся станции ---
  const grid = new Map<string, typeof stations>()
  const cell = 32
  for (const st of stations) {
    const key = `${Math.floor(st.x / cell)}:${Math.floor(st.y / cell)}`
    const arr = grid.get(key)
    if (arr) arr.push(st)
    else grid.set(key, [st])
  }
  const tooClose: Offender[] = []
  const seenPair = new Set<string>()
  for (const st of stations) {
    const gx = Math.floor(st.x / cell)
    const gy = Math.floor(st.y / cell)
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const other of grid.get(`${gx + dx}:${gy + dy}`) ?? []) {
          if (other.id === st.id) continue
          if (st.hubId && other.hubId && st.hubId === other.hubId) continue
          const key = st.id < other.id ? `${st.id}|${other.id}` : `${other.id}|${st.id}`
          if (seenPair.has(key)) continue
          seenPair.add(key)
          const d = Math.hypot(st.x - other.x, st.y - other.y)
          if (d >= MIN_STATION_GAP) continue
          tooClose.push({
            id: key,
            label: `${st.title} ↔ ${other.title}`,
            value: MIN_STATION_GAP - d,
            detail: `${d.toFixed(1)}px между центрами (нужно ≥ ${MIN_STATION_GAP.toFixed(1)}px), линии ${st.lineId}/${other.lineId}`,
          })
        }
      }
    }
  }
  out.push(
    makeMetric({
      id: 'geometry.stationsTooClose',
      category: 'geometry',
      name: 'Слипшиеся станции разных узлов',
      unit: 'шт',
      value: tooClose.length,
      target: 0,
      fail: 10,
      direction: 'lower',
      description: `Пары станций из разных пересадочных узлов, чьи кружки (Ø${(STATION_RADIUS * 2).toFixed(1)}px) касаются или перекрываются. Пользователь не может понять, где какая станция, и промахивается пальцем.`,
      offenders: tooClose,
    }),
  )

  // --- 2. Станция поверх чужой линии ---
  const segGrid = new SegmentGrid<Segment>(model.segments, 64)
  const onForeignLine: Offender[] = []
  for (const st of stations) {
    const hubMates = new Set<string>()
    if (st.hubId) for (const m of model.hubGroups.get(st.hubId) ?? []) hubMates.add(m.id)
    let worst: { d: number; lineId: number } | null = null
    for (const seg of segGrid.query(st.x, st.y, MIN_STATION_LINE_GAP)) {
      if (seg.lineId === st.lineId) continue
      if (hubMates.has(seg.aId) || hubMates.has(seg.bId)) continue
      const d = pointSegDistance(st.x, st.y, seg)
      if (d >= MIN_STATION_LINE_GAP) continue
      if (!worst || d < worst.d) worst = { d, lineId: seg.lineId }
    }
    if (!worst) continue
    onForeignLine.push({
      id: st.id,
      label: st.title,
      value: MIN_STATION_LINE_GAP - worst.d,
      detail: `${worst.d.toFixed(1)}px до линии «${model.lineTitleById.get(worst.lineId) ?? worst.lineId}» (нужно ≥ ${MIN_STATION_LINE_GAP.toFixed(1)}px)`,
    })
  }
  out.push(
    makeMetric({
      id: 'geometry.stationOnForeignLine',
      category: 'geometry',
      name: 'Станции, лежащие на чужой линии',
      unit: 'шт',
      value: onForeignLine.length,
      target: 0,
      fail: 15,
      direction: 'lower',
      description:
        'Кружок станции наезжает на линию другого маршрута, с которым у неё нет пересадки. Выглядит как несуществующая пересадка и путает при выборе станции.',
      offenders: onForeignLine,
    }),
  )

  // --- 3. Октолинейность ---
  const drawnSegments = model.segments.filter((s) => !RING_LINE_IDS.has(s.lineId))
  let octiOk = 0
  const octiOffenders: Offender[] = []
  for (const seg of drawnSegments) {
    const dev = octilinearDeviationDeg(seg)
    if (dev <= OCTILINEAR_TOLERANCE_DEG) {
      octiOk += 1
      continue
    }
    const a = model.byId.get(seg.aId)
    const b = model.byId.get(seg.bId)
    octiOffenders.push({
      id: `${seg.aId}|${seg.bId}`,
      label: `${a?.title ?? seg.aId} → ${b?.title ?? seg.bId}`,
      value: dev,
      detail: `отклонение ${dev.toFixed(1)}° от сетки 0/45/90/135°, линия ${model.lineTitleById.get(seg.lineId) ?? seg.lineId}`,
    })
  }
  const octiShare = drawnSegments.length > 0 ? (octiOk / drawnSegments.length) * 100 : 0
  out.push(
    makeMetric({
      id: 'geometry.octilinearity',
      category: 'geometry',
      name: 'Октолинейность перегонов',
      unit: '%',
      value: octiShare,
      target: 80,
      fail: 55,
      direction: 'higher',
      description: `Доля некольцевых перегонов, идущих под углом, кратным 45° (±${OCTILINEAR_TOLERANCE_DEG}°). Это главный признак «метро-стиля»: чем ниже, тем сильнее схема похожа на географическую карту, а не на схему.`,
      offenders: octiOffenders,
    }),
  )

  // --- 4. Слишком короткие перегоны ---
  const minSegLen = MIN_STATION_GAP
  const shortSegs: Offender[] = []
  const lengths: number[] = []
  for (const seg of drawnSegments) {
    const len = Math.hypot(seg.bx - seg.ax, seg.by - seg.ay)
    lengths.push(len)
    if (len >= minSegLen) continue
    const a = model.byId.get(seg.aId)
    const b = model.byId.get(seg.bId)
    shortSegs.push({
      id: `${seg.aId}|${seg.bId}`,
      label: `${a?.title ?? seg.aId} → ${b?.title ?? seg.bId}`,
      value: minSegLen - len,
      detail: `перегон ${len.toFixed(1)}px (нужно ≥ ${minSegLen.toFixed(1)}px)`,
    })
  }
  out.push(
    makeMetric({
      id: 'geometry.shortSegments',
      category: 'geometry',
      name: 'Слишком короткие перегоны',
      unit: 'шт',
      value: shortSegs.length,
      target: 0,
      fail: 8,
      direction: 'lower',
      description:
        'Перегон короче диаметра двух кружков: линия между станциями не видна, две станции сливаются в «гантельку».',
      offenders: shortSegs,
    }),
  )

  // --- 5. Острые изломы линий ---
  const sharpTurns: Offender[] = []
  for (const line of model.graph.lines) {
    const ids = line.stationIds.filter((id) => model.byId.has(id))
    if (ids.length < 3) continue
    if (RING_LINE_IDS.has(line.id)) continue
    for (let i = 1; i < ids.length - 1; i += 1) {
      const p = model.byId.get(ids[i - 1])!
      const c = model.byId.get(ids[i])!
      const n = model.byId.get(ids[i + 1])!
      const a1 = Math.atan2(p.y - c.y, p.x - c.x)
      const a2 = Math.atan2(n.y - c.y, n.x - c.x)
      let diff = Math.abs(a1 - a2)
      if (diff > Math.PI) diff = 2 * Math.PI - diff
      const deg = (diff * 180) / Math.PI
      if (deg >= 90) continue
      sharpTurns.push({
        id: c.id,
        label: c.title,
        value: 90 - deg,
        detail: `угол ${deg.toFixed(0)}° на линии «${line.title}» — линия складывается сама на себя`,
      })
    }
  }
  out.push(
    makeMetric({
      id: 'geometry.sharpTurns',
      category: 'geometry',
      name: 'Острые изломы линий',
      unit: 'шт',
      value: sharpTurns.length,
      target: 0,
      fail: 12,
      direction: 'lower',
      description:
        'Станции, в которых линия поворачивает острее 90°: маршрут «складывается», и глазом невозможно проследить, куда линия идёт дальше.',
      offenders: sharpTurns,
    }),
  )

  // --- 6. Пересечения линий разных маршрутов ---
  const crossGrid = new SegmentGrid<Segment>(drawnSegments, 64)
  const crossPairs = new Set<string>()
  for (const seg of drawnSegments) {
    const cx = (seg.ax + seg.bx) / 2
    const cy = (seg.ay + seg.by) / 2
    const reach = Math.hypot(seg.bx - seg.ax, seg.by - seg.ay) / 2 + 1
    for (const other of crossGrid.query(cx, cy, reach)) {
      if (other === seg) continue
      if (other.lineId === seg.lineId) continue
      if (
        other.aId === seg.aId || other.aId === seg.bId ||
        other.bId === seg.aId || other.bId === seg.bId
      ) {
        continue
      }
      if (!segmentsIntersect(seg, other)) continue
      const key = [`${seg.aId}|${seg.bId}`, `${other.aId}|${other.bId}`].sort().join('#')
      crossPairs.add(key)
    }
  }
  out.push(
    makeMetric({
      id: 'geometry.lineCrossings',
      category: 'geometry',
      name: 'Пересечения линий',
      unit: 'шт',
      value: crossPairs.size,
      target: 40,
      fail: 90,
      direction: 'lower',
      description:
        'Сколько раз перегоны разных линий пересекаются вне станций. Часть пересечений неизбежна, но их избыток превращает схему в паутину.',
      offenders: [...crossPairs].sort().map((k) => {
        const [p, q] = k.split('#')
        const label = (pair: string) =>
          pair
            .split('|')
            .map((id) => model.byId.get(id)?.title ?? id)
            .join('→')
        return { id: k, label: `${label(p)} × ${label(q)}`, value: 1 }
      }),
    }),
  )

  // --- 7. Разброс длин перегонов ---
  const p10 = percentile(lengths, 0.1)
  const p90 = percentile(lengths, 0.9)
  out.push(
    makeMetric({
      id: 'geometry.segmentLengthSpread',
      category: 'geometry',
      name: 'Разброс длин перегонов (p90/p10)',
      unit: 'x',
      value: p10 > 0 ? p90 / p10 : Infinity,
      target: 3,
      fail: 6,
      direction: 'lower',
      description:
        'Отношение длинного перегона к короткому. В классической схеме метро перегоны примерно равны; большой разброс = в центре всё слиплось, а на окраинах пустота.',
      offenders: [
        { id: 'p10', label: 'короткие перегоны (p10)', value: p10, detail: `${p10.toFixed(1)}px` },
        { id: 'p90', label: 'длинные перегоны (p90)', value: p90, detail: `${p90.toFixed(1)}px` },
      ],
    }),
  )

  return out
}
