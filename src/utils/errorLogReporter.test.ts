// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  clearErrorLog,
  formatErrorLogForShare,
  installErrorReporter,
  readErrorLog,
  recordError,
  subscribeErrorLog,
} from './errorLog.ts'

const KEY = 'metro-map-error-log-v1'

/** Потолок на весь журнал: localStorage обычно ~5 МБ на origin. */
const MAX_TOTAL_CHARS = 24_000
const MAX_ENTRIES = 20

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

const stored = () => JSON.parse(window.localStorage.getItem(KEY) ?? '[]') as unknown[]

describe('лимиты журнала', () => {
  /** Больше двадцати записей никто читать не станет, а место они съедят. */
  it('хранит не больше двадцати записей', () => {
    for (let i = 0; i < MAX_ENTRIES + 15; i += 1) {
      recordError('error', new Error(`беда ${i}`))
    }

    expect(stored()).toHaveLength(MAX_ENTRIES)
  })

  it('вытесняются самые старые', () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
      recordError('error', new Error(`беда ${i}`))
    }

    const messages = readErrorLog().map((e) => e.message)
    expect(messages[0]).toContain('беда 5')
    expect(messages.at(-1)).toContain(`беда ${MAX_ENTRIES + 4}`)
  })

  /** Лимит по размеру срабатывает раньше, чем по количеству: стек весит много. */
  it('огромные записи срезаются по суммарному размеру', () => {
    for (let i = 0; i < MAX_ENTRIES; i += 1) {
      const err = new Error(`беда ${i}`)
      err.stack = 'x'.repeat(5000)
      recordError('error', err)
    }

    expect(window.localStorage.getItem(KEY)!.length).toBeLessThanOrEqual(MAX_TOTAL_CHARS)
    expect(stored().length).toBeLessThan(MAX_ENTRIES)
  })

  /** Длинное сообщение обрезается, но запись сохраняется. */
  it('длинное сообщение подрезается многоточием', () => {
    recordError('error', 'я'.repeat(1000))

    const [entry] = readErrorLog()
    expect(entry.message.length).toBeLessThan(1000)
    expect(entry.message.endsWith('…')).toBe(true)
  })

  /** Квота кончилась — журнал не критичен, молча забываем. */
  it('переполненное хранилище не роняет запись', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })

    expect(() => recordError('error', new Error('беда'))).not.toThrow()
  })
})

describe('что попадает в запись', () => {
  it('у настоящей ошибки берёт имя, текст и стек', () => {
    const err = new TypeError('fullGraph is not defined')
    recordError('error', err, { source: 'metro-map-map.js:12:3' })

    const [entry] = readErrorLog()
    expect(entry.message).toBe('TypeError: fullGraph is not defined')
    expect(entry.source).toBe('metro-map-map.js:12:3')
    expect(entry.stack).toBeTruthy()
  })

  it('строку записывает как есть', () => {
    recordError('error', 'Script error.')
    expect(readErrorLog()[0].message).toBe('Script error.')
  })

  it('объект сворачивает в JSON', () => {
    recordError('promise', { code: 500, reason: 'нет связи' })
    expect(readErrorLog()[0].message).toContain('"code":500')
  })

  /** Объект с циклом JSON не переживёт — но запись всё равно должна появиться. */
  it('нечитаемое значение не теряет запись', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    recordError('error', cyclic)
    expect(readErrorLog()).toHaveLength(1)
  })

  it('пустое значение заменяется общим текстом', () => {
    recordError('error', '')
    expect(readErrorLog()[0].message).toBe('Неизвестная ошибка')
  })

  /** Один и тот же сбой в цикле не должен вытеснить всю историю. */
  it('повторы подряд схлопываются в счётчик', () => {
    recordError('error', new Error('одно и то же'))
    recordError('error', new Error('одно и то же'))
    recordError('error', new Error('одно и то же'))

    const entries = readErrorLog()
    expect(entries).toHaveLength(1)
    expect(entries[0].count).toBe(3)
  })

  it('разные ошибки не схлопываются', () => {
    recordError('error', new Error('первая'))
    recordError('error', new Error('вторая'))

    expect(readErrorLog()).toHaveLength(2)
  })
})

describe('подписчики', () => {
  it('узнают о новой записи и об очистке', () => {
    const listener = vi.fn()
    const off = subscribeErrorLog(listener)

    recordError('error', new Error('беда'))
    expect(listener).toHaveBeenCalledTimes(1)

    clearErrorLog()
    expect(listener).toHaveBeenLastCalledWith([])

    off()
    recordError('error', new Error('ещё беда'))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  /** Подписчик не должен ломать запись журнала. */
  it('упавший подписчик не мешает остальным', () => {
    const good = vi.fn()
    const offBad = subscribeErrorLog(() => {
      throw new Error('подписчик сломался')
    })
    const offGood = subscribeErrorLog(good)

    expect(() => recordError('error', new Error('беда'))).not.toThrow()
    expect(good).toHaveBeenCalled()

    offBad()
    offGood()
  })
})

describe('текст для ручной отправки', () => {
  it('содержит контекст окружения и все записи', () => {
    recordError('error', new Error('первая'), { source: 'app.js:1:1' })
    recordError('promise', new Error('вторая'))

    const text = formatErrorLogForShare(readErrorLog())

    expect(text).toContain('Журнал ошибок — Метро Москвы')
    expect(text).toContain('UA:')
    expect(text).toContain('URL:')
    expect(text).toContain('Экран:')
    expect(text).toContain('первая')
    expect(text).toContain('источник: app.js:1:1')
    expect(text).toContain('[promise]')
  })

  it('счётчик повторов виден в тексте', () => {
    recordError('error', new Error('одно и то же'))
    recordError('error', new Error('одно и то же'))

    expect(formatErrorLogForShare(readErrorLog())).toContain('×2')
  })

  it('пустой журнал так и говорит', () => {
    expect(formatErrorLogForShare([])).toContain('Ошибок нет.')
  })
})

describe('чтение битого хранилища', () => {
  it.each([
    ['не-JSON', '{битое'],
    ['не массив', '{"a":1}'],
  ])('%s даёт пустой журнал', (_name, raw) => {
    window.localStorage.setItem(KEY, raw)
    expect(readErrorLog()).toEqual([])
  })

  it('битые записи внутри массива отбрасываются', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([null, { at: 1, message: 'годная', kind: 'error', count: 1 }, { a: 1 }]),
    )

    expect(readErrorLog()).toHaveLength(1)
  })

  /** Незнакомый вид приводится к 'error', чтобы панель не показала пустоту. */
  it('неизвестный вид приводится к обычной ошибке', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify([{ at: 1, message: 'беда', kind: 'воркер', count: 0 }]),
    )

    const [entry] = readErrorLog()
    expect(entry.kind).toBe('error')
    expect(entry.count).toBe(1)
  })
})

/**
 * Перехватчики ставятся один раз и как можно раньше (main.tsx), чтобы поймать
 * в том числе ошибки на старте приложения.
 */
describe('глобальные перехватчики', () => {
  it('ловят необработанную ошибку вместе с её местом', () => {
    installErrorReporter()

    window.dispatchEvent(
      Object.assign(
        new Event('error'),
        {
          error: new TypeError('всё сломалось'),
          filename: 'https://metro.samoy.love/assets/metro-map-map.js',
          lineno: 120,
          colno: 8,
        },
      ),
    )

    const [entry] = readErrorLog()
    expect(entry.message).toContain('всё сломалось')
    expect(entry.source).toBe('https://metro.samoy.love/assets/metro-map-map.js:120:8')
  })

  /** Ошибки загрузки ресурсов (img/script) не имеют error и всплывают сюда же. */
  it('ошибка без описания всё равно записывается', () => {
    installErrorReporter()

    window.dispatchEvent(new Event('error'))

    expect(readErrorLog()[0].message).toBe('Ошибка без описания')
  })

  it('ловят отклонённый promise', () => {
    installErrorReporter()

    window.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), { reason: new Error('воркер не ответил') }),
    )

    const entries = readErrorLog()
    expect(entries.at(-1)!.kind).toBe('promise')
    expect(entries.at(-1)!.message).toContain('воркер не ответил')
  })

  it('promise без причины тоже записывается', () => {
    installErrorReporter()

    window.dispatchEvent(new Event('unhandledrejection'))

    expect(readErrorLog().at(-1)!.message).toBe('Promise отклонён без причины')
  })

  /** Ставятся один раз: иначе каждая ошибка писалась бы столько раз, сколько вызовов. */
  it('повторная установка перехватчиков не задваивает записи', () => {
    installErrorReporter()
    installErrorReporter()
    installErrorReporter()

    window.dispatchEvent(Object.assign(new Event('error'), { error: new Error('одна') }))

    expect(readErrorLog()).toHaveLength(1)
    expect(readErrorLog()[0].count).toBe(1)
  })
})
