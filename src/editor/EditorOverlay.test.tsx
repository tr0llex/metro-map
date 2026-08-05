// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { EditorOverlay } from './EditorOverlay.tsx'
import { fullGraphStations } from '../metro/fullGraph.ts'
import type { EditorOverlayApi } from './editorTypes.ts'

afterEach(cleanup)

const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** Раскладка «как есть»: сдвинутых станций ноль, значит SaveBar'у нечего сохранять. */
const untouchedLayout = () => {
  const layout: Record<string, { x: number; y: number }> = {}
  for (const s of fullGraphStations) {
    layout[s.id] = { x: s.sourceX as number, y: s.sourceY as number }
  }
  return layout
}

function editorApi(over: Partial<EditorOverlayApi> = {}): EditorOverlayApi {
  return {
    toast: null,
    inspectedStation: null,
    inspectedLineId: null,
    inspectedEdges: [],
    stationOverrides: {},
    edgeOverrides: {},
    edgeTransferKinds: {},
    manualEdges: {},
    lastLayoutOverrides: untouchedLayout(),
    stationById: new Map(fullGraphStations.map((s) => [s.id, s])),
    lineByNumericId: new Map(),
    findExactStationByName: () => undefined,
    edgeKey,
    collisionDebug: false,
    canUndo: false,
    canRedo: false,
    toggleEditMode: () => {},
    exitEditMode: () => {},
    toggleCollisionDebug: () => {},
    ...over,
  } as EditorOverlayApi
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<!doctype html>', { status: 404 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const fab = () => screen.getByRole('button', { name: /режим редактора/ })

describe('кнопка режима редактора', () => {
  /** Единственная кнопка, видимая при выключенном редакторе: ею его и включают. */
  it('видна и при выключенном редакторе', () => {
    render(<EditorOverlay editor={editorApi()} active={false} />)

    expect(fab().getAttribute('aria-label')).toBe('Включить режим редактора')
    expect(fab().className).toBe('editor-fab')
  })

  it('во включённом режиме предлагает выключить и подсвечена', () => {
    render(<EditorOverlay editor={editorApi()} active />)

    expect(fab().getAttribute('aria-label')).toBe('Выключить режим редактора')
    expect(fab().className).toContain('editor-fab--active')
  })

  it('нажатие переключает режим', () => {
    const toggleEditMode = vi.fn()
    render(<EditorOverlay editor={editorApi({ toggleEditMode })} active={false} />)

    fireEvent.click(fab())
    expect(toggleEditMode).toHaveBeenCalledTimes(1)
  })
})

describe('инструменты редактора', () => {
  /**
   * Панель сохранения и отладка коллизий — редакторские инструменты; вне
   * режима они занимали бы угол экрана у обычного пользователя.
   */
  it('вне режима редактора не показываются', () => {
    render(<EditorOverlay editor={editorApi()} active={false} />)

    expect(screen.queryByLabelText('Инструменты редактора')).toBeNull()
    expect(screen.queryByRole('button', { name: /Сохранить/ })).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('в режиме редактора появляются', async () => {
    render(<EditorOverlay editor={editorApi()} active />)

    expect(screen.getByLabelText('Инструменты редактора')).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('button', { name: /Сохранить/ })).toBeTruthy())
  })

  it('отладка коллизий переключается и отражает своё состояние', () => {
    const toggleCollisionDebug = vi.fn()
    const { rerender } = render(
      <EditorOverlay editor={editorApi({ toggleCollisionDebug })} active />,
    )

    const debugButton = screen.getByRole('button', {
      name: 'Включить отладку коллизий подписей',
    })
    expect(debugButton.className).not.toContain('editor-fab--active')

    fireEvent.click(debugButton)
    expect(toggleCollisionDebug).toHaveBeenCalledTimes(1)

    rerender(<EditorOverlay editor={editorApi({ collisionDebug: true })} active />)
    expect(
      screen.getByRole('button', { name: 'Выключить отладку коллизий подписей' }).className,
    ).toContain('editor-fab--active')
  })
})

describe('панель станции', () => {
  /**
   * HubEditorPanel грузится динамически — без выбранной станции импорт не
   * должен даже начинаться.
   */
  it('без выбранной станции не рендерится', () => {
    render(<EditorOverlay editor={editorApi()} active />)
    expect(document.querySelector('.hub-editor')).toBeNull()
  })

  it('появляется для выбранной станции', async () => {
    const station = fullGraphStations[0]
    render(
      <EditorOverlay
        editor={editorApi({ inspectedStation: station, inspectedLineId: station.lineNumericId })}
        active
      />,
    )

    await waitFor(() =>
      expect(document.body.textContent).toContain(station.title),
    )
  })

  /** Режим выключили — панель обязана исчезнуть вместе с ним, а не остаться висеть. */
  it('вне режима редактора не рендерится даже с выбранной станцией', () => {
    render(<EditorOverlay editor={editorApi({ inspectedStation: fullGraphStations[0] })} active={false} />)
    expect(document.querySelector('.hub-editor')).toBeNull()
  })
})

describe('тост', () => {
  it('без сообщения ничего не занимает', () => {
    render(<EditorOverlay editor={editorApi()} active />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  /** Тост сообщает об итоге действия — его надо озвучить, а не только нарисовать. */
  it('сообщение объявляется скринридеру', () => {
    render(<EditorOverlay editor={editorApi({ toast: 'Координаты обновлены' })} active />)

    const toast = screen.getByRole('status')
    expect(toast.textContent).toBe('Координаты обновлены')
    expect(toast.getAttribute('aria-live')).toBe('polite')
  })

  /** Итог действия важен и после выхода из режима — например, «сохранено». */
  it('показывается и вне режима редактора', () => {
    render(<EditorOverlay editor={editorApi({ toast: 'Сохранено' })} active={false} />)
    expect(screen.getByRole('status').textContent).toBe('Сохранено')
  })
})
