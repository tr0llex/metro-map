// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fullGraphStations } from '../metro/fullGraph.ts'
import type { EditorOverlayApi } from './editorTypes.ts'
import { SaveBar } from './SaveBar.tsx'

afterEach(cleanup)

const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** Раскладка «как есть»: сдвинутых станций ноль. */
const untouchedLayout = () => {
  const layout: Record<string, { x: number; y: number }> = {}
  for (const s of fullGraphStations) {
    layout[s.id] = { x: s.sourceX as number, y: s.sourceY as number }
  }
  return layout
}

function editorApi(over: Partial<EditorOverlayApi> = {}): EditorOverlayApi {
  return {
    lastLayoutOverrides: untouchedLayout(),
    stationOverrides: {},
    edgeOverrides: {},
    edgeTransferKinds: {},
    manualEdges: {},
    edgeKey,
    ...over,
  } as EditorOverlayApi
}

/** Одна честная правка: переименованная станция. */
const withRename = (title = 'Переименованная') =>
  editorApi({ stationOverrides: { [fullGraphStations[0].id]: { title } } })

/** Сдвинутые станции — по ним считается «N станций сдвинуто». */
const withMoved = (count: number) => {
  const layout = untouchedLayout()
  for (const s of fullGraphStations.slice(0, count)) {
    layout[s.id] = { x: (s.sourceX as number) + 50, y: (s.sourceY as number) + 50 }
  }
  return editorApi({ lastLayoutOverrides: layout })
}

/** Так отвечает dev-плагин на пробный не-POST запрос. */
const probeAlive = () =>
  new Response(JSON.stringify({ ok: false, error: 'нужен POST' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })

const okSave = () =>
  new Response(
    JSON.stringify({ ok: true, changes: [], changedFiles: [], solver: { ok: true, message: 'ок' } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )

const saveButton = () => screen.getByRole('button', { name: /Сохранить|Сохраняю/ })

let fetchMock: ReturnType<typeof vi.fn>
let frames: FrameRequestCallback[] = []

beforeEach(() => {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    frames.push(fn)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})

  fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(init?.method === 'POST' ? okSave() : probeAlive()),
  )
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const flushFrames = async () =>
  act(async () => {
    const queued = frames
    frames = []
    for (const fn of queued) fn(0)
  })

async function renderBar(api = editorApi()) {
  const view = render(<SaveBar editor={api} />)
  await act(async () => {})
  return view
}

const ctrlS = (target: EventTarget = window) =>
  target.dispatchEvent(
    new window.KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  )

const posts = () => fetchMock.mock.calls.filter((c) => c[1]?.method === 'POST')

describe('сохранение с клавиатуры', () => {
  /** Ctrl+S — привычный жест; браузерное «сохранить страницу» здесь только мешает. */
  it('Ctrl+S сохраняет и отменяет браузерное действие', async () => {
    await renderBar(withRename())

    const event = new window.KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    await act(async () => {
      window.dispatchEvent(event)
    })

    expect(event.defaultPrevented).toBe(true)
    expect(posts()).toHaveLength(1)
  })

  it('Cmd+S работает так же', async () => {
    await renderBar(withRename())

    await act(async () => {
      window.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }),
      )
    })

    expect(posts()).toHaveLength(1)
  })

  it('S без модификатора ничего не сохраняет', async () => {
    await renderBar(withRename())

    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 's', bubbles: true }))
    })

    expect(posts()).toHaveLength(0)
  })

  /**
   * СТОРОЖ БАГА. Значения полей фиксируются при уходе фокуса, и Ctrl+S прямо
   * из поля ввода сохранял то, что было ДО набора: обработчик висит на window
   * и срабатывал раньше, чем поле успевало отдать фокус.
   */
  it('из поля ввода сначала уводит фокус, и только потом сохраняет', async () => {
    const { rerender } = await renderBar(withRename('Старое имя'))

    const field = document.createElement('input')
    document.body.appendChild(field)
    field.focus()

    await act(async () => {
      ctrlS()
    })

    // Пока фокус не ушёл и кадр не отработал, патч не отправлен.
    expect(posts()).toHaveLength(0)
    expect(document.activeElement).not.toBe(field)

    // Правка, которую поле записало на blur, доезжает до панели.
    rerender(<SaveBar editor={withRename('Новое имя')} />)
    await flushFrames()

    await waitFor(() => expect(posts()).toHaveLength(1))
    expect(JSON.parse(posts()[0][1].body).stations[fullGraphStations[0].id].title).toBe(
      'Новое имя',
    )
    field.remove()
  })

  it('обработчик снимается вместе с панелью', async () => {
    const { unmount } = await renderBar(withRename())
    unmount()

    await act(async () => {
      ctrlS()
    })
    expect(posts()).toHaveLength(0)
  })

  it('без правок Ctrl+S ничего не шлёт', async () => {
    await renderBar()

    await act(async () => {
      ctrlS()
    })
    expect(posts()).toHaveLength(0)
  })
})

describe('счётчик правок по-русски', () => {
  /** «1 станция», «2 станции», «5 станций», «11 станций» — числительные склоняются. */
  it.each([
    [1, '1 станция сдвинуто'],
    [2, '2 станции сдвинуто'],
    [5, '5 станций сдвинуто'],
    [11, '11 станций сдвинуто'],
    [21, '21 станция сдвинуто'],
  ])('%i сдвинутых читается как «%s»', async (count, expected) => {
    await renderBar(withMoved(count))
    expect(screen.getByText(new RegExp(expected))).toBeTruthy()
  })
})

describe('состояние панели', () => {
  it('на время отправки кнопка говорит «Сохраняю»', async () => {
    let release: (value: Response) => void = () => {}
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? new Promise<Response>((resolve) => {
            release = resolve
          })
        : Promise.resolve(probeAlive()),
    )

    await renderBar(withRename())
    await act(async () => {
      fireEvent.click(saveButton())
    })

    expect(saveButton().textContent).toContain('Сохраняю')

    await act(async () => {
      release(okSave())
    })
    await waitFor(() => expect(saveButton().textContent).toContain('Сохранить'))
  })

  /** Иначе панель показывает успех прошлого сохранения поверх новых правок. */
  it('новая правка снимает отметку об успехе', async () => {
    const { rerender } = await renderBar(withRename('Первое'))
    await act(async () => {
      fireEvent.click(saveButton())
    })
    await waitFor(() => expect(screen.getByText(/ок/)).toBeTruthy())

    rerender(<SaveBar editor={withRename('Второе')} />)
    await act(async () => {})

    expect(screen.queryByText(/ок/)).toBeNull()
  })

  /** Сорванная сеть посреди сохранения — не молчаливый отказ. */
  it('обрыв сети показывается текстом ошибки', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? Promise.reject(new Error('Failed to fetch'))
        : Promise.resolve(probeAlive()),
    )

    await renderBar(withRename())
    await act(async () => {
      fireEvent.click(saveButton())
    })

    await waitFor(() => expect(screen.getByText(/Failed to fetch/)).toBeTruthy())
  })

  /** Ответ без объяснения — показываем хотя бы код. */
  it('отказ без текста показывается кодом ответа', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? Promise.resolve(
            new Response(JSON.stringify({ ok: false }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            }),
          )
        : Promise.resolve(probeAlive()),
    )

    await renderBar(withRename())
    await act(async () => {
      fireEvent.click(saveButton())
    })

    await waitFor(() => expect(screen.getByText(/сервер ответил 500/)).toBeTruthy())
  })
})
