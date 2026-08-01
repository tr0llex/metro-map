/**
 * Категория «Хабы»: станции одного пересадочного узла должны читаться как один
 * узел, а разные узлы — не слипаться друг с другом.
 *
 * КАК РАНТАЙМ РИСУЕТ ХАБ (проверено по MetroMap.tsx):
 *  1. группа из ≥2 станций обводится капсулой (скруглённый прямоугольник) по
 *     bounding box станций с паддингом stationRadius * 2.1;
 *  2. в барицентре рисуется круг-«пирог» радиуса stationRadius * 1.7,
 *     поделённый на секторы по цветам линий;
 *  3. сами станции рисуются кружками радиуса stationRadius в своих позициях.
 *
 * ВАЖНО ПРО КАЛИБРОВКУ. Требовать, чтобы все станции хаба слились в одну точку
 * (то есть попали внутрь «пирога»), — НЕВЕРНАЯ цель: тогда капсула из п.1 была
 * бы не нужна, а на эталонных схемах метро пересадочный комплекс как раз и
 * рисуется несколькими кружками в общей плашке. Правильный вопрос — «читается
 * ли группа как ОДИН узел», то есть остаётся ли капсула компактной.
 *
 * Отсюда пороги: разброс до 3 радиусов станции даёт капсулу примерно двойного
 * размера значка — это всё ещё один узел; больше 6 радиусов капсула вытягивается
 * в «колбасу» и станции начинают читаться как отдельные.
 */

import { HUB_PIE_RADIUS, HUB_STATION_RADIUS, type RenderModel } from '../render.ts'
import { percentile } from '../geom.ts'
import { makeMetric, type MetricResult, type Offender } from '../types.ts'

/** Разброс станций от центра хаба, при котором группа ещё читается как один узел. */
export const HUB_MERGE_LIMIT = HUB_STATION_RADIUS * 3

/** Разброс, при котором хаб уже явно распадается на отдельные станции. */
export const HUB_SPLIT_LIMIT = HUB_STATION_RADIUS * 6

void HUB_PIE_RADIUS

export function hubMetrics(model: RenderModel): MetricResult[] {
  const out: MetricResult[] = []

  const hubs: { id: string; cx: number; cy: number; spread: number; titles: string[]; worst: string }[] = []
  for (const [hubId, group] of [...model.hubGroups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (group.length < 2) continue
    let cx = 0
    let cy = 0
    for (const st of group) {
      cx += st.x
      cy += st.y
    }
    cx /= group.length
    cy /= group.length
    let spread = 0
    let worst = ''
    for (const st of group) {
      const d = Math.hypot(st.x - cx, st.y - cy)
      if (d > spread) {
        spread = d
        worst = st.title
      }
    }
    hubs.push({
      id: hubId,
      cx,
      cy,
      spread,
      titles: [...new Set(group.map((s) => s.title))].sort(),
      worst,
    })
  }

  // --- 1. Доля «разъехавшихся» хабов ---
  const broken = hubs.filter((h) => h.spread > HUB_MERGE_LIMIT)
  const brokenShare = hubs.length > 0 ? (broken.length / hubs.length) * 100 : 0
  out.push(
    makeMetric({
      id: 'hubs.notMerged',
      category: 'hubs',
      name: 'Хабы, не читающиеся как один узел',
      unit: '%',
      value: brokenShare,
      target: 5,
      fail: 20,
      direction: 'lower',
      description: `Станции хаба разъехались дальше ${HUB_MERGE_LIMIT.toFixed(1)}px от центра — обводка-капсула вытягивается, и узел начинает читаться как несколько разных станций с одним именем. Полное слияние в точку целью НЕ является: комплекс из нескольких кружков в общей плашке — нормальная идиома схем метро.`,
      offenders: broken.map((h) => ({
        id: h.id,
        label: h.titles.join(' / '),
        value: h.spread,
        detail: `разброс ${h.spread.toFixed(1)}px (лимит ${HUB_MERGE_LIMIT.toFixed(1)}px), дальше всех «${h.worst}»`,
      })),
    }),
  )

  // --- 2. Худший разброс (p95) ---
  const spreads = hubs.map((h) => h.spread)
  out.push(
    makeMetric({
      id: 'hubs.spreadP95',
      category: 'hubs',
      name: 'Разброс станций внутри хаба, p95',
      unit: 'px',
      value: percentile(spreads, 0.95),
      target: HUB_MERGE_LIMIT,
      fail: HUB_SPLIT_LIMIT,
      direction: 'lower',
      description:
        'Насколько далеко от центра узла оказывается самая «убежавшая» станция в худших 5% хабов. Прямо показывает масштаб проблемы, а не только её частоту.',
      offenders: hubs
        .map((h) => ({
          id: h.id,
          label: h.titles.join(' / '),
          value: h.spread,
          detail: `дальше всех «${h.worst}»`,
        })),
    }),
  )

  // --- 3. Слипание разных хабов ---
  const collisionLimit = HUB_PIE_RADIUS * 2
  const collisions: Offender[] = []
  for (let i = 0; i < hubs.length; i += 1) {
    for (let j = i + 1; j < hubs.length; j += 1) {
      const d = Math.hypot(hubs[i].cx - hubs[j].cx, hubs[i].cy - hubs[j].cy)
      if (d >= collisionLimit) continue
      collisions.push({
        id: `${hubs[i].id}|${hubs[j].id}`,
        label: `${hubs[i].titles.join('/')} ↔ ${hubs[j].titles.join('/')}`,
        value: collisionLimit - d,
        detail: `центры «пирогов» в ${d.toFixed(1)}px (нужно ≥ ${collisionLimit.toFixed(1)}px)`,
      })
    }
  }
  out.push(
    makeMetric({
      id: 'hubs.pieCollisions',
      category: 'hubs',
      name: 'Наложение значков разных хабов',
      unit: 'шт',
      value: collisions.length,
      target: 0,
      fail: 3,
      direction: 'lower',
      description:
        'Два разных пересадочных узла нарисованы так близко, что их «пироги» перекрываются — пользователь не понимает, где кончается один узел и начинается другой.',
      offenders: collisions,
    }),
  )

  // --- 4. Инвариант «данные == картинка» ---
  // Раньше здесь была копия hubs.notMerged по сырым layoutX/layoutY — она нужна
  // была, чтобы отделить вину солвера от вины рантайм-проекции колец. Проекция
  // перенесена в солвер, метрика стала дубликатом и заменена на прямую проверку
  // главного свойства, ради которого всё делалось: рантайм НЕ должен двигать
  // станции относительно fullGraph.json. Любое ненулевое значение означает, что
  // в отрисовку вернулось искажение координат и все остальные метрики врут.
  const moved: Offender[] = []
  for (const st of model.stations) {
    const d = Math.hypot(st.x - st.rawX, st.y - st.rawY)
    if (d <= 1e-6) continue
    moved.push({
      id: st.id,
      label: st.title,
      value: d,
      detail: `рантайм сдвигает станцию на ${d.toFixed(1)}px относительно layoutX/layoutY`,
    })
  }
  moved.sort((a, b) => b.value - a.value || a.id.localeCompare(b.id))
  out.push(
    makeMetric({
      id: 'render.movesStations',
      category: 'hubs',
      name: 'Станции, сдвинутые рантаймом',
      unit: 'шт',
      value: moved.length,
      target: 0,
      fail: 1,
      direction: 'lower',
      description:
        'Координаты на экране должны совпадать с fullGraph.json. Если рантайм снова начнёт что-то проецировать или подгонять, хабы разъедутся, а метрики начнут измерять не то, что видит пользователь.',
      offenders: moved,
    }),
  )

  return out
}
