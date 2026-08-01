/**
 * Категория «Кольца».
 *
 * MetroMap рисует Кольцевую (5), МЦК (95) и БКЛ (97) АНАЛИТИЧЕСКОЙ кривой
 * (ctx.arc / ctx.ellipse) по форме из fullGraph.json → ringShapes, но станции
 * НЕ двигает — они рисуются ровно там, где их положил солвер. Значит:
 *  - расстояние от станции до кривой = насколько кружок станции съехал с
 *    нарисованной линии (в идеале станции лежат на кривой точно, и он нулевой);
 *  - ненулевое расстояние означает, что солвер и рисовалка разошлись: линия
 *    проходит мимо собственных станций.
 */

import {
  LINE_HALF_WIDTH,
  RING_LINE_IDS,
  STATION_RADIUS,
  projectPointToRingShape,
  type RenderModel,
} from '../render.ts'
import { percentile } from '../geom.ts'
import { makeMetric, type MetricResult, type Offender } from '../types.ts'

export function ringMetrics(model: RenderModel): MetricResult[] {
  const out: MetricResult[] = []

  const errors: number[] = []
  const offenders: Offender[] = []
  for (const st of model.stations) {
    const shape = model.ringShapes.get(st.lineId)
    if (!shape) continue
    const p = projectPointToRingShape(shape, st.x, st.y)
    const d = Math.hypot(p.x - st.x, p.y - st.y)
    errors.push(d)
    offenders.push({
      id: st.id,
      label: st.title,
      value: d,
      detail: `линия ${st.lineId} (${model.lineTitleById.get(st.lineId) ?? ''}): станция лежит в ${d.toFixed(1)}px от нарисованной кривой`,
    })
  }

  // Допуск: станция «сидит» на нарисованной линии, если её сдвиг меньше
  // полуширины линии — тогда пользователь смещения просто не заметит.
  const tolerance = LINE_HALF_WIDTH
  const meanError = errors.length > 0 ? errors.reduce((a, b) => a + b, 0) / errors.length : 0

  out.push(
    makeMetric({
      id: 'rings.projectionErrorMean',
      category: 'rings',
      name: 'Средний отрыв станции кольца от нарисованной кривой',
      unit: 'px',
      value: meanError,
      target: tolerance,
      fail: tolerance * 4,
      direction: 'lower',
      description:
        'Насколько в среднем станция кольцевой линии отстоит от нарисованной окружности/эллипса. Ненулевое значение означает, что кольцо проходит мимо собственных станций.',
      offenders,
    }),
  )

  out.push(
    makeMetric({
      id: 'rings.projectionErrorP95',
      category: 'rings',
      name: 'Отрыв станции кольца от кривой, p95',
      unit: 'px',
      value: percentile(errors, 0.95),
      target: tolerance * 2,
      fail: tolerance * 8,
      direction: 'lower',
      description:
        'Худшие случаи отрыва. Если p95 сравним с расстоянием между станциями, кольцо визуально «съезжает» с собственных станций.',
      offenders,
    }),
  )

  // --- Насколько форма кольца вообще описывает станции линии ---
  // Если невязка велика, рисовать линию ctx.arc/ctx.ellipse нельзя: кривая
  // пройдёт мимо станций, а те окажутся «в воздухе».
  const seamOffenders: Offender[] = []
  for (const [lineId, shape] of [...model.ringShapes.entries()].sort((a, b) => a[0] - b[0])) {
    const line = model.graph.lines.find((l) => l.id === lineId)
    if (!line) continue
    const pts = line.stationIds.map((id) => model.byId.get(id)).filter((s) => s != null)
    if (pts.length < 3) continue
    let sum = 0
    for (const st of pts) {
      const p = projectPointToRingShape(shape, st.x, st.y)
      sum += Math.hypot(p.x - st.x, p.y - st.y)
    }
    const meanAbs = sum / pts.length
    const scale = shape.kind === 'circle' ? shape.r : (shape.rx + shape.ry) / 2
    seamOffenders.push({
      id: `line-${lineId}`,
      label: model.lineTitleById.get(lineId) ?? `линия ${lineId}`,
      value: (meanAbs / scale) * 100,
      detail: `${shape.kind === 'circle' ? 'окружность' : 'эллипс'} R≈${scale.toFixed(0)}px, средняя невязка ${meanAbs.toFixed(1)}px`,
    })
  }
  const worstFit = seamOffenders.reduce((m, o) => Math.max(m, o.value), 0)
  out.push(
    makeMetric({
      id: 'rings.shapeFitError',
      category: 'rings',
      name: 'Невязка формы кольца',
      unit: '%',
      value: worstFit,
      target: 2,
      fail: 8,
      direction: 'lower',
      description:
        'Средняя невязка станций кольца относительно радиуса нарисованной формы, в процентах. Больше 8% — линия по данным вообще не круглая, и рисовать её окружностью нельзя: нужна ломаная либо перекладка станций.',
      offenders: seamOffenders,
    }),
  )

  // --- Равномерность станций по кольцу ---
  const gapOffenders: Offender[] = []
  let worstGapRatio = 0
  for (const lineId of [...model.ringShapes.keys()].sort((a, b) => a - b)) {
    if (!RING_LINE_IDS.has(lineId)) continue
    const line = model.graph.lines.find((l) => l.id === lineId)
    if (!line) continue
    const pts = line.stationIds.map((id) => model.byId.get(id)).filter((s) => s != null)
    if (pts.length < 4) continue
    // Соседи по кольцу, входящие в ОДИН пересадочный узел, стоят вплотную
    // намеренно (Варшавская—Каширская, Шоссе Энтузиастов—Андроновка): узел
    // рисуется группой кружков в общей капсуле. Считать это «неравномерностью»
    // нельзя — метрика штрафовала бы за корректное поведение и толкала бы
    // разносить хабы, которые мы только что собрали.
    const gaps: { d: number; a: string; b: string }[] = []
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      if (a.hubId != null && b.hubId != null && a.hubId === b.hubId) continue
      gaps.push({ d: Math.hypot(a.x - b.x, a.y - b.y), a: a.title, b: b.title })
    }
    if (gaps.length < 4) continue
    const mean = gaps.reduce((s, g) => s + g.d, 0) / gaps.length
    const minGap = gaps.reduce((m, g) => (g.d < m.d ? g : m), gaps[0])
    const ratio = mean > 0 ? minGap.d / mean : 0
    const violation = Math.max(0, 1 - ratio) * 100
    if (violation > worstGapRatio) worstGapRatio = violation
    gapOffenders.push({
      id: `line-${lineId}`,
      label: model.lineTitleById.get(lineId) ?? `линия ${lineId}`,
      value: violation,
      detail: `минимальный перегон ${minGap.d.toFixed(1)}px («${minGap.a}» — «${minGap.b}») при среднем ${mean.toFixed(1)}px`,
    })
  }
  out.push(
    makeMetric({
      id: 'rings.spacingUnevenness',
      category: 'rings',
      name: 'Неравномерность станций по кольцу',
      unit: '%',
      value: worstGapRatio,
      target: 45,
      fail: 70,
      direction: 'lower',
      description: `На сколько процентов самый короткий перегон кольца короче среднего. Слипшиеся соседи на кольце выглядят как одна станция: диаметр кружка ${(STATION_RADIUS * 2).toFixed(1)}px.`,
      offenders: gapOffenders,
    }),
  )

  return out
}
