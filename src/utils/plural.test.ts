import { describe, expect, it } from 'vitest'

import {
  formatStationsCount,
  formatTransfersCount,
  formatTransfersForAria,
  formatVariantsCount,
  pluralRu,
} from './plural.ts'

const FORMS = ['яблоко', 'яблока', 'яблок'] as const

describe('pluralRu — русские формы множественного числа', () => {
  it('единственное число только у 1, 21, 101', () => {
    for (const n of [1, 21, 101, 1001]) expect(pluralRu(n, FORMS), String(n)).toBe('яблоко')
  })

  it('второе число у 2–4 и их «двадцать вторых»', () => {
    for (const n of [2, 3, 4, 22, 33, 104]) expect(pluralRu(n, FORMS), String(n)).toBe('яблока')
  })

  /** Ловушка русского счёта: 11–14 идут в родительный, хотя оканчиваются на 1–4. */
  it('11–14 всегда родительный, несмотря на последнюю цифру', () => {
    for (const n of [11, 12, 13, 14, 111, 112, 113, 114]) {
      expect(pluralRu(n, FORMS), String(n)).toBe('яблок')
    }
  })

  it('0, 5–9 и 20 — родительный', () => {
    for (const n of [0, 5, 9, 20, 25, 100]) expect(pluralRu(n, FORMS), String(n)).toBe('яблок')
  })

  it('знак и дробная часть не влияют на форму', () => {
    expect(pluralRu(-1, FORMS)).toBe('яблоко')
    expect(pluralRu(-13, FORMS)).toBe('яблок')
    expect(pluralRu(2.7, FORMS)).toBe('яблока')
  })
})

describe('форматирование счётчиков интерфейса', () => {
  it('станции', () => {
    expect(formatStationsCount(1)).toBe('1 станция')
    expect(formatStationsCount(3)).toBe('3 станции')
    expect(formatStationsCount(11)).toBe('11 станций')
  })

  /**
   * Ноль — отдельная фраза. «Пересадок: 0» человек читает как отсутствие
   * данных, а не как прямой маршрут.
   */
  it('ноль пересадок — словами, а не цифрой', () => {
    expect(formatTransfersCount(0)).toBe('Без пересадок')
    expect(formatTransfersForAria(0)).toBe('без пересадок')
  })

  it('отрицательное и нечисловое приравнены к нулю, а не печатаются как есть', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatTransfersCount(bad)).toBe('Без пересадок')
      expect(formatTransfersForAria(bad)).toBe('без пересадок')
    }
  })

  it('пересадки: та же форма, разный регистр первой буквы', () => {
    expect(formatTransfersCount(1)).toBe('1 пересадка')
    expect(formatTransfersForAria(1)).toBe('1 пересадка')
    expect(formatTransfersCount(2)).toBe('2 пересадки')
    expect(formatTransfersCount(5)).toBe('5 пересадок')
  })

  it('варианты маршрута', () => {
    expect(formatVariantsCount(1)).toBe('1 вариант')
    expect(formatVariantsCount(2)).toBe('2 варианта')
    expect(formatVariantsCount(6)).toBe('6 вариантов')
  })
})
