import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent, TouchEvent } from 'react'
import './App.css'
import './theme.css'
import helloKittyIcon from './assets/kitty-metro-logo.svg'
import { InstallGuideCard } from './components/InstallGuideCard'
import { UpdateBanner } from './components/UpdateBanner'
import { SplashScreen } from './components/SplashScreen'
import { RouteForm } from './components/RouteForm'
import { RouteDetailsSheet } from './components/RouteDetailsSheet'
import type { DecoratedSegment } from './components/RouteDetailsSheet'
import { RouteHeader } from './components/RouteHeader'
import { HubEditorPanel } from './components/HubEditorPanel'
import {
  fullGraphLines,
  fullGraphStations,
  fullGraphEdges,
  fullGraphTransferHubs,
} from './metro/fullGraph'
import { findRouteAlternativesFullGraph } from './metro/routing'
import type {
  RouteResult,
  FullGraphExport,
  FullGraphEdge,
  EdgeOverride,
  FullGraphStation,
  EditorOverrides,
} from './metro/types'
import { MetroMap } from './components/MetroMap'
import { useRegisterSW } from 'virtual:pwa-register/react'

const EDITOR_ENABLED = import.meta.env.DEV

type NavigatorWithStandalone = Navigator & { standalone?: boolean }

type StationOverride = {
  title?: string
  lineNumericId?: number | null
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
  const pendingLayoutOverridesRef = useRef<
    Record<string, { x: number; y: number }> | null
  >(null)
  const [isDesktop, setIsDesktop] = useState(false)
  const [isSplashDone, setIsSplashDone] = useState(false)
  const [isSplashMounted, setIsSplashMounted] = useState(true)
  const [fromSuggestionIndex, setFromSuggestionIndex] = useState(-1)
  const [toSuggestionIndex, setToSuggestionIndex] = useState(-1)
  const [viewportHeight, setViewportHeight] = useState<number | null>(null)
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
  const bottomSheetRef = useRef<HTMLDivElement | null>(null)
  const savedRouteCounterRef = useRef(1)
  const [hubRotateCommand, setHubRotateCommand] = useState<
    { hubId: string; direction: 'cw' | 'ccw'; token: number } | null
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
    setEditorHistory((prev) => {
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
    setLastLayoutOverrides(snapshot.lastLayoutOverrides)
    setHubRotationOverrides(snapshot.hubRotationOverrides)
  }, [])

  const handleEditorUndo = useCallback(() => {
    setEditorHistory((prev) => {
      if (prev.index <= 0) return prev
      const nextIndex = prev.index - 1
      const snapshot = prev.items[nextIndex]
      applyEditorSnapshot(snapshot)
      return { ...prev, index: nextIndex }
    })
  }, [applyEditorSnapshot])

  const handleEditorRedo = useCallback(() => {
    setEditorHistory((prev) => {
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
    let timeoutId: number | null = null

    const flush = () => {
      timeoutId = null
      const pending = pendingLayoutOverridesRef.current
      if (!pending) return
      pendingLayoutOverridesRef.current = null
      setLastLayoutOverrides((prev) => {
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
      const isEditableElement =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          (target as HTMLElement).isContentEditable)
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

  const persistRoutesToStorage = (key: string, routes: SavedRoute[]) => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(key, JSON.stringify(routes))
    } catch {
      // ignore
    }
  }

  const handleClearRecentRoutes = () => {
    setRecentRoutes([])
    persistRoutesToStorage(RECENTS_STORAGE_KEY, [])
  }

  const handleToggleEdgeTransfer = useCallback(
    (edge: FullGraphEdge) => {
      setEdgeOverrides((prev) => {
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
  const hiddenStationIdSet = useMemo(() => new Set(Object.keys(hiddenStations)), [hiddenStations])

  const handleToggleStationHidden = useCallback((stationId: string) => {
    setHiddenStations((prev) => {
      if (prev[stationId]) {
        const next = { ...prev }
        delete next[stationId]
        return next
      }
      return { ...prev, [stationId]: true }
    })
  }, [])
  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    onRegistered(swRegistration: ServiceWorkerRegistration | undefined) {
      console.log('SW registered', swRegistration)
    },
    onRegisterError(error: unknown) {
      console.log('SW registration error', error)
    },
  })
  const fromInputRef = useRef<HTMLInputElement | null>(null)
  const toInputRef = useRef<HTMLInputElement | null>(null)
  const sheetTouchStartYRef = useRef<number | null>(null)
  const sheetTouchLastYRef = useRef<number | null>(null)
  const sheetDragStartProgressRef = useRef<number | null>(null)

  const updateSheetTransformDom = useCallback(
    (progress: number) => {
      const el = bottomSheetRef.current
      if (!el) return
      if (isDesktop) return

      const clamped = Math.max(0, Math.min(1, progress))
      sheetProgressRef.current = clamped

      // 0 — шторка полностью свернута (у нижнего края), 1 — полностью раскрыта.
      // Двигаем её по translateY в пределах небольшого диапазона, чтобы сохранить
      // связь с пальцем, но не делать гигантский сдвиг.
      const maxOffsetPx = 260
      const translateY = (1 - clamped) * maxOffsetPx

      el.style.transform = `translateY(${translateY}px)`
      el.style.opacity = clamped > 0 ? '1' : '0'
    },
    [isDesktop],
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
    if (!needRefresh) {
      return
    }

    updateServiceWorker(true)
  }, [needRefresh, updateServiceWorker])

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
    if (typeof window === 'undefined') {
      return
    }

    const updateHeight = () => {
      const vv = window.visualViewport
      if (vv && typeof vv.height === 'number') {
        setViewportHeight(vv.height)
      } else {
        setViewportHeight(window.innerHeight)
      }
    }

    updateHeight()
    window.addEventListener('resize', updateHeight)
    const vv = window.visualViewport
    vv?.addEventListener('resize', updateHeight)

    return () => {
      window.removeEventListener('resize', updateHeight)
      vv?.removeEventListener('resize', updateHeight)
    }
  }, [])

  useEffect(() => {
    const updateInsets = () => {
      if (typeof window === 'undefined') return
      const vv = window.visualViewport
      const viewportWidth = vv?.width ?? window.innerWidth
      const viewportHeightLocal = vv?.height ?? window.innerHeight

      let top = 0
      let left = 0
      let right = 0

      const headerEl = document.querySelector<HTMLElement>('.app-header')
      if (headerEl) {
        const r = headerEl.getBoundingClientRect()
        if (r.bottom > top) {
          top = Math.min(r.bottom, viewportHeightLocal)
        }
      }

      const hubPanelEl = document.querySelector<HTMLElement>('.hub-editor-panel')
      if (hubPanelEl) {
        const r = hubPanelEl.getBoundingClientRect()
        if (r.right > left) {
          left = Math.min(r.right, viewportWidth)
        }
      }

      const zoomControlsEl = document.querySelector<HTMLElement>('.metro-map-zoom-controls')
      if (zoomControlsEl && isDesktop) {
        const r = zoomControlsEl.getBoundingClientRect()
        const inset = Math.max(0, viewportWidth - r.left)
        if (inset > right) {
          right = inset
        }
      }

      setMapVisibleInsets((prev) => ({ top, right, bottom: prev.bottom, left }))
    }

    updateInsets()
    window.addEventListener('resize', updateInsets)
    const vv = window.visualViewport
    vv?.addEventListener('resize', updateInsets)

    return () => {
      window.removeEventListener('resize', updateInsets)
      vv?.removeEventListener('resize', updateInsets)
    }
  }, [
    editMode,
    isDesktop,
    errorMessage,
    inspectedStationId,
    routeAlternatives.length,
    isRouteSheetOpen,
  ])

  // Вертикальные инсетЫ (header + шторка) для автофита маршрута теперь считаются
  // непосредственно внутри MetroMap по DOM, поэтому в App мы управляем только
  // верхним/левым/правым инсетами через mapVisibleInsets.

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!EDITOR_ENABLED) return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      const isInputLike =
        tag === 'INPUT' || tag === 'TEXTAREA' || (target && target.isContentEditable)
      if (isInputLike) return

      if ((event.key === 'e' || event.key === 'E') && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        setEditMode((prev) => !prev)
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
        setCollisionDebug((prev) => !prev)
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
      return
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
  const showUpdateBanner = isSplashDone && isMapReady && !shouldShowInstallGuide && needRefresh

  const handleInstallGuideBackdropClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return
    }

    handleCloseInstallGuide()
  }

  const handleUpdateBannerClick = () => {
    updateServiceWorker(true)
  }

  const setRouteSheetOpenState = (open: boolean) => {
    setIsRouteSheetOpen(open)
    if (!open) {
      setIsSmartSuggestionsOpen(false)
    }
    if (!isDesktop) {
      const target = open ? 1 : 0
      updateSheetTransformDom(target)
    }
  }

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

  const clearRoutes = () => {
    setRouteAlternatives([])
    setActiveRouteIndex(0)
  }

  const buildRoute = (fromName: string, toName: string) => {
    setErrorMessage(null)
    clearRoutes()
    setRouteSheetOpenState(false)

    const fromMatch = findExactStationByName(fromName)
    const toMatch = findExactStationByName(toName)

    if (!fromMatch || !toMatch) {
      setErrorMessage('Не удалось найти одну из станций. Выбери её из списка подсказок.')
      return
    }

    if (fromMatch.id === toMatch.id) {
      setErrorMessage('Начальная и конечная станции не могут совпадать. Выбери другую станцию.')
      return
    }

    setFromStationId(fromMatch.id)
    setToStationId(toMatch.id)

    const routes = findRouteAlternativesFullGraph(fromMatch.id, toMatch.id, {
      maxAlternatives: 6,
      edgeOverrides,
      extraEdges: Object.values(manualEdges),
    })
    if (routes.length === 0) {
      setErrorMessage('Маршрут между этими станциями не найден.')
      return
    }

    const fromTitleEffective = stationTitleById.get(fromMatch.id) ?? fromMatch.title
    const toTitleEffective = stationTitleById.get(toMatch.id) ?? toMatch.title

    setRecentRoutes((prev) => {
      const filtered = prev.filter(
        (item) =>
          !(item.fromStationId === fromMatch.id && item.toStationId === toMatch.id),
      )
      const next: SavedRoute[] = [
        {
          fromStationId: fromMatch.id,
          toStationId: toMatch.id,
          fromTitle: fromTitleEffective,
          toTitle: toTitleEffective,
          lastUsedAt: savedRouteCounterRef.current++,
        },
        ...filtered,
      ].slice(0, 5)

      persistRoutesToStorage(RECENTS_STORAGE_KEY, next)
      return next
    })

    setRouteAlternatives(routes)
    setActiveRouteIndex(0)
    // На мобиле шторка остаётся свернутой, на десктопе подробности всегда открываем
    if (routes.length === 1 || isDesktop) {
      setRouteSheetOpenState(true)
    }
  }

  const fromSuggestions = useMemo(() => {
    const q = fromStation.trim().toLowerCase()
    if (!q || fromFixed) return []
    const result: FullGraphStation[] = []
    for (const s of allStations) {
      const ov = stationOverrides[s.id]
      const title = ov?.title?.trim() || s.title
      if (title.toLowerCase().includes(q)) {
        result.push(s)
        if (result.length >= 6) break
      }
    }
    return result
  }, [fromStation, fromFixed, allStations, stationOverrides])

  const toSuggestions = useMemo(() => {
    const q = toStation.trim().toLowerCase()
    if (!q || toFixed) return []
    const result: FullGraphStation[] = []
    for (const s of allStations) {
      const ov = stationOverrides[s.id]
      const title = ov?.title?.trim() || s.title
      if (title.toLowerCase().includes(q)) {
        result.push(s)
        if (result.length >= 6) break
      }
    }
    return result
  }, [toStation, toFixed, allStations, stationOverrides])

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

    setFavoriteRoutes((prev) => {
      const exists = prev.some(
        (item) => item.fromStationId === fromId && item.toStationId === toId,
      )
      let next: SavedRoute[]
      if (exists) {
        next = prev.filter(
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
          ...prev,
        ].slice(0, 20)
      }

      persistRoutesToStorage(FAVORITES_STORAGE_KEY, next)
      return next
    })
  }

  const routeStationIds = useMemo(() => {
    if (!routeResult) return []

    const ids: string[] = []
    for (const step of routeResult.steps) {
      if (ids.length === 0) {
        ids.push(step.fromStationId)
      }
      ids.push(step.toStationId)
    }

    return Array.from(new Set(ids))
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
    buildRoute(saved.fromTitle, saved.toTitle)
  }

  const handleApplyNearbyStationAsFrom = (station: FullGraphStation) => {
    const override = stationOverrides[station.id]
    const title = override?.title?.trim() || station.title
    const toMatch = findExactStationByName(toStation)

    setFromStation(title)
    setFromFixed(true)
    setFromStationId(station.id)
    setErrorMessage(null)

    if (toMatch && toMatch.id !== station.id) {
      buildRoute(title, toStation)
    } else {
      clearRoutes()
      setRouteSheetOpenState(false)
    }
  }

  const handleRequestNearbyStations = useCallback(() => {
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
        const withCoords = allStations.filter(
          (s) => typeof s.lat === 'number' && typeof s.lon === 'number',
        )
        if (withCoords.length === 0) {
          setNearbyStatus('error')
          setNearbyError('Нет станций с координатами.')
          return
        }

        const R = 6371000
        const toRad = (deg: number) => (deg * Math.PI) / 180

        const scored = withCoords.map((s) => {
          const lat1 = toRad(latitude)
          const lon1 = toRad(longitude)
          const lat2 = toRad(s.lat as number)
          const lon2 = toRad(s.lon as number)
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
      () => {
        setNearbyStatus('error')
        setNearbyError('Не удалось получить местоположение.')
      },
      {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 60000,
      },
    )
  }, [allStations])

  useEffect(() => {
    if (typeof window === 'undefined') return

    let shouldAutoRequest = false
    try {
      shouldAutoRequest = window.localStorage.getItem('kitty-metro-nearby-allowed') === '1'
    } catch {
      shouldAutoRequest = false
    }

    if (!shouldAutoRequest) return

    handleRequestNearbyStations()
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

  const handleSelectFromSuggestion = (name: string) => {
    const match = findExactStationByName(name)
    const toMatch = findExactStationByName(toStation)
    if (match && toMatch && match.id === toMatch.id) {
      return
    }

    setFromStation(name)
    setFromFixed(true)
    setFromStationId(match?.id ?? null)
    setFromSuggestionIndex(-1)

    // Если уже есть валидное "Куда" — сразу считаем маршрут
    if (match && toMatch) {
      buildRoute(name, toStation)
    }
  }

  const handleSheetTouchStart = (event: TouchEvent) => {
    if (!routeResult || errorMessage) return
    if (isDesktop) return
    if (event.touches.length === 0) return
    const touch = event.touches[0]
    sheetTouchStartYRef.current = touch.clientY
    sheetTouchLastYRef.current = touch.clientY
    sheetDragStartProgressRef.current = sheetProgressRef.current
  }

  const handleSheetTouchMove = (event: TouchEvent) => {
    if (sheetTouchStartYRef.current == null) return
    if (event.touches.length === 0) return
    const touch = event.touches[0]
    sheetTouchLastYRef.current = touch.clientY
    const startY = sheetTouchStartYRef.current
    const dragRange = viewportHeight ? viewportHeight * 0.4 : 280
    if (!dragRange) return
    const startProgress =
      sheetDragStartProgressRef.current != null
        ? sheetDragStartProgressRef.current
        : isRouteSheetOpen
          ? 1
          : 0
    const deltaY = touch.clientY - startY
    const nextProgress = Math.max(0, Math.min(1, startProgress - deltaY / dragRange))
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
    const startY = sheetTouchStartYRef.current
    const lastY = sheetTouchLastYRef.current
    sheetTouchStartYRef.current = null
    sheetTouchLastYRef.current = null

    // Очищаем отложенный кадр анимации drag'а, чтобы не было лишних
    // setState уже после завершения жеста.
    if (sheetAnimFrameRef.current != null) {
      window.cancelAnimationFrame(sheetAnimFrameRef.current)
      sheetAnimFrameRef.current = null
    }
    sheetAnimTargetRef.current = null

    if (startY == null || lastY == null) return

    const delta = lastY - startY
    const threshold = 40

    if (delta < -threshold) {
      setRouteSheetOpenState(true)
      return
    }

    if (delta > threshold) {
      setRouteSheetOpenState(false)
      return
    }

    setRouteSheetOpenState(delta <= 0)
  }

  const handleSelectToSuggestion = (name: string) => {
    const match = findExactStationByName(name)
    const fromMatch = findExactStationByName(fromStation)
    if (match && fromMatch && match.id === fromMatch.id) {
      return
    }

    setToStation(name)
    setToFixed(true)
    setToStationId(match?.id ?? null)
    setToSuggestionIndex(-1)

    if (fromMatch && match) {
      buildRoute(fromStation, name)
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

    const fromIsValid = !!findExactStationByName(nextFrom)
    const toIsValid = !!findExactStationByName(nextTo)
    setFromFixed(fromIsValid)
    setToFixed(toIsValid)

    setErrorMessage(null)

    if (fromIsValid && toIsValid) {
      buildRoute(nextFrom, nextTo)
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
    }

    const fromMatch = findExactStationByName(nextFromName)
    const fromIsValid = !!fromMatch
    if (fromIsValid) {
      setFromStationId(fromMatch!.id)
    } else {
      setFromStationId(null)
    }
    const toMatch = findExactStationByName(toStation)
    const toIsValid = !!toMatch
    if (!toIsValid) {
      setToStationId(null)
    }

    if (fromIsValid && toIsValid) {
      buildRoute(nextFromName, toStation)
      return
    }

    if (fromIsValid) {
      toInputRef.current?.focus()
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
    }

    const fromMatch2 = findExactStationByName(fromStation)
    const toMatch2 = findExactStationByName(nextToName)
    const fromIsValid = !!fromMatch2
    const toIsValid = !!toMatch2

    if (fromIsValid) {
      setFromStationId(fromMatch2!.id)
    } else {
      setFromStationId(null)
    }
    if (toIsValid) {
      setToStationId(toMatch2!.id)
    } else {
      setToStationId(null)
    }

    if (fromIsValid && toIsValid) {
      buildRoute(fromStation, nextToName)
      return
    }

    if (toIsValid && !fromStation.trim()) {
      fromInputRef.current?.focus()
    }
  }

  const handleMapSelect = (id: string, name: string) => {
    const hasFrom = !!fromStation.trim()
    const hasTo = !!toStation.trim()

    // Первая выбранная станция — всегда "Откуда"
    if (!hasFrom) {
      setFromStation(name)
      setFromFixed(true)
      setFromStationId(id)
      clearRoutes()
      setErrorMessage(null)
      setRouteSheetOpenState(false)
      return
    }

    // Вторая — "Куда" и сразу строим маршрут
    if (!hasTo) {
      const fromMatch = findExactStationByName(fromStation)
      if (fromMatch && fromMatch.id === id) {
        clearRoutes()
        setRouteSheetOpenState(false)
        return
      }

      setToStation(name)
      setToFixed(true)
      setToStationId(id)
      buildRoute(fromStation, name)
      return
    }

    // Третье и последующие нажатия: сброс и начало с новой "Откуда"
    setFromStation(name)
    setFromFixed(true)
    setFromStationId(id)
    setToStation('')
    setToFixed(false)
    setToStationId(null)
    clearRoutes()
    setErrorMessage(null)
    setRouteSheetOpenState(false)
  }

  const currentSelectionMode: 'from' | 'to' =
    !findExactStationByName(fromStation) || (!findExactStationByName(toStation) && fromFixed)
      ? 'from'
      : !findExactStationByName(toStation)
          ? 'to'
          : 'from'
  const isSplashActive = isSplashMounted

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
    if (!routeResult || isDesktop) return
    updateSheetTransformDom(sheetProgressRef.current)
  }, [routeResult, isDesktop, updateSheetTransformDom])

  return (
    <div className={`app-root${isSplashActive ? ' app-root--splash-active' : ''}`}>
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
          collisionDebug={EDITOR_ENABLED && collisionDebug}
          onMapInteraction={() => {
            if (!isDesktop && routeResult && !errorMessage) {
              setRouteSheetOpenState(false)
            }
          }}
          onEditStationInspect={handleInspectStation}
          stationHubOverrides={stationHubOverrides}
          hiddenStationIds={hiddenStationIdSet}
          visibleInsets={mapVisibleInsets}
          stationTitleOverrides={stationTitleOverridesForMap}
          extraStations={Object.values(manualStations)}
          hubRotateCommand={hubRotateCommand}
          onEditSelectionChange={setEditorSelectedStationIds}
          onInitialViewportReady={handleInitialViewportReady}
          routeSheetOpen={isRouteSheetOpen}
        />
      </div>

      <div className="app-overlay">
        {!effectiveEditMode && !isSplashActive && (
          <>
            <RouteHeader
              logoSrc={helloKittyIcon}
              logoAlt="Hello Kitty"
              headerTitle={headerTitle}
              headerChipClassName={headerChipClassName}
              onChipClick={() => {
                setRouteSheetOpenState(true)
                if (!trimmedFrom) {
                  fromInputRef.current?.focus()
                } else if (!trimmedTo) {
                  toInputRef.current?.focus()
                } else if (!isDesktop) {
                  toInputRef.current?.focus()
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

        {effectiveEditMode && inspectedStation && (
          <HubEditorPanel
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
            onRotateHubGeometry={handleRotateHubGeometry}
          />
        )}

        {!effectiveEditMode && !isSplashActive && (
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
            >
              {routeResult && !errorMessage && !isDesktop && (
                <button
                  type="button"
                  className="bottom-sheet-handle"
                  aria-label="Потянуть, чтобы раскрыть или свернуть детали маршрута"
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
              />

              <RouteDetailsSheet
                routeResult={routeResult}
                routeAlternatives={routeAlternatives}
                activeRouteIndex={activeRouteIndex}
                onChangeActiveRoute={setActiveRouteIndex}
                onOpenRouteSheet={() => setRouteSheetOpenState(true)}
                errorMessage={errorMessage}
                isDesktop={isDesktop}
                isRouteSheetOpen={isRouteSheetOpen}
                decoratedSegments={decoratedSegments}
                getRouteVariantLabel={getRouteVariantLabel}
                arrivalTimeLabel={routeArrivalTimeLabel}
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
              onClick={() => setEditMode((prev) => !prev)}
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
                  onClick={() => setCollisionDebug((prev) => !prev)}
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
                      const json = JSON.stringify(lastLayoutOverrides, null, 2)
                      if (navigator.clipboard && json) {
                        await navigator.clipboard.writeText(json)
                      }
                    } catch {
                      // ignore clipboard errors
                    }
                  }}
                  aria-label="Скопировать layout_overrides.json в буфер обмена"
                >
                  xy
                </button>
                <button
                  type="button"
                  className="editor-fab editor-fab--small editor-fab--secondary"
                  onClick={async () => {
                    try {
                      const snapshot: FullGraphExport = {
                        lines: fullGraphLines.map((line) => ({
                          ...line,
                          stationIds:
                            effectiveLineStationIdsById.get(line.id) ?? line.stationIds,
                        })),
                        stations: (() => {
                          const result: FullGraphStation[] = []

                          for (const s of fullGraphStations) {
                            if (hiddenStations[s.id]) continue

                            const hubOverride = stationHubOverrides[s.id]
                            const baseHubId = s.hubId ?? null
                            let next: FullGraphStation = s
                            if (hubOverride === null) {
                              next = { ...next, hubId: undefined }
                            } else if (hubOverride !== undefined && hubOverride !== baseHubId) {
                              next = { ...next, hubId: hubOverride }
                            }

                            const stOverride = stationOverrides[s.id]
                            if (stOverride) {
                              const trimmedTitle = stOverride.title?.trim()
                              if (trimmedTitle && trimmedTitle !== s.title) {
                                next = { ...next, title: trimmedTitle }
                              }
                              if (
                                stOverride.lineNumericId !== undefined &&
                                stOverride.lineNumericId !== s.lineNumericId
                              ) {
                                next = { ...next, lineNumericId: stOverride.lineNumericId }
                              }
                            }

                            const pos = lastLayoutOverrides[s.id]
                            if (pos) {
                              next = {
                                ...next,
                                layoutX: pos.x,
                                layoutY: pos.y,
                              }
                            }

                            result.push(next)
                          }

                          for (const s of Object.values(manualStations)) {
                            if (hiddenStations[s.id]) continue

                            const hubOverride = stationHubOverrides[s.id]
                            const baseHubId = s.hubId ?? null
                            let next: FullGraphStation = s
                            if (hubOverride === null) {
                              next = { ...next, hubId: undefined }
                            } else if (hubOverride !== undefined && hubOverride !== baseHubId) {
                              next = { ...next, hubId: hubOverride }
                            }

                            const stOverride = stationOverrides[s.id]
                            if (stOverride) {
                              const trimmedTitle = stOverride.title?.trim()
                              if (trimmedTitle && trimmedTitle !== s.title) {
                                next = { ...next, title: trimmedTitle }
                              }
                              if (
                                stOverride.lineNumericId !== undefined &&
                                stOverride.lineNumericId !== s.lineNumericId
                              ) {
                                next = { ...next, lineNumericId: stOverride.lineNumericId }
                              }
                            }

                            const pos = lastLayoutOverrides[s.id]
                            if (pos) {
                              next = {
                                ...next,
                                layoutX: pos.x,
                                layoutY: pos.y,
                              }
                            }

                            result.push(next)
                          }

                          return result
                        })(),
                        edges: (() => {
                          const allEdges: FullGraphEdge[] = [
                            ...Object.values(manualEdges),
                            ...fullGraphEdges,
                          ]

                          const result: FullGraphEdge[] = []
                          const seen = new Set<string>()

                          for (const e of allEdges) {
                            if (hiddenStations[e.fromStationId] || hiddenStations[e.toStationId])
                              continue

                            const key = edgeKey(e.fromStationId, e.toStationId)
                            if (seen.has(key)) continue
                            seen.add(key)

                            const override = edgeOverrides[key]
                            if (override?.disabled) continue

                            let next = e
                            if (
                              override &&
                              override.isTransfer !== undefined &&
                              override.isTransfer !== e.isTransfer
                            ) {
                              next = { ...next, isTransfer: override.isTransfer }
                            }
                            if (
                              override &&
                              override.medianTravelSeconds !== undefined &&
                              override.medianTravelSeconds !== e.medianTravelSeconds
                            ) {
                              next = { ...next, medianTravelSeconds: override.medianTravelSeconds }
                            }

                            result.push(next)
                          }

                          return result
                        })(),
                        transferHubs: (() => {
                          const hubMeta = new Map<
                            string,
                            {
                              minTransferSeconds: number
                              source: (typeof fullGraphTransferHubs)[number]['source']
                              rotationDeg?: number
                            }
                          >()
                          for (const hub of fullGraphTransferHubs) {
                            hubMeta.set(hub.id, {
                              minTransferSeconds: hub.minTransferSeconds,
                              source: hub.source,
                              rotationDeg: hub.rotationDeg,
                            })
                          }

                          const hubToStationIds = new Map<string, string[]>()

                          const pushStationToHub = (st: FullGraphStation) => {
                            if (hiddenStations[st.id]) {
                              return
                            }
                            const override = stationHubOverrides[st.id]
                            let hubId: string | null
                            if (override === null) hubId = null
                            else if (override !== undefined) hubId = override
                            else hubId = st.hubId ?? null
                            if (!hubId) return
                            let list = hubToStationIds.get(hubId)
                            if (!list) {
                              list = []
                              hubToStationIds.set(hubId, list)
                            }
                            list.push(st.id)
                          }

                          for (const st of fullGraphStations) {
                            pushStationToHub(st)
                          }
                          for (const st of Object.values(manualStations)) {
                            pushStationToHub(st)
                          }

                          const result: typeof fullGraphTransferHubs = []
                          for (const [hubId, stationIds] of hubToStationIds.entries()) {
                            const meta = hubMeta.get(hubId)
                            const baseMinSeconds = meta?.minTransferSeconds ?? 180
                            const overrideMinSeconds = hubMinOverrides[hubId]
                            const minTransferSeconds = overrideMinSeconds ?? baseMinSeconds
                            const baseRotationDeg = meta?.rotationDeg
                            const overrideRotationDeg = hubRotationOverrides[hubId]
                            const rotationDeg =
                              overrideRotationDeg !== undefined
                                ? overrideRotationDeg
                                : baseRotationDeg
                            result.push({
                              id: hubId,
                              stationIds,
                              minTransferSeconds,
                              source: (meta?.source ?? 'manual_override') as (typeof fullGraphTransferHubs)[number]['source'],
                              ...(rotationDeg !== undefined ? { rotationDeg } : {}),
                            })
                          }
                          return result
                        })(),
                      }

                      const json = JSON.stringify(snapshot, null, 2)
                      if (navigator.clipboard && json) {
                        await navigator.clipboard.writeText(json)
                      }
                    } catch {
                      // ignore clipboard errors
                    }
                  }}
                  aria-label="Скопировать fullGraph.json в буфер обмена"
                >
                  ⧉
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
                      if (navigator.clipboard && json) {
                        await navigator.clipboard.writeText(json)
                      }
                    } catch {
                      // ignore clipboard errors
                    }
                  }}
                  aria-label="Скопировать editor_overrides.json в буфер обмена"
                >
                  OVR
                </button>
              </div>
            )}
          </>
        )}

        {showUpdateBanner && <UpdateBanner onClick={handleUpdateBannerClick} />}

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
