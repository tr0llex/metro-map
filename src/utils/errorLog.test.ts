// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearErrorLog,
  formatErrorLogForShare,
  readErrorLog,
  recordError,
  subscribeErrorLog,
  type ErrorLogEntry,
} from './errorLog.ts'

const STORAGE_KEY = 'metro-map-error-log-v1'
const MAX_ENTRIES = 20
const DEDUPE_WINDOW_MS = 4000

beforeEach(() => {
  window.localStorage.clear()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('readErrorLog — разбор того, что лежит в хранилище', () => {
  it('пустое хранилище — пустой журнал', () => {
    expect(readErrorLog()).toEqual([])
  })

  it('не-JSON и не-массив трактуются как пустой журнал, а не роняют чтение', () => {
    for (const bad of ['{', 'null', '"строка"', '{"a":1}', '42']) {
      window.localStorage.setItem(STORAGE_KEY, bad)
      expect(readErrorLog(), bad).toEqual([])
    }
  })

  /**
   * Ровно тот класс поломки, из-за которого приложение уходило в вечный цикл
   * падений: битый элемент ВНУТРИ массива. Проверять только Array.isArray мало.
   */
  it('битые элементы внутри массива выбрасываются, годные остаются', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        null,
        { at: 1, message: 'ок', kind: 'error', count: 1 },
        { message: 'нет времени' },
        { at: 2 },
        'строка',
      ]),
    )
    const log = readErrorLog()
    expect(log).toHaveLength(1)
    expect(log[0].message).toBe('ок')
  })

  it('неизвестный kind приводится к error, а не протекает наружу', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ at: 1, message: 'm', kind: 'взрыв', count: 1 }]),
    )
    expect(readErrorLog()[0].kind).toBe('error')
  })

  it('kind promise и render сохраняются', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { at: 1, message: 'a', kind: 'promise' },
        { at: 2, message: 'b', kind: 'render' },
      ]),
    )
    expect(readErrorLog().map((e) => e.kind)).toEqual(['promise', 'render'])
  })

  it('нулевой и отрицательный count чинится на 1', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ at: 1, message: 'm', count: 0 }, { at: 2, message: 'n', count: -5 }]),
    )
    expect(readErrorLog().map((e) => e.count)).toEqual([1, 1])
  })
})

describe('recordError', () => {
  it('пишет Error с именем, сообщением и стеком', () => {
    recordError('error', new TypeError('нельзя так'))
    const [entry] = readErrorLog()
    expect(entry.message).toBe('TypeError: нельзя так')
    expect(entry.kind).toBe('error')
    expect(entry.count).toBe(1)
    expect(entry.stack).toBeTruthy()
  })

  it('строка записывается как есть', () => {
    recordError('promise', 'просто текст')
    expect(readErrorLog()[0].message).toBe('просто текст')
  })

  it('объект сериализуется, а несериализуемый не роняет запись', () => {
    recordError('error', { code: 500 })
    expect(readErrorLog()[0].message).toBe('{"code":500}')

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => recordError('error', cyclic)).not.toThrow()
    expect(readErrorLog()).toHaveLength(2)
  })

  it('пустая ошибка получает читаемую заглушку', () => {
    recordError('error', '')
    expect(readErrorLog()[0].message).toBe('Неизвестная ошибка')
  })

  it('источник сохраняется', () => {
    recordError('error', 'сбой', { source: 'MetroMap.tsx:42' })
    expect(readErrorLog()[0].source).toBe('MetroMap.tsx:42')
  })

  /** Один и тот же сбой в цикле не должен вытеснить всю историю. */
  it('повтор в окне склейки увеличивает счётчик, а не плодит записи', () => {
    recordError('error', 'один и тот же')
    vi.advanceTimersByTime(DEDUPE_WINDOW_MS - 100)
    recordError('error', 'один и тот же')

    const log = readErrorLog()
    expect(log).toHaveLength(1)
    expect(log[0].count).toBe(2)
  })

  it('за пределами окна склейки создаётся новая запись', () => {
    recordError('error', 'один и тот же')
    vi.advanceTimersByTime(DEDUPE_WINDOW_MS + 100)
    recordError('error', 'один и тот же')
    expect(readErrorLog()).toHaveLength(2)
  })

  it('склеиваются только соседние одинаковые: чужая ошибка между ними разрывает серию', () => {
    recordError('error', 'A')
    recordError('error', 'B')
    recordError('error', 'A')
    expect(readErrorLog().map((e) => e.message)).toEqual(['A', 'B', 'A'])
  })

  it('журнал не растёт бесконечно: держится лимит по количеству', () => {
    for (let i = 0; i < MAX_ENTRIES + 15; i += 1) recordError('error', `ошибка ${i}`)
    const log = readErrorLog()
    expect(log).toHaveLength(MAX_ENTRIES)
    // Срезаются самые старые.
    expect(log[log.length - 1].message).toBe(`ошибка ${MAX_ENTRIES + 14}`)
  })

  it('длинное сообщение обрезается многоточием', () => {
    recordError('error', 'я'.repeat(1000))
    const { message } = readErrorLog()[0]
    expect(message.length).toBeLessThan(1000)
    expect(message.endsWith('…')).toBe(true)
  })

  it('журнал ошибок не имеет права стать источником ошибок', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })
    expect(() => recordError('error', 'при переполнении')).not.toThrow()
  })
})

describe('подписка и очистка', () => {
  it('подписчик получает журнал при каждой записи', () => {
    const seen: ErrorLogEntry[][] = []
    const off = subscribeErrorLog((entries) => seen.push(entries))

    recordError('error', 'раз')
    recordError('error', 'два')
    expect(seen).toHaveLength(2)
    expect(seen[1]).toHaveLength(2)

    off()
    recordError('error', 'три')
    expect(seen).toHaveLength(2)
  })

  it('упавший подписчик не ломает запись остальным', () => {
    const good: number[] = []
    const offBad = subscribeErrorLog(() => {
      throw new Error('подписчик сломался')
    })
    const offGood = subscribeErrorLog((e) => good.push(e.length))

    expect(() => recordError('error', 'сбой')).not.toThrow()
    expect(good).toEqual([1])

    offBad()
    offGood()
  })

  it('очистка стирает хранилище и уведомляет подписчиков', () => {
    recordError('error', 'что-то')
    const seen: ErrorLogEntry[][] = []
    const off = subscribeErrorLog((e) => seen.push(e))

    clearErrorLog()
    expect(readErrorLog()).toEqual([])
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull()
    expect(seen).toEqual([[]])
    off()
  })
})

describe('formatErrorLogForShare', () => {
  it('пустой журнал описывается словами, а не пустотой', () => {
    const text = formatErrorLogForShare([])
    expect(text).toContain('Ошибок нет.')
    expect(text).toContain('Журнал ошибок')
  })

  it('в шапке есть окружение — без него отчёт бесполезен', () => {
    const text = formatErrorLogForShare([])
    expect(text).toContain('UA:')
    expect(text).toContain('URL:')
    expect(text).toContain('Экран:')
  })

  it('записи нумеруются, повторы помечены кратностью', () => {
    recordError('error', 'первая')
    vi.advanceTimersByTime(100)
    recordError('error', 'первая')
    recordError('promise', 'вторая', { source: 'worker' })

    const text = formatErrorLogForShare(readErrorLog())
    expect(text).toContain('#1 [error]')
    expect(text).toContain('×2')
    expect(text).toContain('#2 [promise]')
    expect(text).toContain('источник: worker')
  })

  it('битое время не роняет форматирование', () => {
    const text = formatErrorLogForShare([
      { at: Number.NaN, kind: 'error', message: 'м', count: 1 },
    ])
    expect(text).toContain('м')
  })
})
