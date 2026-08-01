/**
 * Раскладка подписей станций — ЕДИНСТВЕННАЯ реализация в репозитории.
 *
 * Раньше этот алгоритм существовал в двух копиях: рантайм внутри
 * src/components/MetroMap.tsx и построчный порт в scripts/quality/labelLayout.ts.
 * Копии обязаны были совпадать 1:1, но проверить это было нечем, а расхождение
 * означало бы, что отчёт о качестве меряет не то, что видит пользователь.
 * Теперь копия одна, и разойтись физически не с чем.
 *
 * Модуль намеренно не зависит ни от DOM, ни от React, ни от данных схемы:
 *  · измерение текста инжектится (в браузере — ctx.measureText, в Node —
 *    табличная метрика scripts/quality/textMetrics.ts);
 *  · станции и сегменты принимаются структурно, а не по конкретному типу.
 * Благодаря этому один и тот же код исполняется и в браузере, и в скриптах
 * качества, и в тестах под Node.
 *
 * Файл лежит рядом с MetroMap.tsx и назван с префиксом MetroMap, чтобы попасть
 * в тот же rollup-чанк 'map' (см. manualChunks в vite.config.ts).
 */

/** Идентификаторы кольцевых линий во fullGraph: Кольцевая (5), МЦК (95), БКЛ (97). */
export const RING_LINE_IDS = new Set<number>([5, 95, 97])

/**
 * Измеритель ширины текста в мировых пикселях при базовом кегле раскладки.
 * В браузере — (t) => ctx.measureText(t).width при уже выставленном ctx.font,
 * в Node — таблица относительных ширин символов.
 */
export type LabelTextMeasurer = (text: string) => number

/** Минимум, который раскладке нужно знать о станции. */
export interface LabelLayoutStation {
  id: string
  title: string
  lineId: number | null
  hubId?: string
  x: number
  y: number
}

/** Сегмент линии, инцидентный станции: по ним считается «нормаль к линии». */
export interface LabelIncidentSegment {
  ax: number
  ay: number
  bx: number
  by: number
}

/** Отрезок нарисованной линии метро (кольца — сэмплированы по своей кривой). */
export interface LabelObstacleSegment extends LabelIncidentSegment {
  lineId: number
}

export interface StationLabelPlacement {
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
  /** Точка привязки подписи: станция или центр хаба. */
  anchorX: number
  anchorY: number
  /**
   * Расстояние от якоря подписи до центра схемы — та самая величина, по которой
   * раскладка выбрала зону. Метрика labels.detached берёт её отсюда, чтобы
   * зонирование метрики физически не могло разойтись с зонированием раскладки.
   */
  zoneRadius: number
  /** Прямоугольник подписи в мировых координатах. */
  rect: { x1: number; y1: number; x2: number; y2: number }
}

/**
 * Границы зон схемы: центр / средняя / периферия — радиус от ЦЕНТРА СХЕМЫ
 * (см. resolveLabelZoneCenter), а не от начала координат.
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
export const LABEL_CENTER_RADIUS = 272
export const LABEL_MIDDLE_RADIUS = 520

/** По какой кольцевой линии определяется центр схемы: Кольцевая (5). */
const LABEL_ZONE_CENTER_LINE_ID = 5

/**
 * Границы зон для ПРИОРИТЕТА подписи (кого раскладываем раньше).
 * Совпадают с границами зон допуска: приоритет и допуск описывают одну и ту же
 * структуру схемы (внутри Кольцевой / до МЦК / снаружи).
 */
const LABEL_PRIORITY_CENTER_RADIUS = LABEL_CENTER_RADIUS
const LABEL_PRIORITY_MIDDLE_RADIUS = LABEL_MIDDLE_RADIUS

/**
 * Центр схемы для зонирования подписей.
 *
 * Приоритет — центр Кольцевой линии: это географически честный «центр города»,
 * относительно которого и построены остальные кольца. Если данных о кольцах нет
 * (старый fullGraph.json без ringShapes), берём центр bounding box станций:
 * он считается точно (min/max), не зависит от порядка обхода и от плотности
 * станций, поэтому одинаков в рантайме и в порте метрик.
 */
export const resolveLabelZoneCenter = (
  ringCenters: ReadonlyMap<number, { cx: number; cy: number }>,
  stations: readonly { x: number; y: number }[],
): { x: number; y: number } => {
  const ring = ringCenters.get(LABEL_ZONE_CENTER_LINE_ID)
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
 * Раскладка не зависит от зума, поэтому берём фиксированные значения
 * (STATION_RADIUS_BASE * stationScale при INITIAL_PREFERRED_SCALE).
 */
export const LABEL_NODE_RADIUS_STATION = 5.564
export const LABEL_NODE_RADIUS_HUB = 9.459

/** Веса штрафов раскладки. */
export const LABEL_W = {
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
  /**
   * Подпись залезла на место, зарезервированное под маркер A/B своей станции.
   *
   * Маркер конечной станции маршрута рисуется прямо на кружке и заметно крупнее
   * его: подпись, прижатая к своему кружку вплотную, оказывалась под маркером
   * («Сокол», «Аэропорт»). Место резервируется у КАЖДОЙ станции, а не только у
   * текущих A и B: раскладка считается один раз и не должна зависеть от того,
   * какой маршрут построен, иначе подписи прыгали бы при каждом поиске.
   *
   * Штраф мягкий и заведомо дешевле перечёркивания линией (10000): в тесноте
   * центра лучше подпись под маркером (он появляется у двух станций из 262 и
   * только на время маршрута), чем подпись, перечёркнутая линией всегда.
   */
  endpointBadge: 4000,
} as const

/**
 * Радиус зоны под маркер A/B в мировых координатах на опорном зуме.
 * Считается по коду отрисовки маркера в MetroMap.tsx:
 * screenRadius = min(13, max(8.5, stationRadius * 1.6 * zoom)) плюс кольцо
 * выворотки max(1.2, r * 0.16); при zoom = INITIAL_PREFERRED_SCALE это ≈10.3px.
 */
export const LABEL_ENDPOINT_BADGE_RADIUS = 10.3

/** Сколько проходов локального улучшения делать после жадной раскладки. */
const LABEL_REFINE_PASSES = 2

/**
 * Сколько проходов «расталкивания» делать после координатного спуска.
 * Каждый проход дорогой, а улучшения быстро заканчиваются — цикл всё равно
 * прерывается, как только проход не дал ни одного размена.
 */
const LABEL_EJECT_PASSES = 2

/** Комфортное расстояние от станции до центра подписи по зонам. */
export const labelPreferredMaxDist = (r: number): number =>
  r < LABEL_CENTER_RADIUS ? 44 : r < LABEL_MIDDLE_RADIUS ? 60 : 84

/**
 * Радиальные смещения кандидатов по зонам.
 *
 * В центре сетка самая мелкая (шаг 2px): свободные от линий «щели» там узкие,
 * и на прежнем шаге 3–6px оптимизатор в них просто не попадал.
 */
const labelRadiusOffsetsForZone = (r: number): number[] => {
  if (r < LABEL_CENTER_RADIUS) return [12, 15, 18, 21, 24, 27, 30, 33, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76]
  if (r < LABEL_MIDDLE_RADIUS) return [12, 15, 18, 21, 25, 29, 33, 38, 43, 49, 56, 63, 70, 78, 86, 94]
  return [12, 16, 20, 24, 29, 34, 40, 47, 55, 64, 74, 84]
}

/**
 * Полный круговой перебор направлений с шагом 6°.
 *
 * Шаг 12° давал на радиусе 44px дугу почти в 9px — свободные коридоры между
 * линиями в центре уже этого, и раскладка их пропускала.
 */
const LABEL_CANDIDATE_ANGLE_COUNT = 60
const LABEL_CANDIDATE_ANGLES: number[] = (() => {
  const out: number[] = []
  for (let i = 0; i < LABEL_CANDIDATE_ANGLE_COUNT; i += 1) {
    out.push((i * Math.PI * 2) / LABEL_CANDIDATE_ANGLE_COUNT)
  }
  return out
})()

/**
 * Варианты горизонтальной привязки прямоугольника подписи к точке-кандидату:
 * 0 — текст вправо от точки, 1 — влево от точки, 2 — по центру точки.
 * Режим 2 нужен для подписей строго над/под станцией: они читаются как
 * «принадлежат этой станции» и не тянутся вбок через соседние линии.
 */
const LABEL_ALIGN_MODES = [0, 1, 2] as const

/** Разбиение названия на две максимально ровные строки (null, если невозможно). */
const splitToTwoLines = (label: string): string[] | null => {
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

/** Дефолтный перенос длинного названия на две строки. */
const splitLabelToLines = (label: string, radialDist: number): string[] => {
  const maxSingleLineChars = radialDist < 260 ? 14 : 18
  if (label.length <= maxSingleLineChars) return [label]
  return splitToTwoLines(label) ?? [label]
}

/**
 * Варианты разбиения названия: дефолтный плюс альтернативный.
 * Оптимизатор сам выберет компактный двухстрочный вариант в тесноте
 * и однострочный там, где место есть.
 */
const labelLineVariantsFor = (label: string, radialDist: number): string[][] => {
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

/** Пересечение двух отрезков (строгое, без касаний в общих концах). */
const labelSegmentsCross = (
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number,
): boolean => {
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

/** Точное пересечение отрезка с прямоугольником (включая «отрезок внутри»). */
const labelSegmentIntersectsRect = (
  seg: { ax: number; ay: number; bx: number; by: number },
  x1: number, y1: number, x2: number, y2: number,
): boolean => {
  if (Math.max(seg.ax, seg.bx) < x1 || Math.min(seg.ax, seg.bx) > x2) return false
  if (Math.max(seg.ay, seg.by) < y1 || Math.min(seg.ay, seg.by) > y2) return false
  const inside = (x: number, y: number) => x >= x1 && x <= x2 && y >= y1 && y <= y2
  if (inside(seg.ax, seg.ay) || inside(seg.bx, seg.by)) return true
  if (labelSegmentsCross(seg.ax, seg.ay, seg.bx, seg.by, x1, y1, x2, y1)) return true
  if (labelSegmentsCross(seg.ax, seg.ay, seg.bx, seg.by, x2, y1, x2, y2)) return true
  if (labelSegmentsCross(seg.ax, seg.ay, seg.bx, seg.by, x2, y2, x1, y2)) return true
  if (labelSegmentsCross(seg.ax, seg.ay, seg.bx, seg.by, x1, y2, x1, y1)) return true
  return false
}

/** Расстояние от точки до прямоугольника (0, если точка внутри). */
const labelPointRectDistance = (
  px: number, py: number, x1: number, y1: number, x2: number, y2: number,
): number => {
  const nx = Math.max(x1, Math.min(px, x2))
  const ny = Math.max(y1, Math.min(py, y2))
  return Math.hypot(px - nx, py - ny)
}

/**
 * Углы-кандидаты, отсортированные по «неудобству» — отклонению от нормали к
 * линии. Порядок влияет только на скорость (хороший кандидат находится сразу,
 * дальше работает ранний отсев), но обязан совпадать с портом в scripts/quality:
 * при равных штрафах побеждает первый найденный кандидат.
 */
const labelAnglesSortedByMisfit = (
  angles: readonly number[], baseAngles: readonly number[],
): { ang: number; misfit: number }[] => {
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
const labelNeighborReach = (ownReach: number, otherWidth: number, otherHeight: number): number =>
  ownReach + otherWidth * 1.25 + otherHeight * 3 + 8

/**
 * Сегменты линий, разложенные по клеткам равномерной сетки.
 * Запрос по клеткам даёт надмножество, точная проверка делается тут же,
 * поэтому размер клетки влияет только на скорость, а не на результат.
 */
class LabelSegmentBuckets {
  private readonly cell: number
  private readonly buckets = new Map<number, number[]>()
  private readonly segs: readonly LabelObstacleSegment[]
  private readonly stamp: Int32Array
  private tick = 0
  private readonly hitLines: number[] = []

  constructor(segments: readonly LabelObstacleSegment[], cell = 96) {
    this.cell = cell
    this.segs = segments
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
          if (labelSegmentIntersectsRect(s, x1, y1, x2, y2)) hit.push(s.lineId)
        }
      }
    }
    return hit.length
  }
}

/** Прямоугольник уже размещённой подписи — то, что видят остальные подписи. */
type DrawnLabelRect = {
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

const makeLabelStaticCache = (size: number): Float64Array => {
  const arr = new Float64Array(size)
  arr.fill(Number.NaN)
  return arr
}

/**
 * Разложить подписи станций.
 *
 * @param measureText ширина строки в мировых px при кегле labelFontPx.
 *   Единственное место, где реализация браузера и Node расходятся: в браузере
 *   это ctx.measureText, в Node — табличное приближение. Всё остальное — общий код.
 */
export function computeStationLabelPlacements(
  measureText: LabelTextMeasurer,
  positionedStations: readonly LabelLayoutStation[],
  labelFontPx: number,
  segmentsByStationId: ReadonlyMap<string, readonly LabelIncidentSegment[]>,
  obstacleSegments: readonly LabelObstacleSegment[],
  ringCenters: ReadonlyMap<number, { cx: number; cy: number }>,
): StationLabelPlacement[] {
  // Зоны схемы (и вся «радиальная» геометрия раскладки) считаются от центра
  // схемы, а не от начала координат: солвер не центрирует раскладку в (0,0).
  const zoneCenter = resolveLabelZoneCenter(ringCenters, positionedStations)

  const hubCenters = new Map<string, { x: number; y: number }>()
  const hubCounts = new Map<string, number>()
  const stationsByHubId = new Map<string, LabelLayoutStation[]>()

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

  // Для подписей объединяем станции в пределах одного хаба: одна подпись на весь
  // хаб для каждого уникального названия, при этом внутри хаба выбираем одно
  // «главное» имя с более высоким приоритетом.
  const labelStations: LabelLayoutStation[] = []
  const hubRepresentative = new Map<string, LabelLayoutStation>()
  for (const st of positionedStations) {
    if (st.hubId != null) {
      const key = `${st.hubId}|${st.title.toLowerCase()}`
      if (!hubRepresentative.has(key)) hubRepresentative.set(key, st)
    } else {
      labelStations.push(st)
    }
  }
  for (const st of hubRepresentative.values()) labelStations.push(st)

  // Главная станция хаба — ближайшая к центру схемы.
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
    } else if (r < LABEL_PRIORITY_CENTER_RADIUS) priority = 2
    else if (r < LABEL_PRIORITY_MIDDLE_RADIUS) priority = 1
    return { st, priority, r, anchorX, anchorY }
  })

  // Кружки всех нарисованных станций: подпись не должна накрывать чужой узел.
  const nodes = positionedStations.map((st) => ({
    id: st.id,
    x: st.x,
    y: st.y,
    radius: st.hubId != null ? LABEL_NODE_RADIUS_HUB : LABEL_NODE_RADIUS_STATION,
  }))

  const ordered = [...stationInfos].sort((a, b) =>
    b.priority !== a.priority ? b.priority - a.priority : a.r - b.r,
  )

  const getSegmentsForLabelStation = (st: LabelLayoutStation): readonly LabelIncidentSegment[] => {
    const direct = segmentsByStationId.get(st.id) ?? []
    if (!st.hubId) return direct
    const hubStations = stationsByHubId.get(st.hubId)
    if (!hubStations || hubStations.length <= 1) return direct
    const result: LabelIncidentSegment[] = [...direct]
    for (const hubSt of hubStations) {
      if (hubSt.id === st.id) continue
      const extra = segmentsByStationId.get(hubSt.id)
      if (!extra || extra.length === 0) continue
      result.push(...extra)
    }
    return result
  }

  const segmentBuckets = new LabelSegmentBuckets(obstacleSegments)

  type PreparedLabel = {
    info: (typeof stationInfos)[number]
    stationIds: string[]
    variants: { lines: string[]; width: number; height: number; deviation: number }[]
    /** Углы-кандидаты, отсортированные по «неудобству». */
    angles: { ang: number; misfit: number }[]
    radialAngle: number | null
    isRing: boolean
    radiusOffsets: number[]
    preferred: number
    nearNodes: { x: number; y: number; radius: number }[]
    /** Кружки СВОИХ станций: вокруг них резервируется место под маркер A/B. */
    ownNodes: { x: number; y: number }[]
    nearAnchors: { x: number; y: number }[]
    /** Насколько далеко от станции вообще может оказаться прямоугольник подписи. */
    reach: number
    /**
     * Кеш «статических» штрафов кандидата (узлы, неоднозначность, пересечения с
     * линиями). Геометрия кандидата от прохода к проходу не меняется, а линии и
     * станции неподвижны — значит эти слагаемые считаются один раз. NaN = ещё не
     * считали.
     */
    staticCache: Float64Array
  }

  const lineHeight = labelFontPx + 2
  const lineSpacing = labelFontPx * 0.12

  const prepared: PreparedLabel[] = []
  for (const info of ordered) {
    const st = info.st
    if (!st.title) continue

    const hubStations = st.hubId != null ? stationsByHubId.get(st.hubId) : undefined
    const stationIds =
      hubStations && hubStations.length > 0 ? hubStations.map((s) => s.id) : [st.id]
    const ownNodeIds = new Set(stationIds)

    const defaultLines = splitLabelToLines(st.title, info.r)
    const variants = labelLineVariantsFor(st.title, info.r).map((lines) => {
      let width = 0
      for (const ln of lines) width = Math.max(width, measureText(ln))
      const height = lineHeight * lines.length + lineSpacing * Math.max(0, lines.length - 1)
      const deviation = lines.length === defaultLines.length ? 0 : LABEL_W.lineBreakDeviation
      return { lines, width, height, deviation }
    })

    const segmentsForStation = getSegmentsForLabelStation(st)
    const isRing = typeof st.lineId === 'number' && RING_LINE_IDS.has(st.lineId)
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
    const radiusOffsets = labelRadiusOffsetsForZone(info.r)
    let maxWidth = 0
    let maxHeight = 0
    for (const v of variants) {
      if (v.width > maxWidth) maxWidth = v.width
      if (v.height > maxHeight) maxHeight = v.height
    }
    const reach = radiusOffsets[radiusOffsets.length - 1] + maxWidth + maxHeight

    // Префильтры-надмножества: всё, что дальше, на штраф повлиять не может.
    const nodeReach = reach + LABEL_NODE_RADIUS_HUB + LABEL_W.clearanceGap
    const nearNodes: { x: number; y: number; radius: number }[] = []
    const ownNodes: { x: number; y: number }[] = []
    for (const n of nodes) {
      if (ownNodeIds.has(n.id)) {
        ownNodes.push({ x: n.x, y: n.y })
        continue
      }
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
      angles: labelAnglesSortedByMisfit(LABEL_CANDIDATE_ANGLES, baseAngles),
      radialAngle,
      isRing,
      radiusOffsets,
      preferred: labelPreferredMaxDist(info.r),
      nearNodes,
      ownNodes,
      nearAnchors,
      reach,
      staticCache: makeLabelStaticCache(
        variants.length *
          radiusOffsets.length *
          LABEL_CANDIDATE_ANGLES.length *
          LABEL_ALIGN_MODES.length,
      ),
    })
  }

  type BestCandidate = StationLabelPlacement & { score: number; drawn: DrawnLabelRect }

  const slots: (DrawnLabelRect | null)[] = prepared.map(() => null)
  const chosen: (StationLabelPlacement | null)[] = prepared.map(() => null)

  /** Зафиксировать выбранную позицию подписи. */
  const finish = (index: number, best: BestCandidate): void => {
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

    const neighbors: DrawnLabelRect[] = []
    for (let j = 0; j < slots.length; j += 1) {
      if (j === index) continue
      const s = slots[j]
      if (!s) continue
      const reach = labelNeighborReach(p.reach, s.width, s.height)
      if (Math.abs(s.centerX - anchorX) < reach && Math.abs(s.centerY - anchorY) < reach) {
        neighbors.push(s)
      }
    }

    let best: BestCandidate | null = null

    const nAngles = p.angles.length
    const nModes = LABEL_ALIGN_MODES.length

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

          const angleCost = candidate.misfit * LABEL_W.angleMisfit + variant.deviation

          const px = anchorX + Math.cos(ang) * rOffset
          const py = anchorY + Math.sin(ang) * rOffset

          const candidateBase = ((vi * p.radiusOffsets.length + ri) * nAngles + ai) * nModes

          for (const mode of LABEL_ALIGN_MODES) {
            const x1 = mode === 0 ? px : mode === 1 ? px - textWidth : px - textWidth / 2
            const y1 = py - textHeight / 2
            const x2 = x1 + textWidth
            const y2 = y1 + textHeight
            const cx = (x1 + x2) / 2
            const cy = (y1 + y2) / 2

            const distToStation = Math.hypot(cx - anchorX, cy - anchorY)
            let score = angleCost + distToStation * LABEL_W.distLinear
            if (distToStation > p.preferred) {
              const over = distToStation - p.preferred
              score += LABEL_W.detachedStep + over * over * LABEL_W.detachedQuad
            }
            // Ранний отсев: остальные слагаемые неотрицательны, поэтому кандидат
            // с таким «дешёвым» счётом уже не может обойти найденный лучший.
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
                      LABEL_W.softRepulsionY *
                      ((softGapYThreshold - gapY) / Math.max(softGapYThreshold, 1))
                  }
                }
                if (yOverlap) {
                  const gapX = x1 > r.x2 ? x1 - r.x2 : r.x1 - x2
                  if (gapX < softGapXThreshold) {
                    soft +=
                      LABEL_W.softRepulsionX *
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
                if (inAura) soft += LABEL_W.aura
              }
              const columnWidth = Math.max(textWidth, r.width) * 0.35
              if (Math.abs(cx - r.centerX) < columnWidth) {
                const normDy = Math.abs(cy - r.centerY) / Math.max(textHeight, r.height)
                if (normDy < 3) soft += LABEL_W.column * ((3 - normDy) / 3)
              }
            }
            if (overlaps) score += LABEL_W.labelOverlap
            score += soft
            if (best && score >= best.score) continue

            const cacheKey = candidateBase + mode
            let staticCost = p.staticCache[cacheKey]
            if (Number.isNaN(staticCost)) {
              staticCost = 0
              for (const n of p.nearNodes) {
                const d = labelPointRectDistance(n.x, n.y, x1, y1, x2, y2) - n.radius
                if (d <= 0) {
                  staticCost += LABEL_W.coverStation
                  break
                }
                if (d < LABEL_W.clearanceGap) {
                  staticCost +=
                    LABEL_W.clearance * ((LABEL_W.clearanceGap - d) / LABEL_W.clearanceGap)
                }
              }
              for (const n of p.ownNodes) {
                if (
                  labelPointRectDistance(n.x, n.y, x1, y1, x2, y2) <
                  LABEL_ENDPOINT_BADGE_RADIUS
                ) {
                  staticCost += LABEL_W.endpointBadge
                  break
                }
              }
              for (const a of p.nearAnchors) {
                const d2 = (a.x - cx) ** 2 + (a.y - cy) ** 2
                if (d2 + 1e-3 < distToStation * distToStation) {
                  staticCost += LABEL_W.ambiguous
                  break
                }
              }
              const crossing = segmentBuckets.countCrossingLines(x1, y1, x2, y2)
              if (crossing > 0) {
                staticCost += LABEL_W.lineCrossFirst + (crossing - 1) * LABEL_W.lineCrossMore
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
  for (let pass = 0; pass < LABEL_REFINE_PASSES; pass += 1) {
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

  for (let pass = 0; pass < LABEL_EJECT_PASSES; pass += 1) {
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

  const placements: StationLabelPlacement[] = []
  for (const c of chosen) if (c) placements.push(c)
  return placements
}
