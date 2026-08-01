/**
 * Общие типы системы оценки качества схемы метро.
 *
 * Принцип: каждая метрика отвечает на вопрос «что конкретно пользователь
 * увидит плохого на схеме». Метрики считаются в тех же координатах и с теми же
 * визуальными константами, что использует рантайм (src/components/MetroMap.tsx).
 */

export type MetricCategory = 'integrity' | 'hubs' | 'rings' | 'geometry' | 'labels'

/** Направление «лучше»: lower — меньше значит лучше, higher — больше значит лучше. */
export type MetricDirection = 'lower' | 'higher'

/**
 * INFO — справочная величина: считается и печатается, но целью не является,
 * в сводку и оценку не входит.
 */
export type Verdict = 'PASS' | 'WARN' | 'FAIL' | 'INFO'

/** Конкретный виновник провала метрики — используется как список задач. */
export interface Offender {
  /** id станции / хаба / линии / пары — стабильный, пригоден для поиска в fullGraph.json. */
  id: string
  /** Человекочитаемое имя (название станции, хаба и т.п.). */
  label: string
  /** Числовое значение нарушения в единицах метрики. */
  value: number
  /** Дополнительное пояснение: что именно не так. */
  detail?: string
}

export interface MetricResult {
  id: string
  category: MetricCategory
  /** Короткое человеческое название метрики. */
  name: string
  /** Единица измерения: 'px', '%', 'шт', 'дег'. */
  unit: string
  value: number
  target: number
  fail: number
  direction: MetricDirection
  verdict: Verdict
  /**
   * Справочная величина: печатается, но целью не является и в сводку/оценку
   * не входит. Для таких метрик `target`/`fail` не имеют смысла.
   */
  informational?: boolean
  /** Одно-два предложения: что видит пользователь, если метрика проваливается. */
  description: string
  offenders: Offender[]
}

export interface QualityReport {
  /** Версия схемы отчёта, растёт при несовместимых изменениях набора метрик. */
  schemaVersion: number
  source: string
  summary: {
    total: number
    pass: number
    warn: number
    fail: number
    /** Итоговый вердикт: худший из вердиктов метрик. */
    verdict: Verdict
    /** 0..100, взвешенная оценка (PASS=100, WARN=50, FAIL=0). */
    score: number
  }
  metrics: MetricResult[]
}

// ---------------------------------------------------------------------------
// Формат normalized/fullGraph.json (проверено по данным, а не по документации)
// ---------------------------------------------------------------------------

export interface RawLine {
  id: number
  title: string
  colorHex: string
  stationIds: string[]
}

export interface RawStation {
  id: string
  title: string
  lineNumericId: number
  isTransfer?: boolean
  hubId?: string
  lat?: number
  lon?: number
  layoutX?: number
  layoutY?: number
  yandexX?: number
  yandexY?: number
}

export interface RawEdge {
  fromStationId: string
  toStationId: string
  lineNumericId?: number
  medianTravelSeconds?: number
  isTransfer?: boolean
  transferKind?: string
}

export interface RawHub {
  id: string
  stationIds: string[]
  minTransferSeconds?: number
  source?: string
}

/**
 * Формы кольцевых линий, посчитанные оффлайн-солвером (ключ — ID линии строкой).
 * Поле необязательное: у данных, собранных до переноса проекции в солвер, его нет.
 */
export type RawRingShape =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }

export interface RawGraph {
  lines: RawLine[]
  stations: RawStation[]
  edges: RawEdge[]
  transferHubs: RawHub[]
  ringShapes?: Record<string, RawRingShape>
}

export const MAX_OFFENDERS = 10

/** Присвоение вердикта по значению и порогам. */
export function verdictFor(
  value: number,
  target: number,
  fail: number,
  direction: MetricDirection,
): Verdict {
  if (!Number.isFinite(value)) return 'FAIL'
  if (direction === 'lower') {
    if (value <= target) return 'PASS'
    return value <= fail ? 'WARN' : 'FAIL'
  }
  if (value >= target) return 'PASS'
  return value >= fail ? 'WARN' : 'FAIL'
}

/** Собирает MetricResult, обрезая список offenders до MAX_OFFENDERS. */
export function makeMetric(
  input: Omit<MetricResult, 'verdict'> & { verdict?: Verdict },
): MetricResult {
  const offenders = [...input.offenders]
    .sort((a, b) => (b.value - a.value) || a.id.localeCompare(b.id))
    .slice(0, MAX_OFFENDERS)
    .map((o) => ({ ...o, value: round(o.value) }))

  return {
    ...input,
    value: round(input.value),
    target: round(input.target),
    fail: round(input.fail),
    offenders,
    verdict: input.informational
      ? 'INFO'
      : (input.verdict ?? verdictFor(input.value, input.target, input.fail, input.direction)),
  }
}

/** Округление до 2 знаков — отчёт должен быть diff-friendly. */
export function round(v: number): number {
  if (!Number.isFinite(v)) return v
  return Math.round(v * 100) / 100
}
