/**
 * Мелкие детали раскладки подписей, скопированные из
 * computeStationLabelPlacements (src/components/MetroMap.tsx).
 * Вынесены отдельно, чтобы labelLayout.ts оставался обозримым.
 *
 * ВНИМАНИЕ: всё в этом файле обязано совпадать 1:1 с одноимёнными хелперами
 * внутри computeStationLabelPlacements. Расхождение = метрики врут.
 */

/**
 * Границы зон схемы: центр / средняя / периферия — радиус от ЦЕНТРА СХЕМЫ
 * (см. resolveZoneCenter), а не от начала координат.
 *
 * Значения привязаны к реальной структуре московской схемы:
 *  · 272px = МЕНЬШАЯ полуось Кольцевой линии (ry для ringShapes["5"]), то есть
 *    зона «центр» — это то, что строго ВНУТРИ Кольцевой. Брать средний радиус
 *    (280px) нельзя: станции самой Кольцевой лежат на радиусах 272.5…288.0, и
 *    такая граница рассекала кольцо пополам — Новослободская получала допуск
 *    44px, а её соседка по тому же кольцу Комсомольская 60px. Граница зоны не
 *    должна проходить сквозь линию, которая эту зону и определяет;
 *  · 520px ≈ средний радиус МЦК (ringShapes["95"]), то есть «средняя» зона —
 *    кольцо между Кольцевой и МЦК, а «периферия» — всё, что снаружи МЦК.
 */
export const CENTER_RADIUS = 272
export const MIDDLE_RADIUS = 520

/** По какой кольцевой линии определяется центр схемы: Кольцевая (5). */
export const ZONE_CENTER_LINE_ID = 5

/**
 * Границы зон для ПРИОРИТЕТА подписи (кого раскладываем раньше).
 * Совпадают с границами зон допуска: приоритет и допуск описывают одну и ту же
 * структуру схемы (внутри Кольцевой / до МЦК / снаружи).
 */
export const PRIORITY_CENTER_RADIUS = CENTER_RADIUS
export const PRIORITY_MIDDLE_RADIUS = MIDDLE_RADIUS

/**
 * Центр схемы для зонирования подписей.
 *
 * Приоритет — центр Кольцевой линии: это географически честный «центр города»,
 * относительно которого и построены остальные кольца. Если данных о кольцах нет
 * (старый fullGraph.json без ringShapes), берём центр bounding box станций:
 * он считается точно (min/max), не зависит от порядка обхода и от плотности
 * станций, поэтому одинаков в рантайме и в порте метрик.
 *
 * ВНИМАНИЕ: 1:1 продублировано в src/components/MetroMap.tsx
 * (resolveLabelZoneCenter).
 */
export function resolveZoneCenter(
  ringCenters: ReadonlyMap<number, { cx: number; cy: number }>,
  stations: readonly { x: number; y: number }[],
): { x: number; y: number } {
  const ring = ringCenters.get(ZONE_CENTER_LINE_ID)
  if (ring && Number.isFinite(ring.cx) && Number.isFinite(ring.cy)) {
    return { x: ring.cx, y: ring.cy }
  }
  if (stations.length === 0) return { x: 0, y: 0 }
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const st of stations) {
    if (st.x < minX) minX = st.x
    if (st.x > maxX) maxX = st.x
    if (st.y < minY) minY = st.y
    if (st.y > maxY) maxY = st.y
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
}

/**
 * Радиусы нарисованных узлов в мировых координатах на опорном зуме.
 * Совпадают с STATION_RADIUS / HUB_PIE_RADIUS из scripts/quality/render.ts,
 * то есть с тем, что реально видит пользователь.
 */
export const NODE_RADIUS_STATION = 5.564
export const NODE_RADIUS_HUB = 9.459

/** Веса штрафов раскладки. Единая точка правды для рантайма и порта. */
export const W = {
  /**
   * Жёсткое наложение прямоугольников подписей.
   *
   * Самый дорогой штраф схемы: наложение делает нечитаемыми СРАЗУ ДВЕ подписи,
   * тогда как перечёркнутая линией подпись всё-таки читается (а с вывороткой
   * под текстом — читается нормально). Поэтому наложение стоит дороже
   * перечёркивания в 6 раз, и оптимизатор никогда не разменивает одно на другое.
   */
  labelOverlap: 60000,
  /** Подпись накрыла кружок чужой станции/хаба. */
  coverStation: 24000,
  /** Подпись подошла к чужому узлу ближе комфортного зазора (мягко). */
  clearance: 900,
  /** Комфортный зазор между подписью и чужим узлом, px. */
  clearanceGap: 7,
  /** Первая линия, перечёркивающая подпись. */
  lineCrossFirst: 10000,
  /** Каждая следующая линия. */
  lineCrossMore: 300,
  /**
   * Ступенька за выход за preferredMaxDist.
   *
   * Метрика «оторванные подписи» — ПОРОГОВАЯ: до допуска всё одинаково хорошо,
   * за допуском всё одинаково плохо. Поэтому и штраф сделан ступенькой одного
   * порядка со штрафом за перечёркивание (10000): оптимизатор перестаёт
   * «докупать» удалённость по копейке и вместо этого минимизирует само число
   * дефектов. Квадратичная добавка оставлена крошечной — только чтобы среди
   * заведомо оторванных позиций выбиралась менее оторванная.
   */
  detachedStep: 5000,
  /** Квадратичный рост за каждый пиксель сверх preferredMaxDist. */
  detachedQuad: 2,
  /** Лёгкое предпочтение более близких позиций. */
  distLinear: 1.2,
  /** Центр подписи ближе к чужой станции, чем к своей. */
  ambiguous: 2600,
  /** Отклонение от «нормали к линии» (умножается на 1 - cos). */
  angleMisfit: 110,
  /** Отклонение от дефолтного разбиения названия на строки. */
  lineBreakDeviation: 120,
  /** Мягкое отталкивание по вертикали / горизонтали. */
  softRepulsionY: 240,
  softRepulsionX: 200,
  /** Аура вокруг важных подписей. */
  aura: 320,
  /** Штраф за «колонку» — подписи друг под другом. */
  column: 240,
} as const

/** Сколько проходов локального улучшения делать после жадной раскладки. */
export const REFINE_PASSES = 2

/**
 * Сколько проходов «расталкивания» делать после координатного спуска.
 * Каждый проход дорогой, а улучшения быстро заканчиваются — цикл всё равно
 * прерывается, как только проход не дал ни одного размена.
 */
export const EJECT_PASSES = 2

/** Комфортное расстояние от станции до центра подписи по зонам. */
export function preferredMaxDist(r: number): number {
  return r < CENTER_RADIUS ? 44 : r < MIDDLE_RADIUS ? 60 : 84
}

/**
 * Радиальные смещения кандидатов по зонам.
 *
 * В центре сетка самая мелкая (шаг 2px): свободные от линий «щели» там узкие,
 * и на прежнем шаге 3–6px оптимизатор в них просто не попадал.
 */
export function radiusOffsetsForZone(r: number): number[] {
  if (r < CENTER_RADIUS) return [12, 15, 18, 21, 24, 27, 30, 33, 36, 40, 44, 48, 52, 56]
  if (r < MIDDLE_RADIUS) return [12, 15, 18, 21, 25, 29, 33, 38, 43, 49, 56, 63]
  return [12, 16, 20, 24, 29, 34, 40, 47, 55, 64, 74, 84]
}

/**
 * Полный круговой перебор направлений с шагом 5°.
 *
 * Шаг 12° давал на радиусе 44px дугу почти в 9px — свободные коридоры между
 * линиями в центре уже этого, и раскладка их пропускала.
 */
export const CANDIDATE_ANGLE_COUNT = 60
export const CANDIDATE_ANGLES: number[] = (() => {
  const out: number[] = []
  for (let i = 0; i < CANDIDATE_ANGLE_COUNT; i += 1) {
    out.push((i * Math.PI * 2) / CANDIDATE_ANGLE_COUNT)
  }
  return out
})()

/**
 * Варианты горизонтальной привязки прямоугольника подписи к точке-кандидату:
 * 0 — текст вправо от точки, 1 — влево от точки, 2 — по центру точки.
 * Режим 2 нужен для подписей строго над/под станцией: они читаются как
 * «принадлежат этой станции» и не тянутся вбок через соседние линии.
 */
export const ALIGN_MODES = [0, 1, 2] as const

/** Перенос длинного названия на две строки — как в рантайме. */
export function splitLabelToLines(label: string, radialDist: number): string[] {
  const maxSingleLineChars = radialDist < 260 ? 14 : 18
  if (label.length <= maxSingleLineChars) return [label]
  return splitToTwoLines(label) ?? [label]
}

/** Разбиение названия на две максимально ровные строки (null, если невозможно). */
export function splitToTwoLines(label: string): string[] | null {
  const words = label.split(' ').filter((w) => w.length > 0)
  if (words.length <= 1) return null
  let bestIndex = 1
  let bestDiff = Infinity
  for (let i = 1; i < words.length; i += 1) {
    const diff = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length)
    if (diff < bestDiff) {
      bestDiff = diff
      bestIndex = i
    }
  }
  const first = words.slice(0, bestIndex).join(' ')
  const second = words.slice(bestIndex).join(' ')
  if (!first || !second) return null
  return [first, second]
}

/**
 * Варианты разбиения названия: дефолтный (как раньше) плюс альтернативный.
 * Позволяет оптимизатору выбрать компактный двухстрочный вариант в тесноте
 * и однострочный там, где место есть.
 */
export function lineVariantsFor(label: string, radialDist: number): string[][] {
  const base = splitLabelToLines(label, radialDist)
  const out: string[][] = [base]
  if (base.length === 2) {
    if (label.length <= 24) out.push([label])
  } else {
    const split = splitToTwoLines(label)
    if (split && label.length >= 9) out.push(split)
  }
  return out
}

/**
 * Углы-кандидаты, отсортированные по «неудобству» — отклонению от нормали к
 * линии. Порядок влияет только на скорость (хороший кандидат находится сразу,
 * дальше работает ранний отсев), но обязан совпадать в рантайме и в порте:
 * при равных штрафах побеждает первый найденный кандидат.
 */
export function anglesSortedByMisfit(
  angles: readonly number[], baseAngles: readonly number[],
): { ang: number; misfit: number }[] {
  const out = angles.map((ang) => {
    let misfit = Infinity
    for (const base of baseAngles) {
      const m = 1 - Math.cos(ang - base)
      if (m < misfit) misfit = m
    }
    return { ang, misfit }
  })
  out.sort((a, b) => (a.misfit !== b.misfit ? a.misfit - b.misfit : a.ang - b.ang))
  return out
}

/**
 * Радиус префильтра «эта подпись вообще может повлиять на штраф».
 * Заведомое надмножество: самые дальнобойные слагаемые — «колонка»
 * (до 3 высот по вертикали) и аура (до 1.25 ширины по горизонтали).
 */
export function neighborReach(ownReach: number, otherWidth: number, otherHeight: number): number {
  return ownReach + otherWidth * 1.25 + otherHeight * 3 + 8
}

/** Пересечение двух отрезков (строгое, без касаний в общих концах). */
function segmentsCross(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => {
    const v = (qx - px) * (ry - py) - (qy - py) * (rx - px)
    if (Math.abs(v) < 1e-9) return 0
    return v > 0 ? 1 : -1
  }
  const o1 = o(ax, ay, bx, by, cx, cy)
  const o2 = o(ax, ay, bx, by, dx, dy)
  const o3 = o(cx, cy, dx, dy, ax, ay)
  const o4 = o(cx, cy, dx, dy, bx, by)
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4
}

/**
 * ТОЧНОЕ пересечение отрезка с прямоугольником (включая «отрезок целиком внутри»).
 * Ровно то, что считает метрика labels.crossedByLines: раскладка обязана
 * оптимизировать измеряемую величину, а не её грубое AABB-приближение.
 */
export function segmentIntersectsRect(
  seg: { ax: number; ay: number; bx: number; by: number },
  x1: number, y1: number, x2: number, y2: number,
): boolean {
  if (Math.max(seg.ax, seg.bx) < x1 || Math.min(seg.ax, seg.bx) > x2) return false
  if (Math.max(seg.ay, seg.by) < y1 || Math.min(seg.ay, seg.by) > y2) return false
  const inside = (x: number, y: number) => x >= x1 && x <= x2 && y >= y1 && y <= y2
  if (inside(seg.ax, seg.ay) || inside(seg.bx, seg.by)) return true
  if (segmentsCross(seg.ax, seg.ay, seg.bx, seg.by, x1, y1, x2, y1)) return true
  if (segmentsCross(seg.ax, seg.ay, seg.bx, seg.by, x2, y1, x2, y2)) return true
  if (segmentsCross(seg.ax, seg.ay, seg.bx, seg.by, x2, y2, x1, y2)) return true
  if (segmentsCross(seg.ax, seg.ay, seg.bx, seg.by, x1, y2, x1, y1)) return true
  return false
}

/** Расстояние от точки до прямоугольника (0, если точка внутри). */
export function pointRectDistance(
  px: number, py: number, x1: number, y1: number, x2: number, y2: number,
): number {
  const nx = Math.max(x1, Math.min(px, x2))
  const ny = Math.max(y1, Math.min(py, y2))
  return Math.hypot(px - nx, py - ny)
}

export interface BucketSeg {
  ax: number
  ay: number
  bx: number
  by: number
  lineId: number
}

/**
 * Сегменты линий, сгруппированные по клеткам равномерной сетки.
 * Запрос по клеткам даёт надмножество, точная проверка делается тут же,
 * поэтому размер клетки влияет только на скорость, а не на результат.
 */
export class SegmentBuckets {
  private readonly cell: number
  private readonly buckets = new Map<number, number[]>()
  private readonly segs: BucketSeg[]
  private readonly stamp: Int32Array
  private tick = 0
  private readonly hitLines: number[] = []

  constructor(segments: readonly BucketSeg[], cell = 96) {
    this.cell = cell
    this.segs = segments as BucketSeg[]
    this.stamp = new Int32Array(segments.length)
    for (let i = 0; i < segments.length; i += 1) {
      const s = segments[i]
      const minX = Math.floor(Math.min(s.ax, s.bx) / cell)
      const maxX = Math.floor(Math.max(s.ax, s.bx) / cell)
      const minY = Math.floor(Math.min(s.ay, s.by) / cell)
      const maxY = Math.floor(Math.max(s.ay, s.by) / cell)
      for (let gx = minX; gx <= maxX; gx += 1) {
        for (let gy = minY; gy <= maxY; gy += 1) {
          const key = gx * 100003 + gy
          const arr = this.buckets.get(key)
          if (arr) arr.push(i)
          else this.buckets.set(key, [i])
        }
      }
    }
  }

  /** Сколько РАЗНЫХ линий реально перечёркивают прямоугольник подписи. */
  countCrossingLines(x1: number, y1: number, x2: number, y2: number): number {
    const cell = this.cell
    const minX = Math.floor(x1 / cell)
    const maxX = Math.floor(x2 / cell)
    const minY = Math.floor(y1 / cell)
    const maxY = Math.floor(y2 / cell)
    this.tick += 1
    const tick = this.tick
    const hit = this.hitLines
    hit.length = 0
    for (let gx = minX; gx <= maxX; gx += 1) {
      for (let gy = minY; gy <= maxY; gy += 1) {
        const arr = this.buckets.get(gx * 100003 + gy)
        if (!arr) continue
        for (const idx of arr) {
          if (this.stamp[idx] === tick) continue
          this.stamp[idx] = tick
          const s = this.segs[idx]
          if (hit.includes(s.lineId)) continue
          if (segmentIntersectsRect(s, x1, y1, x2, y2)) hit.push(s.lineId)
        }
      }
    }
    return hit.length
  }
}
