/**
 * Приближение ctx.measureText для шрифта подписей станций
 * (system-ui / Segoe UI, weight 400, кириллица).
 *
 * В Node нет Canvas, поэтому ширина считается по таблице относительных ширин
 * символов. Погрешность на реальных названиях станций — порядка ±4%,
 * чего достаточно для метрик пересечений подписей (они оперируют десятками
 * пикселей). Это осознанное упрощение, см. docs/QUALITY.md.
 */

const NARROW = new Set([...' .,:;!|\'’"`ilIjt()[]{}fr-'])
const WIDE = new Set([...'мшщжфыюМШЩЖФЫЮWMmw@%'])
const MEDIUM_UPPER = /[A-ZА-ЯЁ]/

function charFactor(ch: string): number {
  if (NARROW.has(ch)) return 0.3
  if (WIDE.has(ch)) return 0.82
  if (MEDIUM_UPPER.test(ch)) return 0.65
  if (ch >= '0' && ch <= '9') return 0.56
  return 0.535
}

const cache = new Map<string, number>()

/** Ширина строки в пикселях при заданном размере шрифта. */
export function measureText(text: string, fontPx: number): number {
  const cached = cache.get(text)
  if (cached !== undefined) return cached * fontPx
  let sum = 0
  for (const ch of text) sum += charFactor(ch)
  cache.set(text, sum)
  return sum * fontPx
}
