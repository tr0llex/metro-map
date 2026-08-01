import type { LayoutRingShape } from '../metro/types.ts'

export type BuildLayoutFileInput = {
  /** Координаты станций в текущем состоянии редактора. */
  layout: Record<string, { x: number; y: number }>
  /** Формы кольцевых линий, как их сейчас видит рантайм. */
  canonicalRingShapes: Record<string, LayoutRingShape>
  /**
   * Зафиксировать формы колец в файле. По умолчанию false — см. комментарий
   * к `buildLayoutFile`. Вызывающий обязан спросить это у человека явно.
   */
  includeRingShapes?: boolean
}

export type LayoutFile = {
  $readme: string[]
  stations: Record<string, [number, number]>
  rings: Record<string, LayoutRingShape>
}

const README = [
  'Координаты станций на схеме: "id": [x, y]. Правится редактором',
  '(npm run dev:editor -> «Скопировать раскладку»), руками — только точечно.',
  '`rings` пустой — формы кольцевых линий подбираются автоматически по',
  'координатам станций; заполненный ключ ЖЁСТКО задаёт форму.',
]

/**
 * Собирает содержимое `data/layout.json` из текущего состояния редактора.
 *
 * Раньше редактор выгружал `normalized/editor_overrides.json` — слой правок
 * поверх собранной схемы, где кроме координат были ещё названия станций,
 * состав линий, времена рёбер и параметры узлов. Смысла в этом слое больше нет:
 * всё перечисленное правится прямо в `data/lines/*.json` и `data/transfers.json`,
 * а держать два места, где можно задать одно и то же, — гарантированное
 * расхождение. Координаты остались единственным, что действительно удобнее
 * расставлять мышью, поэтому редактор экспортирует только их.
 *
 * `rings` пишется ТОЛЬКО по явному запросу (`includeRingShapes`). Солвер
 * подбирает форму кольца по станциям; молчаливая запись ключа переключила бы
 * геометрию на жёстко заданную форму без единого следа в выводе.
 */
export function buildLayoutFile(input: BuildLayoutFileInput): LayoutFile {
  const { layout, canonicalRingShapes, includeRingShapes } = input

  const stations: Record<string, [number, number]> = {}
  // Ключи сортируем: файл лежит в git, и порядок обхода объекта не должен
  // превращать правку одной станции в диф на все триста.
  for (const id of Object.keys(layout).sort(compareByCodePoints)) {
    const p = layout[id]
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue
    stations[id] = [p.x, p.y]
  }

  const rings: Record<string, LayoutRingShape> = {}
  if (includeRingShapes) {
    for (const key of Object.keys(canonicalRingShapes).sort(compareByCodePoints)) {
      rings[key] = canonicalRingShapes[key]
    }
  }

  return { $readme: README, stations, rings }
}

/**
 * Сравнение строк по кодовым точкам — ровно то, что делает `sort.Strings` в Go
 * (там сравниваются байты UTF-8, а их порядок совпадает с порядком кодовых
 * точек). Штатный `Array.prototype.sort()` сортирует по кодовым ЕДИНИЦАМ UTF-16
 * и на суррогатных парах расходится с Go. Для нынешних ASCII-идентификаторов
 * разницы нет, но порядок обязан совпадать с Go по построению, а не по удаче.
 */
export function compareByCodePoints(a: string, b: string): number {
  const ac = Array.from(a)
  const bc = Array.from(b)
  const n = Math.min(ac.length, bc.length)
  for (let i = 0; i < n; i += 1) {
    const diff = ac[i].codePointAt(0)! - bc[i].codePointAt(0)!
    if (diff !== 0) return diff
  }
  return ac.length - bc.length
}
