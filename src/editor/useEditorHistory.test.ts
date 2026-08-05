// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { EditorSnapshot } from './editorTypes.ts'
import { useEditorHistory } from './useEditorHistory.ts'

const MAX_EDITOR_HISTORY = 100

/**
 * Снапшот сравнивается по ССЫЛКАМ полей: каждое поле — неизменяемая таблица,
 * которую обработчики пересоздают только при настоящей правке.
 */
const snapshotOf = (over: Partial<EditorSnapshot> = {}): EditorSnapshot => ({
  stationOverrides: {},
  edgeOverrides: {},
  edgeTransferKinds: {},
  manualEdges: {},
  lastLayoutOverrides: {},
  ...over,
})

/** Правка станции: новая ссылка в одном поле — новая запись в истории. */
const withTitle = (title: string) => snapshotOf({ stationOverrides: { s1: { title } } })

type Props = { editMode: boolean; snapshot: () => EditorSnapshot }

function setup(initial: EditorSnapshot = snapshotOf(), editMode = true) {
  const apply = vi.fn()
  let current = initial

  const view = renderHook(
    (props: Props) => useEditorHistory({ ...props, apply }),
    { initialProps: { editMode, snapshot: () => current } },
  )

  /** Внести правку так, как это делает редактор: новый снапшот + новая ссылка. */
  const edit = (next: EditorSnapshot) => {
    current = next
    view.rerender({ editMode, snapshot: () => next })
  }

  return { ...view, apply, edit }
}

beforeEach(() => {
  Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

const keyZ = (over: Partial<KeyboardEventInit> = {}) =>
  new window.KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true, ...over })

describe('запись истории', () => {
  /** Первая запись — исходное состояние: откатываться от неё некуда. */
  it('на старте откатывать нечего', () => {
    const { result } = setup()

    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
  })

  it('правка делает откат доступным', () => {
    const { result, edit } = setup()

    act(() => edit(withTitle('Переименованная')))
    expect(result.current.canUndo).toBe(true)
    expect(result.current.canRedo).toBe(false)
  })

  /**
   * Перерисовка без правки не должна плодить записи: иначе один откат
   * возвращал бы к тому же состоянию и выглядел как сломанный.
   */
  it('перерисовка без правки записи не добавляет', () => {
    const same = snapshotOf()
    const { result, rerender } = renderHook(
      (props: Props) => useEditorHistory({ ...props, apply: vi.fn() }),
      { initialProps: { editMode: true, snapshot: () => same } },
    )

    rerender({ editMode: true, snapshot: () => same })
    rerender({ editMode: true, snapshot: () => ({ ...same }) })

    expect(result.current.canUndo).toBe(false)
  })

  /** История не должна расти бесконечно: сто шагов — потолок. */
  it('старые записи вытесняются после сотни правок', () => {
    const { result, edit } = setup()

    for (let i = 0; i < MAX_EDITOR_HISTORY + 20; i += 1) {
      act(() => edit(withTitle(`шаг ${i}`)))
    }

    let steps = 0
    while (result.current.canUndo && steps < 500) {
      act(() => result.current.undo())
      steps += 1
    }
    expect(steps).toBe(MAX_EDITOR_HISTORY - 1)
  })
})

describe('откат и повтор', () => {
  it('откат возвращает прежнее состояние', () => {
    const start = snapshotOf()
    const { result, apply, edit } = setup(start)

    act(() => edit(withTitle('Переименованная')))
    act(() => result.current.undo())

    expect(apply).toHaveBeenCalledWith(start)
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(true)
  })

  it('повтор возвращает откатанное', () => {
    const edited = withTitle('Переименованная')
    const { result, apply, edit } = setup()

    act(() => edit(edited))
    act(() => result.current.undo())
    apply.mockClear()

    act(() => result.current.redo())
    expect(apply).toHaveBeenCalledWith(edited)
    expect(result.current.canRedo).toBe(false)
  })

  it('в начале истории откат ничего не делает', () => {
    const { result, apply } = setup()

    act(() => result.current.undo())
    expect(apply).not.toHaveBeenCalled()
  })

  it('в конце истории повтор ничего не делает', () => {
    const { result, apply, edit } = setup()

    act(() => edit(withTitle('Раз')))
    act(() => result.current.redo())
    expect(apply).not.toHaveBeenCalled()
  })

  /** Новая правка после отката обрезает ветку повтора — как и везде. */
  it('правка после отката отменяет повтор', () => {
    const { result, edit } = setup()

    act(() => edit(withTitle('Раз')))
    act(() => edit(withTitle('Два')))
    act(() => result.current.undo())
    expect(result.current.canRedo).toBe(true)

    act(() => edit(withTitle('Три')))
    expect(result.current.canRedo).toBe(false)
  })

  /**
   * Раньше undo/redo применяли снапшот ПРЯМО ВНУТРИ апдейтера setHistory.
   * React считает апдейтер чистым и в StrictMode зовёт его дважды — снапшот
   * применялся два раза и дважды поднимался editorLayoutApplyToken.
   */
  it('откат применяет снапшот ровно один раз', () => {
    const { result, apply, edit } = setup()

    act(() => edit(withTitle('Раз')))
    act(() => result.current.undo())

    expect(apply).toHaveBeenCalledTimes(1)
  })
})

describe('горячие клавиши', () => {
  it('Ctrl+Z откатывает', () => {
    const { result, apply, edit } = setup()
    act(() => edit(withTitle('Раз')))

    act(() => {
      window.dispatchEvent(keyZ({ ctrlKey: true }))
    })
    expect(apply).toHaveBeenCalledTimes(1)
    expect(result.current.canRedo).toBe(true)
  })

  it('Ctrl+Shift+Z повторяет', () => {
    const { result, apply, edit } = setup()
    act(() => edit(withTitle('Раз')))
    act(() => result.current.undo())
    apply.mockClear()

    act(() => {
      window.dispatchEvent(keyZ({ ctrlKey: true, shiftKey: true }))
    })
    expect(apply).toHaveBeenCalledTimes(1)
  })

  it('заглавная Z работает так же', () => {
    const { apply, edit } = setup()
    act(() => edit(withTitle('Раз')))

    act(() => {
      window.dispatchEvent(keyZ({ key: 'Z', ctrlKey: true }))
    })
    expect(apply).toHaveBeenCalledTimes(1)
  })

  /** На маке отменяют Cmd+Z, а Ctrl+Z там не значит ничего. */
  it('на маке слушает Cmd, а не Ctrl', () => {
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' })
    const { apply, edit } = setup()
    act(() => edit(withTitle('Раз')))

    act(() => {
      window.dispatchEvent(keyZ({ ctrlKey: true }))
    })
    expect(apply).not.toHaveBeenCalled()

    act(() => {
      window.dispatchEvent(keyZ({ metaKey: true }))
    })
    expect(apply).toHaveBeenCalledTimes(1)
  })

  /** В поле ввода Ctrl+Z обязан отменять набранный текст, а не правку схемы. */
  it.each(['INPUT', 'TEXTAREA'])('в поле %s не перехватывается', (tag) => {
    const { apply, edit } = setup()
    act(() => edit(withTitle('Раз')))

    const field = document.createElement(tag)
    document.body.appendChild(field)
    act(() => {
      field.dispatchEvent(keyZ({ ctrlKey: true }))
    })

    expect(apply).not.toHaveBeenCalled()
    field.remove()
  })

  it('в редактируемом блоке не перехватывается', () => {
    const { apply, edit } = setup()
    act(() => edit(withTitle('Раз')))

    const field = document.createElement('div')
    field.contentEditable = 'true'
    Object.defineProperty(field, 'isContentEditable', { value: true })
    document.body.appendChild(field)

    act(() => {
      field.dispatchEvent(keyZ({ ctrlKey: true }))
    })
    expect(apply).not.toHaveBeenCalled()
    field.remove()
  })

  it('без модификатора ничего не делает', () => {
    const { apply, edit } = setup()
    act(() => edit(withTitle('Раз')))

    act(() => {
      window.dispatchEvent(keyZ())
    })
    expect(apply).not.toHaveBeenCalled()
  })

  it('прочие клавиши историю не трогают', () => {
    const { apply, edit } = setup()
    act(() => edit(withTitle('Раз')))

    act(() => {
      window.dispatchEvent(keyZ({ key: 'y', ctrlKey: true }))
    })
    expect(apply).not.toHaveBeenCalled()
  })

  /** Откатывать нечего — нажатие ничего не меняет. */
  it('в начале истории Ctrl+Z ничего не откатывает', () => {
    const { apply } = setup()

    act(() => {
      window.dispatchEvent(keyZ({ ctrlKey: true }))
    })
    expect(apply).not.toHaveBeenCalled()
  })

  /** Повторять нечего — Ctrl+Shift+Z тоже впустую. */
  it('в конце истории Ctrl+Shift+Z ничего не повторяет', () => {
    const { apply, edit } = setup()
    act(() => edit(withTitle('Раз')))

    act(() => {
      window.dispatchEvent(keyZ({ ctrlKey: true, shiftKey: true }))
    })
    expect(apply).not.toHaveBeenCalled()
  })
})

describe('выход из режима редактора', () => {
  it('очищает историю', () => {
    const { result, rerender, edit } = setup()
    act(() => edit(withTitle('Раз')))
    expect(result.current.canUndo).toBe(true)

    act(() => {
      rerender({ editMode: false, snapshot: () => withTitle('Раз') })
    })
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(false)
  })

  /** Вне режима редактора клавиши принадлежат странице, а не схеме. */
  it('снимает горячие клавиши', () => {
    const { apply, rerender, edit } = setup()
    act(() => edit(withTitle('Раз')))

    act(() => {
      rerender({ editMode: false, snapshot: () => withTitle('Раз') })
    })
    act(() => {
      window.dispatchEvent(keyZ({ ctrlKey: true }))
    })

    expect(apply).not.toHaveBeenCalled()
  })

  it('вне режима редактора правки не записываются', () => {
    const { result, rerender } = setup(snapshotOf(), false)

    act(() => {
      rerender({ editMode: false, snapshot: () => withTitle('Раз') })
    })
    expect(result.current.canUndo).toBe(false)
  })
})
