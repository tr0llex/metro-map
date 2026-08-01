/**
 * Русские формы множественного числа.
 *
 * Интерфейс на «ты» и старается звучать по-человечески, поэтому «3 станций» и
 * «Пересадок: 0» в нём выглядят как недоделка. Правило стандартное:
 * 11–14 — всегда родительный множественного, дальше решает последняя цифра.
 */
export type PluralForms = readonly [one: string, few: string, many: string]

export function pluralRu(count: number, forms: PluralForms): string {
  const abs = Math.abs(Math.trunc(count))
  const mod100 = abs % 100
  if (mod100 >= 11 && mod100 <= 14) return forms[2]

  const mod10 = abs % 10
  if (mod10 === 1) return forms[0]
  if (mod10 >= 2 && mod10 <= 4) return forms[1]
  return forms[2]
}

export const STATION_FORMS: PluralForms = ['станция', 'станции', 'станций']
export const TRANSFER_FORMS: PluralForms = ['пересадка', 'пересадки', 'пересадок']
export const MINUTE_FORMS: PluralForms = ['минута', 'минуты', 'минут']
export const VARIANT_FORMS: PluralForms = ['вариант', 'варианта', 'вариантов']

/** «1 станция», «2 станции», «11 станций». */
export function formatStationsCount(count: number): string {
  return `${count} ${pluralRu(count, STATION_FORMS)}`
}

/**
 * «Без пересадок» / «1 пересадка» / «2 пересадки».
 * Ноль — отдельная фраза: «Пересадок: 0» человек читает как отсутствие данных.
 */
export function formatTransfersCount(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return 'Без пересадок'
  return `${count} ${pluralRu(count, TRANSFER_FORMS)}`
}

/** Тот же смысл, но для мест, где нужен родительный падеж: «пересадок: 2». */
export function formatTransfersForAria(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return 'без пересадок'
  return `${count} ${pluralRu(count, TRANSFER_FORMS)}`
}

export function formatMinutesCount(count: number): string {
  return `${count} ${pluralRu(count, MINUTE_FORMS)}`
}

export function formatVariantsCount(count: number): string {
  return `${count} ${pluralRu(count, VARIANT_FORMS)}`
}
