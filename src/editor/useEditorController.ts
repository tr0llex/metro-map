import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fullGraphEdges,
  fullGraphLines,
  fullGraphStations,
  fullGraphTransferHubs,
} from '../metro/fullGraph.ts'
import type {
  EdgeOverride,
  LayoutRingShape,
  FullGraphEdge,
  FullGraphStation,
} from '../metro/types.ts'
import type {
  CanonicalLayoutPayload,
  EditorController,
  EditorFocusCommand,
  EditorHistoryState,
  EditorSnapshot,
  HubMirrorCommand,
  HubRotateCommand,
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
    a.stationHubOverrides === b.stationHubOverrides &&
    a.edgeOverrides === b.edgeOverrides &&
    a.hubMinOverrides === b.hubMinOverrides &&
    a.manualStations === b.manualStations &&
    a.manualEdges === b.manualEdges &&
    a.hiddenStations === b.hiddenStations &&
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
  const [stationHubOverrides, setStationHubOverrides] = useState<Record<string, string | null>>({})
  const [edgeOverrides, setEdgeOverrides] = useState<Record<string, EdgeOverride>>({})
  const [hubMinOverrides, setHubMinOverrides] = useState<Record<string, number>>({})
  const [canonicalRingShapes, setCanonicalRingShapes] = useState<
    Record<string, LayoutRingShape>
  >({})
  const [manualStations, setManualStations] = useState<Record<string, FullGraphStation>>({})
  const [manualEdges, setManualEdges] = useState<Record<string, FullGraphEdge>>({})
  const [hiddenStations, setHiddenStations] = useState<Record<string, true>>({})
  const [newEdgeTarget, setNewEdgeTarget] = useState('')
  const [hubAddStationInput, setHubAddStationInput] = useState('')
  const [editorSelectedStationIds, setEditorSelectedStationIds] = useState<string[]>([])
  const [editorToast, setEditorToast] = useState<string | null>(null)
  const editorToastTimeoutRef = useRef<number | null>(null)

  const [lastLayoutOverrides, setLastLayoutOverrides] = useState<
    Record<string, { x: number; y: number }>
  >({})
  const [editorLayoutApplyToken, setEditorLayoutApplyToken] = useState(0)
  const pendingLayoutOverridesRef = useRef<Record<string, { x: number; y: number }> | null>(null)

  const [hubRotateCommand, setHubRotateCommand] = useState<HubRotateCommand | null>(null)
  const [hubMirrorCommand, setHubMirrorCommand] = useState<HubMirrorCommand | null>(null)
  const [editorFocusCommand, setEditorFocusCommand] = useState<EditorFocusCommand | null>(null)
  const [editorHistory, setEditorHistory] = useState<EditorHistoryState>({ items: [], index: -1 })

  const hubRotateTokenRef = useRef(0)
  const hubMirrorTokenRef = useRef(0)
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

  const handleMirrorHubGeometry = useCallback(
    (hubId: string) => {
      setHubMirrorCommand(() => {
        hubMirrorTokenRef.current += 1
        return { hubId, token: hubMirrorTokenRef.current }
      })
      showEditorToast('Хаб отзеркален')
    },
    [showEditorToast],
  )

  // --- история undo/redo ----------------------------------------------------

  const makeEditorSnapshot = useCallback((): EditorSnapshot => {
    return {
      stationOverrides,
      stationHubOverrides,
      edgeOverrides,
      hubMinOverrides,
      manualStations,
      manualEdges,
      hiddenStations,
      lastLayoutOverrides,
    }
  }, [
    stationOverrides,
    stationHubOverrides,
    edgeOverrides,
    hubMinOverrides,
    manualStations,
    manualEdges,
    hiddenStations,
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
    setStationHubOverrides(snapshot.stationHubOverrides)
    setEdgeOverrides(snapshot.edgeOverrides)
    setHubMinOverrides(snapshot.hubMinOverrides)
    setManualStations(snapshot.manualStations)
    setManualEdges(snapshot.manualEdges)
    setHiddenStations(snapshot.hiddenStations)
    pendingLayoutOverridesRef.current = null
    setLastLayoutOverrides(snapshot.lastLayoutOverrides)
    setEditorLayoutApplyToken((prev: number) => prev + 1)

    // canonicalGrid/RingShapes/StationParams не восстанавливаются: MetroMap
    // пересчитает их из применённой раскладки и пришлёт через
    // onCanonicalLayoutChange (см. комментарий к EditorSnapshot).
  }, [])

  const handleCanonicalLayoutChange = useCallback((payload: CanonicalLayoutPayload) => {
    setCanonicalRingShapes(payload.ringShapes)
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

  const allStations = useMemo(() => {
    const manualList = Object.values(manualStations)
    if (manualList.length === 0) return fullGraphStations
    return [...fullGraphStations, ...manualList]
  }, [manualStations])

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

  const extraStationsForMap = useMemo(() => Object.values(manualStations), [manualStations])

  const hiddenStationIdSet = useMemo(() => new Set(Object.keys(hiddenStations)), [hiddenStations])

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

  const inspectedHub = useMemo(() => {
    if (!inspectedStation || !inspectedStation.hubId) {
      return null
    }
    const override = stationHubOverrides[inspectedStation.id]
    let hubId: string | null
    if (override === null) hubId = null
    else if (override !== undefined) hubId = override
    else hubId = inspectedStation.hubId ?? null

    if (!hubId) return null

    // На панели редактирования используем эффективный список хабов с учётом оверрайдов
    const hubMeta = new Map<
      string,
      { minTransferSeconds: number; source: (typeof fullGraphTransferHubs)[number]['source'] }
    >()
    for (const hub of fullGraphTransferHubs) {
      hubMeta.set(hub.id, { minTransferSeconds: hub.minTransferSeconds, source: hub.source })
    }

    const hubToStationIds = new Map<string, string[]>()
    for (const st of allStations) {
      const stOverride = stationHubOverrides[st.id]
      let effectiveHubId: string | null
      if (stOverride === null) effectiveHubId = null
      else if (stOverride !== undefined) effectiveHubId = stOverride
      else effectiveHubId = st.hubId ?? null
      if (!effectiveHubId) continue
      let list = hubToStationIds.get(effectiveHubId)
      if (!list) {
        list = []
        hubToStationIds.set(effectiveHubId, list)
      }
      list.push(st.id)
    }

    const stationIds = hubToStationIds.get(hubId)
    if (!stationIds || stationIds.length === 0) return null

    const meta = hubMeta.get(hubId)
    const baseMinSeconds = meta?.minTransferSeconds ?? 180
    const overrideMinSeconds = hubMinOverrides[hubId]
    const minTransferSeconds = overrideMinSeconds ?? baseMinSeconds

    return {
      id: hubId,
      stationIds,
      minTransferSeconds,
      source: (meta?.source ?? 'data') as (typeof fullGraphTransferHubs)[number]['source'],
    }
  }, [inspectedStation, stationHubOverrides, hubMinOverrides, allStations])

  const inspectedLine = useMemo(() => {
    if (inspectedLineId == null) return null
    return lineByNumericId.get(inspectedLineId) ?? null
  }, [inspectedLineId, lineByNumericId])

  const effectiveLineStationIdsById = useMemo(() => {
    const stationEffectiveLineId = new Map<string, number | null>()

    for (const s of fullGraphStations) {
      const ov = stationOverrides[s.id]
      if (ov && ov.lineNumericId !== undefined) {
        stationEffectiveLineId.set(s.id, ov.lineNumericId)
      } else {
        stationEffectiveLineId.set(s.id, s.lineNumericId ?? null)
      }
    }

    for (const s of Object.values(manualStations)) {
      const ov = stationOverrides[s.id]
      if (ov && ov.lineNumericId !== undefined) {
        stationEffectiveLineId.set(s.id, ov.lineNumericId)
      } else {
        stationEffectiveLineId.set(s.id, s.lineNumericId ?? null)
      }
    }

    const edgesByLineId = new Map<number, { from: string; to: string }[]>()

    const processEdge = (e: FullGraphEdge) => {
      if (e.lineNumericId == null) return
      const key = edgeKey(e.fromStationId, e.toStationId)
      const ov = edgeOverrides[key]
      if (ov?.disabled) return
      let list = edgesByLineId.get(e.lineNumericId)
      if (!list) {
        list = []
        edgesByLineId.set(e.lineNumericId, list)
      }
      list.push({ from: e.fromStationId, to: e.toStationId })
    }

    for (const e of fullGraphEdges) {
      processEdge(e)
    }

    for (const e of Object.values(manualEdges)) {
      processEdge(e)
    }

    const result = new Map<number, string[]>()

    for (const line of fullGraphLines) {
      const lineId = line.id

      const baseSeq: string[] = []
      for (const sid of line.stationIds) {
        const eff = stationEffectiveLineId.get(sid) ?? null
        if (eff === lineId) {
          baseSeq.push(sid)
        }
      }

      const seq: string[] = [...baseSeq]

      const extraIds: string[] = []
      for (const [sid, effLine] of stationEffectiveLineId.entries()) {
        if (effLine !== lineId) continue
        if (baseSeq.includes(sid)) continue
        extraIds.push(sid)
      }

      if (extraIds.length > 0) {
        const edges = edgesByLineId.get(lineId) ?? []

        const insertStation = (sid: string) => {
          let anchorIndex = -1
          for (const e of edges) {
            let other: string | null = null
            if (e.from === sid && seq.includes(e.to)) {
              other = e.to
            } else if (e.to === sid && seq.includes(e.from)) {
              other = e.from
            }
            if (!other) continue
            const idx = seq.indexOf(other)
            if (idx >= 0) {
              anchorIndex = idx
              break
            }
          }

          if (anchorIndex >= 0) {
            seq.splice(anchorIndex + 1, 0, sid)
          } else {
            seq.push(sid)
          }
        }

        for (const sid of extraIds) {
          insertStation(sid)
        }
      }

      result.set(lineId, seq)
    }

    return result
  }, [stationOverrides, manualStations, manualEdges, edgeOverrides, edgeKey])

  const inspectedLineEdges = useMemo(() => {
    if (!inspectedLine) return [] as FullGraphEdge[]

    const result: FullGraphEdge[] = []
    const seen = new Set<string>()

    const addEdge = (e: FullGraphEdge) => {
      if (e.lineNumericId !== inspectedLine.id) return
      const key =
        e.fromStationId < e.toStationId
          ? `${e.fromStationId}|${e.toStationId}`
          : `${e.toStationId}|${e.fromStationId}`
      if (seen.has(key)) return
      seen.add(key)
      result.push(e)
    }

    for (const e of fullGraphEdges) {
      addEdge(e)
    }

    for (const e of Object.values(manualEdges)) {
      addEdge(e)
    }

    return result
  }, [inspectedLine, manualEdges])

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

  const availableHubIds = useMemo(() => {
    const ids = new Set<string>()
    for (const hub of fullGraphTransferHubs) {
      ids.add(hub.id)
    }
    for (const value of Object.values(stationHubOverrides)) {
      if (value && value !== null) {
        ids.add(value)
      }
    }
    return Array.from(ids).sort()
  }, [stationHubOverrides])

  // --- обработчики ----------------------------------------------------------

  const handleToggleEdgeTransfer = useCallback(
    (edge: FullGraphEdge) => {
      setEdgeOverrides((prev: Record<string, EdgeOverride>) => {
        const key = edgeKey(edge.fromStationId, edge.toStationId)
        const baseIsTransfer = !!edge.isTransfer
        const baseSeconds = edge.medianTravelSeconds
        const current = prev[key]

        const effectiveIsTransfer =
          current && current.isTransfer !== undefined ? current.isTransfer : baseIsTransfer
        const effectiveSeconds =
          current && current.medianTravelSeconds !== undefined
            ? current.medianTravelSeconds
            : baseSeconds
        const effectiveMinutes = Math.round(effectiveSeconds / 60)

        const LONG_TRANSFER_MINUTES = 6

        let nextIsTransfer: boolean
        let nextSeconds: number | undefined = effectiveSeconds

        if (!effectiveIsTransfer) {
          // перегон -> пересадка (близкая)
          nextIsTransfer = true
          let minutes = effectiveMinutes
          if (!Number.isFinite(minutes) || minutes <= 0) minutes = 3
          if (minutes >= LONG_TRANSFER_MINUTES) minutes = LONG_TRANSFER_MINUTES - 1
          nextSeconds = minutes * 60
        } else if (effectiveMinutes < LONG_TRANSFER_MINUTES) {
          // пересадка (близкая) -> пересадка (дальняя)
          nextIsTransfer = true
          const minSeconds = LONG_TRANSFER_MINUTES * 60
          nextSeconds =
            Number.isFinite(effectiveSeconds) && effectiveSeconds > 0
              ? Math.max(effectiveSeconds, minSeconds)
              : minSeconds
        } else {
          // пересадка (дальняя) -> перегон
          nextIsTransfer = false
        }

        const nextOverride: EdgeOverride = {
          ...(current ?? {}),
          isTransfer: nextIsTransfer,
          medianTravelSeconds: nextSeconds,
        }

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
    (edge: FullGraphEdge, minutesStr: string) => {
      setEdgeOverrides((prev) => {
        const key = edgeKey(edge.fromStationId, edge.toStationId)
        const raw = minutesStr.replace(',', '.').trim()
        const minutes = raw === '' ? NaN : Number(raw)
        const current = prev[key]

        const baseSeconds = edge.medianTravelSeconds
        const hasValidMinutes = Number.isFinite(minutes) && minutes > 0
        const newSeconds = hasValidMinutes ? Math.round(minutes * 60) : undefined

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

  const handleToggleStationHidden = useCallback((stationId: string) => {
    setHiddenStations((prev: Record<string, true>) => {
      if (prev[stationId]) {
        const next = { ...prev }
        delete next[stationId]
        return next
      }
      return { ...prev, [stationId]: true }
    })
  }, [])

  const handleChangeStationHub = useCallback(
    (stationId: string, newHubId: string | null) => {
      setStationHubOverrides((prev) => {
        const base = stationById.get(stationId)
        const baseHubId = base?.hubId ?? null

        const targetHubId = newHubId

        // Если выбрали исходный hubId — снимаем оверрайд
        if (targetHubId === baseHubId) {
          if (!(stationId in prev)) return prev
          const next = { ...prev }
          delete next[stationId]
          return next
        }

        const next = { ...prev }
        next[stationId] = targetHubId
        return next
      })
    },
    [stationById],
  )

  const handleUpdateStationGeoFromOSM = useCallback(
    async (stationId: string) => {
      const base = stationById.get(stationId)
      if (!base) {
        throw new Error('Станция не найдена')
      }

      const title = stationOverrides[stationId]?.title?.trim() || base.title
      const query = `станция метро ${title}, Москва`
      const url =
        'https://nominatim.openstreetmap.org/search' +
        `?format=jsonv2&limit=1&countrycodes=ru&accept-language=ru&q=${encodeURIComponent(query)}`

      const resp = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      })

      if (!resp.ok) {
        throw new Error(`OSM API error: ${resp.status}`)
      }

      const data = (await resp.json()) as Array<{ lat?: string; lon?: string }>
      const first = data[0]
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

        if (current && current.title === next.title && current.lineNumericId === next.lineNumericId) {
          return prev
        }

        return { ...prev, [stationId]: next }
      })

      showEditorToast('lat/lon обновлены (OSM)')
    },
    [stationById, stationOverrides, showEditorToast],
  )

  const handleCreateManualStation = useCallback(() => {
    const existingIds = new Set<string>()
    for (const s of fullGraphStations) existingIds.add(s.id)
    for (const id of Object.keys(manualStations)) existingIds.add(id)

    let index = existingIds.size + 1
    let newId = `manual-${index}`
    while (existingIds.has(newId)) {
      index += 1
      newId = `manual-${index}`
    }

    let baseStation: FullGraphStation | null = inspectedStation
    if (!baseStation && fullGraphStations.length > 0) {
      baseStation = fullGraphStations[0]
    }

    let effectiveLineNumericId: number | null = null
    let baseX = 0
    let baseY = 0

    if (baseStation) {
      const ov = stationOverrides[baseStation.id]
      if (ov && ov.lineNumericId !== undefined) {
        effectiveLineNumericId = ov.lineNumericId
      } else {
        effectiveLineNumericId = baseStation.lineNumericId ?? null
      }

      const pos = lastLayoutOverrides[baseStation.id]
      if (pos) {
        baseX = pos.x
        baseY = pos.y
      } else if (typeof baseStation.layoutX === 'number' && typeof baseStation.layoutY === 'number') {
        baseX = baseStation.layoutX
        baseY = baseStation.layoutY
      }
    }

    const offset = 22
    const layoutX = baseX + offset
    const layoutY = baseY + offset

    const newStation: FullGraphStation = {
      id: newId,
      title: 'Новая станция',
      lineNumericId: effectiveLineNumericId,
      layoutX,
      layoutY,
      isTransfer: false,
    }

    setManualStations((prev) => ({
      ...prev,
      [newId]: newStation,
    }))

    if (baseStation) {
      const baseLine =
        (stationOverrides[baseStation.id]?.lineNumericId ?? baseStation.lineNumericId) ?? null
      const lineNumericId = effectiveLineNumericId != null ? effectiveLineNumericId : baseLine

      const keyUndirected = edgeKey(baseStation.id, newId)
      const manualKey = `manual:${keyUndirected}`

      setManualEdges((prev) => {
        if (prev[manualKey]) return prev

        const defaultSeconds = 180
        const newEdge: FullGraphEdge = {
          fromStationId: baseStation!.id,
          toStationId: newId,
          lineNumericId: lineNumericId ?? undefined,
          medianTravelSeconds: defaultSeconds,
          isTransfer: false,
        }

        return { ...prev, [manualKey]: newEdge }
      })
    }

    setInspectedStationId(newId)
  }, [inspectedStation, manualStations, stationOverrides, lastLayoutOverrides, edgeKey])

  const handleDeleteManualStation = useCallback(
    (stationId: string) => {
      setManualStations((prev) => {
        if (!prev[stationId]) return prev
        const next = { ...prev }
        delete next[stationId]
        return next
      })

      setManualEdges((prev) => {
        const next: typeof prev = {}
        for (const [key, edge] of Object.entries(prev)) {
          if (edge.fromStationId === stationId || edge.toStationId === stationId) continue
          next[key] = edge
        }
        return next
      })

      setStationOverrides((prev) => {
        if (!(stationId in prev)) return prev
        const next = { ...prev }
        delete next[stationId]
        return next
      })

      setStationHubOverrides((prev) => {
        if (!(stationId in prev)) return prev
        const next = { ...prev }
        delete next[stationId]
        return next
      })

      setHiddenStations((prev) => {
        if (!(stationId in prev)) return prev
        const next = { ...prev }
        delete next[stationId]
        return next
      })

      setEdgeOverrides((prev) => {
        const next: typeof prev = {}
        for (const [key, ov] of Object.entries(prev)) {
          const [a, b] = key.split('|')
          if (a === stationId || b === stationId) continue
          next[key] = ov
        }
        return next
      })

      if (inspectedStationId === stationId) {
        setInspectedStationId(null)
      }
    },
    [inspectedStationId],
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

  const handleChangeHubMinMinutes = useCallback((hubId: string, minutesStr: string) => {
    setHubMinOverrides((prev) => {
      const raw = minutesStr.replace(',', '.').trim()
      const minutes = raw === '' ? NaN : Number(raw)

      const base = fullGraphTransferHubs.find((h) => h.id === hubId)
      const baseMinSeconds = base?.minTransferSeconds ?? 180

      if (!Number.isFinite(minutes) || minutes <= 0) {
        if (!(hubId in prev)) return prev
        const cloned = { ...prev }
        delete cloned[hubId]
        return cloned
      }

      const seconds = Math.round(minutes * 60)

      if (seconds === baseMinSeconds) {
        if (!(hubId in prev)) return prev
        const cloned = { ...prev }
        delete cloned[hubId]
        return cloned
      }

      if (prev[hubId] === seconds) return prev
      return { ...prev, [hubId]: seconds }
    })
  }, [])

  const handleRotateHubGeometry = useCallback((hubId: string, direction: 'cw' | 'ccw') => {
    setHubRotateCommand(() => {
      hubRotateTokenRef.current += 1
      return { hubId, direction, token: hubRotateTokenRef.current }
    })
  }, [])

  const handleResetStationEdits = useCallback(
    (stationId: string) => {
      setStationOverrides((prev) => {
        if (!(stationId in prev)) return prev
        const next = { ...prev }
        delete next[stationId]
        return next
      })

      setStationHubOverrides((prev) => {
        if (!(stationId in prev)) return prev
        const next = { ...prev }
        delete next[stationId]
        return next
      })

      setHiddenStations((prev) => {
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

  const handleResetHubEdits = useCallback(
    (hubId: string, hubStationIds: string[]) => {
      setHubMinOverrides((prev) => {
        if (!(hubId in prev)) return prev
        const next = { ...prev }
        delete next[hubId]
        return next
      })

      if (hubStationIds.length > 0) {
        pendingLayoutOverridesRef.current = null
        setLastLayoutOverrides((prev: Record<string, { x: number; y: number }>) => {
          let changed = false
          const next = { ...prev }
          for (const sid of hubStationIds) {
            const st = stationById.get(sid)
            const baseX = st && typeof st.layoutX === 'number' ? st.layoutX : undefined
            const baseY = st && typeof st.layoutY === 'number' ? st.layoutY : undefined
            if (baseX === undefined || baseY === undefined) continue
            const current = prev[sid]
            if (!current || current.x !== baseX || current.y !== baseY) {
              next[sid] = { x: baseX, y: baseY }
              changed = true
            }
          }
          return changed ? next : prev
        })
        setEditorLayoutApplyToken((prev: number) => prev + 1)
      }

      showEditorToast('Настройки хаба сброшены')
    },
    [stationById, showEditorToast],
  )

  const handleResetAllEditorEdits = useCallback(() => {
    if (typeof window !== 'undefined') {
      const ok = window.confirm(
        'Сбросить все изменения редактора?\n\nЭто удалит ручные станции/рёбра и сбросит все оверрайды.',
      )
      if (!ok) return
    }

    setStationOverrides({})
    setStationHubOverrides({})
    setEdgeOverrides({})
    setHubMinOverrides({})
    setManualStations({})
    setManualEdges({})
    setHiddenStations({})
    pendingLayoutOverridesRef.current = null
    setLastLayoutOverrides({})
    setEditorLayoutApplyToken((prev: number) => prev + 1)
    setInspectedStationId(null)
    showEditorToast('Все изменения сброшены')
  }, [showEditorToast])

  const toggleEditMode = useCallback(() => setEditMode((prev: boolean) => !prev), [])
  const exitEditMode = useCallback(() => setEditMode(false), [])
  const toggleCollisionDebug = useCallback(() => setCollisionDebug((prev: boolean) => !prev), [])

  const mapProps = useMemo(
    () => ({
      editMode,
      collisionDebug,
      onLayoutChange: handleLayoutChange,
      onCanonicalLayoutChange: handleCanonicalLayoutChange,
      editorLayoutOverrides: lastLayoutOverrides,
      editorLayoutApplyToken,
      onEditStationInspect: handleInspectStation,
      stationHubOverrides,
      hiddenStationIds: hiddenStationIdSet,
      stationTitleOverrides: stationTitleOverridesForMap,
      extraStations: extraStationsForMap,
      hubRotateCommand,
      hubMirrorCommand,
      editorFocusCommand,
      onEditSelectionChange: setEditorSelectedStationIds,
    }),
    [
      editMode,
      collisionDebug,
      handleLayoutChange,
      handleCanonicalLayoutChange,
      lastLayoutOverrides,
      editorLayoutApplyToken,
      handleInspectStation,
      stationHubOverrides,
      hiddenStationIdSet,
      stationTitleOverridesForMap,
      extraStationsForMap,
      hubRotateCommand,
      hubMirrorCommand,
      editorFocusCommand,
    ],
  )

  const overlay = useMemo(
    () => ({
      toast: editorToast,

      inspectedStation,
      inspectedLineId,
      inspectedLine,
      inspectedLineEdges,
      inspectedHub,
      inspectedEdges,

      stationOverrides,
      stationHubOverrides,
      edgeOverrides,
      hubMinOverrides,
      manualStations,
      manualEdges,
      hiddenStations,
      lastLayoutOverrides,
      canonicalRingShapes,

      availableHubIds,
      stationById,
      lineByNumericId,
      effectiveLineStationIdsById,
      editorSelectedStationIds,
      hubAddStationInput,
      newEdgeTarget,
      findExactStationByName,
      edgeKey,

      collisionDebug,
      canUndo: canEditorUndo,
      canRedo: canEditorRedo,

      setHubAddStationInput,
      setNewEdgeTarget,
      setManualEdges,
      setInspectedStationId,

      showToast: showEditorToast,
      undo: handleEditorUndo,
      redo: handleEditorRedo,
      toggleEditMode,
      exitEditMode,
      toggleCollisionDebug,

      changeStationTitle: handleChangeStationTitle,
      changeStationLine: handleChangeStationLine,
      changeStationHub: handleChangeStationHub,
      changeHubMinMinutes: handleChangeHubMinMinutes,
      changeEdgeMinutes: handleChangeEdgeMinutes,
      toggleEdgeTransfer: handleToggleEdgeTransfer,
      toggleEdgeDisabled: handleToggleEdgeDisabled,
      toggleStationHidden: handleToggleStationHidden,
      focusStation: handleFocusStation,
      rotateHubGeometry: handleRotateHubGeometry,
      mirrorHubGeometry: handleMirrorHubGeometry,
      updateStationGeoFromOSM: handleUpdateStationGeoFromOSM,
      createManualStation: handleCreateManualStation,
      deleteManualStation: handleDeleteManualStation,
      resetStationEdits: handleResetStationEdits,
      resetEdgeEdits: handleResetEdgeEdits,
      resetHubEdits: handleResetHubEdits,
      resetAllEdits: handleResetAllEditorEdits,
    }),
    [
      editorToast,
      inspectedStation,
      inspectedLineId,
      inspectedLine,
      inspectedLineEdges,
      inspectedHub,
      inspectedEdges,
      stationOverrides,
      stationHubOverrides,
      edgeOverrides,
      hubMinOverrides,
      manualStations,
      manualEdges,
      hiddenStations,
      lastLayoutOverrides,
      canonicalRingShapes,
      availableHubIds,
      stationById,
      lineByNumericId,
      effectiveLineStationIdsById,
      editorSelectedStationIds,
      hubAddStationInput,
      newEdgeTarget,
      findExactStationByName,
      edgeKey,
      collisionDebug,
      canEditorUndo,
      canEditorRedo,
      showEditorToast,
      handleEditorUndo,
      handleEditorRedo,
      toggleEditMode,
      exitEditMode,
      toggleCollisionDebug,
      handleChangeStationTitle,
      handleChangeStationLine,
      handleChangeStationHub,
      handleChangeHubMinMinutes,
      handleChangeEdgeMinutes,
      handleToggleEdgeTransfer,
      handleToggleEdgeDisabled,
      handleToggleStationHidden,
      handleFocusStation,
      handleRotateHubGeometry,
      handleMirrorHubGeometry,
      handleUpdateStationGeoFromOSM,
      handleCreateManualStation,
      handleDeleteManualStation,
      handleResetStationEdits,
      handleResetEdgeEdits,
      handleResetHubEdits,
      handleResetAllEditorEdits,
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
