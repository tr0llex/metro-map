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
import { resolveZoneCenter } from '../labelGeom.ts'
import { makeMetric, type MetricResult, type Offender } from '../types.ts'

/** Минимальный зазор между центрами двух кружков станций, чтобы они не слиплись. */
export const MIN_STATION_GAP = STATION_RADIUS * 2 + STATION_BORDER_WIDTH
/** Минимальный зазор от центра станции до чужой линии. */
export const MIN_STATION_LINE_GAP = STATION_RADIUS + LINE_HALF_WIDTH + 1.5
/** Отклонение от 45° сетки, которое ещё считаем октолинейным (справочная величина). */
export const OCTILINEAR_TOLERANCE_DEG = 5

/**
 * Во сколько раз соседние перегоны одной линии должны различаться, чтобы место
 * читалось как сбой ритма, а не как плавное разрежение схемы к окраине.
 *
 * Вывод порога. Схема легально становится реже от центра к краю: реальный
 * межстанционный интервал в Москве растёт примерно вдвое от центра к периферии,
 * и растёт он постепенно — за 8–10 перегонов вдоль линии. Значит честный градиент
 * даёт отношение соседних перегонов около 2^(1/9) ≈ 1.1, и в данных так и есть:
 * медиана 1.29, p75 = 1.58. Отношение 2 градиентом объяснить уже нельзя: станция
 * стоит не посередине между соседями, а на трети — это локальная аномалия.
 */
export const SPACING_JUMP_RATIO = 2

/**
 * Общие пороги для «долевых» метрик однородности.
 *
 * Вывод. Каждый виновник такой метрики — одно «визуально выделяющееся место».
 * На схеме порядка 200–300 мест-кандидатов и 14 некольцевых линий.
 *  · 5% ≈ 10–15 мест ≈ примерно одно на линию. Единичный сбой глаз не обобщает:
 *    он читается как особенность конкретного места (реальная топология города),
 *    а не как свойство схемы. Это и есть «нет выделяющихся мест».
 *  · 15% ≈ каждое седьмое место, по 3–4 на линию. При такой плотности рваность
 *    перестаёт быть исключением и становится самим стилем схемы — требование
 *    владельца нарушено системно.
 * Пороги одинаковы для всех метрик однородности намеренно: они считают одну и ту
 * же сущность — долю мест, выбивающихся из окружения.
 */
export const UNIFORMITY_TARGET_SHARE = 5
export const UNIFORMITY_FAIL_SHARE = 15

/**
 * Сколько ближайших соседей усредняем, оценивая «шаг схемы» вокруг станции.
 * Одного ближайшего мало: он меряет случайную пару, а не плотность места. Трое —
 * минимум, при котором величина описывает окружение (станция + её ближайшая
 * компания), и при этом не размазывается на полсхемы.
 */
export const DENSITY_NEIGHBOURS = 3

/**
 * Ширина скользящего окна (в станциях) по удалению от центра, по которому
 * считается «обычный шаг на этом радиусе». 41 из ~300 — около 13% схемы:
 * достаточно, чтобы медиана была устойчивой, и достаточно узко, чтобы окно
 * следовало за радиальным градиентом, а не усредняло центр с окраиной.
 */
export const DENSITY_RADIUS_WINDOW = 41

/**
 * Во сколько раз плотность вокруг станции должна отличаться от обычной на этом
 * же удалении от центра, чтобы место читалось как сгусток или дыра.
 * Порог тот же, что у ритма, и по той же причине: радиальный градиент плавный,
 * двукратное отличие от соседей ПО РАДИУСУ градиентом объяснить нельзя.
 */
export const DENSITY_JUMP_RATIO = 2

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

  // --- 3. Октолинейность (СПРАВОЧНО, целью не является) ---
  // Меряет сходство со стилем Яндекс.Метро, а не однородность схемы. Схема может
  // быть на 55% октолинейной и выглядеть отлично, если она такая ВЕЗДЕ. Оставлена
  // как справочная величина, чтобы видеть, куда съезжает стиль, но без вердикта.
  const drawnSegments = model.segments.filter((s) => !RING_LINE_IDS.has(s.lineId))
  let octiOk = 0
  for (const seg of drawnSegments) {
    if (octilinearDeviationDeg(seg) <= OCTILINEAR_TOLERANCE_DEG) octiOk += 1
  }
  const octiShare = drawnSegments.length > 0 ? (octiOk / drawnSegments.length) * 100 : 0
  out.push(
    makeMetric({
      id: 'geometry.octilinearity',
      category: 'geometry',
      name: 'Октолинейность перегонов (справочно)',
      unit: '%',
      value: octiShare,
      target: 0,
      fail: 0,
      direction: 'higher',
      informational: true,
      description: `Доля некольцевых перегонов под углом, кратным 45° (±${OCTILINEAR_TOLERANCE_DEG}°). Признак «метро-стиля» в духе Яндекс.Метро. Целью НЕ является: схема должна быть однородной, а не похожей на эталон. Величина справочная — показывает, меняется ли стиль укладки между сборками.`,
      offenders: [],
    }),
  )

  // --- 4. Слишком короткие перегоны ---
  const minSegLen = MIN_STATION_GAP
  const shortSegs: Offender[] = []
  for (const seg of drawnSegments) {
    const len = Math.hypot(seg.bx - seg.ax, seg.by - seg.ay)
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

  // --- 7. Рваный ритм станций (локальная однородность вдоль линии) ---
  // Глобальный разброс длин (p90/p10) сюда НЕ годится: он штрафует нормальный
  // радиальный градиент «плотный центр — редкая окраина». Смотрим только на
  // соседей: станцию видно как «выделяющуюся», когда она прилипла к одному
  // соседу и оторвана от другого.
  let rhythmPlaces = 0
  const rhythmOffenders: Offender[] = []
  for (const line of model.graph.lines) {
    if (RING_LINE_IDS.has(line.id)) continue
    // Обход по сегментам: ответвление не образует пары с концом основного хода.
    for (const segment of line.segments?.length ? line.segments : [line.stationIds]) {
    const pts = segment
      .map((id) => model.byId.get(id))
      .filter((s): s is NonNullable<typeof s> => s != null)
    if (pts.length < 3) continue
    for (let i = 1; i < pts.length - 1; i += 1) {
      const prev = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
      const next = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
      const lo = Math.min(prev, next)
      const hi = Math.max(prev, next)
      if (lo < 1e-6) continue
      rhythmPlaces += 1
      const ratio = hi / lo
      if (ratio < SPACING_JUMP_RATIO) continue
      rhythmOffenders.push({
        id: pts[i].id,
        label: `${pts[i].title} (${line.title})`,
        value: ratio,
        detail: `соседние перегоны ${prev.toFixed(0)}px и ${next.toFixed(0)}px — разница в ${ratio.toFixed(1)} раза`,
      })
    }
    }
  }
  const rhythmShare = rhythmPlaces > 0 ? (rhythmOffenders.length / rhythmPlaces) * 100 : 0
  out.push(
    makeMetric({
      id: 'geometry.spacingRhythm',
      category: 'geometry',
      name: 'Рваный ритм станций',
      unit: '%',
      value: rhythmShare,
      target: UNIFORMITY_TARGET_SHARE,
      fail: UNIFORMITY_FAIL_SHARE,
      direction: 'lower',
      description: `Доля станций, у которых соседние перегоны своей линии различаются более чем в ${SPACING_JUMP_RATIO} раза. Такая станция прилипает к одному соседу и отрывается от другого — место «выделяется» из ровного ритма линии. Плавное разрежение от центра к окраине сюда не попадает: оно даёт отношение соседних перегонов около 1.1–1.5.`,
      offenders: rhythmOffenders,
    }),
  )

  // --- 8. Сгустки и пустоты (однородность плотности на равном удалении от центра) ---
  // Ритм ловит неоднородность ВДОЛЬ линии. Здесь — неоднородность ПЛОЩАДИ: место,
  // где станции набились кучей или, наоборот, зияет дыра, тогда как на том же
  // расстоянии от центра схема выглядит иначе. Плотный центр и редкая окраина —
  // норма, поэтому сравниваем каждую станцию не со схемой целиком, а со «своим»
  // радиусом: ожидаемый шаг берётся скользящей медианой по станциям, стоящим на
  // близком удалении от центра.
  const center = resolveZoneCenter(model.ringShapes, stations)
  // Станции, связанные пересадкой (в одном хабе или ребром-пересадкой), стоят
  // вплотную по замыслу и вместе читаются как один узел — сгустком они не являются.
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
  const transferPairs = new Set<string>()
  for (const e of model.graph.edges) {
    if (!e.isTransfer) continue
    transferPairs.add(pairKey(e.fromStationId, e.toStationId))
  }
  const localStep = new Map<string, number>()
  for (const st of stations) {
    const d: number[] = []
    for (const other of stations) {
      if (other.id === st.id) continue
      if (st.hubId && other.hubId && st.hubId === other.hubId) continue
      if (transferPairs.has(pairKey(st.id, other.id))) continue
      d.push(Math.hypot(st.x - other.x, st.y - other.y))
    }
    if (d.length < DENSITY_NEIGHBOURS) continue
    d.sort((a, b) => a - b)
    let sum = 0
    for (let i = 0; i < DENSITY_NEIGHBOURS; i += 1) sum += d[i]
    localStep.set(st.id, sum / DENSITY_NEIGHBOURS)
  }

  const byRadius = stations
    .filter((st) => localStep.has(st.id))
    .map((st) => ({ st, r: Math.hypot(st.x - center.x, st.y - center.y) }))
    .sort((a, b) => a.r - b.r || a.st.id.localeCompare(b.st.id))

  const densityOffenders: Offender[] = []
  const half = Math.floor(DENSITY_RADIUS_WINDOW / 2)
  for (let i = 0; i < byRadius.length; i += 1) {
    const lo = Math.max(0, Math.min(i - half, byRadius.length - DENSITY_RADIUS_WINDOW))
    const hi = Math.min(byRadius.length, lo + DENSITY_RADIUS_WINDOW)
    const win: number[] = []
    for (let j = lo; j < hi; j += 1) {
      if (j === i) continue
      win.push(localStep.get(byRadius[j].st.id)!)
    }
    if (win.length < 4) continue
    const expected = percentile(win, 0.5)
    if (expected <= 0) continue
    const step = localStep.get(byRadius[i].st.id)!
    const ratio = step >= expected ? step / expected : expected / step
    if (ratio < DENSITY_JUMP_RATIO) continue
    const st = byRadius[i].st
    densityOffenders.push({
      id: st.id,
      label: `${st.title} (${model.lineTitleById.get(st.lineId) ?? st.lineId})`,
      value: ratio,
      detail:
        `${step > expected ? 'пустота' : 'сгусток'}: вокруг станции шаг ${step.toFixed(0)}px ` +
        `при обычных ${expected.toFixed(0)}px на том же удалении от центра (${byRadius[i].r.toFixed(0)}px)`,
    })
  }
  const densityShare =
    byRadius.length > 0 ? (densityOffenders.length / byRadius.length) * 100 : 0
  out.push(
    makeMetric({
      id: 'geometry.densityOutliers',
      category: 'geometry',
      name: 'Сгустки и пустоты',
      unit: '%',
      value: densityShare,
      target: UNIFORMITY_TARGET_SHARE,
      fail: UNIFORMITY_FAIL_SHARE,
      direction: 'lower',
      description: `Доля станций, вокруг которых схема более чем в ${DENSITY_JUMP_RATIO} раза плотнее или реже, чем на том же удалении от центра. Такое место видно как чёрное пятно из слипшихся кружков или как дыра в полотне схемы. Радиальный градиент «плотный центр — редкая окраина» из метрики исключён по построению: сравнение идёт внутри своего радиуса.`,
      offenders: densityOffenders,
    }),
  )

  return out
}
