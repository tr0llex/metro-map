import { describe, expect, it } from 'vitest'
import { fullGraphStations } from '../metro/fullGraph'
import { rankStationCandidates, scoreStationTitle } from './stationSearch'
import { formatStationsCount, formatTransfersCount, pluralRu } from './plural'

const candidates = fullGraphStations.map((s) => ({ id: s.id, title: s.title }))

function firstTitle(query: string): string | undefined {
  return rankStationCandidates(candidates, query, 8)[0]?.title
}

describe('ранжирование подсказок станций', () => {
  // S-3: ровно эти четыре ввода давали ДРУГУЮ станцию по Enter.
  it.each([
    ['Аэропорт', 'Аэропорт'],
    ['Сокол', 'Сокол'],
    ['Косино', 'Косино'],
    ['Лихоборы', 'Лихоборы'],
  ])('точное название «%s» стоит первым', (query, expected) => {
    expect(firstTitle(query)).toBe(expected)
  })

  it('нечувствительно к регистру и к «ё»', () => {
    expect(firstTitle('мневники')).toBe('Мнёвники')
    expect(firstTitle('МНЁВНИКИ')).toBe('Мнёвники')
    expect(firstTitle('савеловская')).toBe('Савёловская')
    // Обратное направление: в данных название через «е», а вводят с «ё».
    // «Планерная» — единственная такая станция на схеме; у остальных, где
    // путаница возможна, официальное написание как раз через «ё».
    expect(firstTitle('планёрная')).toBe('Планерная')
  })

  it('префикс важнее совпадения в середине слова', () => {
    const titles = rankStationCandidates(candidates, 'пар', 8).map((s) => s.title)
    const parkKulturyIndex = titles.indexOf('Парк культуры')
    const tropareoIndex = titles.indexOf('Тропарёво')
    expect(parkKulturyIndex).toBeGreaterThanOrEqual(0)
    if (tropareoIndex >= 0) {
      expect(parkKulturyIndex).toBeLessThan(tropareoIndex)
    }
  })

  it('лимит применяется после сортировки, а не до неё', () => {
    // «сокол» в порядке данных отдаёт сначала Сокольники — нужная станция
    // обязана остаться первой независимо от того, сколько всего совпадений.
    expect(rankStationCandidates(candidates, 'сокол', 2)[0]?.title).toBe('Сокол')
  })

  it('пустой запрос не даёт подсказок', () => {
    expect(rankStationCandidates(candidates, '   ', 8)).toEqual([])
  })

  it('оценка совпадения упорядочена от точного к вхождению', () => {
    expect(scoreStationTitle('Сокол', 'сокол')).toBe(0)
    expect(scoreStationTitle('Сокольники', 'сокол')).toBe(1)
    expect(scoreStationTitle('Парк культуры', 'культуры')).toBe(2)
    expect(scoreStationTitle('Тропарёво', 'пар')).toBe(3)
    expect(scoreStationTitle('Сокол', 'динамо')).toBeNull()
  })
})

describe('русские формы множественного числа', () => {
  it('склоняет станции', () => {
    expect(formatStationsCount(1)).toBe('1 станция')
    expect(formatStationsCount(2)).toBe('2 станции')
    expect(formatStationsCount(3)).toBe('3 станции')
    expect(formatStationsCount(5)).toBe('5 станций')
    expect(formatStationsCount(11)).toBe('11 станций')
    expect(formatStationsCount(21)).toBe('21 станция')
    expect(formatStationsCount(112)).toBe('112 станций')
  })

  it('ноль пересадок — отдельная фраза', () => {
    expect(formatTransfersCount(0)).toBe('Без пересадок')
    expect(formatTransfersCount(1)).toBe('1 пересадка')
    expect(formatTransfersCount(2)).toBe('2 пересадки')
    expect(formatTransfersCount(5)).toBe('5 пересадок')
  })

  it('работает на границе 11–14', () => {
    const forms = ['минута', 'минуты', 'минут'] as const
    expect(pluralRu(11, forms)).toBe('минут')
    expect(pluralRu(14, forms)).toBe('минут')
    expect(pluralRu(101, forms)).toBe('минута')
  })
})
