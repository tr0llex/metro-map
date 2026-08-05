// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ErrorLogEntry } from '../utils/errorLog.ts'
import { ThemeErrorLogPanel } from './ThemeErrorLogPanel.tsx'

afterEach(cleanup)

const ERROR_LOG_STORAGE_KEY = 'metro-map-error-log-v1'

const entry = (over: Partial<ErrorLogEntry> = {}): ErrorLogEntry => ({
  at: Date.parse('2026-03-01T10:20:30Z'),
  kind: 'error',
  message: 'TypeError: fullGraph is not defined',
  count: 1,
  ...over,
})

const clipboard = { writeText: vi.fn() }

beforeEach(() => {
  window.localStorage.clear()
  clipboard.writeText.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const copyButton = () => screen.getByRole('button', { name: /Скопировать|Не удалось|Скопировано/ })
const clearButton = () => screen.getByRole('button', { name: 'Очистить' })

describe('список записей', () => {
  /**
   * Свежая ошибка — самая нужная, а копится журнал с конца: без разворота
   * пользователь искал бы её внизу длинного списка.
   */
  it('показывает свежие записи первыми', () => {
    render(
      <ThemeErrorLogPanel
        entries={[entry({ message: 'старая' }), entry({ message: 'свежая' })]}
        onClose={() => {}}
        onEntriesChange={() => {}}
      />,
    )

    const messages = Array.from(document.querySelectorAll('.theme-error-log-message')).map(
      (el) => el.textContent,
    )
    expect(messages).toEqual(['свежая', 'старая'])
  })

  it('переводит вид ошибки на человеческий язык', () => {
    render(
      <ThemeErrorLogPanel
        entries={[entry({ kind: 'error' }), entry({ kind: 'promise' }), entry({ kind: 'render' })]}
        onClose={() => {}}
        onEntriesChange={() => {}}
      />,
    )

    const kinds = Array.from(document.querySelectorAll('.theme-error-log-kind')).map(
      (el) => el.textContent,
    )
    expect(kinds).toEqual(['Рендер', 'Promise', 'Ошибка'])
  })

  /** Незнакомый вид не должен превращаться в пустую ячейку. */
  it('незнакомый вид показывает как есть', () => {
    render(
      <ThemeErrorLogPanel
        entries={[entry({ kind: 'worker' as ErrorLogEntry['kind'] })]}
        onClose={() => {}}
        onEntriesChange={() => {}}
      />,
    )

    expect(document.querySelector('.theme-error-log-kind')?.textContent).toBe('worker')
  })

  /**
   * Повтор — важный сигнал: «упало 40 раз» и «упало один раз» это разные
   * истории, а записи журнал схлопывает.
   */
  it('счётчик повторов показывает только при повторе', () => {
    const { rerender } = render(
      <ThemeErrorLogPanel entries={[entry()]} onClose={() => {}} onEntriesChange={() => {}} />,
    )
    expect(document.querySelector('.theme-error-log-count')).toBeNull()

    rerender(
      <ThemeErrorLogPanel
        entries={[entry({ count: 40 })]}
        onClose={() => {}}
        onEntriesChange={() => {}}
      />,
    )
    expect(document.querySelector('.theme-error-log-count')?.textContent).toBe('×40')
  })

  it('источник показывает, когда он известен', () => {
    const { rerender } = render(
      <ThemeErrorLogPanel entries={[entry()]} onClose={() => {}} onEntriesChange={() => {}} />,
    )
    expect(document.querySelector('.theme-error-log-source')).toBeNull()

    rerender(
      <ThemeErrorLogPanel
        entries={[entry({ source: 'metro-map-map-a1b2.js:120:8' })]}
        onClose={() => {}}
        onEntriesChange={() => {}}
      />,
    )
    expect(document.querySelector('.theme-error-log-source')?.textContent).toBe(
      'metro-map-map-a1b2.js:120:8',
    )
  })

  /** Битая метка времени не должна оставлять ячейку пустой. */
  it('нечитаемое время печатает числом', () => {
    render(
      <ThemeErrorLogPanel
        entries={[entry({ at: Number.NaN })]}
        onClose={() => {}}
        onEntriesChange={() => {}}
      />,
    )

    expect(document.querySelector('.theme-error-log-time')?.textContent).toBeTruthy()
  })

  it('пустой журнал говорит об этом словами', () => {
    render(<ThemeErrorLogPanel entries={[]} onClose={() => {}} onEntriesChange={() => {}} />)

    expect(screen.getByText('Ошибок нет.')).toBeTruthy()
    expect(copyButton().hasAttribute('disabled')).toBe(true)
    expect(clearButton().hasAttribute('disabled')).toBe(true)
  })

  /**
   * Панель существует ровно ради ручной пересылки, и обещание «никуда не
   * отправляется» — часть договора с пользователем.
   */
  it('обещает, что записи никуда не уходят', () => {
    render(<ThemeErrorLogPanel entries={[entry()]} onClose={() => {}} onEntriesChange={() => {}} />)
    expect(document.body.textContent).toContain('никуда не отправляются')
  })
})

describe('закрытие', () => {
  it('крестиком', () => {
    const onClose = vi.fn()
    render(<ThemeErrorLogPanel entries={[]} onClose={onClose} onEntriesChange={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть журнал ошибок' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('нажатием мимо панели', () => {
    const onClose = vi.fn()
    render(<ThemeErrorLogPanel entries={[]} onClose={onClose} onEntriesChange={() => {}} />)

    fireEvent.click(document.querySelector('.theme-error-log-backdrop')!)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  /** Нажатие по самому журналу — это попытка выделить текст, а не закрыть. */
  it('нажатие внутри панели её не закрывает', () => {
    const onClose = vi.fn()
    render(<ThemeErrorLogPanel entries={[entry()]} onClose={onClose} onEntriesChange={() => {}} />)

    fireEvent.click(screen.getByRole('dialog'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('клавишей Escape', () => {
    const onClose = vi.fn()
    render(<ThemeErrorLogPanel entries={[]} onClose={onClose} onEntriesChange={() => {}} />)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  /** Подписка на window обязана сниматься: иначе Escape закрывал бы призрак. */
  it('снятая панель на Escape больше не отзывается', () => {
    const onClose = vi.fn()
    const { unmount } = render(
      <ThemeErrorLogPanel entries={[]} onClose={onClose} onEntriesChange={() => {}} />,
    )
    unmount()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('копирование журнала', () => {
  it('кладёт в буфер текст с записями и контекстом окружения', async () => {
    render(
      <ThemeErrorLogPanel
        entries={[entry({ message: 'TypeError: боль' })]}
        onClose={() => {}}
        onEntriesChange={() => {}}
      />,
    )

    fireEvent.click(copyButton())
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledTimes(1))

    const text = clipboard.writeText.mock.calls[0][0] as string
    expect(text).toContain('Журнал ошибок — Метро Москвы')
    expect(text).toContain('TypeError: боль')
    expect(text).toContain('UA:')
  })

  it('подтверждает успех на кнопке', async () => {
    render(<ThemeErrorLogPanel entries={[entry()]} onClose={() => {}} onEntriesChange={() => {}} />)

    fireEvent.click(copyButton())
    await waitFor(() => expect(copyButton().textContent).toBe('Скопировано'))
  })

  /** Молчаливый отказ буфера — худший исход: человек уверен, что текст у него. */
  it('о неудаче говорит прямо', async () => {
    // Отказ и у Clipboard API, и у фолбэка на execCommand (в jsdom его нет).
    clipboard.writeText.mockRejectedValue(new Error('нет доступа'))

    render(<ThemeErrorLogPanel entries={[entry()]} onClose={() => {}} onEntriesChange={() => {}} />)

    fireEvent.click(copyButton())
    await waitFor(() => expect(copyButton().textContent).toBe('Не удалось скопировать'))
  })

  it('через пару секунд возвращает обычную подпись', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })

    render(<ThemeErrorLogPanel entries={[entry()]} onClose={() => {}} onEntriesChange={() => {}} />)

    fireEvent.click(copyButton())
    await waitFor(() => expect(copyButton().textContent).toBe('Скопировано'))

    await act(async () => {
      vi.advanceTimersByTime(2400)
    })
    expect(copyButton().textContent).toBe('Скопировать журнал')
  })
})

describe('очистка журнала', () => {
  it('стирает хранилище и отдаёт наверх опустевший список', () => {
    window.localStorage.setItem(ERROR_LOG_STORAGE_KEY, JSON.stringify([entry()]))
    const onEntriesChange = vi.fn()

    render(
      <ThemeErrorLogPanel
        entries={[entry()]}
        onClose={() => {}}
        onEntriesChange={onEntriesChange}
      />,
    )
    fireEvent.click(clearButton())

    expect(window.localStorage.getItem(ERROR_LOG_STORAGE_KEY)).toBeNull()
    expect(onEntriesChange).toHaveBeenCalledWith([])
  })
})
