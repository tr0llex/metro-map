/**
 * Категория «Подписи». Считается по результату РЕАЛЬНОЙ раскладки подписей
 * (порт computeStationLabelPlacements), а не по абстрактным прямоугольникам.
 */

import { HUB_PIE_RADIUS, STATION_RADIUS, type RenderModel, type Segment } from '../render.ts'
import { SegmentGrid, rectOverlapArea, rectsOverlap, segIntersectsRect } from '../geom.ts'
import { CENTER_RADIUS, MIDDLE_RADIUS, preferredMaxDist } from '../labelGeom.ts'
import type { LabelPlacement } from '../labelLayout.ts'
import { makeMetric, type MetricResult, type Offender } from '../types.ts'

/** Индексы зон: 0 — центр (внутри Кольцевой), 1 — средняя (до МЦК), 2 — периферия. */
const ZONE_CENTER = 0
const ZONE_NAMES = ['центр', 'средняя зона', 'периферия'] as const

/**
 * Веса зон для сводной метрики перечёркнутости.
 *
 * Не подобраны под результат — выведены из плотности схемы: внутри Кольцевой
 * на подпись приходится примерно втрое больше отрезков линий, чем на периферии,
 * и именно этот кусок схемы пользователь видит при первом открытии. Средняя
 * зона — промежуточная.
 */
const ZONE_WEIGHTS = [3, 1.5, 1] as const
const ZONE_WEIGHT_SUM = ZONE_WEIGHTS[0] + ZONE_WEIGHTS[1] + ZONE_WEIGHTS[2]

/**
 * Зона подписи по тому же радиусу, по которому её выбирала раскладка
 * (`zoneRadius` приходит прямо из результата раскладки), и по тем же границам
 * CENTER_RADIUS / MIDDLE_RADIUS. Метрика структурно не может разойтись
 * с зонированием алгоритма.
 */
function zoneOf(r: number): number {
  return r < CENTER_RADIUS ? 0 : r < MIDDLE_RADIUS ? 1 : 2
}

export function labelMetrics(model: RenderModel, placements: LabelPlacement[]): MetricResult[] {
  const out: MetricResult[] = []
  const total = placements.length

  // --- 1. Наложение подписей друг на друга ---
  const overlaps: Offender[] = []
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      const a = placements[i]
      const b = placements[j]
      if (!rectsOverlap(a.rect, b.rect)) continue
      const area = rectOverlapArea(a.rect, b.rect)
      const minArea = Math.min(a.width * a.height, b.width * b.height)
      overlaps.push({
        id: [a.stationIds[0], b.stationIds[0]].sort().join('|'),
        label: `«${a.text}» × «${b.text}»`,
        value: minArea > 0 ? (area / minArea) * 100 : 0,
        detail: `перекрытие ${area.toFixed(0)}px² — ${((area / Math.max(minArea, 1)) * 100).toFixed(0)}% меньшей подписи`,
      })
    }
  }
  out.push(
    makeMetric({
      id: 'labels.overlaps',
      category: 'labels',
      name: 'Наложения подписей друг на друга',
      unit: 'шт',
      value: overlaps.length,
      target: 0,
      fail: 6,
      direction: 'lower',
      description:
        'Две подписи станций налезли друг на друга — текст физически нечитаем. Самый заметный дефект схемы: пользователь не может прочитать название.',
      offenders: overlaps,
    }),
  )

  // --- 2. Подписи, перечёркнутые линиями (ЗОНАЛЬНО) ---
  //
  // Плоская доля по всей схеме — ложно успокаивающая метрика. Перечёркнутые
  // подписи почти все сидят в плотном центре, куда приложение открывается по
  // умолчанию, но делятся они на 260+ подписей всей схемы и размазываются
  // до «нормы». Поэтому центр считается ОТДЕЛЬНО и строго, а сводная метрика
  // взвешивает доли по зонам, а не по числу подписей.
  const segGrid = new SegmentGrid<Segment>(model.segments, 64)
  const crossed: Offender[] = []
  const zoneTotal = [0, 0, 0]
  const zoneCrossed = [0, 0, 0]
  const centerOffenders: Offender[] = []
  for (const p of placements) {
    const z = zoneOf(p.zoneRadius)
    zoneTotal[z] += 1
    const cx = (p.rect.x1 + p.rect.x2) / 2
    const cy = (p.rect.y1 + p.rect.y2) / 2
    const reach = Math.max(p.width, p.height)
    const hit = new Set<number>()
    for (const seg of segGrid.query(cx, cy, reach)) {
      if (!segIntersectsRect(seg, p.rect)) continue
      hit.add(seg.lineId)
    }
    if (hit.size === 0) continue
    zoneCrossed[z] += 1
    const offender: Offender = {
      id: p.stationIds[0],
      label: p.text,
      value: hit.size,
      detail: `${ZONE_NAMES[z]}: подпись перечёркнута линиями — ${[...hit]
        .sort((a, b) => a - b)
        .map((id) => model.lineTitleById.get(id) ?? id)
        .join(', ')}`,
    }
    crossed.push(offender)
    if (z === ZONE_CENTER) centerOffenders.push(offender)
  }

  const zoneShare = (z: number) => (zoneTotal[z] > 0 ? (zoneCrossed[z] / zoneTotal[z]) * 100 : 0)

  // Сводная величина — средневзвешенное ДОЛЕЙ по зонам, а не доля по всем
  // подписям сразу: иначе 165 спокойных подписей периферии перевешивают
  // 31 подпись центра просто количеством.
  const weightedCrossed =
    (ZONE_WEIGHTS[0] * zoneShare(0) + ZONE_WEIGHTS[1] * zoneShare(1) + ZONE_WEIGHTS[2] * zoneShare(2)) /
    ZONE_WEIGHT_SUM

  out.push(
    makeMetric({
      id: 'labels.crossedByLinesCenter',
      category: 'labels',
      name: 'Перечёркнутые подписи в центре (внутри Кольцевой)',
      unit: '%',
      value: zoneShare(ZONE_CENTER),
      target: 8,
      fail: 20,
      direction: 'lower',
      description:
        'Доля перечёркнутых линиями подписей ВНУТРИ Кольцевой линии — там, где схема открывается по умолчанию и куда пользователь смотрит первым делом. Считается отдельно от остальной схемы: в общей доле эти подписи растворяются.',
      offenders: centerOffenders,
    }),
  )

  out.push(
    makeMetric({
      id: 'labels.crossedByLines',
      category: 'labels',
      name: 'Подписи, перечёркнутые линиями (взвешенно по зонам)',
      unit: '%',
      value: weightedCrossed,
      target: 6,
      fail: 20,
      direction: 'lower',
      description:
        'Средневзвешенная по зонам доля подписей, через которые проходит цветная линия. Веса центр/средняя/периферия = 3/1.5/1: в центре линий вчетверо больше, и там же пользователь читает схему в первую очередь.',
      offenders: crossed,
    }),
  )

  // --- 3. Подписи, накрывающие кружки станций ---
  const covered: Offender[] = []
  for (const p of placements) {
    const ownIds = new Set(p.stationIds)
    const hits: string[] = []
    for (const st of model.stations) {
      if (ownIds.has(st.id)) continue
      const r = st.hubId ? HUB_PIE_RADIUS : STATION_RADIUS
      const nx = Math.max(p.rect.x1, Math.min(st.x, p.rect.x2))
      const ny = Math.max(p.rect.y1, Math.min(st.y, p.rect.y2))
      if (Math.hypot(st.x - nx, st.y - ny) > r) continue
      hits.push(st.title)
    }
    if (hits.length === 0) continue
    covered.push({
      id: p.stationIds[0],
      label: p.text,
      value: hits.length,
      detail: `накрывает станции: ${[...new Set(hits)].sort().join(', ')}`,
    })
  }
  out.push(
    makeMetric({
      id: 'labels.coverStations',
      category: 'labels',
      name: 'Подписи поверх чужих станций',
      unit: 'шт',
      value: covered.length,
      target: 0,
      fail: 8,
      direction: 'lower',
      description:
        'Подпись легла на кружок чужой станции или на значок хаба: узел прячется под текстом, по нему невозможно ни прочитать, ни попасть пальцем.',
      offenders: covered,
    }),
  )

  // --- 4. Подписи, оторванные от своей станции ---
  // Порог берётся ТОЙ ЖЕ функцией preferredMaxDist и от ТОГО ЖЕ радиуса зоны
  // (расстояние до центра схемы), что использовала раскладка: p.zoneRadius
  // приходит прямо из неё, поэтому метрика не может разойтись с алгоритмом.
  const detached: Offender[] = []
  for (const p of placements) {
    const preferred = preferredMaxDist(p.zoneRadius)
    const cx = (p.rect.x1 + p.rect.x2) / 2
    const cy = (p.rect.y1 + p.rect.y2) / 2
    const d = Math.hypot(cx - p.anchorX, cy - p.anchorY)
    if (d <= preferred) continue
    detached.push({
      id: p.stationIds[0],
      label: p.text,
      value: d - preferred,
      detail: `${d.toFixed(0)}px от станции при допустимых ${preferred}px`,
    })
  }
  const detachedShare = total > 0 ? (detached.length / total) * 100 : 0
  out.push(
    makeMetric({
      id: 'labels.detached',
      category: 'labels',
      name: 'Подписи, оторванные от станции',
      unit: '%',
      value: detachedShare,
      target: 3,
      fail: 12,
      direction: 'lower',
      description:
        'Подпись ушла дальше комфортного расстояния — непонятно, к какой станции она относится, особенно в плотном центре.',
      offenders: detached,
    }),
  )

  // --- 5. Подписи, у которых вообще не нашлось места ---
  const expected = countExpectedLabels(model)
  const placedShare = expected > 0 ? (total / expected) * 100 : 100
  out.push(
    makeMetric({
      id: 'labels.placedShare',
      category: 'labels',
      name: 'Доля размещённых подписей',
      unit: '%',
      value: placedShare,
      target: 100,
      fail: 98,
      direction: 'higher',
      description:
        'Сколько подписей алгоритм вообще смог поставить. Неразмещённая подпись = станция без названия на схеме.',
      offenders:
        placedShare >= 100
          ? []
          : [{ id: 'labels', label: 'не размещено подписей', value: expected - total }],
    }),
  )

  return out
}

/** Сколько подписей должно быть: по одной на станцию вне хаба + по одной на уникальное имя в хабе. */
function countExpectedLabels(model: RenderModel): number {
  let n = 0
  const hubKeys = new Set<string>()
  for (const st of model.stations) {
    if (st.hubId == null) n += 1
    else hubKeys.add(`${st.hubId}|${st.title.toLowerCase()}`)
  }
  return n + hubKeys.size
}
