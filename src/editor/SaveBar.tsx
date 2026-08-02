import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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

/**
 * Есть ли на том конце сервер, умеющий писать в `data/`.
 *
 * `npm run preview:editor` поднимает статику готовой сборки. Эндпоинт живёт в
 * `configureServer` vite-плагина, которого у `vite preview` нет вовсе, — и
 * кнопка «Сохранить» там не делает НИЧЕГО, молча. Раскладку такая сборка тоже
 * не снимает (снимок стоит за `import.meta.env.DEV`), так что чинить одну
 * кнопку бессмысленно: честнее сказать вслух, что сохранять некуда.
 */
type Availability = 'checking' | 'available' | 'missing'

const NO_ENDPOINT_HINT = 'сохранение доступно только в npm run dev:editor'

/**
 * Пробный запрос: dev-плагин отвечает на не-POST кодом 405 и телом JSON.
 * Никакой другой сервер так не отвечает — статика отдаёт 404 или index.html,
 * поэтому проверка не путает «редактор с сервером» и «редактор без сервера».
 */
async function probeSaveEndpoint(): Promise<Availability> {
  try {
    const res = await fetch(SAVE_ENDPOINT, { method: 'GET' })
    const isJson = (res.headers.get('content-type') ?? '').includes('application/json')
    return res.status === 405 && isJson ? 'available' : 'missing'
  } catch {
    return 'missing'
  }
}

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
  const [availability, setAvailability] = useState<Availability>('checking')

  useEffect(() => {
    let cancelled = false
    void probeSaveEndpoint().then((result) => {
      if (!cancelled) setAvailability(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

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
        // Связи, созданные кнопкой «Добавить». Сюда их не передавали вовсе:
        // новая пересадка без последующей правки времени исчезала бесследно,
        // а панель писала «Правок нет».
        manualEdges: editor.manualEdges,
        edgeKey: editor.edgeKey,
      }),
    [
      editor.lastLayoutOverrides,
      editor.stationOverrides,
      editor.edgeOverrides,
      editor.manualEdges,
      editor.edgeKey,
    ],
  )

  const dirty = hasSavableChanges(built)

  const save = useCallback(async () => {
    if (!dirty) return
    if (availability === 'missing') {
      setState({ kind: 'failed', message: NO_ENDPOINT_HINT })
      return
    }
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
  }, [built, dirty, availability])

  // Всегда актуальная ссылка на save: нужна для отложенного вызова после blur,
  // где замыкание обработчика держит уже устаревший патч.
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  }, [save])

  // Ctrl/Cmd+S — привычный жест сохранения; браузерное «сохранить страницу»
  // здесь только мешает.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 's' || !(event.ctrlKey || event.metaKey)) return
      event.preventDefault()

      // Значения полей фиксируются при уходе фокуса. Ctrl+S прямо из поля
      // ввода сохранял то, что было ДО набора: обработчик висит на window и
      // срабатывал раньше, чем поле успевало отдать фокус. Уводим фокус сами
      // и ждём кадр, чтобы blur успел записать правку в состояние.
      const active = document.activeElement
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        active.blur()
        // Через реф, а не через save из замыкания: то замыкание держит патч,
        // собранный ДО blur, — ровно то устаревшее значение, от которого мы
        // здесь и уходим.
        requestAnimationFrame(() => {
          void saveRef.current()
        })
        return
      }

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

  const noEndpoint = availability === 'missing'

  return (
    <div className="editor-save" role="region" aria-label="Сохранение правок схемы">
      <div className="editor-save-row">
        <button
          type="button"
          className="editor-save-button"
          onClick={() => void save()}
          disabled={!dirty || noEndpoint || state.kind === 'saving'}
          title={
            noEndpoint
              ? NO_ENDPOINT_HINT
              : dirty
                ? 'Записать правки в data/ и пересобрать граф (Ctrl+S)'
                : 'Правок нет'
          }
        >
          {state.kind === 'saving' ? 'Сохраняю…' : 'Сохранить в data/'}
        </button>

        <span className="editor-save-status">
          {dirty ? parts.join(' · ') : 'Правок нет'}
        </span>
      </div>

      {/* Кнопка, которая молча ничего не делает, хуже отсутствующей кнопки:
          в preview-сборке правки некуда девать, и об этом надо сказать прямо. */}
      {noEndpoint && (
        <div className="editor-save-error" role="status">
          Здесь сохранять некуда: {NO_ENDPOINT_HINT}.
          <div className="editor-save-hint">
            Эндпоинт записи живёт в плагине сервера разработки, у статики его нет.
          </div>
        </div>
      )}

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
