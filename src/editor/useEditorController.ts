import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseTravelTime } from './travelTime.ts'
import { DEFAULT_TRANSFER_KIND, type TransferKind } from './transferKinds.ts'
import {
  fullGraphEdges,
  fullGraphLines,
  fullGraphStations,
} from '../metro/fullGraph.ts'
import type {
  EdgeOverride,
  FullGraphEdge,
  FullGraphStation,
} from '../metro/types.ts'
import type {
  EditorController,
  EditorFocusCommand,
  EditorHistoryState,
  EditorSnapshot,
  StationOverride,
} from './editorTypes.ts'

const MAX_EDITOR_HISTORY = 100

function areEditorSnapshotsShallowEqual(
  a: EditorSnapshot | undefined,
  b: EditorSnapshot | undefined,
) {
  if (!a || !b) return false
  return (
    a.stationOverrides === b.stationOverrides &&
    a.edgeOverrides === b.edgeOverrides &&
    a.edgeTransferKinds === b.edgeTransferKinds &&
    a.manualEdges === b.manualEdges &&
    a.lastLayoutOverrides === b.lastLayoutOverrides
  )
}

/**
 * Всё состояние и вся логика редактора схемы в одном месте.
 *
 * Хук вызывается только в dev- и editor-сборке: в App он выбирается через
 * `EDITOR_ENABLED ? useEditorController : useNoopEditorController`, и в
 * продакшене Rollup сворачивает эту ветку и выкидывает модуль целиком.
 */
export function useEditorController(): EditorController {
  const [editMode, setEditMode] = useState(false)
  const [collisionDebug, setCollisionDebug] = useState(false)

  const [inspectedStationId, setInspectedStationId] = useState<string | null>(null)
  const [inspectedLineId, setInspectedLineId] = useState<number | null>(null)

  const [stationOverrides, setStationOverrides] = useState<Record<string, StationOverride>>({})
  const [edgeOverrides, setEdgeOverrides] = useState<Record<string, EdgeOverride>>({})
  // Тип пересадки лежит отдельно от EdgeOverride: тот тип описывает граф в
  // src/metro и про data/transfers.json ничего не знает.
  const [edgeTransferKinds, setEdgeTransferKinds] = useState<Record<string, TransferKind>>({})
  const [manualEdges, setManualEdges] = useState<Record<string, FullGraphEdge>>({})
  const [editorToast, setEditorToast] = useState<string | null>(null)
  const editorToastTimeoutRef = useRef<number | null>(null)

  const [lastLayoutOverrides, setLastLayoutOverrides] = useState<
    Record<string, { x: number; y: number }>
  >({})
  const [editorLayoutApplyToken, setEditorLayoutApplyToken] = useState(0)
  const pendingLayoutOverridesRef = useRef<Record<string, { x: number; y: number }> | null>(null)

  const [editorFocusCommand, setEditorFocusCommand] = useState<EditorFocusCommand | null>(null)
  const [editorHistory, setEditorHistory] = useState<EditorHistoryState>({ items: [], index: -1 })

  const editorFocusTokenRef = useRef(0)

  const edgeKey = useCallback((a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`), [])

  const showEditorToast = useCallback((message: string) => {
    setEditorToast(message)
    if (editorToastTimeoutRef.current != null) {
      window.clearTimeout(editorToastTimeoutRef.current)
    }
    editorToastTimeoutRef.current = window.setTimeout(() => {
      editorToastTimeoutRef.current = null
      setEditorToast(null)
    }, 2200)
  }, [])

  // Без этого таймер тоста переживал размонтирование хука и дёргал setState
  // у уже мёртвого компонента.
  useEffect(() => {
    return () => {
      if (editorToastTimeoutRef.current != null) {
        window.clearTimeout(editorToastTimeoutRef.current)
        editorToastTimeoutRef.current = null
      }
    }
  }, [])

  // --- история undo/redo ----------------------------------------------------

  const makeEditorSnapshot = useCallback((): EditorSnapshot => {
    return {
      stationOverrides,
      edgeOverrides,
      edgeTransferKinds,
      manualEdges,
      lastLayoutOverrides,
    }
  }, [
    stationOverrides,
    edgeOverrides,
    edgeTransferKinds,
    manualEdges,
    lastLayoutOverrides,
  ])

  /**
   * История читается из рефа, а не из аргумента функции-апдейтера.
   *
   * Раньше undo/redo вызывали `applyEditorSnapshot` (десяток `setState`) ПРЯМО
   * ВНУТРИ апдейтера `setEditorHistory`. React считает апдейтер чистым и в
   * StrictMode вызывает его дважды — снапшот применялся два раза и дважды
   * поднимался `editorLayoutApplyToken`. Теперь апдейтеров нет вовсе: реф —
   * единственный источник правды, `commitEditorHistory` синхронно обновляет
   * и его, и состояние для рендера.
   */
  const editorHistoryRef = useRef<EditorHistoryState>({ items: [], index: -1 })

  const commitEditorHistory = useCallback((next: EditorHistoryState) => {
    editorHistoryRef.current = next
    setEditorHistory(next)
  }, [])

  const pushEditorHistory = useCallback(() => {
    const prev = editorHistoryRef.current
    const snapshot = makeEditorSnapshot()

    if (prev.index >= 0 && areEditorSnapshotsShallowEqual(prev.items[prev.index], snapshot)) {
      return
    }

    let items = prev.items.slice(0, prev.index + 1)
    items.push(snapshot)
    if (items.length > MAX_EDITOR_HISTORY) {
      items = items.slice(items.length - MAX_EDITOR_HISTORY)
    }
    commitEditorHistory({ items, index: items.length - 1 })
  }, [makeEditorSnapshot, commitEditorHistory])

  const applyEditorSnapshot = useCallback((snapshot: EditorSnapshot) => {
    setStationOverrides(snapshot.stationOverrides)
    setEdgeOverrides(snapshot.edgeOverrides)
    setEdgeTransferKinds(snapshot.edgeTransferKinds)
    setManualEdges(snapshot.manualEdges)
    pendingLayoutOverridesRef.current = null
    setLastLayoutOverrides(snapshot.lastLayoutOverrides)
    setEditorLayoutApplyToken((prev: number) => prev + 1)

    // canonicalGrid/RingShapes/StationParams не восстанавливаются: MetroMap
    // пересчитает их из применённой раскладки и пришлёт через
    // onCanonicalLayoutChange (см. комментарий к EditorSnapshot).
  }, [])

  const handleEditorUndo = useCallback(() => {
    const prev = editorHistoryRef.current
    if (prev.index <= 0) return
    const nextIndex = prev.index - 1
    commitEditorHistory({ ...prev, index: nextIndex })
    applyEditorSnapshot(prev.items[nextIndex])
  }, [applyEditorSnapshot, commitEditorHistory])

  const handleEditorRedo = useCallback(() => {
    const prev = editorHistoryRef.current
    if (prev.index < 0 || prev.index >= prev.items.length - 1) return
    const nextIndex = prev.index + 1
    commitEditorHistory({ ...prev, index: nextIndex })
    applyEditorSnapshot(prev.items[nextIndex])
  }, [applyEditorSnapshot, commitEditorHistory])

  const canEditorUndo = editorHistory.index > 0
  const canEditorRedo =
    editorHistory.index >= 0 && editorHistory.index < editorHistory.items.length - 1

  const handleLayoutChange = useCallback((overrides: Record<string, { x: number; y: number }>) => {
    pendingLayoutOverridesRef.current = overrides
  }, [])

  useEffect(() => {
    if (!editMode) return
    setEditorLayoutApplyToken((prev: number) => prev + 1)
  }, [editMode])

  useEffect(() => {
    // Опрос pendingLayoutOverridesRef нужен только в режиме редактора.
    // В продакшене редактора нет, и вечный интервал зря жёг батарею.
    if (!editMode) {
      pendingLayoutOverridesRef.current = null
      return
    }

    let timeoutId: number | null = null

    const flush = () => {
      timeoutId = null
      const pending = pendingLayoutOverridesRef.current
      if (!pending) return
      pendingLayoutOverridesRef.current = null
      setLastLayoutOverrides((prev: Record<string, { x: number; y: number }>) => {
        const prevKeys = Object.keys(prev)
        const nextKeys = Object.keys(pending)
        if (prevKeys.length === nextKeys.length) {
          let same = true
          for (const id of nextKeys) {
            const p = prev[id]
            const n = pending[id]
            if (!p || !n || p.x !== n.x || p.y !== n.y) {
              same = false
              break
            }
          }
          if (same) return prev
        }
        return pending
      })
    }

    const schedule = () => {
      if (timeoutId != null) return
      timeoutId = window.setTimeout(flush, 50)
    }

    const interval = window.setInterval(() => {
      if (pendingLayoutOverridesRef.current) {
        schedule()
      }
    }, 60)

    return () => {
      if (timeoutId != null) {
        window.clearTimeout(timeoutId)
      }
      window.clearInterval(interval)
    }
  }, [editMode])

  // Запись в историю на каждое изменение редактируемого состояния.
  // `makeEditorSnapshot` меняет ссылку ровно тогда, когда меняется любое из
  // полей снапшота, поэтому отдельного перечисления состояний не нужно.
  useEffect(() => {
    if (!editMode) return
    pushEditorHistory()
  }, [editMode, makeEditorSnapshot, pushEditorHistory])

  useEffect(() => {
    if (editMode) return
    commitEditorHistory({ items: [], index: -1 })
  }, [editMode, commitEditorHistory])

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
          if (canEditorRedo) {
            event.preventDefault()
            handleEditorRedo()
          }
        } else {
          if (canEditorUndo) {
            event.preventDefault()
            handleEditorUndo()
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [editMode, canEditorUndo, canEditorRedo, handleEditorUndo, handleEditorRedo])

  // Ctrl+E — вкл/выкл редактор, Escape — закрыть панель/режим, Ctrl+D — отладка коллизий.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      const isInputLike =
        tag === 'INPUT' || tag === 'TEXTAREA' || (target && target.isContentEditable)
      if (isInputLike) return

      if ((event.key === 'e' || event.key === 'E') && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        setEditMode((prev: boolean) => !prev)
        return
      }

      if (event.key === 'Escape') {
        if (inspectedStationId) {
          event.preventDefault()
          setInspectedStationId(null)
          return
        }
        if (editMode) {
          event.preventDefault()
          setEditMode(false)
        }
        return
      }

      if (editMode && (event.key === 'd' || event.key === 'D') && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        setCollisionDebug((prev: boolean) => !prev)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [editMode, inspectedStationId])

  // --- производные представления графа -------------------------------------

  // Станции берутся только из графа. Раньше сюда подмешивались созданные в
  // редакторе, но создать их было нечем: единственная кнопка вела к функции без
  // единого вызывающего, а сохранение такой станции сервер всё равно отвергал.
  const allStations = fullGraphStations

  const stationById = useMemo(() => {
    const map = new Map<string, FullGraphStation>()
    for (const s of allStations) {
      map.set(s.id, s)
    }
    return map
  }, [allStations])

  const stationTitleById = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of allStations) {
      const ov = stationOverrides[s.id]
      const title = ov?.title?.trim() || s.title
      map.set(s.id, title)
    }
    return map
  }, [allStations, stationOverrides])

  const findExactStationByName = useCallback(
    (name: string) => {
      const q = name.trim().toLowerCase()
      if (!q) return undefined

      for (const s of allStations) {
        const ov = stationOverrides[s.id]
        const title = ov?.title?.trim() || s.title
        if (title.toLowerCase() === q) return s
      }

      return undefined
    },
    [allStations, stationOverrides],
  )

  const stationTitleOverridesForMap = useMemo(() => {
    const result: Record<string, string> = {}
    for (const [stationId, ov] of Object.entries(stationOverrides)) {
      const t = ov.title?.trim()
      if (t) {
        result[stationId] = t
      }
    }
    return result
  }, [stationOverrides])



  const lineByNumericId = useMemo(() => {
    const map = new Map<number, (typeof fullGraphLines)[number]>()
    for (const line of fullGraphLines) {
      map.set(line.id, line)
    }
    return map
  }, [])

  const inspectedStation = useMemo(() => {
    if (!inspectedStationId) return null
    return stationById.get(inspectedStationId) ?? null
  }, [inspectedStationId, stationById])

  useEffect(() => {
    if (!inspectedStationId) {
      setInspectedLineId(null)
      return
    }
    const st = stationById.get(inspectedStationId)
    const ov = stationOverrides[inspectedStationId]
    const effectiveLineNumericId =
      ov && ov.lineNumericId !== undefined ? ov.lineNumericId : st?.lineNumericId ?? null
    setInspectedLineId(effectiveLineNumericId)
  }, [inspectedStationId, stationById, stationOverrides])

  const inspectedEdges = useMemo(() => {
    if (!inspectedStation) return [] as FullGraphEdge[]
    const result: FullGraphEdge[] = []
    const seen = new Set<string>()

    for (const e of fullGraphEdges) {
      if (e.fromStationId === inspectedStation.id || e.toStationId === inspectedStation.id) {
        result.push(e)
        const key =
          e.fromStationId < e.toStationId
            ? `${e.fromStationId}|${e.toStationId}`
            : `${e.toStationId}|${e.fromStationId}`
        seen.add(key)
      }
    }

    for (const e of Object.values(manualEdges)) {
      if (e.fromStationId !== inspectedStation.id && e.toStationId !== inspectedStation.id) continue
      const key =
        e.fromStationId < e.toStationId
          ? `${e.fromStationId}|${e.toStationId}`
          : `${e.toStationId}|${e.fromStationId}`
      if (seen.has(key)) continue
      result.push(e)
    }

    return result
  }, [inspectedStation, manualEdges])

  // --- обработчики ----------------------------------------------------------

  /**
   * Перегон <-> пересадка, и ничего больше.
   *
   * Прежде это была карусель из трёх положений: перегон -> «близкая» ->
   * «дальняя» -> перегон, — и каждый щелчок ПЕРЕПИСЫВАЛ время, потому что
   * «близкая» и «дальняя» ничем, кроме времени, не различались: тип пересадки
   * в патч всегда уходил базовый. Теперь тип выбирается явно
   * (`changeEdgeTransferKind`), а время трогает только тот, кто его правит.
   */
  const handleToggleEdgeTransfer = useCallback(
    (edge: FullGraphEdge) => {
      const key = edgeKey(edge.fromStationId, edge.toStationId)
      const baseIsTransfer = !!edge.isTransfer

      setEdgeOverrides((prev: Record<string, EdgeOverride>) => {
        const current = prev[key]
        const effectiveIsTransfer =
          current && current.isTransfer !== undefined ? current.isTransfer : baseIsTransfer

        const nextOverride: EdgeOverride = { ...(current ?? {}), isTransfer: !effectiveIsTransfer }

        const isSameAsBase =
          (nextOverride.disabled === undefined || nextOverride.disabled === false) &&
          nextOverride.isTransfer === baseIsTransfer &&
          (nextOverride.medianTravelSeconds === undefined ||
            nextOverride.medianTravelSeconds === edge.medianTravelSeconds)

        if (isSameAsBase) {
          if (!(key in prev)) return prev
          const cloned = { ...prev }
          delete cloned[key]
          return cloned
        }

        return { ...prev, [key]: nextOverride }
      })
    },
    [edgeKey],
  )

  const handleChangeEdgeTransferKind = useCallback(
    (edge: FullGraphEdge, kind: TransferKind) => {
      const key = edgeKey(edge.fromStationId, edge.toStationId)
      const baseKind = edge.transferKind ?? DEFAULT_TRANSFER_KIND

      setEdgeTransferKinds((prev) => {
        if (kind === baseKind) {
          if (!(key in prev)) return prev
          const cloned = { ...prev }
          delete cloned[key]
          return cloned
        }
        if (prev[key] === kind) return prev
        return { ...prev, [key]: kind }
      })
    },
    [edgeKey],
  )

  const handleToggleEdgeDisabled = useCallback(
    (edge: FullGraphEdge) => {
      setEdgeOverrides((prev) => {
        const key = edgeKey(edge.fromStationId, edge.toStationId)
        const current = prev[key]

        const effectiveDisabled = current?.disabled ?? false
        const nextDisabled = !effectiveDisabled

        const nextOverride: EdgeOverride = {
          ...(current ?? {}),
          disabled: nextDisabled,
        }

        const baseIsTransfer = !!edge.isTransfer
        const baseSeconds = edge.medianTravelSeconds

        const isSameAsBase =
          (nextOverride.disabled === undefined || nextOverride.disabled === false) &&
          (nextOverride.isTransfer === undefined || nextOverride.isTransfer === baseIsTransfer) &&
          (nextOverride.medianTravelSeconds === undefined ||
            nextOverride.medianTravelSeconds === baseSeconds)

        if (isSameAsBase) {
          if (!(key in prev)) return prev
          const cloned = { ...prev }
          delete cloned[key]
          return cloned
        }

        return { ...prev, [key]: nextOverride }
      })
    },
    [edgeKey],
  )

  const handleChangeEdgeMinutes = useCallback(
    (edge: FullGraphEdge, timeStr: string) => {
      setEdgeOverrides((prev) => {
        const key = edgeKey(edge.fromStationId, edge.toStationId)
        const current = prev[key]

        const baseSeconds = edge.medianTravelSeconds
        // Разбор «м:сс» либо голых секунд — см. travelTime.ts о том, почему
        // минуты как единица здесь не годятся. Ноль допустим: это осмысленное
        // значение, а не отсутствие ввода.
        const parsed = parseTravelTime(timeStr)
        const newSeconds = parsed != null && parsed >= 0 ? parsed : undefined

        if (newSeconds === undefined) {
          if (!current) {
            if (!(key in prev)) return prev
            const cloned = { ...prev }
            delete cloned[key]
            return cloned
          }

          const nextOverride: EdgeOverride = {}
          if (current.isTransfer !== undefined) {
            nextOverride.isTransfer = current.isTransfer
          }
          if (current.disabled !== undefined) {
            nextOverride.disabled = current.disabled
          }

          const isSameAsBase =
            (nextOverride.disabled === undefined || nextOverride.disabled === false) &&
            (nextOverride.isTransfer === undefined || nextOverride.isTransfer === !!edge.isTransfer)

          if (isSameAsBase) {
            if (!(key in prev)) return prev
            const cloned = { ...prev }
            delete cloned[key]
            return cloned
          }

          return { ...prev, [key]: nextOverride }
        }

        const nextOverride: EdgeOverride = {
          ...(current ?? {}),
          medianTravelSeconds: newSeconds,
        }

        const isSameAsBase =
          (nextOverride.disabled === undefined || nextOverride.disabled === false) &&
          (nextOverride.isTransfer === undefined || nextOverride.isTransfer === !!edge.isTransfer) &&
          nextOverride.medianTravelSeconds === baseSeconds

        if (isSameAsBase) {
          if (!(key in prev)) return prev
          const cloned = { ...prev }
          delete cloned[key]
          return cloned
        }

        return { ...prev, [key]: nextOverride }
      })
    },
    [edgeKey],
  )

  const handleInspectStation = useCallback((stationId: string) => {
    setInspectedStationId(stationId)
  }, [])

  const handleFocusStation = useCallback((stationId: string) => {
    setEditorFocusCommand(() => {
      editorFocusTokenRef.current += 1
      return { stationId, token: editorFocusTokenRef.current }
    })
  }, [])

  const handleUpdateStationGeoFromOSM = useCallback(
    async (stationId: string) => {
      const base = stationById.get(stationId)
      if (!base) {
        throw new Error('Станция не найдена')
      }

      const title = stationOverrides[stationId]?.title?.trim() || base.title

      // Запрос был «станция метро {название}, Москва» и не находил НИЧЕГО.
      // В OSM объект называется просто «Боровицкая»; слова «станция метро» в
      // имени нет, а свободный поиск Nominatim не разбирает их как категорию —
      // он честно ищет эту фразу целиком. Ломалось для любой станции, в чьём
      // названии нет слова «метро», то есть практически для всех.
      //
      // Ищем по имени, а принадлежность к метро проверяем по классу объекта в
      // ответе. Берём пять кандидатов, а не один: по названию станции первым
      // может прийти одноимённая улица или площадь.
      const query = `${title}, Москва`
      const url =
        'https://nominatim.openstreetmap.org/search' +
        `?format=jsonv2&limit=5&countrycodes=ru&accept-language=ru&q=${encodeURIComponent(query)}`

      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      })

      if (resp.status === 429 || resp.status === 403) {
        // Nominatim ограничивает до одного запроса в секунду. Без этой ветки
        // отказ выглядел как «координаты не найдены», и станцию искали в OSM
        // руками, хотя она там есть.
        throw new Error('OSM: слишком часто, подожди секунду и повтори')
      }

      if (!resp.ok) {
        throw new Error(`OSM API error: ${resp.status}`)
      }

      const data = (await resp.json()) as Array<{
        lat?: string
        lon?: string
        category?: string
        class?: string
        type?: string
      }>

      const isRailway = (item: (typeof data)[number]) =>
        item.category === 'railway' || item.class === 'railway'

      const first = data.find(isRailway) ?? data[0]
      const lat = first?.lat != null ? Number(first.lat) : NaN
      const lon = first?.lon != null ? Number(first.lon) : NaN
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error('OSM: координаты не найдены')
      }

      setStationOverrides((prev) => {
        const baseLat = base.lat
        const baseLon = base.lon
        const current = prev[stationId]
        const next: StationOverride = { ...(current ?? {}) }

        if (baseLat !== undefined && lat === baseLat) {
          delete next.lat
        } else {
          next.lat = lat
        }

        if (baseLon !== undefined && lon === baseLon) {
          delete next.lon
        } else {
          next.lon = lon
        }

        if (
          next.title === undefined &&
          next.lineNumericId === undefined &&
          next.lat === undefined &&
          next.lon === undefined
        ) {
          if (!(stationId in prev)) return prev
          const cloned = { ...prev }
          delete cloned[stationId]
          return cloned
        }

        // Сравнение «ничего не изменилось» смотрело только title и
        // lineNumericId — то есть ровно те два поля, которых эта операция не
        // касается. У станции с любым оверрайдом (например, переименованной)
        // полученные координаты молча выбрасывались, а тост «lat/lon обновлены»
        // всё равно показывался: снаружи это выглядело как успешная запись.
        if (
          current &&
          current.title === next.title &&
          current.lineNumericId === next.lineNumericId &&
          current.lat === next.lat &&
          current.lon === next.lon
        ) {
          return prev
        }

        return { ...prev, [stationId]: next }
      })

      showEditorToast('lat/lon обновлены (OSM)')
    },
    [stationById, stationOverrides, showEditorToast],
  )

  const handleChangeStationTitle = useCallback(
    (stationId: string, nextTitle: string) => {
      setStationOverrides((prev) => {
        const base = stationById.get(stationId)
        if (!base) return prev

        const trimmed = nextTitle.trim()
        const baseTitle = base.title
        const current = prev[stationId]
        const next: StationOverride = { ...(current ?? {}) }

        if (!trimmed || trimmed === baseTitle) {
          delete next.title
        } else {
          next.title = trimmed
        }

        if (
          next.title === undefined &&
          next.lineNumericId === undefined &&
          next.lat === undefined &&
          next.lon === undefined
        ) {
          if (!(stationId in prev)) return prev
          const cloned = { ...prev }
          delete cloned[stationId]
          return cloned
        }

        if (current && current.title === next.title && current.lineNumericId === next.lineNumericId) {
          return prev
        }

        return { ...prev, [stationId]: next }
      })
    },
    [stationById],
  )

  const handleChangeStationLine = useCallback(
    (stationId: string, lineIdStr: string) => {
      setStationOverrides((prev) => {
        const base = stationById.get(stationId)
        if (!base) return prev

        const baseLine = base.lineNumericId ?? null
        const current = prev[stationId]
        const next: StationOverride = { ...(current ?? {}) }

        const raw = lineIdStr.trim()
        let newLine: number | null
        if (raw === '') {
          newLine = null
        } else {
          const parsed = Number(raw)
          if (!Number.isFinite(parsed)) {
            return prev
          }
          newLine = parsed
        }

        if (newLine === baseLine) {
          delete next.lineNumericId
        } else {
          next.lineNumericId = newLine
        }

        if (next.title === undefined && next.lineNumericId === undefined) {
          if (!(stationId in prev)) return prev
          const cloned = { ...prev }
          delete cloned[stationId]
          return cloned
        }

        if (current && current.title === next.title && current.lineNumericId === next.lineNumericId) {
          return prev
        }

        return { ...prev, [stationId]: next }
      })
    },
    [stationById],
  )

  const handleResetStationEdits = useCallback(
    (stationId: string) => {
      setStationOverrides((prev) => {
        if (!(stationId in prev)) return prev
        const next = { ...prev }
        delete next[stationId]
        return next
      })

      const base = stationById.get(stationId)
      const baseX = base && typeof base.layoutX === 'number' ? base.layoutX : undefined
      const baseY = base && typeof base.layoutY === 'number' ? base.layoutY : undefined
      if (baseX !== undefined && baseY !== undefined) {
        pendingLayoutOverridesRef.current = null
        setLastLayoutOverrides((prev: Record<string, { x: number; y: number }>) => {
          const current = prev[stationId]
          if (current && current.x === baseX && current.y === baseY) return prev
          return { ...prev, [stationId]: { x: baseX, y: baseY } }
        })
        setEditorLayoutApplyToken((prev: number) => prev + 1)
      }

      showEditorToast('Изменения станции сброшены')
    },
    [stationById, showEditorToast],
  )

  const handleResetEdgeEdits = useCallback(
    (edge: FullGraphEdge) => {
      const key = edgeKey(edge.fromStationId, edge.toStationId)
      const manualKey = `manual:${key}`

      setEdgeOverrides((prev) => {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })

      setEdgeTransferKinds((prev) => {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })

      setManualEdges((prev) => {
        if (!(manualKey in prev)) return prev
        const next = { ...prev }
        delete next[manualKey]
        return next
      })

      showEditorToast('Изменения ребра сброшены')
    },
    [edgeKey, showEditorToast],
  )

  const toggleEditMode = useCallback(() => setEditMode((prev: boolean) => !prev), [])
  const exitEditMode = useCallback(() => setEditMode(false), [])
  const toggleCollisionDebug = useCallback(() => setCollisionDebug((prev: boolean) => !prev), [])

  const mapProps = useMemo(
    () => ({
      editMode,
      collisionDebug,
      onLayoutChange: handleLayoutChange,
      editorLayoutOverrides: lastLayoutOverrides,
      editorLayoutApplyToken,
      onEditStationInspect: handleInspectStation,
      stationTitleOverrides: stationTitleOverridesForMap,
      editorFocusCommand,
    }),
    [
      editMode,
      collisionDebug,
      handleLayoutChange,
      lastLayoutOverrides,
      editorLayoutApplyToken,
      handleInspectStation,
      stationTitleOverridesForMap,
      editorFocusCommand,
    ],
  )

  const overlay = useMemo(
    () => ({
      toast: editorToast,

      inspectedStation,
      inspectedLineId,
      inspectedEdges,

      stationOverrides,
      edgeOverrides,
      edgeTransferKinds,
      manualEdges,
      lastLayoutOverrides,

      stationById,
      lineByNumericId,
      findExactStationByName,
      edgeKey,

      collisionDebug,
      canUndo: canEditorUndo,
      canRedo: canEditorRedo,

      setManualEdges,
      setInspectedStationId,

      undo: handleEditorUndo,
      redo: handleEditorRedo,
      toggleEditMode,
      exitEditMode,
      toggleCollisionDebug,

      changeStationTitle: handleChangeStationTitle,
      changeStationLine: handleChangeStationLine,
      changeEdgeMinutes: handleChangeEdgeMinutes,
      toggleEdgeTransfer: handleToggleEdgeTransfer,
      changeEdgeTransferKind: handleChangeEdgeTransferKind,
      toggleEdgeDisabled: handleToggleEdgeDisabled,
      focusStation: handleFocusStation,
      updateStationGeoFromOSM: handleUpdateStationGeoFromOSM,
      resetStationEdits: handleResetStationEdits,
      resetEdgeEdits: handleResetEdgeEdits,
    }),
    [
      editorToast,
      inspectedStation,
      inspectedLineId,
      inspectedEdges,
      stationOverrides,
      edgeOverrides,
      edgeTransferKinds,
      manualEdges,
      lastLayoutOverrides,
      stationById,
      lineByNumericId,
      findExactStationByName,
      edgeKey,
      collisionDebug,
      canEditorUndo,
      canEditorRedo,
      handleEditorUndo,
      handleEditorRedo,
      toggleEditMode,
      exitEditMode,
      toggleCollisionDebug,
      handleChangeStationTitle,
      handleChangeStationLine,
      handleChangeEdgeMinutes,
      handleToggleEdgeTransfer,
      handleChangeEdgeTransferKind,
      handleToggleEdgeDisabled,
      handleFocusStation,
      handleUpdateStationGeoFromOSM,
      handleResetStationEdits,
      handleResetEdgeEdits,
    ],
  )

  return {
    editMode,
    allStations,
    stationById,
    stationTitleById,
    stationOverrides,
    edgeOverrides,
    manualEdges,
    mapProps,
    overlay,
  }
}
