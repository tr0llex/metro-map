import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  ComponentType,
  LazyExoticComponent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  TouchEvent,
} from 'react'
import './App.css'
import './theme.css'
import helloKittyIcon from './assets/kitty-metro-logo.svg'
import { InstallGuideCard } from './components/InstallGuideCard.tsx'
import { UpdateBanner } from './components/UpdateBanner.tsx'
import { SplashScreen } from './components/SplashScreen.tsx'
import { RouteForm } from './components/RouteForm.tsx'
import type { RouteSuggestionItem } from './components/RouteForm.tsx'
import { RouteDetailsSheet } from './components/RouteDetailsSheet.tsx'
import type { DecoratedSegment } from './components/RouteDetailsSheet.tsx'
import { RouteHeader } from './components/RouteHeader.tsx'
import type { HubEditorPanelProps } from './components/HubEditorPanel.tsx'
import {
  fullGraphLines,
  fullGraphStations,
  fullGraphEdges,
  fullGraphTransferHubs,
} from './metro/fullGraph.ts'
import type {
  RouteResult,
  FullGraphEdge,
  EdgeOverride,
  FullGraphStation,
  EditorOverrides,
} from './metro/types.ts'
import { MetroMap } from './components/MetroMap.tsx'
import { useRegisterSW } from 'virtual:pwa-register/react'

const EDITOR_ENABLED = import.meta.env.DEV || import.meta.env.MODE === 'editor'

const HubEditorPanelLazy: LazyExoticComponent<ComponentType<HubEditorPanelProps>> | null =
  EDITOR_ENABLED
    ? lazy(() =>
        import('./components/HubEditorPanel.tsx').then((m) => ({ default: m.HubEditorPanel })),
      )
    : null

type NavigatorWithStandalone = Navigator & { standalone?: boolean }

type StationOverride = {
  title?: string
  lineNumericId?: number | null
  lat?: number
  lon?: number
}

type SavedRoute = {
  fromStationId: string
  toStationId: string
  fromTitle: string
  toTitle: string
  lastUsedAt: number
}

const FAVORITES_STORAGE_KEY = 'kitty-metro-favorites-v1'
const RECENTS_STORAGE_KEY = 'kitty-metro-recents-v1'
const HUB_ROTATE_STEP_DEG = 15

type EditorSnapshot = {
  stationOverrides: Record<string, StationOverride>
  stationHubOverrides: Record<string, string | null>
  edgeOverrides: Record<string, EdgeOverride>
  hubMinOverrides: Record<string, number>
  manualStations: Record<string, FullGraphStation>
  manualEdges: Record<string, FullGraphEdge>
  hiddenStations: Record<string, true>
  lastLayoutOverrides: Record<string, { x: number; y: number }>
  hubRotationOverrides: Record<string, number>
}

type EditorHistoryState = {
  items: EditorSnapshot[]
  index: number // -1, если истории ещё нет
}

const MAX_EDITOR_HISTORY = 100

function areEditorSnapshotsShallowEqual(a: EditorSnapshot | undefined, b: EditorSnapshot | undefined) {
  if (!a || !b) return false
  return (
    a.stationOverrides === b.stationOverrides &&
    a.stationHubOverrides === b.stationHubOverrides &&
    a.edgeOverrides === b.edgeOverrides &&
    a.hubMinOverrides === b.hubMinOverrides &&
    a.manualStations === b.manualStations &&
    a.manualEdges === b.manualEdges &&
    a.hiddenStations === b.hiddenStations &&
    a.lastLayoutOverrides === b.lastLayoutOverrides &&
    a.hubRotationOverrides === b.hubRotationOverrides
  )
}

function getRouteVariantLabel(index: number, routes: RouteResult[]): string {
  if (index === 0) return 'Самый быстрый'

  if (routes.length > 1) {
    const fastest = routes[0]
    const minTransfers = routes.reduce(
      (min, r) => (r.transfersCount < min ? r.transfersCount : min),
      routes[0]?.transfersCount ?? Infinity,
    )

    const bestTransfersIndex = routes.findIndex(
      (r, i) => i !== 0 && r.transfersCount === minTransfers && fastest && minTransfers < fastest.transfersCount,
    )

    if (index === bestTransfersIndex) {
      return 'Минимум пересадок'
    }
  }

  return `Маршрут ${index + 1}`
}

function App() {
  const [fromStation, setFromStation] = useState('')
  const [toStation, setToStation] = useState('')
  const [fromStationId, setFromStationId] = useState<string | null>(null)
  const [toStationId, setToStationId] = useState<string | null>(null)
  const [stationPickPopover, setStationPickPopover] = useState<{
    stationId: string
    stationName: string
    clientPoint: { x: number; y: number; t?: number }
  } | null>(null)
  const [stationPickPopoverClosing, setStationPickPopoverClosing] = useState(false)
  const [stationPickPopoverPressed, setStationPickPopoverPressed] = useState<'from' | 'to' | null>(null)
  const [stationPickPopoverPos, setStationPickPopoverPos] = useState<{ left: number; top: number } | null>(
    null,
  )
  const stationPickPopoverRef = useRef<HTMLDivElement | null>(null)
  const stationPickPopoverCloseTimeoutRef = useRef<number | null>(null)
  const stationPickPopoverPerfRef = useRef<{ openedAt: number; tapAt?: number } | null>(null)
  const [routeAlternatives, setRouteAlternatives] = useState<RouteResult[]>([])
  const [activeRouteIndex, setActiveRouteIndex] = useState(0)
  const [isRouteSheetOpen, setIsRouteSheetOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [fromFixed, setFromFixed] = useState(false)
  const [toFixed, setToFixed] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [collisionDebug, setCollisionDebug] = useState(false)
  const effectiveEditMode = EDITOR_ENABLED && editMode
  const [lastLayoutOverrides, setLastLayoutOverrides] = useState<
    Record<string, { x: number; y: number }>
  >({})
  const [editorLayoutApplyToken, setEditorLayoutApplyToken] = useState(0)
  const pendingLayoutOverridesRef = useRef<
    Record<string, { x: number; y: number }> | null
  >(null)
  const [isDesktop, setIsDesktop] = useState(false)
  const [isSplashDone, setIsSplashDone] = useState(false)
  const [isSplashMounted, setIsSplashMounted] = useState(true)
  const [fromSuggestionIndex, setFromSuggestionIndex] = useState(-1)
  const [toSuggestionIndex, setToSuggestionIndex] = useState(-1)
  const [inspectedStationId, setInspectedStationId] = useState<string | null>(null)
  const [inspectedLineId, setInspectedLineId] = useState<number | null>(null)
  const [stationOverrides, setStationOverrides] = useState<Record<string, StationOverride>>({})
  const [stationHubOverrides, setStationHubOverrides] = useState<Record<string, string | null>>({})
  const [edgeOverrides, setEdgeOverrides] = useState<
    Record<string, EdgeOverride>
  >({})
  const [hubMinOverrides, setHubMinOverrides] = useState<Record<string, number>>({})
  const [hubRotationOverrides, setHubRotationOverrides] = useState<Record<string, number>>({})
  const [manualStations, setManualStations] = useState<Record<string, FullGraphStation>>({})
  const [manualEdges, setManualEdges] = useState<Record<string, FullGraphEdge>>({})
  const [newEdgeTarget, setNewEdgeTarget] = useState('')
  const [hubAddStationInput, setHubAddStationInput] = useState('')
  const [hiddenStations, setHiddenStations] = useState<Record<string, true>>({})
  const [editorSelectedStationIds, setEditorSelectedStationIds] = useState<string[]>([])
  const [editorToast, setEditorToast] = useState<string | null>(null)
  const editorToastTimeoutRef = useRef<number | null>(null)
  const [favoriteRoutes, setFavoriteRoutes] = useState<SavedRoute[]>([])
  const [recentRoutes, setRecentRoutes] = useState<SavedRoute[]>([])
  const [isSmartSuggestionsOpen, setIsSmartSuggestionsOpen] = useState(false)
  const [isMapReady, setIsMapReady] = useState(false)
  const [nearbyStations, setNearbyStations] = useState<FullGraphStation[]>([])
  const [nearbyStatus, setNearbyStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [nearbyError, setNearbyError] = useState<string | null>(null)
  const [mapVisibleInsets, setMapVisibleInsets] = useState({
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  })
  const sheetAnimFrameRef = useRef<number | null>(null)
  const sheetAnimTargetRef = useRef<number | null>(null)
  const sheetProgressRef = useRef(0)
  const sheetSpringRafRef = useRef<number | null>(null)
  const sheetSpringTargetRef = useRef<number | null>(null)
  const sheetSpringVelocityRef = useRef(0)
  const sheetSpringLastTimeRef = useRef<number | null>(null)
  const sheetDragLastSampleTimeRef = useRef<number | null>(null)
  const sheetDragLastSampleProgressRef = useRef<number | null>(null)
  const sheetDragVelocityRef = useRef(0)
  const bottomSheetRef = useRef<HTMLDivElement | null>(null)
  const sheetMinVisibleRef = useRef<HTMLDivElement | null>(null)
  const routeDetailsRef = useRef<HTMLDivElement | null>(null)
  const sheetMaxOffsetPxRef = useRef(0)
  const sheetMinHeightPxRef = useRef(0)
  const sheetOpenHeightPxRef = useRef(0)
  const savedRouteCounterRef = useRef(1)

  const routeWorkerRef = useRef<Worker | null>(null)
  const routeWorkerRequestIdRef = useRef(0)
  const routeWorkerPendingRef = useRef<
    Map<
      number,
      {
        fromId: string
        toId: string
        fromTitleEffective: string
        toTitleEffective: string
        isDesktop: boolean
      }
    >
  >(new Map())

  const perfInteractionActiveRef = useRef(false)
  const perfInteractionTimeoutRef = useRef<number | null>(null)

  const markPerfInteraction = useCallback(() => {
    if (typeof window === 'undefined') return
    if (typeof document === 'undefined') return

    const root = document.documentElement
    if (!perfInteractionActiveRef.current) {
      perfInteractionActiveRef.current = true
      root.classList.add('perf-interaction')
    }

    if (perfInteractionTimeoutRef.current != null) {
      window.clearTimeout(perfInteractionTimeoutRef.current)
      perfInteractionTimeoutRef.current = null
    }

    perfInteractionTimeoutRef.current = window.setTimeout(() => {
      perfInteractionTimeoutRef.current = null
      perfInteractionActiveRef.current = false
      root.classList.remove('perf-interaction')
    }, 180)
  }, [])

  const perfLastFrameTsRef = useRef<number | null>(null)
  const perfFrameSamplesRef = useRef<number[]>([])
  const perfLogCooldownRef = useRef<number>(0)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (typeof window === 'undefined') return

    let raf = 0
    const tick = (ts: number) => {
      raf = window.requestAnimationFrame(tick)
      if (!perfInteractionActiveRef.current) {
        perfLastFrameTsRef.current = ts
        return
      }

      const last = perfLastFrameTsRef.current
      perfLastFrameTsRef.current = ts
      if (last == null) return

      const dt = ts - last
      if (!Number.isFinite(dt) || dt <= 0) return

      const samples = perfFrameSamplesRef.current
      samples.push(dt)
      if (samples.length > 80) samples.shift()

      const now = performance.now()
      if (now < perfLogCooldownRef.current) return
      if (samples.length < 40) return

      const sorted = [...samples].sort((a, b) => a - b)
      const p50 = sorted[Math.floor(sorted.length * 0.5)]
      const p95 = sorted[Math.floor(sorted.length * 0.95)]
      const max = sorted[sorted.length - 1]
      // логируем редко, чтобы не заспамить консоль
      perfLogCooldownRef.current = now + 1500
      console.log('[perf] interaction frame dt ms', {
        p50: Number(p50?.toFixed(1)),
        p95: Number(p95?.toFixed(1)),
        max: Number(max?.toFixed(1)),
      })
    }

    raf = window.requestAnimationFrame(tick)
    return () => {
      if (raf) window.cancelAnimationFrame(raf)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && perfInteractionTimeoutRef.current != null) {
        window.clearTimeout(perfInteractionTimeoutRef.current)
        perfInteractionTimeoutRef.current = null
      }
      if (typeof document !== 'undefined') {
        document.documentElement.classList.remove('perf-interaction')
      }
      perfInteractionActiveRef.current = false
    }
  }, [])
  const [hubRotateCommand, setHubRotateCommand] = useState<
    { hubId: string; direction: 'cw' | 'ccw'; token: number } | null
  >(null)
  const [hubMirrorCommand, setHubMirrorCommand] = useState<
    { hubId: string; token: number } | null
  >(null)
  const [editorFocusCommand, setEditorFocusCommand] = useState<
    { stationId: string; token: number } | null
  >(null)
  const [editorHistory, setEditorHistory] = useState<EditorHistoryState>({ items: [], index: -1 })
  const [installGuidePlatform, setInstallGuidePlatform] = useState<
    'ios' | 'android' | 'desktop' | 'unknown' | 'hidden'
  >(() => {
    if (typeof window === 'undefined') {
      return 'hidden'
    }

    const isStandaloneDisplay =
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(display-mode: standalone)').matches === true) ||
      ((window.navigator as NavigatorWithStandalone).standalone === true)

    if (isStandaloneDisplay) {
      return 'hidden'
    }

    try {
      const seenKey = 'kitty-metro-install-guide-seen'
      const hasSeen = window.localStorage.getItem(seenKey) === '1'
      if (hasSeen) {
        return 'hidden'
      }
    } catch {
      return 'hidden'
    }

    const ua = window.navigator.userAgent || ''
    const isIOS = /iPhone|iPad|iPod/.test(ua)
    const isAndroid = /Android/.test(ua)

    if (isIOS) return 'ios'
    if (isAndroid) return 'android'
    if (window.innerWidth >= 768) return 'desktop'
    return 'unknown'
  })
  const isInstallGuideOpen = installGuidePlatform !== 'hidden'
  const [isInstallGuideDelayPassed, setIsInstallGuideDelayPassed] = useState(false)

  const edgeKey = useCallback((a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`), [])

  const hubRotateTokenRef = useRef(0)
  const hubMirrorTokenRef = useRef(0)
  const editorFocusTokenRef = useRef(0)

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

  const copyTextToClipboard = useCallback(async (text: string): Promise<boolean> => {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        // ignore
      }
    }

    try {
      const el = document.createElement('textarea')
      el.value = text
      el.setAttribute('readonly', '')
      el.style.position = 'fixed'
      el.style.top = '0'
      el.style.left = '-9999px'
      document.body.appendChild(el)
      el.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(el)
      return ok
    } catch {
      return false
    }
  }, [])

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
      hubRotationOverrides,
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
    hubRotationOverrides,
  ])

  const pushEditorHistory = useCallback(() => {
    setEditorHistory((prev: EditorHistoryState) => {
      const snapshot = makeEditorSnapshot()

      if (prev.index >= 0) {
        const current = prev.items[prev.index]
        if (areEditorSnapshotsShallowEqual(current, snapshot)) {
          return prev
        }
      }

      let items = prev.items.slice(0, prev.index + 1)
      items.push(snapshot)
      if (items.length > MAX_EDITOR_HISTORY) {
        items = items.slice(items.length - MAX_EDITOR_HISTORY)
      }
      const index = items.length - 1
      return { items, index }
    })
  }, [makeEditorSnapshot])

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
    setHubRotationOverrides(snapshot.hubRotationOverrides)
  }, [])

  const handleEditorUndo = useCallback(() => {
    setEditorHistory((prev: EditorHistoryState) => {
      if (prev.index <= 0) return prev
      const nextIndex = prev.index - 1
      const snapshot = prev.items[nextIndex]
      applyEditorSnapshot(snapshot)
      return { ...prev, index: nextIndex }
    })
  }, [applyEditorSnapshot])

  const handleEditorRedo = useCallback(() => {
    setEditorHistory((prev: EditorHistoryState) => {
      if (prev.index < 0 || prev.index >= prev.items.length - 1) return prev
      const nextIndex = prev.index + 1
      const snapshot = prev.items[nextIndex]
      applyEditorSnapshot(snapshot)
      return { ...prev, index: nextIndex }
    })
  }, [applyEditorSnapshot])

  const canEditorUndo = editorHistory.index > 0
  const canEditorRedo = editorHistory.index >= 0 && editorHistory.index < editorHistory.items.length - 1

  const handleLayoutChange = useCallback((overrides: Record<string, { x: number; y: number }>) => {
    pendingLayoutOverridesRef.current = overrides
  }, [])

  const handleInitialViewportReady = useCallback(() => {
    setIsMapReady(true)
  }, [])

  useEffect(() => {
    if (!effectiveEditMode) return
    setEditorLayoutApplyToken((prev: number) => prev + 1)
  }, [effectiveEditMode])

  useEffect(() => {
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
  }, [])

  useEffect(() => {
    if (!effectiveEditMode) return

    pushEditorHistory()
  }, [effectiveEditMode, makeEditorSnapshot, pushEditorHistory])

  useEffect(() => {
    if (!effectiveEditMode) return
    pushEditorHistory()
  }, [
    effectiveEditMode,
    stationOverrides,
    stationHubOverrides,
    edgeOverrides,
    hubMinOverrides,
    manualStations,
    manualEdges,
    hiddenStations,
    lastLayoutOverrides,
    hubRotationOverrides,
    pushEditorHistory,
  ])

  useEffect(() => {
    if (effectiveEditMode) return
    setEditorHistory({ items: [], index: -1 })
  }, [effectiveEditMode])

  useEffect(() => {
    if (!effectiveEditMode) return

    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      const isEditableElement =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (target as HTMLElement).isContentEditable
      if (isEditableElement) return

      const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform)
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
  }, [effectiveEditMode, canEditorUndo, canEditorRedo, handleEditorUndo, handleEditorRedo])

  useEffect(() => {
    if (typeof window === 'undefined') return

    try {
      const rawFavorites = window.localStorage.getItem(FAVORITES_STORAGE_KEY)
      if (rawFavorites) {
        const parsed = JSON.parse(rawFavorites) as SavedRoute[]
        if (Array.isArray(parsed)) {
          setFavoriteRoutes(parsed)
        }
      }
    } catch {
      // ignore
    }

    try {
      const rawRecents = window.localStorage.getItem(RECENTS_STORAGE_KEY)
      if (rawRecents) {
        const parsed = JSON.parse(rawRecents) as SavedRoute[]
        if (Array.isArray(parsed)) {
          const limited = parsed.slice(0, 5)
          setRecentRoutes(limited)

          if (limited.length !== parsed.length) {
            try {
              window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(limited))
            } catch {
              // ignore storage errors
            }
          }
        } else {
          try {
            window.localStorage.removeItem(RECENTS_STORAGE_KEY)
          } catch {
            // ignore storage errors
          }
          setRecentRoutes([])
        }
      }
    } catch {
      try {
        window.localStorage.removeItem(RECENTS_STORAGE_KEY)
      } catch {
        // ignore storage errors
      }
      setRecentRoutes([])
    }
  }, [])

  const persistRoutesToStorage = useCallback((key: string, routes: SavedRoute[]) => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(key, JSON.stringify(routes))
    } catch {
      // ignore
    }
  }, [])

  const handleClearRecentRoutes = () => {
    setRecentRoutes([])
    persistRoutesToStorage(RECENTS_STORAGE_KEY, [])
  }

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
  const hiddenStationIdSet = useMemo(() => new Set(Object.keys(hiddenStations)), [hiddenStations])

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
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!import.meta.env.DEV) return
    if (!('serviceWorker' in navigator)) return

    const alreadyCleaned = window.sessionStorage.getItem('kitty-metro-dev-sw-cleaned') === '1'
    if (alreadyCleaned) return
    window.sessionStorage.setItem('kitty-metro-dev-sw-cleaned', '1')

    void (async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((r) => r.unregister()))

        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))

        if (regs.length > 0) {
          window.location.reload()
        }
      } catch {
        // ignore
      }
    })()
  }, [])
  const swRegistrationRef = useRef<ServiceWorkerRegistration | undefined>(undefined)
  const swLastUpdateCheckMsRef = useRef<number>(0)
  const checkForSwUpdate = useCallback(() => {
    if (typeof window === 'undefined') return

    const now = Date.now()
    if (now - swLastUpdateCheckMsRef.current < 3000) {
      return
    }
    swLastUpdateCheckMsRef.current = now

    const reg = swRegistrationRef.current
    if (!reg) return
    void reg.update()
  }, [])
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    onRegistered(swRegistration: ServiceWorkerRegistration | undefined) {
      swRegistrationRef.current = swRegistration
      console.log('SW registered', swRegistration)
      checkForSwUpdate()
    },
    onRegisterError(error: unknown) {
      console.log('SW registration error', error)
    },
  })
  const [isUpdateDismissed, setIsUpdateDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false
    }

    try {
      return window.sessionStorage.getItem('kitty-metro-update-dismissed') === '1'
    } catch {
      return false
    }
  })
  const fromInputRef = useRef<HTMLInputElement | null>(null)
  const toInputRef = useRef<HTMLInputElement | null>(null)

  const focusIfNeeded = (el: HTMLInputElement | null) => {
    if (!el) return
    if (typeof document !== 'undefined' && document.activeElement === el) return
    el.focus()
  }

  const shouldIgnoreSheetTouch = (target: EventTarget | null) => {
    if (typeof document === 'undefined') return false
    if (!(target instanceof Element)) return false
    if (target.closest('.bottom-sheet-handle')) return false
    return Boolean(target.closest('input, textarea, select, a'))
  }
  const sheetTouchStartYRef = useRef<number | null>(null)
  const sheetTouchLastYRef = useRef<number | null>(null)
  const sheetTouchStartXRef = useRef<number | null>(null)
  const sheetTouchLastXRef = useRef<number | null>(null)
  const sheetGestureAxisRef = useRef<'pending' | 'x' | 'y' | null>(null)
  const sheetDeferredRecomputeRef = useRef(false)
  const sheetTouchStartedOnButtonRef = useRef(false)
  const sheetTouchStartedInSmartSuggestionsRef = useRef(false)
  const sheetDragStartProgressRef = useRef<number | null>(null)

  const getBottomInsetPx = useCallback(() => {
    if (isDesktop) return mapVisibleInsets.bottom
    const min = sheetMinHeightPxRef.current
    const maxOffset = sheetMaxOffsetPxRef.current
    const progress = sheetProgressRef.current
    const openHeight = min + progress * maxOffset
    // Шторка может быть уже/выше в зависимости от контента и режима.
    // Гарантируем неотрицательное значение.
    return Math.max(0, openHeight)
  }, [isDesktop, mapVisibleInsets.bottom])

  const updateSheetTransformDom = useCallback(
    (progress: number) => {
      const el = bottomSheetRef.current
      if (!el) return
      if (isDesktop) return

      const clamped = Math.max(0, Math.min(1, progress))
      sheetProgressRef.current = clamped

      const maxOffsetPx = sheetMaxOffsetPxRef.current
      const translateY = (1 - clamped) * maxOffsetPx
      el.style.transform = `translate3d(0, ${translateY}px, 0)`
    },
    [isDesktop],
  )

  const recomputeSheetMaxOffsetPx = useCallback(() => {
    if (typeof window === 'undefined') return
    if (isDesktop) return
    const sheetEl = bottomSheetRef.current
    const minEl = sheetMinVisibleRef.current
    if (!sheetEl || !minEl) return

    const innerEl = sheetEl.querySelector<HTMLElement>('.bottom-sheet-inner')
    let innerPaddingTop = 0
    let innerPaddingBottom = 0
    if (innerEl) {
      const style = window.getComputedStyle(innerEl)
      const pt = Number.parseFloat(style.paddingTop)
      const pb = Number.parseFloat(style.paddingBottom)
      innerPaddingTop = Number.isFinite(pt) ? pt : 0
      innerPaddingBottom = Number.isFinite(pb) ? pb : 0
    }

    const minHeight = minEl.offsetHeight + innerPaddingTop + innerPaddingBottom

    let detailsHeight = 0
    let detailsMarginTop = 0
    const detailsEl = routeDetailsRef.current
    if (detailsEl) {
      detailsHeight = detailsEl.scrollHeight
      const mt = window.getComputedStyle(detailsEl).marginTop
      const mtPx = Number.parseFloat(mt)
      if (Number.isFinite(mtPx)) {
        detailsMarginTop = mtPx
      }
    }

    const vv = window.visualViewport
    const viewportHeight = vv?.height ?? window.innerHeight
    const rootFontSizeStr = window.getComputedStyle(document.documentElement).fontSize
    const rootFontSize = Number.parseFloat(rootFontSizeStr)
    const remPx = Number.isFinite(rootFontSize) ? rootFontSize : 16

    const maxHeightPxRaw = Math.min(Math.max(0, viewportHeight - remPx * 1.75), viewportHeight * 0.78)
    const maxHeightPx = Math.max(minHeight, maxHeightPxRaw)

    const hasExpandableContent = detailsHeight > 2
    const desiredOpenHeight = hasExpandableContent ? minHeight + detailsMarginTop + detailsHeight : minHeight
    const openHeight = Math.min(desiredOpenHeight, maxHeightPx)

    sheetMinHeightPxRef.current = minHeight
    sheetOpenHeightPxRef.current = openHeight
    sheetMaxOffsetPxRef.current = Math.max(0, openHeight - minHeight)

    sheetEl.style.height = `${openHeight}px`

    updateSheetTransformDom(sheetProgressRef.current)
  }, [isDesktop, updateSheetTransformDom])

  useLayoutEffect(() => {
    recomputeSheetMaxOffsetPx()
  }, [
    recomputeSheetMaxOffsetPx,
    isDesktop,
    isSmartSuggestionsOpen,
    favoriteRoutes.length,
    recentRoutes.length,
    nearbyStatus,
    nearbyStations.length,
    errorMessage,
    routeAlternatives.length,
    activeRouteIndex,
    isRouteSheetOpen,
  ])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (isDesktop) return

    const sheetEl = bottomSheetRef.current
    const minEl = sheetMinVisibleRef.current
    const detailsEl = routeDetailsRef.current
    if (!sheetEl || !minEl) return

    let raf = 0
    const schedule = () => {
      if (sheetTouchStartYRef.current != null) {
        sheetDeferredRecomputeRef.current = true
        return
      }
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        recomputeSheetMaxOffsetPx()
      })
    }

    const onResize = () => schedule()
    window.addEventListener('resize', onResize)

    const vv = window.visualViewport
    vv?.addEventListener('resize', onResize)
    vv?.addEventListener('scroll', onResize)

    let ro: ResizeObserver | null = null
    if (typeof window.ResizeObserver === 'function') {
      ro = new window.ResizeObserver(() => schedule())
      ro.observe(sheetEl)
      ro.observe(minEl)
      if (detailsEl) {
        ro.observe(detailsEl)
      }
    }

    return () => {
      window.removeEventListener('resize', onResize)
      vv?.removeEventListener('resize', onResize)
      vv?.removeEventListener('scroll', onResize)
      if (raf) {
        window.cancelAnimationFrame(raf)
      }
      if (ro) {
        ro.disconnect()
      }
    }
  }, [
    isDesktop,
    recomputeSheetMaxOffsetPx,
    errorMessage,
    routeAlternatives.length,
    activeRouteIndex,
    isRouteSheetOpen,
    isSmartSuggestionsOpen,
    favoriteRoutes.length,
    recentRoutes.length,
    nearbyStatus,
    nearbyStations.length,
  ])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (isDesktop) return

    const sheetEl = bottomSheetRef.current
    const innerEl = sheetEl?.querySelector<HTMLElement>('.bottom-sheet-inner')
    if (!innerEl) return

    const onTouchMove = (event: globalThis.TouchEvent) => {
      if (sheetTouchStartYRef.current == null) return
      if (sheetGestureAxisRef.current !== 'y') return
      event.preventDefault()
    }

    innerEl.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      innerEl.removeEventListener('touchmove', onTouchMove)
    }
  }, [isDesktop])

  const stopSheetSpring = useCallback(() => {
    if (typeof window === 'undefined') return
    if (sheetSpringRafRef.current != null) {
      window.cancelAnimationFrame(sheetSpringRafRef.current)
      sheetSpringRafRef.current = null
    }
    sheetSpringLastTimeRef.current = null
  }, [])

  const startSheetSpring = useCallback(
    (targetProgress: number, initialVelocity?: number) => {
      if (typeof window === 'undefined') return
      if (isDesktop) return

      const clampedTarget = Math.max(0, Math.min(1, targetProgress))
      sheetSpringTargetRef.current = clampedTarget
      if (typeof initialVelocity === 'number' && Number.isFinite(initialVelocity)) {
        sheetSpringVelocityRef.current = initialVelocity
      }

      if (sheetSpringRafRef.current != null) {
        return
      }

      const step = (timestamp: number) => {
        sheetSpringRafRef.current = null
        const target = sheetSpringTargetRef.current
        if (target == null) {
          sheetSpringLastTimeRef.current = null
          return
        }

        const lastTime = sheetSpringLastTimeRef.current
        const dtMs = lastTime == null ? 16 : Math.min(32, Math.max(8, timestamp - lastTime))
        sheetSpringLastTimeRef.current = timestamp
        const dt = dtMs / 1000

        const x = sheetProgressRef.current
        const v0 = sheetSpringVelocityRef.current

        const k = 420
        const c = 70

        const a = k * (target - x) - c * v0
        const v1 = v0 + a * dt
        const x1 = x + v1 * dt

        sheetSpringVelocityRef.current = v1
        updateSheetTransformDom(x1)

        const done = Math.abs(target - x1) < 0.002 && Math.abs(v1) < 0.02
        if (done) {
          updateSheetTransformDom(target)
          sheetSpringVelocityRef.current = 0
          sheetSpringLastTimeRef.current = null
          return
        }

        sheetSpringRafRef.current = window.requestAnimationFrame(step)
      }

      sheetSpringRafRef.current = window.requestAnimationFrame(step)
    },
    [isDesktop, updateSheetTransformDom],
  )

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia === 'undefined') {
      return
    }

    const media = window.matchMedia('(min-width: 1024px)')
    const handleChange = () => {
      setIsDesktop(media.matches)
    }

    handleChange()
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    checkForSwUpdate()

    const onFocus = () => checkForSwUpdate()
    const onPageShow = () => checkForSwUpdate()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkForSwUpdate()
      }
    }

    window.addEventListener('focus', onFocus)
    window.addEventListener('pageshow', onPageShow)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('pageshow', onPageShow)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [checkForSwUpdate])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    if (!('serviceWorker' in navigator)) {
      return
    }

    void (async () => {
      let registrations: readonly ServiceWorkerRegistration[]
      try {
        registrations = await navigator.serviceWorker.getRegistrations()
      } catch {
        return
      }

      const legacyRegs = registrations.filter((reg) => {
        const sw = reg.active ?? reg.waiting ?? reg.installing
        if (!sw?.scriptURL) return false
        try {
          const url = new URL(sw.scriptURL)
          return url.pathname.endsWith('/sw.js')
        } catch {
          return false
        }
      })

      if (legacyRegs.length === 0) {
        return
      }

      try {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      } catch {
        // ignore
      }

      for (const reg of legacyRegs) {
        try {
          await reg.unregister()
        } catch {
          // ignore
        }
      }

      checkForSwUpdate()
    })()
  }, [checkForSwUpdate])

  useEffect(() => {
    if (needRefresh) {
      return
    }
    if (!isUpdateDismissed) {
      return
    }

    setIsUpdateDismissed(false)
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.removeItem('kitty-metro-update-dismissed')
      } catch {
        // ignore
      }
    }
  }, [needRefresh, isUpdateDismissed])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setIsSplashDone(true)
    }, 2600)

    return () => window.clearTimeout(timeoutId)
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (typeof document === 'undefined') return

    let raf = 0
    let burstRaf: number | null = null
    const schedule = () => {
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        const mapEl = document.querySelector<HTMLElement>('.metro-map-wrapper')
        if (!mapEl) return

        const mapRect = mapEl.getBoundingClientRect()
        const mapWidth = Math.max(1, mapRect.width)
        const mapHeight = Math.max(1, mapRect.height)

        let top = 0
        let left = 0
        let right = 0

        let headerInsetCandidate = 0
        let headerRect: DOMRect | null = null

        const headerEl = document.querySelector<HTMLElement>('.app-header')
        if (headerEl) {
          const r = headerEl.getBoundingClientRect()
          headerRect = r
          headerInsetCandidate = Math.min(Math.max(0, r.bottom - mapRect.top), mapHeight)
        }

        // dev-editor панель учитываем только когда она реально присутствует в DOM
        const hubPanelEl = document.querySelector<HTMLElement>('.hub-editor-panel')
        if (hubPanelEl) {
          const r = hubPanelEl.getBoundingClientRect()
          const inset = Math.max(0, r.right - mapRect.left)
          if (inset > left) {
            left = Math.min(inset, mapWidth)
          }
        }

        const sheetEl = document.querySelector<HTMLElement>('.bottom-sheet')
        if (sheetEl && isDesktop) {
          const r = sheetEl.getBoundingClientRect()
          const inset = Math.max(0, r.right - mapRect.left)
          if (inset > left) {
            left = Math.min(inset, mapWidth)
          }
        }

        const zoomControlsEl = document.querySelector<HTMLElement>('.metro-map-zoom-controls')
        if (zoomControlsEl) {
          const r = zoomControlsEl.getBoundingClientRect()
          const inset = Math.max(0, mapRect.right - r.left)
          if (inset > right) {
            right = Math.min(inset, mapWidth)
          }
        }

        if (headerRect && headerInsetCandidate > 0) {
          const usableLeft = mapRect.left + left
          const usableRight = mapRect.right - right
          const overlapW = Math.min(headerRect.right, usableRight) - Math.max(headerRect.left, usableLeft)
          if (overlapW > 0) {
            top = headerInsetCandidate
          }
        }

        setMapVisibleInsets((prev: typeof mapVisibleInsets) => ({
          top,
          right,
          bottom: prev.bottom,
          left,
        }))
      })
    }

    const startBurst = () => {
      if (burstRaf != null) {
        window.cancelAnimationFrame(burstRaf)
        burstRaf = null
      }

      let framesLeft = 16
      const tick = () => {
        schedule()
        framesLeft -= 1
        if (framesLeft > 0) {
          burstRaf = window.requestAnimationFrame(tick)
        } else {
          burstRaf = null
        }
      }

      burstRaf = window.requestAnimationFrame(tick)
    }

    schedule()
    startBurst()
    window.addEventListener('resize', schedule)
    const vv = window.visualViewport
    vv?.addEventListener('resize', schedule)
    vv?.addEventListener('scroll', schedule)

    return () => {
      window.removeEventListener('resize', schedule)
      vv?.removeEventListener('resize', schedule)
      vv?.removeEventListener('scroll', schedule)
      if (raf) {
        window.cancelAnimationFrame(raf)
      }
      if (burstRaf != null) {
        window.cancelAnimationFrame(burstRaf)
      }
    }
  }, [isDesktop, isRouteSheetOpen])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!EDITOR_ENABLED) return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      const isInputLike =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        (target && target.isContentEditable)
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

      if (
        editMode &&
        (event.key === 'd' || event.key === 'D') &&
        (event.ctrlKey || event.metaKey)
      ) {
        event.preventDefault()
        setCollisionDebug((prev: boolean) => !prev)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [editMode, inspectedStationId])

  const handleCloseInstallGuide = () => {
    setInstallGuidePlatform('hidden')
    if (typeof window === 'undefined') {
      return
    }

    try {
      window.localStorage.setItem('kitty-metro-install-guide-seen', '1')
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    if (!isSplashDone || !isMapReady || !isInstallGuideOpen) {
      setIsInstallGuideDelayPassed(false)
      return
    }

    let timeoutId: number | undefined

    if (typeof window !== 'undefined') {
      timeoutId = window.setTimeout(() => {
        setIsInstallGuideDelayPassed(true)
      }, 900)
    } else {
      setIsInstallGuideDelayPassed(true)
    }

    return () => {
      if (timeoutId !== undefined && typeof window !== 'undefined') {
        window.clearTimeout(timeoutId)
      }
    }
  }, [isSplashDone, isMapReady, isInstallGuideOpen])

  const shouldShowInstallGuide =
    isSplashDone && isMapReady && isInstallGuideOpen && isInstallGuideDelayPassed
  const showUpdateBanner =
    isSplashDone && isMapReady && !shouldShowInstallGuide && needRefresh && !isUpdateDismissed

  const handleInstallGuideBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return
    }

    handleCloseInstallGuide()
  }

  const handleUpdateBannerClick = () => {
    updateServiceWorker(true)
  }

  const handleUpdateBannerLater = () => {
    setIsUpdateDismissed(true)
    if (typeof window === 'undefined') {
      return
    }

    try {
      window.sessionStorage.setItem('kitty-metro-update-dismissed', '1')
    } catch {
      // ignore
    }
  }

  const setRouteSheetOpenState = useCallback((open: boolean) => {
    setIsRouteSheetOpen(open)
    if (!open) {
      setIsSmartSuggestionsOpen(false)
    }
    if (!isDesktop) {
      if (!open) {
        const hasRange = sheetMaxOffsetPxRef.current > 0
        if (hasRange) {
          startSheetSpring(0, 0)
        } else {
          stopSheetSpring()
          updateSheetTransformDom(0)
        }
        return
      }

      // Открытие: откладываем тяжёлые layout-риды (scrollHeight/getComputedStyle)
      // на следующий кадр, чтобы не блокировать первый paint контента на слабых устройствах.
      window.requestAnimationFrame(() => {
        recomputeSheetMaxOffsetPx()
        const hasRange = sheetMaxOffsetPxRef.current > 0
        if (hasRange) {
          startSheetSpring(1, 0)
        } else {
          stopSheetSpring()
          updateSheetTransformDom(0)
        }
      })
    }
  }, [
    isDesktop,
    recomputeSheetMaxOffsetPx,
    startSheetSpring,
    stopSheetSpring,
    updateSheetTransformDom,
  ])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const worker = new Worker(new URL('./routeWorker.ts', import.meta.url), { type: 'module' })
    routeWorkerRef.current = worker

    const pending = routeWorkerPendingRef.current

    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data as
        | { type: 'routeResult'; requestId: number; routes: RouteResult[] }
        | { type: 'routeError'; requestId: number; errorMessage: string }

      if (!msg || typeof msg.requestId !== 'number') return

      const ctx = pending.get(msg.requestId)
      if (!ctx) return
      pending.delete(msg.requestId)

      if (msg.type === 'routeError') {
        setErrorMessage(msg.errorMessage || 'Маршрут между этими станциями не найден.')
        return
      }

      const routes = msg.routes ?? []
      if (routes.length === 0) {
        setErrorMessage('Маршрут между этими станциями не найден.')
        return
      }

      setRecentRoutes((prev: SavedRoute[]) => {
        const filtered = prev.filter(
          (item) => !(item.fromStationId === ctx.fromId && item.toStationId === ctx.toId),
        )
        const next: SavedRoute[] = [
          {
            fromStationId: ctx.fromId,
            toStationId: ctx.toId,
            fromTitle: ctx.fromTitleEffective,
            toTitle: ctx.toTitleEffective,
            lastUsedAt: savedRouteCounterRef.current++,
          },
          ...filtered,
        ].slice(0, 5)

        persistRoutesToStorage(RECENTS_STORAGE_KEY, next)
        return next
      })

      startTransition(() => {
        setRouteAlternatives(routes)
        setActiveRouteIndex(0)
        if (routes.length === 1 || ctx.isDesktop) {
          setRouteSheetOpenState(true)
        }
      })
    }

    return () => {
      routeWorkerRef.current = null
      pending.clear()
      worker.terminate()
    }
  }, [persistRoutesToStorage, setRouteSheetOpenState])

  useEffect(() => {
    if (isDesktop) return

    if (isSmartSuggestionsOpen) {
      if (!isRouteSheetOpen) {
        setIsRouteSheetOpen(true)
      }
      startSheetSpring(1, 0)
      return
    }

    const hasRoute = routeAlternatives.length > 0 && !errorMessage
    if (!hasRoute) {
      stopSheetSpring()
      updateSheetTransformDom(0)
      if (isRouteSheetOpen) {
        setIsRouteSheetOpen(false)
      }
    }
  }, [
    isDesktop,
    isSmartSuggestionsOpen,
    isRouteSheetOpen,
    routeAlternatives.length,
    errorMessage,
    startSheetSpring,
    stopSheetSpring,
    updateSheetTransformDom,
  ])

  const allStations = useMemo(() => {
    const manualList = Object.values(manualStations)
    if (manualList.length === 0) return fullGraphStations
    return [...fullGraphStations, ...manualList]
  }, [manualStations])

  const findExactStationByName = (name: string) => {
    const q = name.trim().toLowerCase()
    if (!q) return undefined

    for (const s of allStations) {
      const ov = stationOverrides[s.id]
      const title = ov?.title?.trim() || s.title
      if (title.toLowerCase() === q) return s
    }

    return undefined
  }

  const stationTitleById = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of allStations) {
      const ov = stationOverrides[s.id]
      const title = ov?.title?.trim() || s.title
      map.set(s.id, title)
    }
    return map
  }, [allStations, stationOverrides])

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

  const stationById = useMemo(() => {
    const map = new Map<string, FullGraphStation>()
    for (const s of allStations) {
      map.set(s.id, s)
    }
    return map
  }, [allStations])

  const lineByNumericId = useMemo(() => {
    const map = new Map<number, (typeof fullGraphLines)[number]>()
    for (const line of fullGraphLines) {
      map.set(line.id, line)
    }
    return map
  }, [])

  const getStationColorHex = useCallback(
    (station: FullGraphStation) => {
      const lineId = station.lineNumericId
      if (lineId == null) return undefined
      return lineByNumericId.get(lineId)?.colorHex
    },
    [lineByNumericId],
  )

  const fromSelectedColor = useMemo(() => {
    if (!fromStationId) return undefined
    const st = stationById.get(fromStationId)
    if (!st) return undefined
    return getStationColorHex(st)
  }, [fromStationId, stationById, getStationColorHex])

  const toSelectedColor = useMemo(() => {
    if (!toStationId) return undefined
    const st = stationById.get(toStationId)
    if (!st) return undefined
    return getStationColorHex(st)
  }, [toStationId, stationById, getStationColorHex])

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
    const hubMeta = new Map<string, { minTransferSeconds: number; source: (typeof fullGraphTransferHubs)[number]['source'] }>()
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
      source: (meta?.source ?? 'manual_override') as (typeof fullGraphTransferHubs)[number]['source'],
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
      const key = e.fromStationId < e.toStationId
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
        const key = e.fromStationId < e.toStationId
          ? `${e.fromStationId}|${e.toStationId}`
          : `${e.toStationId}|${e.fromStationId}`
        seen.add(key)
      }
    }

    for (const e of Object.values(manualEdges)) {
      if (e.fromStationId !== inspectedStation.id && e.toStationId !== inspectedStation.id) continue
      const key = e.fromStationId < e.toStationId
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
      } else if (
        typeof baseStation.layoutX === 'number' &&
        typeof baseStation.layoutY === 'number'
      ) {
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
        (stationOverrides[baseStation.id]?.lineNumericId ?? baseStation.lineNumericId) ??
        null
      const lineNumericId =
        effectiveLineNumericId != null ? effectiveLineNumericId : baseLine

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
    setHubRotationOverrides((prev) => {
      const prevDeg = prev[hubId] ?? 0
      const delta = direction === 'cw' ? HUB_ROTATE_STEP_DEG : -HUB_ROTATE_STEP_DEG
      let nextDeg = prevDeg + delta
      if (!Number.isFinite(nextDeg)) nextDeg = 0
      nextDeg = ((nextDeg % 360) + 360) % 360
      if (nextDeg === 0) {
        if (!(hubId in prev)) return prev
        const cloned = { ...prev }
        delete cloned[hubId]
        return cloned
      }
      if (prevDeg === nextDeg) return prev
      return { ...prev, [hubId]: nextDeg }
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

      setHubRotationOverrides((prev) => {
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
    setHubRotationOverrides({})
    setManualStations({})
    setManualEdges({})
    setHiddenStations({})
    pendingLayoutOverridesRef.current = null
    setLastLayoutOverrides({})
    setEditorLayoutApplyToken((prev: number) => prev + 1)
    setInspectedStationId(null)
    showEditorToast('Все изменения сброшены')
  }, [showEditorToast])

  const clearRoutes = () => {
    setRouteAlternatives([])
    setActiveRouteIndex(0)
  }

  const buildRouteByIds = (fromId: string, toId: string) => {
    if (import.meta.env.DEV) {
      console.log(`[perf][route] buildRouteByIds from=${fromId} to=${toId}`)
    }
    setErrorMessage(null)
    clearRoutes()
    setRouteSheetOpenState(false)

    const fromStationResolved = stationById.get(fromId)
    const toStationResolved = stationById.get(toId)

    if (!fromStationResolved || !toStationResolved) {
      setErrorMessage('Не удалось найти одну из станций. Выбери её из списка подсказок.')
      return
    }

    if (fromId === toId) {
      setErrorMessage('Начальная и конечная станции не могут совпадать. Выбери другую станцию.')
      return
    }

    setFromStationId(fromId)
    setToStationId(toId)

    const worker = routeWorkerRef.current
    if (!worker) {
      setErrorMessage('Не удалось запустить вычисление маршрута. Обнови страницу.')
      return
    }

    // Отменяем/игнорируем все предыдущие pending запросы (важно при быстром тапе по станциям)
    routeWorkerPendingRef.current.clear()

    routeWorkerRequestIdRef.current += 1
    const requestId = routeWorkerRequestIdRef.current

    const fromTitleEffective = stationTitleById.get(fromId) ?? fromStationResolved.title
    const toTitleEffective = stationTitleById.get(toId) ?? toStationResolved.title

    routeWorkerPendingRef.current.set(requestId, {
      fromId,
      toId,
      fromTitleEffective,
      toTitleEffective,
      isDesktop,
    })

    worker.postMessage({
      type: 'route',
      requestId,
      fromId,
      toId,
      maxAlternatives: 6,
      edgeOverrides,
      extraEdges: Object.values(manualEdges),
    })
  }

  const fromSuggestions = useMemo(() => {
    const q = fromStation.trim().toLowerCase()
    if (!q || fromFixed) return []
    const result: RouteSuggestionItem[] = []
    for (const s of allStations) {
      const ov = stationOverrides[s.id]
      const title = ov?.title?.trim() || s.title
      if (title.toLowerCase().includes(q)) {
        const effectiveLineNumericId =
          ov && ov.lineNumericId !== undefined ? ov.lineNumericId : s.lineNumericId

        const color =
          effectiveLineNumericId != null
            ? lineByNumericId.get(effectiveLineNumericId)?.colorHex
            : undefined

        result.push({ id: s.id, title, color })
        if (result.length >= 6) break
      }
    }
    return result
  }, [fromStation, fromFixed, allStations, stationOverrides, lineByNumericId])

  const toSuggestions = useMemo(() => {
    const q = toStation.trim().toLowerCase()
    if (!q || toFixed) return []
    const result: RouteSuggestionItem[] = []
    for (const s of allStations) {
      const ov = stationOverrides[s.id]
      const title = ov?.title?.trim() || s.title
      if (title.toLowerCase().includes(q)) {
        const effectiveLineNumericId =
          ov && ov.lineNumericId !== undefined ? ov.lineNumericId : s.lineNumericId

        const color =
          effectiveLineNumericId != null
            ? lineByNumericId.get(effectiveLineNumericId)?.colorHex
            : undefined

        result.push({ id: s.id, title, color })
        if (result.length >= 6) break
      }
    }
    return result
  }, [toStation, toFixed, allStations, stationOverrides, lineByNumericId])

  const routeResult = routeAlternatives[activeRouteIndex] ?? null

  const routeArrivalTimeLabel = useMemo(() => {
    if (!routeResult) return null

    const now = new Date()
    const arrival = new Date(now.getTime() + routeResult.totalMinutes * 60 * 1000)

    return arrival.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })
  }, [routeResult])

  const activeRouteEndpoints = useMemo(() => {
    if (!routeResult) return null
    if (!fromStationId || !toStationId) return null

    const fromTitleSource = stationTitleById.get(fromStationId)
    const toTitleSource = stationTitleById.get(toStationId)

    const fromTitleEffective = (fromTitleSource ?? fromStation.trim()) || ''
    const toTitleEffective = (toTitleSource ?? toStation.trim()) || ''

    if (!fromTitleEffective || !toTitleEffective) return null

    return {
      fromStationId,
      toStationId,
      fromTitle: fromTitleEffective,
      toTitle: toTitleEffective,
    }
  }, [routeResult, fromStationId, toStationId, stationTitleById, fromStation, toStation])

  const isActiveRouteFavorite = useMemo(
    () =>
      !!(
        activeRouteEndpoints &&
        favoriteRoutes.some(
          (item) =>
            item.fromStationId === activeRouteEndpoints.fromStationId &&
            item.toStationId === activeRouteEndpoints.toStationId,
        )
      ),
    [activeRouteEndpoints, favoriteRoutes],
  )

  const handleToggleFavoriteActiveRoute = () => {
    if (!activeRouteEndpoints) return
    const { fromStationId: fromId, toStationId: toId, fromTitle, toTitle } =
      activeRouteEndpoints

    const prevRoutes = favoriteRoutes
    const exists = prevRoutes.some(
      (item) => item.fromStationId === fromId && item.toStationId === toId,
    )
    let next: SavedRoute[]
    if (exists) {
      next = prevRoutes.filter(
        (item) => !(item.fromStationId === fromId && item.toStationId === toId),
      )
    } else {
      const now = Date.now()
      next = [
        {
          fromStationId: fromId,
          toStationId: toId,
          fromTitle,
          toTitle,
          lastUsedAt: now,
        },
        ...prevRoutes,
      ].slice(0, 20)
    }

    persistRoutesToStorage(FAVORITES_STORAGE_KEY, next)
    setFavoriteRoutes(next)
  }

  const routeStationIds = useMemo(() => {
    if (!routeResult) return []

    const ids: string[] = []
    for (const step of routeResult.steps) {
      if (ids.length === 0) {
        ids.push(step.fromStationId)
      }
      const last = ids[ids.length - 1]
      if (last !== step.toStationId) {
        ids.push(step.toStationId)
      }
    }

    return ids
  }, [routeResult])

  const routeEdgeKeys = useMemo(() => {
    if (!routeResult) return []

    const keys: string[] = []
    const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

    for (const step of routeResult.steps) {
      keys.push(edgeKey(step.fromStationId, step.toStationId))
    }

    return Array.from(new Set(keys))
  }, [routeResult])

  const routeLongTransferEdgeKeys = useMemo(() => {
    if (!routeResult) return []

    const keys: string[] = []
    const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

    for (const step of routeResult.steps) {
      if (!step.isTransfer) continue

      const kind = step.transferKind
      const isFarKind =
        kind === 'far' ||
        kind === 'out_of_station' ||
        kind === 'mcc' ||
        kind === 'mcd'

      const isFarByTime = step.travelMinutes >= 6

      if (isFarKind || (!kind && isFarByTime)) {
        keys.push(edgeKey(step.fromStationId, step.toStationId))
      }
    }

    return Array.from(new Set(keys))
  }, [routeResult])

  const decoratedSegments = useMemo<DecoratedSegment[]>(
    () => {
      if (!routeResult) return []

      type RideSegment = {
        type: 'ride'
        key: string
        fromTitle: string
        toTitle: string
        lineColor?: string
        stationTitles: string[]
        travelMinutes: number
      }

      type TransferSegment = {
        type: 'transfer'
        key: string
        fromTitle: string
        toTitle: string
        fromLineColor?: string
        toLineColor?: string
        travelMinutes: number
        isFar: boolean
      }

      type Segment = RideSegment | TransferSegment

      const segments: Segment[] = []
      let currentRide: RideSegment | null = null

      const flushRide = () => {
        if (currentRide) {
          segments.push(currentRide)
          currentRide = null
        }
      }

      routeResult.steps.forEach((step, index) => {
        const fromTitle = stationTitleById.get(step.fromStationId) ?? step.fromStationId
        const toTitle = stationTitleById.get(step.toStationId) ?? step.toStationId

        const fromStation = stationById.get(step.fromStationId)
        const toStation = stationById.get(step.toStationId)

        const fromLineNumericId = fromStation?.lineNumericId ?? null
        const toLineNumericId = toStation?.lineNumericId ?? null

        const fromLine = fromLineNumericId != null ? lineByNumericId.get(fromLineNumericId) : undefined
        const toLine = toLineNumericId != null ? lineByNumericId.get(toLineNumericId) : undefined

        if (step.isTransfer) {
          flushRide()

          const kind = step.transferKind
          const isFar =
            kind === 'far' ||
            kind === 'out_of_station' ||
            kind === 'mcc' ||
            kind === 'mcd' ||
            (!kind && step.travelMinutes >= 6)

          const transferSegment: TransferSegment = {
            type: 'transfer',
            key: `${step.fromStationId}-${step.toStationId}-${index}`,
            fromTitle,
            toTitle,
            travelMinutes: step.travelMinutes,
            fromLineColor: fromLine?.colorHex,
            toLineColor: toLine?.colorHex,
            isFar,
          }

          segments.push(transferSegment)
        } else {
          const lineColor = fromLine?.colorHex ?? toLine?.colorHex

          if (
            currentRide &&
            currentRide.lineColor === lineColor &&
            currentRide.toTitle === fromTitle
          ) {
            // Продолжаем поездку по той же линии: добавляем станцию и время
            currentRide = {
              ...currentRide,
              toTitle,
              travelMinutes: currentRide.travelMinutes + step.travelMinutes,
              stationTitles: [...currentRide.stationTitles, toTitle],
            }
          } else {
            // Начинаем новый сегмент поездки по линии
            flushRide()
            currentRide = {
              type: 'ride',
              key: `${step.fromStationId}-${step.toStationId}-${index}`,
              fromTitle,
              toTitle,
              lineColor,
              travelMinutes: step.travelMinutes,
              stationTitles: [fromTitle, toTitle],
            }
          }
        }
      })

      flushRide()

      return segments
    },
    [routeResult, stationTitleById, stationById, lineByNumericId],
  )

  const handleApplySavedRoute = (saved: SavedRoute) => {
    setFromStation(saved.fromTitle)
    setToStation(saved.toTitle)
    setFromFixed(true)
    setToFixed(true)
    setFromStationId(saved.fromStationId)
    setToStationId(saved.toStationId)
    setErrorMessage(null)
    buildRouteByIds(saved.fromStationId, saved.toStationId)
  }

  const handleApplyNearbyStationAsFrom = (station: FullGraphStation) => {
    const override = stationOverrides[station.id]
    const title = override?.title?.trim() || station.title
    const targetToId = toStationId

    setFromStation(title)
    setFromFixed(true)
    setFromStationId(station.id)
    setErrorMessage(null)

    if (targetToId && targetToId !== station.id) {
      buildRouteByIds(station.id, targetToId)
    } else {
      clearRoutes()
      setRouteSheetOpenState(false)
    }
  }

  const handleRequestNearbyStations = useCallback(() => {
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      setNearbyStatus('error')
      setNearbyError('Геолокация доступна только по HTTPS (или на localhost).')
      return
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setNearbyStatus('error')
      setNearbyError('Геолокация недоступна.')
      return
    }

    setNearbyStatus('loading')
    setNearbyError(null)

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords
        const withCoords = allStations.filter((s) => {
          const ov = stationOverrides[s.id]
          const lat = ov?.lat ?? s.lat
          const lon = ov?.lon ?? s.lon
          return typeof lat === 'number' && typeof lon === 'number'
        })
        if (withCoords.length === 0) {
          setNearbyStatus('error')
          setNearbyError('Нет станций с координатами.')
          return
        }

        const R = 6371000
        const toRad = (deg: number) => (deg * Math.PI) / 180

        const scored = withCoords.map((s) => {
          const ov = stationOverrides[s.id]
          const effectiveLat = (ov?.lat ?? s.lat) as number
          const effectiveLon = (ov?.lon ?? s.lon) as number
          const lat1 = toRad(latitude)
          const lon1 = toRad(longitude)
          const lat2 = toRad(effectiveLat)
          const lon2 = toRad(effectiveLon)
          const dLat = lat2 - lat1
          const dLon = lon2 - lon1
          const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2)
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
          const distance = R * c
          return { station: s, distance }
        })

        scored.sort((a, b) => a.distance - b.distance)
        const nearest = scored.slice(0, 6).map((x) => x.station)

        setNearbyStations(nearest)
        setNearbyStatus('idle')

        if (typeof window !== 'undefined') {
          try {
            window.localStorage.setItem('kitty-metro-nearby-allowed', '1')
          } catch {
            // ignore storage errors
          }
        }
      },
      (error) => {
        setNearbyStatus('error')
        if (error?.code === 1) {
          setNearbyError('Нет разрешения на местоположение. Разреши доступ в настройках браузера.')
          return
        }
        if (error?.code === 2) {
          setNearbyError('Не удалось определить местоположение (нет сигнала).')
          return
        }
        if (error?.code === 3) {
          setNearbyError('Истекло время ожидания геолокации.')
          return
        }
        setNearbyError('Не удалось получить местоположение.')
      },
      {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 60000,
      },
    )
  }, [allStations, stationOverrides])

  useEffect(() => {
    if (typeof window === 'undefined') return

    let shouldAutoRequest = false
    try {
      shouldAutoRequest = window.localStorage.getItem('kitty-metro-nearby-allowed') === '1'
    } catch {
      shouldAutoRequest = false
    }

    if (!shouldAutoRequest) return

    if (typeof navigator === 'undefined') return
    const permissionsApi = (navigator as unknown as { permissions?: Permissions }).permissions
    if (!permissionsApi?.query) {
      return
    }

    void permissionsApi
      .query({ name: 'geolocation' as PermissionName })
      .then((status) => {
        if (status.state === 'granted') {
          handleRequestNearbyStations()
        }
      })
      .catch(() => {
        return
      })
  }, [handleRequestNearbyStations])

  const handleFromChange = (value: string) => {
    setFromStation(value)
    setFromStationId(null)
    setFromFixed(false)
    clearRoutes()
    setErrorMessage(null)
    setRouteSheetOpenState(false)
    setFromSuggestionIndex(-1)
  }

  const handleToChange = (value: string) => {
    setToStation(value)
    setToStationId(null)
    setToFixed(false)
    clearRoutes()
    setErrorMessage(null)
    setRouteSheetOpenState(false)
    setToSuggestionIndex(-1)
  }

  const handleSelectFromSuggestion = (stationId: string) => {
    const station = stationById.get(stationId)
    if (!station) return

    const toId = toStationId
    if (toId && stationId === toId) {
      return
    }

    const name = stationTitleById.get(stationId) ?? station.title

    setFromStation(name)
    setFromFixed(true)
    setFromStationId(stationId)
    setFromSuggestionIndex(-1)
    setErrorMessage(null)

    if (!isDesktop && !toStationId) {
      focusIfNeeded(toInputRef.current)
    }

    // Если уже есть валидное "Куда" — сразу считаем маршрут
    if (toId) {
      buildRouteByIds(stationId, toId)
    }
  }

  const handleSheetTouchStart = (event: TouchEvent) => {
    if (errorMessage) return
    if (isDesktop) return
    if (event.touches.length === 0) return
    if (shouldIgnoreSheetTouch(event.target)) return

    markPerfInteraction()

    // Важно: НЕ делаем recomputeSheetMaxOffsetPx() внутри touchstart.
    // Там куча layout-ридов (scrollHeight/getComputedStyle) и на low-tier
    // это даёт фризы на сотни миллисекунд.
    if (sheetMaxOffsetPxRef.current <= 0) return

    stopSheetSpring()
    sheetTouchStartedOnButtonRef.current =
      event.target instanceof Element && Boolean(event.target.closest('button, [role="button"]'))
    sheetTouchStartedInSmartSuggestionsRef.current =
      event.target instanceof Element &&
      Boolean(
        event.target.closest(
          '.smart-suggestions-inline, .smart-suggestions, .smart-suggestions-row, .smart-suggestion-chip, .smart-suggestions-inline-chip',
        ),
      )
    const touch = event.touches[0]
    sheetTouchStartYRef.current = touch.screenY
    sheetTouchLastYRef.current = touch.screenY
    sheetTouchStartXRef.current = touch.screenX
    sheetTouchLastXRef.current = touch.screenX
    sheetGestureAxisRef.current = 'pending'
    sheetDeferredRecomputeRef.current = false
    sheetDragStartProgressRef.current = sheetProgressRef.current

    const now =
      typeof event.timeStamp === 'number' && event.timeStamp > 0 ? event.timeStamp : performance.now()
    sheetDragLastSampleTimeRef.current = now
    sheetDragLastSampleProgressRef.current = sheetProgressRef.current
    sheetDragVelocityRef.current = 0
  }

  const handleSheetTouchMove = (event: TouchEvent) => {
    if (sheetTouchStartYRef.current == null) return
    if (event.touches.length === 0) return
    markPerfInteraction()
    const touch = event.touches[0]
    sheetTouchLastYRef.current = touch.screenY
    sheetTouchLastXRef.current = touch.screenX
    const gestureThresholdPx = sheetTouchStartedOnButtonRef.current
      ? sheetTouchStartedInSmartSuggestionsRef.current
        ? 18
        : 12
      : 6
    const axis = sheetGestureAxisRef.current
    if (axis === 'pending') {
      const startX = sheetTouchStartXRef.current ?? touch.screenX
      const startY = sheetTouchStartYRef.current ?? touch.screenY
      const dx = touch.screenX - startX
      const dy = touch.screenY - startY
      if (Math.abs(dx) >= gestureThresholdPx || Math.abs(dy) >= gestureThresholdPx) {
        sheetGestureAxisRef.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      } else {
        return
      }
    }
    if (sheetGestureAxisRef.current !== 'y') return
    const startY = sheetTouchStartYRef.current
    let dragRange = sheetMaxOffsetPxRef.current
    if (!dragRange || dragRange <= 0) return
    const startProgress =
      sheetDragStartProgressRef.current != null
        ? sheetDragStartProgressRef.current
        : isRouteSheetOpen
          ? 1
          : 0
    const deltaY = touch.screenY - startY
    const nextProgress = Math.max(0, Math.min(1, startProgress - deltaY / dragRange))

    const now =
      typeof event.timeStamp === 'number' && event.timeStamp > 0 ? event.timeStamp : performance.now()
    const lastTime = sheetDragLastSampleTimeRef.current
    const lastProgress = sheetDragLastSampleProgressRef.current
    if (lastTime != null && lastProgress != null) {
      const dtMs = now - lastTime
      if (dtMs > 0 && dtMs < 200) {
        const dt = dtMs / 1000
        const rawV = (nextProgress - lastProgress) / dt
        const clampedV = Math.max(-4, Math.min(4, rawV))
        sheetDragVelocityRef.current = sheetDragVelocityRef.current * 0.7 + clampedV * 0.3
      }
    }
    sheetDragLastSampleTimeRef.current = now
    sheetDragLastSampleProgressRef.current = nextProgress

    sheetAnimTargetRef.current = nextProgress
    if (sheetAnimFrameRef.current == null) {
      sheetAnimFrameRef.current = window.requestAnimationFrame(() => {
        sheetAnimFrameRef.current = null
        const target = sheetAnimTargetRef.current
        if (target == null) return
        updateSheetTransformDom(target)
      })
    }
  }

  const handleSheetTouchEnd = () => {
    markPerfInteraction()
    const axis = sheetGestureAxisRef.current
    const startY = sheetTouchStartYRef.current
    const lastY = sheetTouchLastYRef.current
    sheetTouchStartYRef.current = null
    sheetTouchLastYRef.current = null
    sheetTouchStartXRef.current = null
    sheetTouchLastXRef.current = null
    sheetGestureAxisRef.current = null
    sheetTouchStartedOnButtonRef.current = false
    sheetTouchStartedInSmartSuggestionsRef.current = false
    sheetDragStartProgressRef.current = null

    // Очищаем отложенный кадр анимации drag'а, чтобы не было лишних
    // setState уже после завершения жеста.
    const pendingTarget = sheetAnimTargetRef.current
    if (sheetAnimFrameRef.current != null) {
      window.cancelAnimationFrame(sheetAnimFrameRef.current)
      sheetAnimFrameRef.current = null
    }
    sheetAnimTargetRef.current = null

    let releasedProgress = sheetProgressRef.current
    if (pendingTarget != null) {
      releasedProgress = pendingTarget
      updateSheetTransformDom(pendingTarget)
    }

    sheetDragLastSampleTimeRef.current = null
    sheetDragLastSampleProgressRef.current = null

    if (sheetDeferredRecomputeRef.current) {
      sheetDeferredRecomputeRef.current = false
      window.requestAnimationFrame(() => {
        recomputeSheetMaxOffsetPx()
      })
    }

    if (axis !== 'y') {
      const targetProgress = isRouteSheetOpen ? 1 : 0
      startSheetSpring(targetProgress, 0)
      return
    }

    if (startY == null || lastY == null) return

    const dragVelocity = sheetDragVelocityRef.current
    sheetDragVelocityRef.current = 0

    const velocityThreshold = 1.2
    const targetOpen =
      dragVelocity > velocityThreshold
        ? true
        : dragVelocity < -velocityThreshold
          ? false
          : releasedProgress >= 0.5

    setIsRouteSheetOpen(targetOpen)
    if (!targetOpen) {
      setIsSmartSuggestionsOpen(false)
    }

    const targetProgress = targetOpen ? 1 : 0
    let initialVelocity = dragVelocity
    if (targetOpen && initialVelocity < 0) initialVelocity = 0
    if (!targetOpen && initialVelocity > 0) initialVelocity = 0
    startSheetSpring(targetProgress, initialVelocity * 0.35)
  }

  const handleSheetTouchCancel = () => {
    const axis = sheetGestureAxisRef.current
    sheetTouchStartYRef.current = null
    sheetTouchLastYRef.current = null
    sheetTouchStartXRef.current = null
    sheetTouchLastXRef.current = null
    sheetGestureAxisRef.current = null
    sheetTouchStartedOnButtonRef.current = false
    sheetTouchStartedInSmartSuggestionsRef.current = false
    sheetDragStartProgressRef.current = null

    if (sheetAnimFrameRef.current != null) {
      window.cancelAnimationFrame(sheetAnimFrameRef.current)
      sheetAnimFrameRef.current = null
    }
    const pendingTarget = sheetAnimTargetRef.current
    sheetAnimTargetRef.current = null
    if (pendingTarget != null) {
      updateSheetTransformDom(pendingTarget)
    }

    sheetDragLastSampleTimeRef.current = null
    sheetDragLastSampleProgressRef.current = null
    sheetDragVelocityRef.current = 0

    if (sheetDeferredRecomputeRef.current) {
      sheetDeferredRecomputeRef.current = false
      window.requestAnimationFrame(() => {
        recomputeSheetMaxOffsetPx()
      })
    }

    if (axis === 'y' || axis === 'pending') {
      const targetProgress = isRouteSheetOpen ? 1 : 0
      startSheetSpring(targetProgress, 0)
    }
  }

  const handleSelectToSuggestion = (stationId: string) => {
    const station = stationById.get(stationId)
    if (!station) return

    const fromId = fromStationId
    if (fromId && stationId === fromId) {
      return
    }

    const name = stationTitleById.get(stationId) ?? station.title

    setToStation(name)
    setToFixed(true)
    setToStationId(stationId)
    setToSuggestionIndex(-1)
    setErrorMessage(null)

    if (fromId) {
      buildRouteByIds(fromId, stationId)
    }
  }

  const closeStationPickPopoverImmediate = useCallback(() => {
    if (stationPickPopoverCloseTimeoutRef.current != null) {
      window.clearTimeout(stationPickPopoverCloseTimeoutRef.current)
      stationPickPopoverCloseTimeoutRef.current = null
    }
    setStationPickPopoverClosing(false)
    setStationPickPopoverPressed(null)
    setStationPickPopover(null)
    setStationPickPopoverPos(null)
  }, [])

  const closeStationPickPopoverAnimated = useCallback(
    ({ delayMs }: { delayMs?: number } = {}) => {
      const exitMs = 160
      const delay = delayMs ?? 0
      if (stationPickPopoverCloseTimeoutRef.current != null) {
        window.clearTimeout(stationPickPopoverCloseTimeoutRef.current)
        stationPickPopoverCloseTimeoutRef.current = null
      }

      stationPickPopoverCloseTimeoutRef.current = window.setTimeout(() => {
        setStationPickPopoverClosing(true)
        stationPickPopoverCloseTimeoutRef.current = window.setTimeout(() => {
          closeStationPickPopoverImmediate()
        }, exitMs)
      }, delay)
    },
    [closeStationPickPopoverImmediate],
  )

  const applyStationToField = (mode: 'from' | 'to', stationId: string, stationName: string) => {
    if (mode === 'from') {
      const toId = toStationId
      if (toId && stationId === toId) {
        return
      }

      setFromStation(stationName)
      setFromFixed(true)
      setFromStationId(stationId)
      setFromSuggestionIndex(-1)
      setErrorMessage(null)

      if (toId) {
        buildRouteByIds(stationId, toId)
      } else {
        clearRoutes()
        setRouteSheetOpenState(false)
      }
      return
    }

    const fromId = fromStationId
    if (fromId && stationId === fromId) {
      return
    }

    setToStation(stationName)
    setToFixed(true)
    setToStationId(stationId)
    setToSuggestionIndex(-1)
    setErrorMessage(null)

    if (fromId) {
      buildRouteByIds(fromId, stationId)
    } else {
      clearRoutes()
      setRouteSheetOpenState(false)
    }
  }

  const handleSwapStations = () => {
    if (!fromStation.trim() && !toStation.trim()) {
      return
    }

    const nextFrom = toStation
    const nextTo = fromStation
    const nextFromId = toStationId
    const nextToId = fromStationId

    setFromStation(nextFrom)
    setToStation(nextTo)
    setFromStationId(nextFromId ?? null)
    setToStationId(nextToId ?? null)

    const fromIsValid = nextFromId != null
    const toIsValid = nextToId != null
    setFromFixed(fromIsValid)
    setToFixed(toIsValid)

    setErrorMessage(null)

    if (fromIsValid && toIsValid) {
      if (nextFromId === nextToId) {
        clearRoutes()
        setRouteSheetOpenState(false)
        setErrorMessage('Начальная и конечная станции не могут совпадать. Выбери другую станцию.')
        return
      }
      buildRouteByIds(nextFromId!, nextToId!)
    } else {
      clearRoutes()
      setRouteSheetOpenState(false)
    }
  }

  const handleFromKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      if (fromSuggestions.length === 0) return
      event.preventDefault()
      setFromSuggestionIndex((prev) => {
        const next = prev + 1
        return next >= fromSuggestions.length ? fromSuggestions.length - 1 : next
      })
      return
    }

    if (event.key === 'ArrowUp') {
      if (fromSuggestions.length === 0) return
      event.preventDefault()
      setFromSuggestionIndex((prev) => {
        const next = prev - 1
        return next < 0 ? 0 : next
      })
      return
    }

    if (event.key !== 'Enter') return

    event.preventDefault()

    let nextFromName = fromStation
    let nextFromId = fromStationId
    if (!fromFixed && fromSuggestions.length > 0) {
      const index =
        fromSuggestionIndex >= 0 && fromSuggestionIndex < fromSuggestions.length
          ? fromSuggestionIndex
          : 0
      const selected = fromSuggestions[index]
      nextFromName = selected.title
      setFromStation(selected.title)
      setFromFixed(true)
      setFromStationId(selected.id)
      nextFromId = selected.id
    }

    if (!nextFromId) {
      setErrorMessage('Выбери станцию "Откуда" из списка подсказок.')
      return
    }

    const nextToId = toStationId
    if (nextToId) {
      if (nextFromId === nextToId) {
        setErrorMessage('Начальная и конечная станции не могут совпадать. Выбери другую станцию.')
        clearRoutes()
        setRouteSheetOpenState(false)
        return
      }
      buildRouteByIds(nextFromId, nextToId)
      return
    }

    if (nextFromName.trim()) {
      focusIfNeeded(toInputRef.current)
    }
  }

  const handleToKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      if (toSuggestions.length === 0) return
      event.preventDefault()
      setToSuggestionIndex((prev) => {
        const next = prev + 1
        return next >= toSuggestions.length ? toSuggestions.length - 1 : next
      })
      return
    }

    if (event.key === 'ArrowUp') {
      if (toSuggestions.length === 0) return
      event.preventDefault()
      setToSuggestionIndex((prev) => {
        const next = prev - 1
        return next < 0 ? 0 : next
      })
      return
    }

    if (event.key !== 'Enter') return

    event.preventDefault()

    let nextToName = toStation
    let nextToId = toStationId
    if (!toFixed && toSuggestions.length > 0) {
      const index =
        toSuggestionIndex >= 0 && toSuggestionIndex < toSuggestions.length
          ? toSuggestionIndex
          : 0
      const selected = toSuggestions[index]
      nextToName = selected.title
      setToStation(selected.title)
      setToFixed(true)
      setToStationId(selected.id)
      nextToId = selected.id
    }

    if (!nextToId) {
      setErrorMessage('Выбери станцию "Куда" из списка подсказок.')
      return
    }

    const nextFromId = fromStationId
    if (nextFromId) {
      if (nextFromId === nextToId) {
        setErrorMessage('Начальная и конечная станции не могут совпадать. Выбери другую станцию.')
        clearRoutes()
        setRouteSheetOpenState(false)
        return
      }
      buildRouteByIds(nextFromId, nextToId)
      return
    }

    if (nextToName.trim() && !fromStation.trim()) {
      focusIfNeeded(fromInputRef.current)
    }
  }

  const handleMapSelect = useCallback((
    id: string,
    name: string,
    clientPoint?: { x: number; y: number; t?: number },
  ) => {
    if (!clientPoint) {
      return
    }
    if (import.meta.env.DEV) {
      stationPickPopoverPerfRef.current = { openedAt: performance.now(), tapAt: clientPoint.t }
      console.log(`[perf][popover] open station=${id} tapAt=${clientPoint.t != null ? clientPoint.t.toFixed(1) : 'n/a'}`)
    }
    if (stationPickPopoverCloseTimeoutRef.current != null) {
      window.clearTimeout(stationPickPopoverCloseTimeoutRef.current)
      stationPickPopoverCloseTimeoutRef.current = null
    }
    startTransition(() => {
      setStationPickPopoverClosing(false)
      setStationPickPopoverPressed(null)
      setStationPickPopover({ stationId: id, stationName: name, clientPoint })
    })
  }, [])

  const handleMapInteraction = useCallback(() => {
    markPerfInteraction()
    if (!isDesktop && routeResult && !errorMessage) {
      setRouteSheetOpenState(false)
    }
  }, [markPerfInteraction, isDesktop, routeResult, errorMessage, setRouteSheetOpenState])

  useEffect(() => {
    if (!stationPickPopover) return
    if (typeof window === 'undefined') return

    let rafId = 0
    rafId = window.requestAnimationFrame(() => {
      const el = stationPickPopoverRef.current
      if (!el) return

      const vw = window.innerWidth
      const vh = window.innerHeight
      const rect = el.getBoundingClientRect()

      const margin = 8
      const gap = 20
      const nudgeX = 10

      const preferTop = stationPickPopover.clientPoint.y - gap - rect.height
      const top = preferTop < margin ? stationPickPopover.clientPoint.y + gap : preferTop
      const left = stationPickPopover.clientPoint.x - rect.width / 2 + nudgeX

      const clampedLeft = Math.min(vw - margin - rect.width, Math.max(margin, left))
      const clampedTop = Math.min(vh - margin - rect.height, Math.max(margin, top))

      setStationPickPopoverPos({ left: clampedLeft, top: clampedTop })

      if (import.meta.env.DEV) {
        const perf = stationPickPopoverPerfRef.current
        if (perf) {
          const now = performance.now()
          const openLatency = now - perf.openedAt
          const tapLatency = perf.tapAt != null ? now - perf.tapAt : null
          console.log(
            `[perf][popover] positioned openLatency=${openLatency.toFixed(1)}ms tapLatency=${tapLatency != null ? tapLatency.toFixed(1) : 'n/a'}ms`,
          )
          stationPickPopoverPerfRef.current = null
        }
      }
    })

    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId)
      }
    }
  }, [stationPickPopover])

  useEffect(() => {
    if (!stationPickPopover) return
    if (typeof window === 'undefined') return
    if (typeof document === 'undefined') return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeStationPickPopoverAnimated()
      }
    }

    const onPointerDown = (event: PointerEvent) => {
      const el = stationPickPopoverRef.current
      if (!el) return
      const target = event.target
      if (!(target instanceof Node)) return
      if (el.contains(target)) return
      closeStationPickPopoverAnimated()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', closeStationPickPopoverImmediate)
    document.addEventListener('pointerdown', onPointerDown, true)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', closeStationPickPopoverImmediate)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [stationPickPopover, closeStationPickPopoverAnimated, closeStationPickPopoverImmediate])

  const currentSelectionMode: 'from' | 'to' = !fromStationId
    ? 'from'
    : !toStationId
      ? 'to'
      : 'from'
  const isSplashActive = isSplashMounted
  const isPrimaryUiReady = isSplashDone && isMapReady

  const trimmedFrom = fromStation.trim()
  const trimmedTo = toStation.trim()

  let headerTitle: string
  if (trimmedFrom && trimmedTo) {
    headerTitle = `${trimmedFrom} → ${trimmedTo}`
  } else if (trimmedFrom) {
    headerTitle = `Откуда: ${trimmedFrom}`
  } else if (trimmedTo) {
    headerTitle = `Куда: ${trimmedTo}`
  } else {
    headerTitle = 'Откуда? → Куда?'
  }

  let headerChipClassName = 'app-header-chip'
  if (routeResult) {
    headerChipClassName += ' app-header-chip--has-route'
  }
  if (isRouteSheetOpen) {
    headerChipClassName += ' app-header-chip--sheet-open'
  }

  useEffect(() => {
    if (isDesktop) return

    if (isSmartSuggestionsOpen) {
      recomputeSheetMaxOffsetPx()
      updateSheetTransformDom(sheetProgressRef.current)
      return
    }

    const hasRoute = routeAlternatives.length > 0 && !errorMessage
    if (!hasRoute) {
      stopSheetSpring()
      updateSheetTransformDom(0)
      return
    }

    recomputeSheetMaxOffsetPx()
    updateSheetTransformDom(sheetProgressRef.current)
  }, [
    isDesktop,
    isSmartSuggestionsOpen,
    routeAlternatives.length,
    errorMessage,
    recomputeSheetMaxOffsetPx,
    stopSheetSpring,
    updateSheetTransformDom,
  ])

  return (
    <div className={`app-root${isSplashActive ? ' app-root--splash-active' : ''}`}>
      <div className="app-status-bar-fill" aria-hidden="true" />
      {isSplashMounted && (
        <SplashScreen
          isDone={isSplashDone && isMapReady}
          onDone={() => setIsSplashDone(true)}
          onHidden={() => setIsSplashMounted(false)}
        />
      )}

      <div className="app-map-layer">
        <MetroMap
          selectionMode={currentSelectionMode}
          onSelectStation={handleMapSelect}
          fromStationName={fromStation}
          toStationName={toStation}
          fromStationId={fromStationId ?? undefined}
          toStationId={toStationId ?? undefined}
          routeStationIds={routeStationIds}
          routeEdgeKeys={routeEdgeKeys}
          routeLongTransferEdgeKeys={routeLongTransferEdgeKeys}
          editMode={effectiveEditMode}
          onLayoutChange={handleLayoutChange}
          editorLayoutOverrides={lastLayoutOverrides}
          editorLayoutApplyToken={editorLayoutApplyToken}
          collisionDebug={EDITOR_ENABLED && collisionDebug}
          onMapInteraction={handleMapInteraction}
          onEditStationInspect={handleInspectStation}
          stationHubOverrides={stationHubOverrides}
          hiddenStationIds={hiddenStationIdSet}
          visibleInsets={mapVisibleInsets}
          getBottomInsetPx={getBottomInsetPx}
          stationTitleOverrides={stationTitleOverridesForMap}
          extraStations={extraStationsForMap}
          hubRotateCommand={hubRotateCommand}
          hubMirrorCommand={hubMirrorCommand}
          editorFocusCommand={editorFocusCommand}
          onEditSelectionChange={setEditorSelectedStationIds}
          onInitialViewportReady={handleInitialViewportReady}
          routeSheetOpen={isRouteSheetOpen}
        />
      </div>

      {!effectiveEditMode && stationPickPopover && (
        <div
          ref={stationPickPopoverRef}
          className={`station-pick-popover${stationPickPopoverClosing ? ' station-pick-popover--closing' : ''}`}
          style={
            stationPickPopoverPos
              ? { left: stationPickPopoverPos.left, top: stationPickPopoverPos.top }
              : { left: 0, top: 0, visibility: 'hidden' }
          }
          role="dialog"
          aria-label="Выбор поля для станции"
        >
          {(() => {
            const st = stationById.get(stationPickPopover.stationId)
            const override = stationOverrides[stationPickPopover.stationId]
            const lineNumericId = (override?.lineNumericId ?? st?.lineNumericId) ?? null
            const line = lineNumericId != null ? lineByNumericId.get(lineNumericId) : undefined
            const lineColor = line?.colorHex

            return (
              <div className="station-pick-popover-header">
                <span
                  className="station-pick-popover-line-dot"
                  style={{ backgroundColor: lineColor ?? 'var(--color-accent)' }}
                  aria-hidden="true"
                />
                <div className="station-pick-popover-title">{stationPickPopover.stationName}</div>
              </div>
            )
          })()}

          <div className="station-pick-popover-actions">
            <button
              type="button"
              className="station-pick-popover-button"
              data-pressed={stationPickPopoverPressed === 'from' ? 'true' : undefined}
              onClick={(event) => {
                event.preventDefault()
                if (import.meta.env.DEV) {
                  console.log(`[perf][popover] button=from station=${stationPickPopover.stationId}`)
                }
                startTransition(() => {
                  setStationPickPopoverPressed('from')
                  applyStationToField('from', stationPickPopover.stationId, stationPickPopover.stationName)
                })
                closeStationPickPopoverAnimated({ delayMs: 120 })
              }}
            >
              Откуда
            </button>
            <button
              type="button"
              className="station-pick-popover-button"
              data-pressed={stationPickPopoverPressed === 'to' ? 'true' : undefined}
              onClick={(event) => {
                event.preventDefault()
                if (import.meta.env.DEV) {
                  console.log(`[perf][popover] button=to station=${stationPickPopover.stationId}`)
                }
                startTransition(() => {
                  setStationPickPopoverPressed('to')
                  applyStationToField('to', stationPickPopover.stationId, stationPickPopover.stationName)
                })
                closeStationPickPopoverAnimated({ delayMs: 120 })
              }}
            >
              Куда
            </button>
          </div>
        </div>
      )}

      <div className="app-overlay">
        {!effectiveEditMode && isPrimaryUiReady && (
          <>
            <RouteHeader
              logoSrc={helloKittyIcon}
              logoAlt="Hello Kitty"
              headerTitle={headerTitle}
              headerChipClassName={headerChipClassName}
              onChipClick={() => {
                setRouteSheetOpenState(true)
                if (!trimmedFrom) {
                  focusIfNeeded(fromInputRef.current)
                } else if (!trimmedTo) {
                  focusIfNeeded(toInputRef.current)
                }
              }}
            />

            <main className="app-main">
              {errorMessage && (
                <section className="route-placeholder">
                  <p className="error-text">{errorMessage}</p>
                </section>
              )}
            </main>
          </>
        )}

        {EDITOR_ENABLED && HubEditorPanelLazy && effectiveEditMode && inspectedStation && (
          <Suspense fallback={null}>
            <HubEditorPanelLazy
              inspectedStation={inspectedStation}
              inspectedLineId={inspectedLineId}
              inspectedLine={inspectedLine}
              inspectedLineEdges={inspectedLineEdges}
              inspectedHub={inspectedHub}
              inspectedEdges={inspectedEdges}
              fullGraphLines={fullGraphLines}
              fullGraphEdges={fullGraphEdges}
              stationOverrides={stationOverrides}
              manualStations={manualStations}
              manualEdges={manualEdges}
              stationHubOverrides={stationHubOverrides}
              hiddenStations={hiddenStations}
              availableHubIds={availableHubIds}
              baseHubIds={fullGraphTransferHubs.map((hub) => hub.id)}
              stationById={stationById}
              lineByNumericId={lineByNumericId}
              effectiveLineStationIdsById={effectiveLineStationIdsById}
              edgeOverrides={edgeOverrides}
              hubMinOverrides={hubMinOverrides}
              hubRotationOverrides={hubRotationOverrides}
              editorSelectedStationIds={editorSelectedStationIds}
              hubAddStationInput={hubAddStationInput}
              newEdgeTarget={newEdgeTarget}
              findExactStationByName={findExactStationByName}
              edgeKey={edgeKey}
              onClose={() => setEditMode(false)}
              onUndo={handleEditorUndo}
              onRedo={handleEditorRedo}
              canUndo={canEditorUndo}
              canRedo={canEditorRedo}
              onChangeStationTitle={handleChangeStationTitle}
              onChangeStationLine={handleChangeStationLine}
              onDeleteManualStation={handleDeleteManualStation}
              onToggleEdgeTransfer={handleToggleEdgeTransfer}
              onChangeEdgeMinutes={handleChangeEdgeMinutes}
              onToggleEdgeDisabled={handleToggleEdgeDisabled}
              onChangeStationHub={handleChangeStationHub}
              onChangeHubMinMinutes={handleChangeHubMinMinutes}
              onToggleStationHidden={handleToggleStationHidden}
              onSetHubAddStationInput={setHubAddStationInput}
              onSetNewEdgeTarget={setNewEdgeTarget}
              onSetManualEdges={setManualEdges}
              onSetInspectedStationId={setInspectedStationId}
              onFocusStation={handleFocusStation}
              onRotateHubGeometry={handleRotateHubGeometry}
              onMirrorHubGeometry={handleMirrorHubGeometry}
              onUpdateStationGeoFromOSM={handleUpdateStationGeoFromOSM}
              onResetStationEdits={handleResetStationEdits}
              onResetEdgeEdits={handleResetEdgeEdits}
              onResetHubEdits={handleResetHubEdits}
              onResetAllEdits={handleResetAllEditorEdits}
            />
          </Suspense>
        )}

        {!effectiveEditMode && isPrimaryUiReady && (
          <div
            ref={bottomSheetRef}
            className={`bottom-sheet${
              routeResult && !errorMessage ? ' bottom-sheet--with-route' : ''
            }`}
          >
            <div
              className="bottom-sheet-inner"
              onTouchStart={handleSheetTouchStart}
              onTouchMove={handleSheetTouchMove}
              onTouchEnd={handleSheetTouchEnd}
              onTouchCancel={handleSheetTouchCancel}
            >
              <div ref={sheetMinVisibleRef} className="bottom-sheet-min">
                {routeResult && !errorMessage && !isDesktop && (
                  <button
                    type="button"
                    className="bottom-sheet-handle"
                    aria-label="Потянуть, чтобы раскрыть или свернуть детали маршрута"
                  />
                )}

                {!routeResult && !isDesktop && (
                  <button
                    type="button"
                    className="bottom-sheet-handle"
                    aria-label="Потянуть, чтобы раскрыть или свернуть шторку"
                  />
                )}

                {!isSmartSuggestionsOpen &&
                  (favoriteRoutes.length > 0 ||
                    recentRoutes.length > 0 ||
                    nearbyStatus !== 'error' ||
                    nearbyStations.length > 0) && (
                  <div className="smart-suggestions-inline">
                    {recentRoutes.length > 0 && (
                      <button
                        type="button"
                        className="smart-suggestions-inline-chip"
                        onClick={() => setIsSmartSuggestionsOpen(true)}
                      >
                        ⟳ Недавние
                      </button>
                    )}
                    {(nearbyStatus !== 'error' || nearbyStations.length > 0) && (
                      <button
                        type="button"
                        className="smart-suggestions-inline-chip"
                        onClick={() => {
                          setIsSmartSuggestionsOpen(true)
                          if (nearbyStatus === 'idle' && nearbyStations.length === 0) {
                            handleRequestNearbyStations()
                          }
                        }}
                      >
                        📍 Рядом
                      </button>
                    )}
                    {favoriteRoutes.length > 0 && (
                      <button
                        type="button"
                        className="smart-suggestions-inline-chip"
                        onClick={() => setIsSmartSuggestionsOpen(true)}
                      >
                        ★ Избранные
                      </button>
                    )}
                  </div>
                )}

                {isSmartSuggestionsOpen &&
                  (favoriteRoutes.length > 0 ||
                    recentRoutes.length > 0 ||
                    nearbyStatus !== 'error' ||
                    nearbyStations.length > 0) && (
                    <section className="smart-suggestions">
                      {favoriteRoutes.length === 0 && (
                        <div className="smart-suggestions-header">
                          <button
                            type="button"
                            className="smart-suggestions-close"
                            onClick={() => setIsSmartSuggestionsOpen(false)}
                            aria-label="Скрыть быстрые маршруты"
                          >
                            ✕
                          </button>
                        </div>
                      )}

                      {favoriteRoutes.length > 0 && (
                        <div className="smart-suggestions-section">
                          <div className="smart-suggestions-header">
                            <div className="smart-suggestions-title">Избранные</div>
                            <button
                              type="button"
                              className="smart-suggestions-close"
                              onClick={() => setIsSmartSuggestionsOpen(false)}
                              aria-label="Скрыть быстрые маршруты"
                            >
                              ✕
                            </button>
                          </div>
                          <div className="smart-suggestions-row">
                            {favoriteRoutes.map((route) => (
                              <button
                                key={`${route.fromStationId}-${route.toStationId}`}
                                type="button"
                                className="smart-suggestion-chip"
                                onClick={() => handleApplySavedRoute(route)}
                              >
                                {route.fromTitle} → {route.toTitle}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {recentRoutes.length > 0 && (
                        <div className="smart-suggestions-section">
                          <div className="smart-suggestions-header">
                            <div className="smart-suggestions-title">Недавние</div>
                            <button
                              type="button"
                              className="smart-suggestions-clear"
                              onClick={handleClearRecentRoutes}
                            >
                              Очистить
                            </button>
                          </div>
                          <div className="smart-suggestions-row">
                            {recentRoutes.map((route) => (
                              <button
                                key={`recent-${route.fromStationId}-${route.toStationId}-${route.lastUsedAt}`}
                                type="button"
                                className="smart-suggestion-chip smart-suggestion-chip--secondary"
                                onClick={() => handleApplySavedRoute(route)}
                              >
                                {route.fromTitle} → {route.toTitle}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      <div className="smart-suggestions-section">
                        <div className="smart-suggestions-title">Рядом</div>
                        {nearbyStatus === 'idle' && nearbyStations.length === 0 && (
                          <button
                            type="button"
                            className="smart-suggestion-chip smart-suggestion-chip--ghost"
                            onClick={handleRequestNearbyStations}
                          >
                            Показать станции рядом
                          </button>
                        )}
                        {nearbyStatus === 'loading' && (
                          <div className="smart-suggestions-hint">
                            Определяем ближайшие станции…
                          </div>
                        )}
                        {nearbyStatus === 'error' && (
                          <div className="smart-suggestions-error">
                            {nearbyError || 'Не удалось определить местоположение.'}
                          </div>
                        )}
                        {nearbyStatus !== 'loading' && nearbyStations.length > 0 && (
                          <div className="smart-suggestions-row">
                            {nearbyStations.map((station) => (
                              <button
                                key={station.id}
                                type="button"
                                className="smart-suggestion-chip smart-suggestion-chip--ghost"
                                onClick={() => handleApplyNearbyStationAsFrom(station)}
                              >
                                {station.title}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </section>
                  )}

                <RouteForm
                  fromStation={fromStation}
                  toStation={toStation}
                  fromSuggestions={fromSuggestions}
                  toSuggestions={toSuggestions}
                  fromSuggestionIndex={fromSuggestionIndex}
                  toSuggestionIndex={toSuggestionIndex}
                  fromSelectedColor={fromSelectedColor}
                  toSelectedColor={toSelectedColor}
                  fromInputRef={fromInputRef}
                  toInputRef={toInputRef}
                  onFromChange={handleFromChange}
                  onToChange={handleToChange}
                  onFromKeyDown={handleFromKeyDown}
                  onToKeyDown={handleToKeyDown}
                  onSelectFromSuggestion={handleSelectFromSuggestion}
                  onSelectToSuggestion={handleSelectToSuggestion}
                  onSwap={handleSwapStations}
                  onClearFrom={() => handleFromChange('')}
                  onClearTo={() => handleToChange('')}
                  isDesktop={isDesktop}
                />

                {routeAlternatives.length > 1 && !errorMessage && !isDesktop && (
                  <div className="bottom-route-summary-wrapper">
                    <div className="bottom-route-summary-scroll">
                      {routeAlternatives.map((route, index) => {
                        const isActive = index === activeRouteIndex
                        const label = getRouteVariantLabel(index, routeAlternatives)
                        return (
                          <button
                            key={index}
                            type="button"
                            className={`bottom-route-chip route-choice-chip${
                              isActive ? ' bottom-route-chip--active' : ''
                            }`}
                            tabIndex={0}
                            onClick={() => {
                              setActiveRouteIndex(index)
                              setRouteSheetOpenState(true)
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                setActiveRouteIndex(index)
                                setRouteSheetOpenState(true)
                              }
                            }}
                            aria-label={`Выбрать маршрут: ${label}, ~${route.totalMinutes} мин, пересадок ${route.transfersCount}`}
                          >
                            <div className="bottom-route-chip-main">
                              <span className="bottom-route-chip-time">⏱ {route.totalMinutes} мин</span>
                            </div>
                            <div className="bottom-route-chip-sub">
                              Пересадок: {route.transfersCount}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>

              <RouteDetailsSheet
                routeResult={routeResult}
                routeAlternatives={routeAlternatives}
                activeRouteIndex={activeRouteIndex}
                onChangeActiveRoute={setActiveRouteIndex}
                errorMessage={errorMessage}
                isDesktop={isDesktop}
                isRouteSheetOpen={isRouteSheetOpen}
                decoratedSegments={decoratedSegments}
                arrivalTimeLabel={routeArrivalTimeLabel}
                detailsRef={routeDetailsRef}
                isFavoriteRoute={isActiveRouteFavorite}
                onToggleFavoriteRoute={handleToggleFavoriteActiveRoute}
              />
            </div>
          </div>
        )}

        {EDITOR_ENABLED && (
          <>
            <button
              type="button"
              className={`editor-fab${effectiveEditMode ? ' editor-fab--active' : ''}`}
              onClick={() => setEditMode((prev: boolean) => !prev)}
              aria-label={
                effectiveEditMode ? 'Выключить режим редактора' : 'Включить режим редактора'
              }
            >
              ✎
            </button>

            {effectiveEditMode && (
              <div className="editor-tools-stack" aria-label="Инструменты редактора">
                <button
                  type="button"
                  className="editor-fab editor-fab--small editor-fab--secondary"
                  onClick={handleCreateManualStation}
                  aria-label="Создать новую станцию рядом с текущей"
                >
                  +
                </button>
                <button
                  type="button"
                  className={`editor-fab editor-fab--small${
                    collisionDebug ? ' editor-fab--active' : ''
                  }`}
                  onClick={() => setCollisionDebug((prev: boolean) => !prev)}
                  aria-label={
                    collisionDebug
                      ? 'Выключить отладку коллизий подписей'
                      : 'Включить отладку коллизий подписей'
                  }
                >
                  ⚡
                </button>
                <button
                  type="button"
                  className="editor-fab editor-fab--small editor-fab--secondary"
                  onClick={async () => {
                    try {
                      const layout = lastLayoutOverrides

                      const stations: Record<
                        string,
                        {
                          title?: string
                          lineNumericId?: number | null
                          hubId?: string | null
                          hidden?: boolean
                          manual?: boolean
                        }
                      > = {}

                      const applyStation = (s: FullGraphStation, manual: boolean) => {
                        const id = s.id
                        const baseTitle = s.title
                        const baseLine = s.lineNumericId ?? null
                        const baseHubId = s.hubId ?? null

                        const stOverride = stationOverrides[id]
                        const trimmedTitle = stOverride?.title?.trim()
                        const overrideLine =
                          stOverride && stOverride.lineNumericId !== undefined
                            ? stOverride.lineNumericId
                            : undefined

                        const stationHidden = !!hiddenStations[id]

                        const hubOverride = stationHubOverrides[id]
                        let effectiveHubId: string | null
                        if (hubOverride === null) effectiveHubId = null
                        else if (hubOverride !== undefined) effectiveHubId = hubOverride
                        else effectiveHubId = baseHubId

                        if (manual) {
                          const entry: {
                            title?: string
                            lineNumericId?: number | null
                            hubId?: string | null
                            hidden?: boolean
                            manual?: boolean
                          } = {}

                          entry.manual = true

                          entry.title =
                            trimmedTitle && trimmedTitle.length > 0
                              ? trimmedTitle
                              : baseTitle

                          entry.lineNumericId =
                            overrideLine !== undefined ? overrideLine : baseLine

                          entry.hubId = effectiveHubId

                          if (stationHidden) {
                            entry.hidden = true
                          }

                          stations[id] = entry
                          return
                        }

                        const entry: {
                          title?: string
                          lineNumericId?: number | null
                          hubId?: string | null
                          hidden?: boolean
                          manual?: boolean
                        } = {}

                        if (trimmedTitle && trimmedTitle !== baseTitle) {
                          entry.title = trimmedTitle
                        }

                        if (overrideLine !== undefined) {
                          if (overrideLine !== baseLine) {
                            entry.lineNumericId = overrideLine
                          }
                        }

                        if (effectiveHubId !== baseHubId) {
                          entry.hubId = effectiveHubId
                        }

                        if (stationHidden) {
                          entry.hidden = true
                        }

                        if (Object.keys(entry).length === 0) {
                          return
                        }

                        stations[id] = entry
                      }

                      for (const s of fullGraphStations) {
                        applyStation(s, false)
                      }
                      for (const s of Object.values(manualStations)) {
                        applyStation(s, true)
                      }

                      const lines: Record<
                        string,
                        {
                          stationIds?: string[]
                        }
                      > = {}

                      for (const line of fullGraphLines) {
                        const effective = effectiveLineStationIdsById.get(line.id)
                        if (!effective) continue
                        const baseIds = line.stationIds
                        if (
                          effective.length === baseIds.length &&
                          effective.every((sid, idx) => sid === baseIds[idx])
                        ) {
                          continue
                        }
                        lines[String(line.id)] = {
                          stationIds: effective,
                        }
                      }

                      const edges: Record<
                        string,
                        {
                          fromStationId?: string
                          toStationId?: string
                          lineNumericId?: number | null
                          medianTravelSeconds?: number
                          isTransfer?: boolean
                          disabled?: boolean
                          manual?: boolean
                        }
                      > = {}

                      const allBaseEdges: FullGraphEdge[] = [...fullGraphEdges]

                      for (const e of allBaseEdges) {
                        const key = edgeKey(e.fromStationId, e.toStationId)
                        const ov = edgeOverrides[key]
                        if (!ov) continue

                        const entry: {
                          medianTravelSeconds?: number
                          isTransfer?: boolean
                          disabled?: boolean
                        } = {}

                        if (ov.medianTravelSeconds !== undefined) {
                          if (ov.medianTravelSeconds !== e.medianTravelSeconds) {
                            entry.medianTravelSeconds = ov.medianTravelSeconds
                          }
                        }
                        if (ov.isTransfer !== undefined) {
                          if (ov.isTransfer !== !!e.isTransfer) {
                            entry.isTransfer = ov.isTransfer
                          }
                        }
                        if (ov.disabled !== undefined && ov.disabled) {
                          entry.disabled = true
                        }

                        if (Object.keys(entry).length === 0) continue

                        edges[key] = {
                          ...edges[key],
                          ...entry,
                        }
                      }

                      for (const e of Object.values(manualEdges)) {
                        const key = edgeKey(e.fromStationId, e.toStationId)
                        const existing = edges[key] || {}
                        edges[key] = {
                          ...existing,
                          fromStationId: e.fromStationId,
                          toStationId: e.toStationId,
                          lineNumericId: e.lineNumericId ?? null,
                          medianTravelSeconds: e.medianTravelSeconds,
                          isTransfer: !!e.isTransfer,
                          manual: true,
                        }
                      }

                      const hubs: Record<
                        string,
                        {
                          minTransferSeconds?: number
                          rotationDeg?: number
                        }
                      > = {}

                      for (const [hubId, seconds] of Object.entries(hubMinOverrides)) {
                        if (!Number.isFinite(seconds)) continue
                        hubs[hubId] = {
                          ...(hubs[hubId] || {}),
                          minTransferSeconds: seconds,
                        }
                      }

                      for (const [hubId, deg] of Object.entries(hubRotationOverrides)) {
                        if (!Number.isFinite(deg)) continue
                        hubs[hubId] = {
                          ...(hubs[hubId] || {}),
                          rotationDeg: deg,
                        }
                      }

                      const editorOverrides: EditorOverrides = {
                        layout,
                        stations,
                        lines,
                        edges,
                        hubs,
                      }

                      const json = JSON.stringify(editorOverrides, null, 2)
                      const ok = json ? await copyTextToClipboard(json) : false
                      if (ok) {
                        showEditorToast('editor_overrides.json скопирован')
                      } else {
                        showEditorToast('Не удалось скопировать editor_overrides.json')
                      }
                    } catch {
                      showEditorToast('Не удалось скопировать editor_overrides.json')
                      // ignore clipboard errors
                    }
                  }}
                  aria-label="Скопировать editor_overrides.json в буфер обмена"
                  title="Скопировать editor_overrides.json"
                >
                  OVR
                </button>
              </div>
            )}
          </>
        )}

        {EDITOR_ENABLED && editorToast && (
          <div className="editor-toast" role="status" aria-live="polite">
            {editorToast}
          </div>
        )}

        {showUpdateBanner && (
          <UpdateBanner onUpdate={handleUpdateBannerClick} onLater={handleUpdateBannerLater} />
        )}

        {shouldShowInstallGuide && (
          <div className="install-guide-backdrop" onClick={handleInstallGuideBackdropClick}>
            <InstallGuideCard
              platform={installGuidePlatform as 'ios' | 'android' | 'desktop' | 'unknown'}
              onClose={handleCloseInstallGuide}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export default App
