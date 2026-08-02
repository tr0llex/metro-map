/**
 * Время перегона и пересадки: разбор и показ.
 *
 * ПОЧЕМУ НЕ МИНУТЫ. Поле в редакторе было целочисленным в минутах, а в данных
 * 284 из 291 перегона хранят секунды, не кратные 60. Показывалось
 * Math.round(sec / 60), записывалось Math.round(min * 60) — то есть 173 с
 * показывались как «3» и записывались обратно как 180 с. Проверки «человек
 * ничего не менял» не было: хватало щелчка в поле и щелчка мимо, чтобы правка
 * засчиталась и уехала в файл. Минуты как единица физически не способны
 * выразить 97% значений в данных.
 *
 * ПОЧЕМУ НЕ ГОЛЫЕ СЕКУНДЫ. «173» — точно, но нечитаемо: глазом не видно, это
 * две минуты или три. Формат «м:сс» читается сразу и при этом не теряет ни
 * секунды.
 *
 * Ввод принимается в обоих видах: «2:53» и «173» — одно и то же. Так правка
 * времени не требует считать в уме ни туда, ни обратно.
 */

/** Секунды → «м:сс». Ноль секунд — «0:00», не пустая строка. */
export function formatTravelTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return ''
  const total = Math.round(seconds)
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

/**
 * «2:53», «173», «2:5» → секунды. Возвращает null, если разобрать нельзя, —
 * вызывающий обязан отличить «пусто/мусор» от честного нуля.
 *
 * Секунды сверх 59 в форме «м:сс» не допускаются: «2:75» — это почти наверняка
 * опечатка, а не 195 секунд, и молча её истолковать хуже, чем отвергнуть.
 */
export function parseTravelTime(text: string): number | null {
  const raw = text.trim()
  if (raw === '') return null

  const colon = raw.indexOf(':')
  if (colon === -1) {
    if (!/^\d+$/.test(raw)) return null
    return Number(raw)
  }

  const minutesPart = raw.slice(0, colon)
  const secondsPart = raw.slice(colon + 1)
  if (!/^\d+$/.test(minutesPart) || !/^\d{1,2}$/.test(secondsPart)) return null

  const seconds = Number(secondsPart)
  if (seconds > 59) return null

  return Number(minutesPart) * 60 + seconds
}
