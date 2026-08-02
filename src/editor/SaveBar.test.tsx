// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SaveBar } from './SaveBar.tsx'
import { fullGraphStations } from '../metro/fullGraph.ts'
import type { EditorOverlayApi } from './editorTypes.ts'

afterEach(cleanup)

const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** Раскладка «как есть»: сдвинутых станций ноль, сохранять нечего. */
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
    manualEdges: {},
    edgeKey,
    ...over,
  } as EditorOverlayApi
}

/** Одна честная правка: переименованная станция. */
const withRename = () =>
  editorApi({ stationOverrides: { [fullGraphStations[0].id]: { title: 'Переименованная' } } })

/** Так отвечает dev-плагин на пробный не-POST запрос. */
const probeAlive = () =>
  new Response(JSON.stringify({ ok: false, error: 'нужен POST' }), {
    status: 405,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })

/** Так отвечает статика `vite preview`: эндпоинта нет. */
const probeDead = () => new Response('<!doctype html>', { status: 404 })

const saveButton = () => screen.getByRole('button', { name: /Сохранить|Сохраняю/ })
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Рендер и ожидание ответа на пробный запрос — иначе видно состояние «ещё проверяю». */
async function renderBar(api = editorApi()) {
  const view = render(<SaveBar editor={api} />)
  await act(async () => {})
  return view
}

describe('панель сохранения на живом сервере', () => {
  beforeEach(() => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'POST'
          ? new Response(
              JSON.stringify({
                ok: true,
                changes: ['1/a: название'],
                changedFiles: ['data/lines/001-a.json'],
                solver: { ok: true, message: 'граф пересобран' },
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            )
          : probeAlive(),
      ),
    )
  })

  it('без правок кнопка выключена и об этом сказано', async () => {
    await renderBar()
    expect(saveButton()).toHaveProperty('disabled', true)
    expect(screen.getByText('Правок нет')).toBeTruthy()
  })

  it('с правкой кнопка включена, а счётчик её показывает', async () => {
    await renderBar(withRename())
    expect(saveButton()).toHaveProperty('disabled', false)
    expect(screen.getByText(/переименовано/)).toBeTruthy()
  })

  it('нажатие шлёт патч POST-ом и показывает ответ сервера', async () => {
    await renderBar(withRename())

    await act(async () => {
      fireEvent.click(saveButton())
    })

    const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST')!
    expect(post[0]).toBe('/__editor/save')
    expect(JSON.parse(post[1].body).stations[fullGraphStations[0].id].title).toBe(
      'Переименованная',
    )
    await waitFor(() => expect(screen.getByText(/граф пересобран/)).toBeTruthy())
  })

  /** Файлы не тронуты — это главное, что человеку нужно знать при отказе. */
  it('отказ сервера показывается вместе с обещанием не трогать data/', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(
        init?.method === 'POST'
          ? new Response(JSON.stringify({ ok: false, error: 'станции нет на линии' }), {
              status: 400,
              headers: { 'Content-Type': 'application/json' },
            })
          : probeAlive(),
      ),
    )

    await renderBar(withRename())
    await act(async () => {
      fireEvent.click(saveButton())
    })

    await waitFor(() => expect(screen.getByText(/станции нет на линии/)).toBeTruthy())
    expect(screen.getByText(/не тронуты/)).toBeTruthy()
  })
})

/**
 * СТОРОЖ БАГА. `npm run preview:editor` показывал полностью рабочую с виду
 * панель: кнопка нажималась, ничего не происходило, и ни одного слова о том,
 * почему. Эндпоинт записи живёт в `configureServer` vite-плагина, а у
 * `vite preview` этой стадии нет вовсе.
 */
describe('панель сохранения там, где сервера нет', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(probeDead())
  })

  it('кнопка выключена, даже когда правки есть', async () => {
    await renderBar(withRename())
    expect(saveButton()).toHaveProperty('disabled', true)
  })

  it('причина названа прямо в панели', async () => {
    await renderBar(withRename())
    expect(screen.getByText(/сохранение доступно только в npm run dev:editor/)).toBeTruthy()
  })

  it('патч на сервер не уходит', async () => {
    await renderBar(withRename())
    expect(fetchMock.mock.calls.some((c) => c[1]?.method === 'POST')).toBe(false)
  })

  /** Недоступная сеть — тот же случай: сохранять некуда, молчать нельзя. */
  it('сорванный пробный запрос тоже считается «сервера нет»', async () => {
    fetchMock.mockRejectedValue(new Error('network'))
    await renderBar(withRename())
    expect(screen.getByText(/сохранение доступно только в npm run dev:editor/)).toBeTruthy()
  })

  /**
   * Проверка именно на 405 с JSON: этим кодом отвечает только сам плагин.
   * HTML-заглушка со статусом 200 — не сервер записи.
   */
  it('index.html вместо ответа плагина за сервер не сходит', async () => {
    fetchMock.mockResolvedValue(new Response('<!doctype html>', { status: 200 }))
    await renderBar(withRename())
    expect(saveButton()).toHaveProperty('disabled', true)
  })
})
