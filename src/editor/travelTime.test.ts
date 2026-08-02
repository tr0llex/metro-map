import { describe, expect, it } from 'vitest'

import { formatTravelTime, parseTravelTime } from './travelTime.ts'

describe('показ времени', () => {
  it('секунды разворачиваются в м:сс', () => {
    expect(formatTravelTime(173)).toBe('2:53')
    expect(formatTravelTime(60)).toBe('1:00')
    expect(formatTravelTime(0)).toBe('0:00')
  })

  it('секунды меньше десяти дополняются нулём', () => {
    expect(formatTravelTime(65)).toBe('1:05')
  })

  it('меньше минуты — нулевые минуты, а не пустое место', () => {
    expect(formatTravelTime(42)).toBe('0:42')
  })

  it('мусор не показывается', () => {
    expect(formatTravelTime(Number.NaN)).toBe('')
    expect(formatTravelTime(-5)).toBe('')
  })
})

describe('разбор времени', () => {
  it('принимает м:сс', () => {
    expect(parseTravelTime('2:53')).toBe(173)
    expect(parseTravelTime('0:42')).toBe(42)
    expect(parseTravelTime('10:00')).toBe(600)
  })

  it('принимает голые секунды: пересчитывать в уме не требуется', () => {
    expect(parseTravelTime('173')).toBe(173)
    expect(parseTravelTime('60')).toBe(60)
  })

  it('секунды без ведущего нуля — это те же секунды', () => {
    expect(parseTravelTime('2:5')).toBe(125)
  })

  it('пробелы по краям не мешают', () => {
    expect(parseTravelTime('  2:53  ')).toBe(173)
  })

  it('пустая строка — не ноль, а отсутствие значения', () => {
    expect(parseTravelTime('')).toBeNull()
    expect(parseTravelTime('   ')).toBeNull()
  })

  it('мусор отвергается', () => {
    expect(parseTravelTime('две минуты')).toBeNull()
    expect(parseTravelTime('2:53:10')).toBeNull()
    expect(parseTravelTime('-5')).toBeNull()
    expect(parseTravelTime('2.5')).toBeNull()
  })

  /** «2:75» — почти наверняка опечатка; истолковать её молча хуже, чем отвергнуть. */
  it('секунды сверх 59 отвергаются, а не переносятся в минуты', () => {
    expect(parseTravelTime('2:75')).toBeNull()
  })

  it('ноль записывается честно', () => {
    expect(parseTravelTime('0:00')).toBe(0)
    expect(parseTravelTime('0')).toBe(0)
  })
})

/**
 * Главное свойство: круг «показать → разобрать» обязан вернуть ровно то же
 * число. Прежняя пара Math.round(sec/60) / Math.round(min*60) его не имела —
 * ровно поэтому щелчок в поле и щелчок мимо портили значение.
 */
describe('круг показ → разбор', () => {
  it('возвращает исходные секунды на всех значениях из данных', () => {
    for (let seconds = 0; seconds <= 1200; seconds += 1) {
      expect(parseTravelTime(formatTravelTime(seconds))).toBe(seconds)
    }
  })
})
