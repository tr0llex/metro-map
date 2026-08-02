import { useCallback, useEffect, useMemo, useState } from 'react'

import { fullGraphEdges, fullGraphLines, fullGraphStations } from '../metro/fullGraph.ts'
import type { EditorSaveResponse } from '../../scripts/editor/editorApiPlugin.ts'
import { buildEditorPatch, hasSavableChanges } from './buildEditorPatch.ts'
import type { EditorOverlayApi } from './editorTypes.ts'

/** Кольцевые линии: нужны, чтобы обойти линию с замыканием. */
const RING_LINE_IDS = new Set([5, 95, 97])

const SAVE_ENDPOINT = '/__editor/save'

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'done'; response: EditorSaveResponse }
  | { kind: 'failed'; message: string }

const plural = (n: number, one: string, few: string, many: string) => {
  const m100 = Math.abs(n) % 100
  if (m100 >= 11 && m100 <= 14) return many
  const m10 = m100 % 10
  if (m10 === 1) return one
  if (m10 >= 2 && m10 <= 4) return few
  return many
}

/**
 * Панель сохранения.
 *
 * Заменила кнопку «скопировать в буфер». Прежний путь был из четырёх шагов —
 * скопировать, открыть файл, вставить, пересобрать, — и на каждом можно было
 * ошибиться. Здесь одно нажатие: сервер разработки накладывает правки на
 * `data/` и сразу пересобирает граф.
 */
export function SaveBar({ editor }: { editor: EditorOverlayApi }) {
  const [state, setState] = useState<SaveState>({ kind: 'idle' })

  const built = useMemo(
    () =>
      buildEditorPatch({
        lines: fullGraphLines,
        stations: fullGraphStations,
        edges: fullGraphEdges,
        ringLineIds: RING_LINE_IDS,
        layout: editor.lastLayoutOverrides,
        stationOverrides: editor.stationOverrides,
        edgeOverrides: editor.edgeOverrides,
        edgeKey: editor.edgeKey,
      }),
    [editor.lastLayoutOverrides, editor.stationOverrides, editor.edgeOverrides, editor.edgeKey],
  )

  const dirty = hasSavableChanges(built)

  const save = useCallback(async () => {
    if (!dirty) return
    setState({ kind: 'saving' })
    try {
      const res = await fetch(SAVE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(built.patch),
      })
      const body = (await res.json()) as EditorSaveResponse
      if (!res.ok || !body.ok) {
        setState({ kind: 'failed', message: body.error ?? `сервер ответил ${res.status}` })
        return
      }
      setState({ kind: 'done', response: body })
    } catch (error) {
      setState({
        kind: 'failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }, [built, dirty])

  // Ctrl/Cmd+S — привычный жест сохранения; браузерное «сохранить страницу»
  // здесь только мешает.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 's' || !(event.ctrlKey || event.metaKey)) return
      event.preventDefault()
      void save()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [save])

  // Любая новая правка снимает отметку «сохранено»: иначе панель показывает
  // успех прошлого сохранения поверх несохранённых изменений.
  useEffect(() => {
    setState((prev) => (prev.kind === 'done' || prev.kind === 'failed' ? { kind: 'idle' } : prev))
  }, [built])

  const { layout, stations, rides, transfers } = built.counts
  const parts: string[] = []
  if (layout > 0) parts.push(`${layout} ${plural(layout, 'станция', 'станции', 'станций')} сдвинуто`)
  if (stations > 0) parts.push(`${stations} переименовано`)
  if (rides > 0) parts.push(`${rides} ${plural(rides, 'перегон', 'перегона', 'перегонов')}`)
  if (transfers > 0)
    parts.push(`${transfers} ${plural(transfers, 'пересадка', 'пересадки', 'пересадок')}`)

  return (
    <div className="editor-save" role="region" aria-label="Сохранение правок схемы">
      <div className="editor-save-row">
        <button
          type="button"
          className="editor-save-button"
          onClick={() => void save()}
          disabled={!dirty || state.kind === 'saving'}
          title={dirty ? 'Записать правки в data/ и пересобрать граф (Ctrl+S)' : 'Правок нет'}
        >
          {state.kind === 'saving' ? 'Сохраняю…' : 'Сохранить в data/'}
        </button>

        <span className="editor-save-status">
          {dirty ? parts.join(' · ') : 'Правок нет'}
        </span>
      </div>

      {state.kind === 'done' && (
        <div className="editor-save-result" role="status">
          <div className="editor-save-ok">
            Записано: {state.response.changedFiles.join(', ') || 'ничего'}
          </div>
          <div
            className={
              state.response.solver.ok ? 'editor-save-solver' : 'editor-save-solver-failed'
            }
          >
            {state.response.solver.message}
          </div>
          {state.response.changes.length > 0 && (
            <ul className="editor-save-changes">
              {state.response.changes.slice(0, 8).map((line) => (
                <li key={line}>{line}</li>
              ))}
              {state.response.changes.length > 8 && (
                <li>…ещё {state.response.changes.length - 8}</li>
              )}
            </ul>
          )}
        </div>
      )}

      {state.kind === 'failed' && (
        <div className="editor-save-error" role="alert">
          Не сохранилось: {state.message}
          <div className="editor-save-hint">Файлы в data/ не тронуты — правки остались здесь.</div>
        </div>
      )}

      {built.unsupported.length > 0 && (
        <div className="editor-save-unsupported">
          <div className="editor-save-unsupported-title">Не попадёт в файлы:</div>
          <ul>
            {built.unsupported.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
