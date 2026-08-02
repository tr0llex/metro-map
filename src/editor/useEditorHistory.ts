import { useCallback, useEffect, useRef, useState } from 'react'
import type { EditorHistoryState, EditorSnapshot } from './editorTypes.ts'

const MAX_EDITOR_HISTORY = 100

/**
 * Снапшоты сравниваются по ссылкам полей, а не по содержимому: каждое поле —
 * неизменяемая таблица, которую обработчики пересоздают только при настоящей
 * правке. Глубокое сравнение здесь стоило бы обхода всей схемы на каждый
 * рендер и ничего бы не уточнило.
 */
function areEditorSnapshotsShallowEqual(a: EditorSnapshot | undefined, b: EditorSnapshot) {
  if (!a) return false
  const keys = Object.keys(b) as (keyof EditorSnapshot)[]
  return keys.every((key) => a[key] === b[key])
}

/**
 * История правок редактора: запись, откат, повтор и Ctrl+Z / Ctrl+Shift+Z.
 *
 * `snapshot` — текущее редактируемое состояние, пересобираемое вызывающим на
 * каждое изменение; `apply` возвращает состояние к переданному снапшоту.
 * Выход из режима редактора историю очищает.
 */
export function useEditorHistory({
  editMode,
  snapshot,
  apply,
}: {
  editMode: boolean
  snapshot: () => EditorSnapshot
  apply: (snapshot: EditorSnapshot) => void
}) {
  const [history, setHistory] = useState<EditorHistoryState>({ items: [], index: -1 })

  /**
   * История читается из рефа, а не из аргумента функции-апдейтера.
   *
   * Раньше undo/redo вызывали применение снапшота (десяток `setState`) ПРЯМО
   * ВНУТРИ апдейтера `setHistory`. React считает апдейтер чистым и в
   * StrictMode вызывает его дважды — снапшот применялся два раза и дважды
   * поднимался `editorLayoutApplyToken`. Теперь апдейтеров нет вовсе: реф —
   * единственный источник правды, `commit` синхронно обновляет и его, и
   * состояние для рендера.
   */
  const historyRef = useRef<EditorHistoryState>({ items: [], index: -1 })

  const commit = useCallback((next: EditorHistoryState) => {
    historyRef.current = next
    setHistory(next)
  }, [])

  const push = useCallback(() => {
    const prev = historyRef.current
    const next = snapshot()

    if (prev.index >= 0 && areEditorSnapshotsShallowEqual(prev.items[prev.index], next)) {
      return
    }

    let items = prev.items.slice(0, prev.index + 1)
    items.push(next)
    if (items.length > MAX_EDITOR_HISTORY) {
      items = items.slice(items.length - MAX_EDITOR_HISTORY)
    }
    commit({ items, index: items.length - 1 })
  }, [snapshot, commit])

  const undo = useCallback(() => {
    const prev = historyRef.current
    if (prev.index <= 0) return
    const nextIndex = prev.index - 1
    commit({ ...prev, index: nextIndex })
    apply(prev.items[nextIndex])
  }, [apply, commit])

  const redo = useCallback(() => {
    const prev = historyRef.current
    if (prev.index < 0 || prev.index >= prev.items.length - 1) return
    const nextIndex = prev.index + 1
    commit({ ...prev, index: nextIndex })
    apply(prev.items[nextIndex])
  }, [apply, commit])

  const canUndo = history.index > 0
  const canRedo = history.index >= 0 && history.index < history.items.length - 1

  // Запись в историю на каждое изменение редактируемого состояния.
  // `snapshot` меняет ссылку ровно тогда, когда меняется любое из его полей,
  // поэтому отдельного перечисления состояний не нужно.
  useEffect(() => {
    if (!editMode) return
    push()
  }, [editMode, snapshot, push])

  useEffect(() => {
    if (editMode) return
    commit({ items: [], index: -1 })
  }, [editMode, commit])

  useEffect(() => {
    if (!editMode) return

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      const isEditableElement =
        tag === 'INPUT' || tag === 'TEXTAREA' || (target as HTMLElement).isContentEditable
      if (isEditableElement) return

      const isMac =
        typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
      const ctrlOrMeta = isMac ? event.metaKey : event.ctrlKey
      if (!ctrlOrMeta) return

      if (event.key === 'z' || event.key === 'Z') {
        if (event.shiftKey) {
          if (canRedo) {
            event.preventDefault()
            redo()
          }
        } else {
          if (canUndo) {
            event.preventDefault()
            undo()
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [editMode, canUndo, canRedo, undo, redo])

  return { canUndo, canRedo, undo, redo }
}
