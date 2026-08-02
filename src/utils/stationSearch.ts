/**
 * Ранжирование подсказок станций.
 *
 * Раньше подсказки строились простым `includes` и обрезались по первым шести
 * совпадениям в порядке данных, а Enter брал первый элемент. Из-за этого ввод
 * точного названия давал ДРУГУЮ станцию: «Аэропорт» → «Аэропорт Внуково»,
 * «Сокол» → «Сокольники», «Косино» → «Новокосино», «Лихоборы» → «Верхние
 * Лихоборы». Плюс отсутствовала нормализация «ё»: «мневники» не находило
 * ничего, хотя «мнёвники» находило.
 */

/**
 * Регистр вниз, «ё» → «е», схлопывание пробелов. `\s` в JS покрывает и
 * неразрывный пробел, который встречается и в данных, и в вводе с телефона.
 */
export function normalizeStationText(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Дополнительно выкидывает пробелы, дефисы и точки — для «свободного» поиска. */
function squashStationText(value: string): string {
  return normalizeStationText(value).replace(
    /[\s\-–—.,'’«»"()]/g,
    '',
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Насколько хорошо название подходит запросу. Меньше — лучше.
 * `null` — не подходит вовсе.
 *
 * 0 — точное совпадение,
 * 1 — название начинается с запроса,
 * 2 — с запроса начинается какое-то слово названия,
 * 3 — запрос встречается внутри названия,
 * 4 — совпадение только без пробелов и дефисов.
 */
export function scoreStationTitle(title: string, normalizedQuery: string): number | null {
  if (!normalizedQuery) return null

  const normalizedTitle = normalizeStationText(title)

  if (normalizedTitle === normalizedQuery) return 0
  if (normalizedTitle.startsWith(normalizedQuery)) return 1

  const wordStart = new RegExp(
    `[\\s\\-–—(«"'/]${escapeRegExp(normalizedQuery)}`,
  )
  if (wordStart.test(normalizedTitle)) return 2

  if (normalizedTitle.includes(normalizedQuery)) return 3

  const squashedQuery = squashStationText(normalizedQuery)
  if (squashedQuery && squashStationText(title).includes(squashedQuery)) return 4

  return null
}

export type StationSearchCandidate = {
  id: string
  title: string
  color?: string
  /** Название линии. Показывается, только когда название станции неуникально. */
  lineTitle?: string
}

type Scored = { item: StationSearchCandidate; score: number; order: number }

/**
 * Сортировка: сначала по качеству совпадения, потом более короткое название
 * (при равном качестве «Сокол» должен опережать «Соколиная Гора»),
 * потом — исходный порядок данных, чтобы результат был устойчивым.
 *
 * Важно: лимит применяется ПОСЛЕ сортировки. Раньше обрезка шла до неё, и
 * нужная станция могла вообще не попасть в список.
 */
export function rankStationCandidates(
  candidates: Iterable<StationSearchCandidate>,
  query: string,
  limit: number,
): StationSearchCandidate[] {
  const normalizedQuery = normalizeStationText(query)
  if (!normalizedQuery) return []

  const scored: Scored[] = []
  let order = 0

  for (const item of candidates) {
    const score = scoreStationTitle(item.title, normalizedQuery)
    order += 1
    if (score == null) continue
    scored.push({ item, score, order })
  }

  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score
    if (a.item.title.length !== b.item.title.length) {
      return a.item.title.length - b.item.title.length
    }
    return a.order - b.order
  })

  return scored.slice(0, limit).map((entry) => entry.item)
}
