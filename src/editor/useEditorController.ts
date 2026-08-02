import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TransferKind } from './transferKinds.ts'
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
  EditorSnapshot,
  StationOverride,
} from './editorTypes.ts'
import { useEditorHistory } from './useEditorHistory.ts'
import { fetchStationGeoFromOSM } from './osmGeo.ts'
import * as stationEdits from './stationEdits.ts'
import * as edgeEdits from './edgeEdits.ts'

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

  const {
    canUndo: canEditorUndo,
    canRedo: canEditorRedo,
    undo: handleEditorUndo,
    redo: handleEditorRedo,
  } = useEditorHistory({
    editMode,
    snapshot: makeEditorSnapshot,
    apply: applyEditorSnapshot,
  })

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

  // Как именно правка меняет таблицу оверрайдов — в edgeEdits.ts; здесь
  // остаётся только ключ ребра и вызов setState.
  const handleToggleEdgeTransfer = useCallback(
    (edge: FullGraphEdge) => {
      const key = edgeKey(edge.fromStationId, edge.toStationId)
      setEdgeOverrides((prev) => edgeEdits.toggleTransfer(prev, key, edge))
    },
    [edgeKey],
  )

  const handleChangeEdgeTransferKind = useCallback(
    (edge: FullGraphEdge, kind: TransferKind) => {
      const key = edgeKey(edge.fromStationId, edge.toStationId)
      setEdgeTransferKinds((prev) => edgeEdits.setTransferKind(prev, key, edge, kind))
    },
    [edgeKey],
  )

  const handleToggleEdgeDisabled = useCallback(
    (edge: FullGraphEdge) => {
      const key = edgeKey(edge.fromStationId, edge.toStationId)
      setEdgeOverrides((prev) => edgeEdits.toggleDisabled(prev, key, edge))
    },
    [edgeKey],
  )

  const handleChangeEdgeMinutes = useCallback(
    (edge: FullGraphEdge, timeStr: string) => {
      const key = edgeKey(edge.fromStationId, edge.toStationId)
      setEdgeOverrides((prev) => edgeEdits.setTravelTime(prev, key, edge, timeStr))
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
      const { lat, lon } = await fetchStationGeoFromOSM(title)

      setStationOverrides((prev) => stationEdits.setGeo(prev, base, lat, lon))
      showEditorToast('lat/lon обновлены (OSM)')
    },
    [stationById, stationOverrides, showEditorToast],
  )

  const handleChangeStationTitle = useCallback(
    (stationId: string, nextTitle: string) => {
      setStationOverrides((prev) => {
        const base = stationById.get(stationId)
        if (!base) return prev
        return stationEdits.setTitle(prev, base, nextTitle)
      })
    },
    [stationById],
  )

  const handleChangeStationLine = useCallback(
    (stationId: string, lineIdStr: string) => {
      setStationOverrides((prev) => {
        const base = stationById.get(stationId)
        if (!base) return prev
        return stationEdits.setLine(prev, base, lineIdStr)
      })
    },
    [stationById],
  )

  const handleResetStationEdits = useCallback(
    (stationId: string) => {
      setStationOverrides((prev) => stationEdits.forgetStation(prev, stationId))

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

      setEdgeOverrides((prev) => edgeEdits.forgetEdge(prev, key))
      setEdgeTransferKinds((prev) => edgeEdits.forgetEdge(prev, key))
      setManualEdges((prev) => edgeEdits.forgetEdge(prev, manualKey))

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
