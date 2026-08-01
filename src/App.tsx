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
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
  TouchEvent,
} from 'react'
import './App.css'
import './theme.css'
import appLogo from './assets/metro-logo.svg'
import { InstallGuideCard } from './components/InstallGuideCard.tsx'
import { UpdateBanner } from './components/UpdateBanner.tsx'
import { SplashScreen } from './components/SplashScreen.tsx'
import { RouteForm } from './components/RouteForm.tsx'
import type { RouteSuggestionItem } from './components/RouteForm.tsx'
import { RouteDetailsSheet } from './components/RouteDetailsSheet.tsx'
import type { DecoratedSegment } from './components/RouteDetailsSheet.tsx'
import { RouteHeader } from './components/RouteHeader.tsx'
import { RouteLinePills } from './components/RouteLinePills.tsx'
import { IconClock, IconClose, IconHistory, IconPin, IconStar } from './components/icons.tsx'
import { fullGraphLines } from './metro/fullGraph.ts'
import type { RouteResult, FullGraphStation } from './metro/types.ts'
import { MetroMap } from './components/MetroMap.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { ThemeToggle } from './components/ThemeToggle.tsx'
import { ThemeStationHint } from './components/ThemeStationHint.tsx'
import type { StationHint, StationHintKind } from './components/ThemeStationHint.tsx'
import { ThemeErrorLogPanel } from './components/ThemeErrorLogPanel.tsx'
import { copyTextToClipboard } from './utils/clipboard.ts'
import { normalizeStationText, rankStationCandidates } from './utils/stationSearch.ts'
import type { StationSearchCandidate } from './utils/stationSearch.ts'
import {
  formatTransfersCount,
  formatTransfersForAria,
  formatVariantsCount,
  pluralRu,
} from './utils/plural.ts'
import { startMinuteTicker } from './utils/minuteTicker.ts'
import { readErrorLog, subscribeErrorLog } from './utils/errorLog.ts'
import type { ErrorLogEntry } from './utils/errorLog.ts'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { useEditorController } from './editor/useEditorController.ts'
import { useNoopEditorController } from './editor/noopEditorController.ts'

const EDITOR_ENABLED = import.meta.env.DEV || import.meta.env.MODE === 'editor'

// Выбор реализации редактора делается один раз на модуль, а не на рендер:
// при EDITOR_ENABLED === false Rollup сворачивает тернарник, ссылка на
// useEditorController пропадает, и весь модуль редактора вылетает из бандла.
// Хук при этом вызывается безусловно — правило хуков не нарушено.
const useEditor = EDITOR_ENABLED ? useEditorController : useNoopEditorController

// Максимальное время ожидания готовности карты, после которого UI показывается принудительно.
const MAP_READY_FALLBACK_MS = 3500

/** Признак того, что ожидающее обновление уже применялось в этой вкладке — защита от петли перезагрузок. */
const SW_COLD_START_APPLIED_KEY = 'kitty-metro-sw-cold-start-applied'

// Минимальная длительность заставки. Держим её короткой: заставка — это «привет»,
// а не загрузочный экран, реальную готовность карты сторожит MAP_READY_FALLBACK_MS.
const SPLASH_MIN_DURATION_MS = 1200

// Сколько ждём ответ воркера, прежде чем признать расчёт провалившимся.
// Воркер может не ответить вовсе (упал, не создался, зажевал память) — без этого
// таймаута индикатор загрузки висел бы вечно.
const ROUTE_REQUEST_TIMEOUT_MS = 9000

// Первый запрос — особый случай: воркер отвечает только после загрузки графа
// (отдельный ассет, ~сотни килобайт), и на медленной сети или холодном старте
// PWA девяти секунд не хватает. Считать таймаут от готовности графа нельзя —
// воркер о ней не сообщает, — поэтому первому запросу даём отдельный бюджет и
// отдельный текст ошибки: «данные ещё грузятся» вместо «расчёт завис».
const ROUTE_FIRST_REQUEST_TIMEOUT_MS = 30000

// Обычный расчёт укладывается в единицы миллисекунд, и если показывать индикатор
// сразу, пользователь видит не «загрузку», а мигание скелетона на каждый запрос.
// Поэтому индикатор появляется, только если расчёт реально затянулся...
const ROUTE_LOADING_SHOW_DELAY_MS = 220
// ...а появившись — держится минимум столько, чтобы не мигнуть и не исчезнуть.
const ROUTE_LOADING_MIN_VISIBLE_MS = 420

const ONBOARDING_HINT_STORAGE_KEY = 'kitty-metro-onboarding-hint-seen'

// Сколько подсказок показываем. Лимит применяется ПОСЛЕ ранжирования, поэтому
// его можно держать выше прежних шести: нужная станция уже наверху списка.
const SUGGESTIONS_LIMIT = 8

// Человек уже строил маршрут хотя бы раз. Карточка установки читает этот флаг
// на старте: до первого маршрута предлагать установку нечего (см. UX-9).
const INSTALL_GUIDE_EARNED_KEY = 'kitty-metro-install-guide-earned'

// --- Тап по станции ---------------------------------------------------------
// Первый тап ставит «Откуда», второй — «Куда» (стандарт Яндекс.Метро и Google
// Maps), а прежний поповер с явным выбором поля остаётся на долгом нажатии.
// MetroMap сообщает о выборе только на touchend/click и не отдаёт длительность
// нажатия, поэтому App сам засекает pointerdown на документе — см.
// pointerDownRef и handleMapSelect.
const LONG_PRESS_MS = 480
// Палец всегда немного «плывёт»: сдвиг больше этого — уже не долгое нажатие.
const LONG_PRESS_MAX_MOVE_PX = 14
// Сколько держится подсказка «станция назначена в поле».
const STATION_HINT_DURATION_MS = 2200

// Оверлей редактора грузится динамически и только в dev/editor-сборке:
// в проде тернарник сворачивается в null и import() исчезает вместе с чанком.
const EditorOverlayLazy = EDITOR_ENABLED
  ? lazy(() => import('./editor/EditorOverlay.tsx').then((m) => ({ default: m.EditorOverlay })))
  : null

type NavigatorWithStandalone = Navigator & { standalone?: boolean }

type SavedRoute = {
  fromStationId: string
  toStationId: string
  fromTitle: string
  toTitle: string
  lastUsedAt: number
}

/**
 * Проверка одной записи из localStorage.
 *
 * Проверять только `Array.isArray` недостаточно: одна битая запись внутри
 * массива (например `[null]`) роняла приложение при КАЖДОМ построении маршрута,
 * а экран ошибки localStorage сознательно не чистит — получался вечный цикл
 * падений, из которого нельзя выйти изнутри приложения. Поэтому валидируем
 * каждый элемент и молча выбрасываем мусор.
 */
function isSavedRoute(value: unknown): value is SavedRoute {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.fromStationId === 'string' &&
    typeof v.toStationId === 'string' &&
    typeof v.fromTitle === 'string' &&
    typeof v.toTitle === 'string' &&
    typeof v.lastUsedAt === 'number' &&
    Number.isFinite(v.lastUsedAt)
  )
}

const FAVORITES_STORAGE_KEY = 'kitty-metro-favorites-v1'
const RECENTS_STORAGE_KEY = 'kitty-metro-recents-v1'

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

// --- Deep links -------------------------------------------------------------
// ID станций выглядят как `mos-1-1.148` и содержат точки и дефисы, поэтому
// в ссылку они всегда попадают через encodeURIComponent, а читаются через
// URLSearchParams (он сам декодирует значение).

function readDeepLinkStationIds(search: string): { fromId: string; toId: string } | null {
  try {
    const params = new URLSearchParams(search)
    const fromId = params.get('from')?.trim()
    const toId = params.get('to')?.trim()
    if (!fromId || !toId) return null
    return { fromId, toId }
  } catch {
    return null
  }
}

/** Есть ли в адресе хоть один параметр маршрута — чтобы отличить обрезанную ссылку от обычного входа. */
function hasAnyDeepLinkParam(search: string): boolean {
  try {
    const params = new URLSearchParams(search)
    return Boolean(params.get('from')?.trim() || params.get('to')?.trim())
  } catch {
    return false
  }
}

/**
 * Убираем мусорные `?from/?to` из адреса: иначе перезагрузка бесконечно
 * повторяет неудачный сценарий, а ссылка выглядит рабочей.
 */
function clearDeepLinkParamsFromUrl(): void {
  if (typeof window === 'undefined') return
  if (typeof window.history?.replaceState !== 'function') return

  try {
    const url = new URL(window.location.href)
    url.searchParams.delete('from')
    url.searchParams.delete('to')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {
    // ignore
  }
}

/**
 * Скрыто визуально, но доступно скринридеру. Инлайн-стилем, а не классом:
 * файлы CSS в этой задаче правит другой агент.
 */
function buildRouteShareUrl(fromId: string, toId: string): string | null {
  if (typeof window === 'undefined') return null

  try {
    const { origin, pathname } = window.location
    return `${origin}${pathname}?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`
  } catch {
    return null
  }
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
  // Последний pointerdown: единственный доступный источник длительности нажатия,
  // потому что MetroMap правкам не подлежит и отдаёт только момент отпускания.
  const pointerDownRef = useRef<{ at: number; x: number; y: number } | null>(null)
  const [stationHint, setStationHint] = useState<StationHint | null>(null)
  const stationHintTimeoutRef = useRef<number | null>(null)
  const stationHintIdRef = useRef(0)
  const [errorLogEntries, setErrorLogEntries] = useState<ErrorLogEntry[]>([])
  const [isErrorLogOpen, setIsErrorLogOpen] = useState(false)
  const [routeAlternatives, setRouteAlternatives] = useState<RouteResult[]>([])
  const [activeRouteIndex, setActiveRouteIndex] = useState(0)
  // ID запроса, ответ на который мы сейчас ждём (null — ничего не считается).
  const [pendingRouteRequestId, setPendingRouteRequestId] = useState<number | null>(null)
  // Отдельный флаг именно ВИДИМОСТИ индикатора: расчёт почти всегда мгновенный,
  // и показывать скелетон на 5 мс — значит просто мигать пользователю в лицо.
  const [isRouteLoadingVisible, setIsRouteLoadingVisible] = useState(false)
  const routeLoadingShownAtRef = useRef<number | null>(null)
  const [shareHint, setShareHint] = useState<string | null>(null)
  // Текст для скринридера: и «строим», и готовый результат живут в одной
  // aria-live-области, иначе результат расчёта не объявляется вовсе.
  const [routeAnnouncement, setRouteAnnouncement] = useState('')
  const [isRouteSheetOpen, setIsRouteSheetOpen] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [fromFixed, setFromFixed] = useState(false)
  const [toFixed, setToFixed] = useState(false)
  /**
   * В какое поле попытались положить станцию, уже занятую соседним. Нужен, чтобы
   * подсказка встала ПОД ЭТИМ полем: общий блок ошибки под формой человек ищет
   * глазами, а поле, которое надо править, — вот оно.
   */
  const [sameStationField, setSameStationField] = useState<'from' | 'to' | null>(null)
  // Всё состояние и вся логика редактора схемы живут в отдельном модуле.
  // В проде здесь работает заглушка, а редакторский код в бандл не попадает.
  const editor = useEditor()
  const effectiveEditMode = editor.editMode
  const {
    allStations,
    stationById,
    stationTitleById,
    stationOverrides,
    edgeOverrides,
    manualEdges,
  } = editor

  const [isDesktop, setIsDesktop] = useState(false)
  const [isSplashDone, setIsSplashDone] = useState(false)
  const [isSplashMounted, setIsSplashMounted] = useState(true)
  const [fromSuggestionIndex, setFromSuggestionIndex] = useState(-1)
  const [toSuggestionIndex, setToSuggestionIndex] = useState(-1)
  const [favoriteRoutes, setFavoriteRoutes] = useState<SavedRoute[]>([])
  const [recentRoutes, setRecentRoutes] = useState<SavedRoute[]>([])
  const [isSmartSuggestionsOpen, setIsSmartSuggestionsOpen] = useState(false)
  // Ссылка-пропуск видна только в фокусе; CSS-псевдоклассы недоступны, поэтому
  // состояние держим явно.
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

  // Таймер «воркер не ответил» для текущего запроса маршрута.
  const routeRequestTimeoutRef = useRef<number | null>(null)
  // Ответил ли воркер хоть раз: пока нет — граф ещё может грузиться, и запросу
  // положен увеличенный таймаут (см. ROUTE_FIRST_REQUEST_TIMEOUT_MS).
  const hasWorkerRespondedRef = useRef(false)
  // Параметры последнего запроса — чтобы кнопка «Повторить» могла его переиграть.
  const lastRouteRequestRef = useRef<{ fromId: string; toId: string } | null>(null)
  const shareHintTimeoutRef = useRef<number | null>(null)
  // Deep link применяем один раз на «живой» воркер. Сбрасывается вместе с воркером,
  // чтобы пересоздание (в т.ч. двойной монтаж в StrictMode) не потеряло ссылку.
  const deepLinkAppliedRef = useRef(false)

  const [isOnboardingHintVisible, setIsOnboardingHintVisible] = useState(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.localStorage.getItem(ONBOARDING_HINT_STORAGE_KEY) !== '1'
    } catch {
      return false
    }
  })

  const dismissOnboardingHint = useCallback(() => {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(ONBOARDING_HINT_STORAGE_KEY, '1')
      } catch {
        // ignore
      }
    }
    setIsOnboardingHintVisible(false)
  }, [])

  // Засекаем начало нажатия на уровне документа: MetroMap трогать нельзя, а
  // без момента pointerdown отличить долгое нажатие от обычного тапа негде.
  useEffect(() => {
    if (typeof window === 'undefined') return

    const onPointerDown = (event: PointerEvent) => {
      pointerDownRef.current = {
        at: performance.now(),
        x: event.clientX,
        y: event.clientY,
      }
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  const showStationHint = useCallback((kind: StationHintKind, text: string) => {
    stationHintIdRef.current += 1
    setStationHint({ id: stationHintIdRef.current, kind, text })

    if (typeof window === 'undefined') return
    if (stationHintTimeoutRef.current != null) {
      window.clearTimeout(stationHintTimeoutRef.current)
    }
    stationHintTimeoutRef.current = window.setTimeout(() => {
      stationHintTimeoutRef.current = null
      setStationHint(null)
    }, STATION_HINT_DURATION_MS)
  }, [])

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && stationHintTimeoutRef.current != null) {
        window.clearTimeout(stationHintTimeoutRef.current)
        stationHintTimeoutRef.current = null
      }
    }
  }, [])

  // Журнал ошибок: читаем накопленное при старте и слушаем новые записи, чтобы
  // кнопка «Журнал ошибок» появлялась сразу, а не после перезагрузки.
  useEffect(() => {
    setErrorLogEntries(readErrorLog())
    return subscribeErrorLog(setErrorLogEntries)
  }, [])

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

  /**
   * Право карточки установки на показ.
   *
   * Считается ОДИН РАЗ на старте и в этой сессии больше не меняется. Условие:
   * человек уже строил маршрут раньше, то есть застал пользу приложения, и
   * пришёл снова. Флаг ставится по факту построенного маршрута, но карточка
   * появится только на следующем запуске — иначе она накрывает свежий
   * результат ровно в тот момент, ради которого человек всё и делал.
   */
  const [isInstallGuideEarned] = useState(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.localStorage.getItem(INSTALL_GUIDE_EARNED_KEY) === '1'
    } catch {
      return false
    }
  })

  const handleInitialViewportReady = useCallback(() => {
    setIsMapReady(true)
  }, [])

  // Страховка: пользователь никогда не должен застрять на сплэше навсегда.
  // Если карта не отчиталась о готовности viewport за MAP_READY_FALLBACK_MS,
  // выставляем готовность принудительно и показываем UI.
  useEffect(() => {
    if (isMapReady) return
    const timeoutId = window.setTimeout(() => {
      setIsMapReady(true)
    }, MAP_READY_FALLBACK_MS)
    return () => window.clearTimeout(timeoutId)
  }, [isMapReady])

  useEffect(() => {
    if (typeof window === 'undefined') return

    try {
      const rawFavorites = window.localStorage.getItem(FAVORITES_STORAGE_KEY)
      if (rawFavorites) {
        const parsed = JSON.parse(rawFavorites) as unknown
        if (Array.isArray(parsed)) {
          setFavoriteRoutes(parsed.filter(isSavedRoute))
        }
      }
    } catch {
      // ignore
    }

    try {
      const rawRecents = window.localStorage.getItem(RECENTS_STORAGE_KEY)
      if (rawRecents) {
        const parsedRaw = JSON.parse(rawRecents) as unknown
        const parsed = Array.isArray(parsedRaw) ? parsedRaw.filter(isSavedRoute) : null
        if (parsed) {
          const limited = parsed.slice(0, 5)
          setRecentRoutes(limited)

          if (limited.length !== (parsedRaw as unknown[]).length) {
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

      // Самолечение на холодном старте.
      //
      // registerType: 'prompt' означает, что новая версия ждёт явного согласия
      // пользователя. Это правильно ПОСРЕДИ сессии: смена версии на лету может
      // дать 404 на уже загруженных lazy-чанках. Но если по какой-то причине
      // подтвердить обновление не удаётся (баннер перекрыт, не нажимается,
      // пользователь его закрыл), приложение застревает на старой версии
      // навсегда — обычная перезагрузка идёт через service worker и снова
      // отдаёт закэшированное.
      //
      // Поэтому: если обновление УЖЕ ждало на момент регистрации, значит это
      // свежая загрузка страницы, ломать нечего — применяем молча. Спрашиваем
      // только про обновления, найденные во время работы.
      //
      // sessionStorage-флаг защищает от петли перезагрузок, если активация
      // почему-то не доводится до конца.
      if (!swRegistration?.waiting) return
      try {
        if (window.sessionStorage.getItem(SW_COLD_START_APPLIED_KEY) === '1') return
        window.sessionStorage.setItem(SW_COLD_START_APPLIED_KEY, '1')
      } catch {
        return
      }
      console.log('SW: применяю ожидающее обновление на холодном старте')
      void updateServiceWorker(true)
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
    // Шторка монтируется только когда основной UI готов (isSplashDone && isMapReady).
    // Без этих зависимостей эффект не перезапускался в момент появления шторки,
    // и при открытии по deep link она оставалась неизмеренной: высота бралась
    // по контенту, шторка вылезала за экран и уносила поля ввода вверх за границу.
    isSplashDone,
    isMapReady,
    effectiveEditMode,
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
    isRouteLoadingVisible,
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
    // Те же зависимости, что и у измеряющего layout-эффекта: ResizeObserver должен
    // подписаться на шторку сразу, как только она появилась в DOM.
    isSplashDone,
    isMapReady,
    effectiveEditMode,
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
    isRouteLoadingVisible,
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
    }, SPLASH_MIN_DURATION_MS)

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

        // Возвращаем ПРЕЖНИЙ объект, если ничего не изменилось.
        // React сравнивает состояние по Object.is, поэтому новый объект с теми
        // же числами — это перерендер App, перерендер MetroMap (мемоизация по
        // `visibleInsets` не срабатывает) и перезапуск эффекта автофита. А сюда
        // мы приходим 16 раз подряд на «всплеске» и на каждом resize/scroll.
        setMapVisibleInsets((prev: typeof mapVisibleInsets) => {
          if (
            prev.top === top &&
            prev.right === right &&
            prev.left === left
          ) {
            return prev
          }
          return { top, right, bottom: prev.bottom, left }
        })
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

  /**
   * UX-9. Карточка установки выезжала через ~1,8 с после запуска, накрывала
   * подсказку онбординга, которую человек начал читать полсекунды назад, и
   * приходила до того, как он вообще понял, что это за приложение.
   *
   * Теперь она «зарабатывается»: либо человек уже построил маршрут (увидел
   * пользу), либо это как минимум второй визит. Плюс она никогда не перебивает
   * онбординг.
   */
  const shouldShowInstallGuide =
    isSplashDone &&
    isMapReady &&
    isInstallGuideOpen &&
    isInstallGuideDelayPassed &&
    isInstallGuideEarned &&
    !isOnboardingHintVisible
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

  // Видимость индикатора отделена от факта расчёта: см. ROUTE_LOADING_SHOW_DELAY_MS.
  useEffect(() => {
    if (typeof window === 'undefined') return

    if (pendingRouteRequestId != null) {
      if (isRouteLoadingVisible) return
      const timeoutId = window.setTimeout(() => {
        routeLoadingShownAtRef.current = Date.now()
        setIsRouteLoadingVisible(true)
      }, ROUTE_LOADING_SHOW_DELAY_MS)
      return () => window.clearTimeout(timeoutId)
    }

    if (!isRouteLoadingVisible) return

    const shownAt = routeLoadingShownAtRef.current ?? 0
    const restMs = Math.max(0, ROUTE_LOADING_MIN_VISIBLE_MS - (Date.now() - shownAt))
    const timeoutId = window.setTimeout(() => {
      routeLoadingShownAtRef.current = null
      setIsRouteLoadingVisible(false)
    }, restMs)
    return () => window.clearTimeout(timeoutId)
  }, [pendingRouteRequestId, isRouteLoadingVisible])

  // Гасим индикатор загрузки и сторожевой таймер.
  // Вызывается и при успехе, и при ошибке, и при отмене устаревшего запроса,
  // поэтому «залипнуть» индикатор не может.
  const stopRouteLoading = useCallback(() => {
    if (routeRequestTimeoutRef.current != null) {
      window.clearTimeout(routeRequestTimeoutRef.current)
      routeRequestTimeoutRef.current = null
    }
    setPendingRouteRequestId(null)
  }, [])

  // Обработчики ответа воркера держим в ref и обновляем на каждом рендере.
  //
  // Это принципиально: сам воркер должен создаваться РОВНО ОДИН РАЗ. Раньше эффект
  // создания воркера зависел от коллбэков (`setRouteSheetOpenState` и т.п.), а те
  // пересоздаются при смене `isDesktop`. На широком экране `isDesktop` переключается
  // с false на true сразу после монтирования — воркер пересоздавался прямо посреди
  // расчёта, pending-запрос вычищался, и маршрут молча терялся (сильнее всего это
  // било по deep link: на десктопе ссылка вообще не открывала маршрут).
  const routeWorkerMessageRef = useRef<(event: MessageEvent) => void>(() => {})
  const routeWorkerErrorRef = useRef<() => void>(() => {})

  useEffect(() => {
    const pending = routeWorkerPendingRef.current

    routeWorkerErrorRef.current = () => {
      pending.clear()
      stopRouteLoading()
      setErrorMessage('Не удалось построить маршрут: расчёт завершился с ошибкой. Попробуй ещё раз.')
    }

    routeWorkerMessageRef.current = (event: MessageEvent) => {
      const msg = event.data as
        | { type: 'routeResult'; requestId: number; routes: RouteResult[] }
        | { type: 'routeError'; requestId: number; errorMessage: string }

      if (!msg || typeof msg.requestId !== 'number') return

      // Воркер жив и граф загружен — дальше действует обычный таймаут.
      hasWorkerRespondedRef.current = true

      const ctx = pending.get(msg.requestId)
      // Ответ на устаревший (отменённый) запрос: молча игнорируем,
      // индикатор при этом продолжает относиться к актуальному запросу.
      if (!ctx) return
      pending.delete(msg.requestId)

      stopRouteLoading()

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
            // Именно время, а не порядковый номер: поле называется «когда
            // использовали», избранное пишет туда Date.now(), и после
            // перезагрузки счётчик всё равно начинался заново с единицы.
            lastUsedAt: Date.now(),
          },
          ...filtered,
        ].slice(0, 5)

        persistRoutesToStorage(RECENTS_STORAGE_KEY, next)
        return next
      })

      // Маршрут построен — предложение установить приложение стало осмысленным.
      // Флаг сработает на СЛЕДУЮЩЕМ запуске, чтобы не накрыть свежий результат.
      try {
        window.localStorage.setItem(INSTALL_GUIDE_EARNED_KEY, '1')
      } catch {
        // ignore
      }

      // A11Y: раньше живая область говорила только «Строим маршрут…», а сам
      // результат не объявлялся вообще — незрячий пользователь после Enter
      // не узнавал ничего.
      const best = routes[0]
      setRouteAnnouncement(
        `Маршрут построен: ${ctx.fromTitleEffective} — ${ctx.toTitleEffective}. ` +
          `${best.totalMinutes} ${pluralRu(best.totalMinutes, ['минута', 'минуты', 'минут'])}, ` +
          `${formatTransfersForAria(best.transfersCount)}. ` +
          (routes.length > 1 ? `Всего ${formatVariantsCount(routes.length)}.` : 'Один вариант.'),
      )

      startTransition(() => {
        setRouteAlternatives(routes)
        setActiveRouteIndex(0)
        if (routes.length === 1 || ctx.isDesktop) {
          setRouteSheetOpenState(true)
        }
      })
    }
  })

  useEffect(() => {
    if (typeof window === 'undefined') return

    const worker = new Worker(new URL('./routeWorker.ts', import.meta.url), { type: 'module' })
    routeWorkerRef.current = worker

    const pending = routeWorkerPendingRef.current

    worker.onerror = () => routeWorkerErrorRef.current()
    worker.onmessage = (event: MessageEvent) => routeWorkerMessageRef.current(event)

    return () => {
      routeWorkerRef.current = null
      pending.clear()
      stopRouteLoading()
      deepLinkAppliedRef.current = false
      // Новый воркер — новая загрузка графа, значит снова «первый запрос».
      hasWorkerRespondedRef.current = false
      worker.terminate()
    }
  }, [stopRouteLoading])

  useEffect(() => {
    return () => {
      if (shareHintTimeoutRef.current != null) {
        window.clearTimeout(shareHintTimeoutRef.current)
        shareHintTimeoutRef.current = null
      }
    }
  }, [])

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

  const clearRoutes = () => {
    setRouteAlternatives([])
    setActiveRouteIndex(0)
  }

  const buildRouteByIds = (fromId: string, toId: string) => {
    if (import.meta.env.DEV) {
      console.log(`[perf][route] buildRouteByIds from=${fromId} to=${toId}`)
    }
    setErrorMessage(null)
    setRouteAnnouncement('')
    clearRoutes()
    setRouteSheetOpenState(false)
    stopRouteLoading()
    dismissOnboardingHint()

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

    lastRouteRequestRef.current = { fromId, toId }

    // Deep link: держим адресную строку в актуальном состоянии, но без записи
    // каждого шага в историю — иначе «назад» превращается в перебор станций.
    if (typeof window !== 'undefined' && typeof window.history?.replaceState === 'function') {
      const shareUrl = buildRouteShareUrl(fromId, toId)
      if (shareUrl) {
        try {
          window.history.replaceState(window.history.state, '', shareUrl)
        } catch {
          // ignore
        }
      }
    }

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

    setPendingRouteRequestId(requestId)

    if (typeof window !== 'undefined') {
      const isFirstRequest = !hasWorkerRespondedRef.current
      const timeoutMs = isFirstRequest
        ? ROUTE_FIRST_REQUEST_TIMEOUT_MS
        : ROUTE_REQUEST_TIMEOUT_MS

      routeRequestTimeoutRef.current = window.setTimeout(() => {
        routeRequestTimeoutRef.current = null
        // Ответа так и нет: считаем запрос потерянным, снимаем его из pending,
        // чтобы опоздавший ответ уже ничего не перерисовал.
        if (!routeWorkerPendingRef.current.has(requestId)) return
        routeWorkerPendingRef.current.delete(requestId)
        setPendingRouteRequestId(null)
        setErrorMessage(
          isFirstRequest
            ? 'Данные схемы всё ещё загружаются. Проверь связь и попробуй ещё раз.'
            : 'Расчёт маршрута занял слишком много времени. Попробуй ещё раз.',
        )
      }, timeoutMs)
    }
  }

  const buildRouteByIdsRef = useRef(buildRouteByIds)

  useEffect(() => {
    buildRouteByIdsRef.current = buildRouteByIds
  })

  const handleRetryRoute = useCallback(() => {
    const last = lastRouteRequestRef.current
    if (!last) {
      setErrorMessage(null)
      return
    }
    buildRouteByIdsRef.current(last.fromId, last.toId)
  }, [])

  // Deep link при холодном старте: если в URL есть обе станции и обе нашлись
  // в графе — сразу строим маршрут. Если параметров нет, сценарий не меняется.
  useEffect(() => {
    if (deepLinkAppliedRef.current) return
    if (typeof window === 'undefined') return
    if (!routeWorkerRef.current) return

    deepLinkAppliedRef.current = true

    const params = readDeepLinkStationIds(window.location.search)
    if (!params) {
      // Половинчатая ссылка (`?from=` без `?to=`) молча не делала ничего.
      // Человек, которому её прислали, не понимал, что она обрезана.
      if (hasAnyDeepLinkParam(window.location.search)) {
        setErrorMessage(
          'Ссылка на маршрут неполная: в ней указана только одна станция. Выбери станции сами.',
        )
        clearDeepLinkParamsFromUrl()
      }
      return
    }

    const fromStationResolved = stationById.get(params.fromId)
    const toStationResolved = stationById.get(params.toId)

    if (!fromStationResolved || !toStationResolved) {
      setErrorMessage('Ссылка на маршрут не сработала: таких станций нет. Выбери станции сами.')
      clearDeepLinkParamsFromUrl()
      return
    }

    if (params.fromId === params.toId) {
      setErrorMessage('В ссылке начальная и конечная станции совпадают. Выбери другую станцию.')
      clearDeepLinkParamsFromUrl()
      return
    }

    const fromTitle = stationTitleById.get(params.fromId) ?? fromStationResolved.title
    const toTitle = stationTitleById.get(params.toId) ?? toStationResolved.title

    setFromStation(fromTitle)
    setToStation(toTitle)
    setFromFixed(true)
    setToFixed(true)

    buildRouteByIdsRef.current(params.fromId, params.toId)
  }, [stationById, stationTitleById])

  const handleShareRoute = useCallback(async () => {
    const from = fromStationId
    const to = toStationId
    if (!from || !to) return

    const shareUrl = buildRouteShareUrl(from, to)
    if (!shareUrl) return

    const fromTitle = stationTitleById.get(from) ?? ''
    const toTitle = stationTitleById.get(to) ?? ''
    const title =
      fromTitle && toTitle ? `Метро: ${fromTitle} → ${toTitle}` : 'Маршрут в метро Москвы'

    const showHint = (text: string) => {
      setShareHint(text)
      if (shareHintTimeoutRef.current != null) {
        window.clearTimeout(shareHintTimeoutRef.current)
      }
      shareHintTimeoutRef.current = window.setTimeout(() => {
        shareHintTimeoutRef.current = null
        setShareHint(null)
      }, 2400)
    }

    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, text: title, url: shareUrl })
        return
      } catch (err) {
        // Пользователь закрыл системный шит — это не ошибка, ничего не показываем.
        if (err instanceof DOMException && err.name === 'AbortError') return
        // Иначе падаем в фолбэк с копированием.
      }
    }

    const copied = await copyTextToClipboard(shareUrl)
    showHint(copied ? 'Ссылка на маршрут скопирована' : 'Не удалось скопировать ссылку')
  }, [fromStationId, toStationId, stationTitleById])

  /**
   * Кандидаты автодополнения. Считаются один раз на набор станций, а не на
   * каждое нажатие клавиши: наложение оверрайдов на 300+ станций в обработчике
   * ввода — лишняя работа на слабом телефоне.
   *
   * Название линии заполняется ТОЛЬКО у неуникальных названий (Киевская ×3,
   * Арбатская ×2, Деловой центр ×3 …): в остальных строках это лишний шум.
   */
  const stationSearchCandidates = useMemo<StationSearchCandidate[]>(() => {
    const titleCounts = new Map<string, number>()

    const rows = allStations.map((s) => {
      const ov = stationOverrides[s.id]
      const title = ov?.title?.trim() || s.title
      const effectiveLineNumericId =
        ov && ov.lineNumericId !== undefined ? ov.lineNumericId : s.lineNumericId
      const line =
        effectiveLineNumericId != null ? lineByNumericId.get(effectiveLineNumericId) : undefined

      const key = normalizeStationText(title)
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1)

      return { id: s.id, title, color: line?.colorHex, lineTitle: line?.title, key }
    })

    return rows.map(({ key, id, title, color, lineTitle }) => ({
      id,
      title,
      color,
      lineTitle: (titleCounts.get(key) ?? 0) > 1 ? lineTitle : undefined,
    }))
  }, [allStations, stationOverrides, lineByNumericId])

  /**
   * Список закрывается и после отказа «эта станция уже занята соседним полем»:
   * иначе он остаётся висеть поверх подсказки под полем, да и повторно
   * предлагать ровно ту станцию, которую только что отклонили, — издёвка.
   * Достаточно любого ввода (он сбрасывает sameStationField), чтобы список
   * вернулся.
   */
  const fromSuggestions = useMemo<RouteSuggestionItem[]>(() => {
    if (fromFixed || sameStationField === 'from') return []
    return rankStationCandidates(stationSearchCandidates, fromStation, SUGGESTIONS_LIMIT)
  }, [fromStation, fromFixed, sameStationField, stationSearchCandidates])

  const toSuggestions = useMemo<RouteSuggestionItem[]>(() => {
    if (toFixed || sameStationField === 'to') return []
    return rankStationCandidates(stationSearchCandidates, toStation, SUGGESTIONS_LIMIT)
  }, [toStation, toFixed, sameStationField, stationSearchCandidates])

  /**
   * «Ввели что-то, но не нашли ничего». Именно этот случай — а не пустое поле,
   * не уже выбранная станция и не отказ по совпадению (там своя подсказка под
   * полем) — показывает пустое состояние подсказок.
   */
  const fromNoMatches =
    !fromFixed &&
    sameStationField !== 'from' &&
    fromStation.trim().length > 0 &&
    fromSuggestions.length === 0
  const toNoMatches =
    !toFixed &&
    sameStationField !== 'to' &&
    toStation.trim().length > 0 &&
    toSuggestions.length === 0

  const fromFieldHint =
    sameStationField === 'from' ? 'Эта станция уже выбрана в поле «Куда»' : null
  const toFieldHint =
    sameStationField === 'to' ? 'Эта станция уже выбрана в поле «Откуда»' : null

  const routeResult = routeAlternatives[activeRouteIndex] ?? null

  // «Прибытие ~HH:MM» считалось один раз при смене маршрута: с открытой шторкой
  // через двадцать минут значение врало ровно на двадцать минут. Тикаем по
  // границе минуты и только когда есть что показывать.
  const [arrivalClockTick, setArrivalClockTick] = useState(0)

  useEffect(() => {
    if (!routeResult) return
    return startMinuteTicker(() => {
      setArrivalClockTick((v) => v + 1)
    })
  }, [routeResult])

  const routeArrivalTimeLabel = useMemo(() => {
    if (!routeResult) return null

    const now = new Date()
    const arrival = new Date(now.getTime() + routeResult.totalMinutes * 60 * 1000)

    return arrival.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })
    // arrivalClockTick — намеренная зависимость-таймер: без неё значение
    // замерзает на моменте построения маршрута.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeResult, arrivalClockTick])

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

  // Цвета линий по каждому варианту маршрута — для «пилюль» в чипах выбора.
  // Логика та же, что у decoratedSegments (цвет берём у линии станции отправления
  // перегона), но считаем сразу для всех альтернатив и без сборки текстов.
  // Мемоизация обязательна: вариантов до 6, у каждого — десятки шагов.
  const routeAlternativeLineColors = useMemo<string[][]>(() => {
    return routeAlternatives.map((route) => {
      const colors: string[] = []

      for (const step of route.steps) {
        if (step.isTransfer) continue

        const fromStationResolved = stationById.get(step.fromStationId)
        const toStationResolved = stationById.get(step.toStationId)

        const fromLineNumericId = fromStationResolved?.lineNumericId ?? null
        const toLineNumericId = toStationResolved?.lineNumericId ?? null

        const color =
          (fromLineNumericId != null ? lineByNumericId.get(fromLineNumericId)?.colorHex : undefined) ??
          (toLineNumericId != null ? lineByNumericId.get(toLineNumericId)?.colorHex : undefined)

        if (!color) continue
        if (colors[colors.length - 1] === color) continue
        colors.push(color)
      }

      return colors
    })
  }, [routeAlternatives, stationById, lineByNumericId])

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
    dismissOnboardingHint()
    setFromStation(value)
    setFromStationId(null)
    setFromFixed(false)
    setSameStationField(null)
    clearRoutes()
    setErrorMessage(null)
    setRouteSheetOpenState(false)
    setFromSuggestionIndex(-1)
  }

  const handleToChange = (value: string) => {
    dismissOnboardingHint()
    setToStation(value)
    setToStationId(null)
    setToFixed(false)
    setSameStationField(null)
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
      // Раньше здесь был молчаливый return: подсказка «съедалась», поле не
      // менялось, сообщения не было — пользователь упирался в тупик без causa.
      const name = stationTitleById.get(stationId) ?? station.title
      setErrorMessage(`«${name}» уже выбрана как станция назначения. Выбери другую.`)
      setSameStationField('from')
      setFromSuggestionIndex(-1)
      return
    }

    const name = stationTitleById.get(stationId) ?? station.title

    setFromStation(name)
    setFromFixed(true)
    setFromStationId(stationId)
    setFromSuggestionIndex(-1)
    setErrorMessage(null)
    setSameStationField(null)

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
    const dragRange = sheetMaxOffsetPxRef.current
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
      // См. handleSelectFromSuggestion: молчаливый выход давал тупик без
      // единого сообщения, хотя нужный текст в приложении уже есть.
      const name = stationTitleById.get(stationId) ?? station.title
      setErrorMessage(`«${name}» уже выбрана как станция отправления. Выбери другую.`)
      setSameStationField('to')
      setToSuggestionIndex(-1)
      return
    }

    const name = stationTitleById.get(stationId) ?? station.title

    setToStation(name)
    setToFixed(true)
    setToStationId(stationId)
    setToSuggestionIndex(-1)
    setErrorMessage(null)
    setSameStationField(null)

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

  /**
   * Результат попытки поставить станцию в поле.
   *
   * Раньше функция при конфликте молча делала `return`, а вызывающий код всё
   * равно показывал подтверждение «B Куда: Мнёвники» — пользователю сообщали
   * об успехе действия, которого не произошло. Теперь решение о подсказке
   * принимает вызывающий, по факту.
   */
  type ApplyStationResult = 'applied' | 'same-station'

  const applyStationToField = (
    mode: 'from' | 'to',
    stationId: string,
    stationName: string,
  ): ApplyStationResult => {
    if (mode === 'from') {
      const toId = toStationId
      if (toId && stationId === toId) {
        return 'same-station'
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
      return 'applied'
    }

    const fromId = fromStationId
    if (fromId && stationId === fromId) {
      return 'same-station'
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

    return 'applied'
  }

  /**
   * Тап по станции без поповера: первый тап — «Откуда», второй — «Куда».
   *
   * Когда обе точки уже заданы, тап заменяет «Куда» и сразу пересчитывает
   * маршрут. Причина: «Откуда» — это почти всегда «где я сейчас», значение
   * липкое, а меняется обычно цель поездки. К тому же замена «Куда» даёт
   * полезный результат за один тап, тогда как замена «Откуда» со сбросом
   * «Куда» оставила бы пользователя без маршрута и потребовала второй тап.
   * Сменить точку отправления по-прежнему можно долгим нажатием.
   */
  const applyStationByTap = (stationId: string, stationName: string) => {
    const fromId = fromStationId
    const toId = toStationId

    if (!fromId) {
      if (toId && stationId === toId) {
        showStationHint('info', `${stationName} уже выбрана как «Куда»`)
        return
      }
      applyStationToField('from', stationId, stationName)
      showStationHint('from', `Откуда: ${stationName}`)
      return
    }

    if (stationId === fromId) {
      showStationHint('info', `${stationName} уже выбрана как «Откуда»`)
      return
    }

    if (toId && stationId === toId) {
      showStationHint('info', `${stationName} уже выбрана как «Куда»`)
      return
    }

    applyStationToField('to', stationId, stationName)
    showStationHint('to', `Куда: ${stationName}`)
  }

  // Держим функцию в ref: handleMapSelect уходит в MetroMap пропом и должен
  // оставаться стабильным, а applyStationByTap пересоздаётся каждый рендер.
  const applyStationByTapRef = useRef(applyStationByTap)
  useEffect(() => {
    applyStationByTapRef.current = applyStationByTap
  })

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
    setSameStationField(null)

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
        setSameStationField('from')
        clearRoutes()
        setRouteSheetOpenState(false)
        return
      }
      setSameStationField(null)
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
        setSameStationField('to')
        clearRoutes()
        setRouteSheetOpenState(false)
        return
      }
      setSameStationField(null)
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
    dismissOnboardingHint()

    // Долгое нажатие = «хочу выбрать поле сам» → прежний поповер.
    // Длительность считаем сами: MetroMap отдаёт только момент отпускания.
    const down = pointerDownRef.current
    pointerDownRef.current = null
    let isLongPress = false
    if (down) {
      const heldMs = (typeof performance !== 'undefined' ? performance.now() : 0) - down.at
      const dx = clientPoint.x - down.x
      const dy = clientPoint.y - down.y
      isLongPress =
        heldMs >= LONG_PRESS_MS &&
        heldMs < 10_000 &&
        dx * dx + dy * dy <= LONG_PRESS_MAX_MOVE_PX * LONG_PRESS_MAX_MOVE_PX
    }

    if (!isLongPress) {
      applyStationByTapRef.current(id, name)
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
  }, [dismissOnboardingHint])

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

  // Какое поле получит следующий тап по карте. Совпадает с логикой
  // applyStationByTap: пусто → «Откуда», иначе → «Куда» (в том числе когда обе
  // точки уже заданы — тап заменяет именно цель поездки).
  const currentSelectionMode: 'from' | 'to' = !fromStationId ? 'from' : 'to'
  const isSplashActive = isSplashMounted
  const isPrimaryUiReady = isSplashDone && isMapReady

  const isRouteLoading = isRouteLoadingVisible

  // Подсказка первого запуска: показываем только на «чистом» экране и только
  // когда основной UI уже виден и ничего не перекрывает.
  const showOnboardingHint =
    isOnboardingHintVisible &&
    !effectiveEditMode &&
    !shouldShowInstallGuide &&
    !isRouteLoading &&
    !errorMessage &&
    !fromStationId &&
    !toStationId &&
    routeAlternatives.length === 0

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

      {/* Единственный заголовок первого уровня: без него скринридер не давал
          ни оглавления, ни представления о том, что это за экран. */}
      <h1 className="visually-hidden">Метро Москвы: схема и маршруты</h1>

      {/* A11Y-4. До поля «Откуда» приходилось нажимать Tab девять раз: сначала
          кнопки зума карты, тумблер темы, чип шапки, ручка шторки. Порядок
          задан раскладкой и слоями, менять его нельзя, поэтому даём штатное
          решение — ссылку-пропуск первым элементом обхода. */}
      {!effectiveEditMode && isPrimaryUiReady && (
        <button
          type="button"
          className="app-skip-link"
          onClick={() => {
            setRouteSheetOpenState(true)
            focusIfNeeded(fromInputRef.current)
          }}
        >
          Перейти к вводу маршрута
        </button>
      )}
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
          onMapInteraction={handleMapInteraction}
          visibleInsets={mapVisibleInsets}
          getBottomInsetPx={getBottomInsetPx}
          onInitialViewportReady={handleInitialViewportReady}
          // editMode, collisionDebug, editorLayout*, stationHubOverrides,
          // hiddenStationIds, stationTitleOverrides, extraStations, hub*Command,
          // onEdit*: имена и семантика те же, просто собраны редактором.
          {...editor.mapProps}
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
                // Подсказку показываем ПОСЛЕ проверки результата: раньше она
                // всплывала безусловно и врала при конфликте станций.
                // Сам вызов остаётся внутри startTransition — его отложенность
                // тут сделана ради отзывчивости поповера на слабых телефонах.
                const isSameStation =
                  toStationId != null && stationPickPopover.stationId === toStationId
                startTransition(() => {
                  setStationPickPopoverPressed('from')
                  applyStationToField(
                    'from',
                    stationPickPopover.stationId,
                    stationPickPopover.stationName,
                  )
                })
                if (!isSameStation) {
                  showStationHint('from', `Откуда: ${stationPickPopover.stationName}`)
                } else {
                  showStationHint(
                    'info',
                    `${stationPickPopover.stationName} уже выбрана как «Куда»`,
                  )
                }
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
                const isSameStation =
                  fromStationId != null && stationPickPopover.stationId === fromStationId
                startTransition(() => {
                  setStationPickPopoverPressed('to')
                  applyStationToField(
                    'to',
                    stationPickPopover.stationId,
                    stationPickPopover.stationName,
                  )
                })
                if (!isSameStation) {
                  showStationHint('to', `Куда: ${stationPickPopover.stationName}`)
                } else {
                  showStationHint(
                    'info',
                    `${stationPickPopover.stationName} уже выбрана как «Откуда»`,
                  )
                }
                closeStationPickPopoverAnimated({ delayMs: 120 })
              }}
            >
              Куда
            </button>
          </div>
        </div>
      )}

      {!effectiveEditMode && isPrimaryUiReady && <ThemeToggle />}

      {!effectiveEditMode && <ThemeStationHint hint={stationHint} />}

      <div className="app-overlay">
        {!effectiveEditMode && isPrimaryUiReady && (
          <>
            <RouteHeader
              logoSrc={appLogo}
              logoAlt="Метро Москвы"
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

            {/* Пустой <main> остался слоем-распоркой над картой: он держит
                флекс-раскладку оверлея. Сообщение об ошибке переехало отсюда
                вниз, к полям ввода (см. блок с role="alert" в шторке): здесь
                оно рисовалось в 700 px от точки внимания и было перекрыто
                переключателем темы. */}
            <main className="app-main" aria-label="Схема метро Москвы" />
          </>
        )}

        {!effectiveEditMode && isPrimaryUiReady && (
          <section
            aria-label="Поиск и детали маршрута"
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
                <h2 className="visually-hidden">
                  {routeResult ? 'Маршрут' : 'Куда едем'}
                </h2>

                {/* Ручка шторки была фокусируемой кнопкой, не реагирующей ни на
                    Enter, ни на Space, ни на click, — то есть ловушкой в обходе
                    по Tab. Теперь это настоящий переключатель: клавиатурой
                    детали маршрута раскрываются именно отсюда. */}
                {routeResult && !errorMessage && !isDesktop && (
                  <button
                    type="button"
                    className="bottom-sheet-handle"
                    aria-expanded={isRouteSheetOpen}
                    aria-label={
                      isRouteSheetOpen
                        ? 'Свернуть детали маршрута'
                        : 'Раскрыть детали маршрута'
                    }
                    onClick={() => setRouteSheetOpenState(!isRouteSheetOpen)}
                  />
                )}

                {!routeResult && !isDesktop && (
                  <button
                    type="button"
                    className="bottom-sheet-handle"
                    aria-expanded={isRouteSheetOpen}
                    aria-label={isRouteSheetOpen ? 'Свернуть шторку' : 'Раскрыть шторку'}
                    onClick={() => setRouteSheetOpenState(!isRouteSheetOpen)}
                  />
                )}

                {showOnboardingHint && (
                  <div className="onboarding-hint" role="note">
                    <span className="onboarding-hint-text">
                      Первый тап по станции — «Откуда», второй — «Куда». Долгое нажатие даёт выбор
                      поля.
                    </span>
                    <button
                      type="button"
                      className="onboarding-hint-close"
                      onClick={dismissOnboardingHint}
                      aria-label="Скрыть подсказку"
                    >
                      <IconClose />
                    </button>
                  </div>
                )}

                {/* Условие видимости больше НЕ содержит `nearbyStatus !== 'error'`:
                    при отказе в геолокации вся строка чипов вместе с кнопкой
                    «Рядом» пропадала с экрана, и заботливо написанный текст
                    ошибки не показывался никогда — пользователь думал, что
                    сломал приложение. */}
                {!isSmartSuggestionsOpen && (
                  <div className="smart-suggestions-inline">
                    {recentRoutes.length > 0 && (
                      <button
                        type="button"
                        className="smart-suggestions-inline-chip"
                        onClick={() => setIsSmartSuggestionsOpen(true)}
                        aria-label="Показать недавние маршруты"
                      >
                        <IconHistory className="inline-icon" />
                        Недавние
                      </button>
                    )}
                    <button
                      type="button"
                      className="smart-suggestions-inline-chip"
                      onClick={() => {
                        setIsSmartSuggestionsOpen(true)
                        if (nearbyStatus !== 'loading' && nearbyStations.length === 0) {
                          handleRequestNearbyStations()
                        }
                      }}
                      aria-label="Показать станции рядом"
                    >
                      <IconPin className="inline-icon" />
                      Рядом
                    </button>
                    {favoriteRoutes.length > 0 && (
                      <button
                        type="button"
                        className="smart-suggestions-inline-chip"
                        onClick={() => setIsSmartSuggestionsOpen(true)}
                        aria-label="Показать избранные маршруты"
                      >
                        <IconStar className="inline-icon" filled />
                        Избранные
                      </button>
                    )}
                  </div>
                )}

                {isSmartSuggestionsOpen && (
                    <section className="smart-suggestions" aria-label="Быстрые маршруты">
                      {favoriteRoutes.length === 0 && (
                        <div className="smart-suggestions-header">
                          <button
                            type="button"
                            className="smart-suggestions-close"
                            onClick={() => setIsSmartSuggestionsOpen(false)}
                            aria-label="Скрыть быстрые маршруты"
                          >
                            <IconClose />
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
                              <IconClose />
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
                          <>
                            <div className="smart-suggestions-error" role="alert">
                              {nearbyError || 'Не удалось определить местоположение.'}
                            </div>
                            <button
                              type="button"
                              className="smart-suggestion-chip smart-suggestion-chip--ghost"
                              onClick={handleRequestNearbyStations}
                            >
                              Попробовать ещё раз
                            </button>
                          </>
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

                {/* Кнопка появляется, только если в локальном журнале реально
                    что-то есть — иначе это шум в чистом интерфейсе. */}
                {errorLogEntries.length > 0 && (
                  <div className="smart-suggestions-inline">
                    <button
                      type="button"
                      className="theme-error-log-trigger"
                      onClick={() => setIsErrorLogOpen(true)}
                      aria-label={`Показать журнал ошибок, записей: ${errorLogEntries.length}`}
                    >
                      Журнал ошибок ({errorLogEntries.length})
                    </button>
                  </div>
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
                  fromNoMatches={fromNoMatches}
                  toNoMatches={toNoMatches}
                  fromHint={fromFieldHint}
                  toHint={toFieldHint}
                />

                {/* Ошибка живёт рядом с полями — там, куда человек смотрит,
                    когда печатает. Наверху экрана её перекрывал переключатель
                    темы, а при поднятой клавиатуре она вообще уезжала за кадр. */}
                {errorMessage && (
                  <div className="route-placeholder" role="alert">
                    <p className="error-text">{errorMessage}</p>
                    {fromStationId && toStationId && fromStationId !== toStationId && (
                      <button
                        type="button"
                        className="route-retry-button"
                        onClick={handleRetryRoute}
                        aria-label="Построить маршрут ещё раз"
                      >
                        Попробовать ещё раз
                      </button>
                    )}
                  </div>
                )}

                {/* Честное состояние загрузки: пока воркер считает, шторка
                    показывает скелетон, а не «ничего не произошло». */}
                <div className="route-loading-live" role="status" aria-live="polite">
                  {isRouteLoading ? 'Строим маршрут…' : routeAnnouncement}
                </div>

                {isRouteLoading && (
                  /* Текст дублирует aria-live-область выше, поэтому для скринридера
                     блок скрыт — иначе «Строим маршрут…» читается дважды. */
                  <div className="route-loading" aria-hidden="true">
                    <div className="route-loading-head">
                      <span className="route-loading-spinner" aria-hidden="true" />
                      <span className="route-loading-title">Строим маршрут…</span>
                    </div>
                    <div className="route-loading-skeleton" aria-hidden="true">
                      <span className="route-loading-skeleton-chip" />
                      <span className="route-loading-skeleton-chip" />
                      <span className="route-loading-skeleton-chip" />
                    </div>
                  </div>
                )}

                {routeAlternatives.length > 1 && !errorMessage && !isDesktop && !isRouteLoading && (
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
                            aria-label={`Выбрать маршрут: ${label}, ~${route.totalMinutes} мин, ${formatTransfersForAria(route.transfersCount)}`}
                          >
                            <div className="bottom-route-chip-main">
                              <span className="bottom-route-chip-time">
                                <IconClock className="inline-icon" />
                                {route.totalMinutes} мин
                              </span>
                            </div>
                            <RouteLinePills colors={routeAlternativeLineColors[index] ?? []} />
                            <div className="bottom-route-chip-sub">
                              {formatTransfersCount(route.transfersCount)}
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
                routeLineColors={routeAlternativeLineColors}
                onShareRoute={activeRouteEndpoints ? handleShareRoute : undefined}
                shareHint={shareHint}
              />
            </div>
          </section>
        )}

        {EDITOR_ENABLED && EditorOverlayLazy && editor.overlay && (
          <Suspense fallback={null}>
            <EditorOverlayLazy editor={editor.overlay} active={effectiveEditMode} />
          </Suspense>
        )}

        {showUpdateBanner && (
          <UpdateBanner onUpdate={handleUpdateBannerClick} onLater={handleUpdateBannerLater} />
        )}

        {isErrorLogOpen && (
          <ThemeErrorLogPanel
            entries={errorLogEntries}
            onClose={() => setIsErrorLogOpen(false)}
            onEntriesChange={setErrorLogEntries}
          />
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

// Оборачиваем всё дерево в error boundary: без него любая ошибка рендера
// давала белый экран без единого сообщения (main.tsx править нельзя).
function AppWithErrorBoundary() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}

export default AppWithErrorBoundary
