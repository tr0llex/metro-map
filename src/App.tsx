import {
  lazy,
  startTransition,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
} from 'react'
import './App.css'
import './theme.css'
import appLogo from './assets/metro-logo.svg'
import { InstallGuideCard } from './components/InstallGuideCard.tsx'
import { UpdateBanner } from './components/UpdateBanner.tsx'
import { SplashScreen } from './components/SplashScreen.tsx'
import { RouteForm } from './components/RouteForm.tsx'
import { RouteDetailsSheet } from './components/RouteDetailsSheet.tsx'
import { RouteHeader } from './components/RouteHeader.tsx'
import { RouteLinePills } from './components/RouteLinePills.tsx'
import { IconClock, IconClose, IconHistory, IconPin, IconStar } from './components/icons.tsx'
import { fullGraphLines } from './metro/fullGraph.ts'
import type { RouteResult, FullGraphStation } from './metro/types.ts'
import { MetroMap } from './components/MetroMap.tsx'
import { ErrorBoundary } from './components/ErrorBoundary.tsx'
import { ThemeToggle } from './components/ThemeToggle.tsx'
import { ThemeStationHint } from './components/ThemeStationHint.tsx'
import { StationPickPopover } from './components/StationPickPopover.tsx'
import { ThemeErrorLogPanel } from './components/ThemeErrorLogPanel.tsx'
import {
  formatTransfersCount,
  formatTransfersForAria,
  formatVariantsCount,
  pluralRu,
} from './utils/plural.ts'
import { useBottomSheet } from './hooks/useBottomSheet.ts'
import { useDragScroll } from './hooks/useDragScroll.ts'
import { useErrorLogPanel } from './hooks/useErrorLogPanel.ts'
import { markInstallGuideEarned, useInstallGuide } from './hooks/useInstallGuide.ts'
import { useIsDesktop } from './hooks/useIsDesktop.ts'
import { useMapVisibleInsets } from './hooks/useMapVisibleInsets.ts'
import { useNearbyStations } from './hooks/useNearbyStations.ts'
import { useOnboardingHint } from './hooks/useOnboardingHint.ts'
import { usePerfInteraction } from './hooks/usePerfInteraction.ts'
import { usePwaUpdate } from './hooks/usePwaUpdate.ts'
import { useRouteDerivations } from './hooks/useRouteDerivations.ts'
import { useRouteWorker } from './hooks/useRouteWorker.ts'
import { useSavedRoutes } from './hooks/useSavedRoutes.ts'
import { useShareRoute } from './hooks/useShareRoute.ts'
import { useSplashGate } from './hooks/useSplashGate.ts'
import { useStationHint } from './hooks/useStationHint.ts'
import { useStationPickPopover } from './hooks/useStationPickPopover.ts'
import { useStationSuggestions } from './hooks/useStationSuggestions.ts'
import {
  buildRouteShareUrl,
  clearDeepLinkParamsFromUrl,
  hasAnyDeepLinkParam,
  readDeepLinkStationIds,
} from './utils/deepLink.ts'
import { trackEvent } from './utils/events.ts'
import type { SavedRoute } from './features/route/savedRoutes.ts'
import { getRouteVariantLabel } from './features/route/routeLabels.ts'
import { useEditorController } from './editor/useEditorController.ts'
import { useNoopEditorController } from './editor/noopEditorController.ts'

const EDITOR_ENABLED = import.meta.env.DEV || import.meta.env.MODE === 'editor'

// Выбор реализации редактора делается один раз на модуль, а не на рендер:
// при EDITOR_ENABLED === false Rollup сворачивает тернарник, ссылка на
// useEditorController пропадает, и весь модуль редактора вылетает из бандла.
// Хук при этом вызывается безусловно — правило хуков не нарушено.
const useEditor = EDITOR_ENABLED ? useEditorController : useNoopEditorController

// Оверлей редактора грузится динамически и только в dev/editor-сборке:
// в проде тернарник сворачивается в null и import() исчезает вместе с чанком.
const EditorOverlayLazy = EDITOR_ENABLED
  ? lazy(() => import('./editor/EditorOverlay.tsx').then((m) => ({ default: m.EditorOverlay })))
  : null

/**
 * Корневой экран приложения.
 *
 * Здесь остались только те вещи, которые связывают темы друг с другом: поля
 * «Откуда»/«Куда», построение маршрута, разметка. Всё остальное вынесено в
 * хуки, и каждую тему можно читать и править, не открывая остальные:
 *
 *   useRouteWorker          — транспорт до воркера: запросы, таймауты, индикатор
 *   useRouteDerivations     — производные от маршрута: подсветка, участки, цвета
 *   useBottomSheet          — физика шторки: пружина, жесты, пересчёт высоты
 *   useStationSuggestions   — поиск станций и автодополнение
 *   useStationPickPopover   — тап и долгое нажатие по станции
 *   useSavedRoutes          — избранное и недавние
 *   useNearbyStations       — «Рядом» по геолокации
 *   useShareRoute           — «Поделиться» (deep link + буфер обмена)
 *   usePwaUpdate            — service worker, баннер обновления, самолечение
 *   useInstallGuide         — карточка установки на домашний экран
 *   useSplashGate           — заставка и готовность карты
 *   useMapVisibleInsets     — отступы карты под интерфейсом
 *   useOnboardingHint / useStationHint / useErrorLogPanel / usePerfInteraction
 */
function App() {
  const [fromStation, setFromStation] = useState('')
  const [toStation, setToStation] = useState('')
  const [fromStationId, setFromStationId] = useState<string | null>(null)
  const [toStationId, setToStationId] = useState<string | null>(null)
  const { hint: stationHint, show: showStationHint } = useStationHint()
  const errorLog = useErrorLogPanel()
  const [routeAlternatives, setRouteAlternatives] = useState<RouteResult[]>([])
  const [activeRouteIndex, setActiveRouteIndex] = useState(0)
  // Текст для скринридера: и «строим», и готовый результат живут в одной
  // aria-live-области, иначе результат расчёта не объявляется вовсе.
  const [routeAnnouncement, setRouteAnnouncement] = useState('')
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

  const isDesktop = useIsDesktop()
  const markPerfInteraction = usePerfInteraction()
  const {
    isSplashDone,
    isSplashMounted,
    isMapReady,
    isPrimaryUiReady,
    markSplashDone,
    markSplashHidden,
    markMapReady,
  } = useSplashGate()
  const [fromSuggestionIndex, setFromSuggestionIndex] = useState(-1)
  const [toSuggestionIndex, setToSuggestionIndex] = useState(-1)
  const savedRoutes = useSavedRoutes()
  const nearby = useNearbyStations({ allStations, stationOverrides })

  const routeWorker = useRouteWorker({
    onError: setErrorMessage,
    onRoutes: (ctx, routes) => {
      savedRoutes.rememberRecent({
        fromStationId: ctx.fromId,
        toStationId: ctx.toId,
        fromTitle: ctx.fromTitleEffective,
        toTitle: ctx.toTitleEffective,
      })

      // Маршрут построен — предложение установить приложение стало осмысленным.
      // Флаг сработает на СЛЕДУЮЩЕМ запуске, чтобы не накрыть свежий результат.
      markInstallGuideEarned()

      // Единственное место, где видно, что приложением пользуются: маршрут
      // считается здесь, на клиенте, и до сервера не доходит ничего.
      trackEvent('route_built')

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
    },
  })

  const desktopBottomInsetPxRef = useRef(0)
  const bottomSheetRef = useRef<HTMLDivElement | null>(null)
  const sheetMinVisibleRef = useRef<HTMLDivElement | null>(null)
  const routeDetailsRef = useRef<HTMLDivElement | null>(null)
  const stationPickPopoverRef = useRef<HTMLDivElement | null>(null)
  // Лента вариантов маршрута: прокрутка зажатой мышью (см. useDragScroll).
  const routeChoicesScrollRef = useDragScroll<HTMLDivElement>()

  const hasRoute = routeAlternatives.length > 0 && !errorMessage

  const sheet = useBottomSheet({
    isDesktop,
    isDragDisabled: Boolean(errorMessage),
    hasRoute,
    desktopBottomInsetPxRef,
    markPerfInteraction,
    sheetRef: bottomSheetRef,
    minVisibleRef: sheetMinVisibleRef,
    detailsRef: routeDetailsRef,
    // Всё, от чего зависит ВЫСОТА содержимого шторки. Шторка сама себя измеряет,
    // но перемерять её надо ровно тогда, когда меняется что-то из этого списка.
    contentSignature: [
      isSplashDone,
      isMapReady,
      effectiveEditMode,
      savedRoutes.favorites.length,
      savedRoutes.recents.length,
      nearby.status,
      nearby.stations.length,
      errorMessage,
      routeAlternatives.length,
      activeRouteIndex,
      routeWorker.isRouteLoading,
    ].join('|'),
  })
  const isRouteSheetOpen = sheet.isOpen
  const setRouteSheetOpenState = sheet.setOpen
  const isSmartSuggestionsOpen = sheet.isSmartSuggestionsOpen
  const setIsSmartSuggestionsOpen = sheet.setSmartSuggestionsOpen
  const getBottomInsetPx = sheet.getBottomInsetPx

  const mapVisibleInsets = useMapVisibleInsets({ isDesktop, isRouteSheetOpen: sheet.isOpen })
  useEffect(() => {
    desktopBottomInsetPxRef.current = mapVisibleInsets.bottom
  }, [mapVisibleInsets.bottom])

  const { isVisible: isOnboardingHintVisible, dismiss: dismissOnboardingHint } = useOnboardingHint()

  const installGuide = useInstallGuide({ isPrimaryUiReady, isOnboardingHintVisible })
  const pwaUpdate = usePwaUpdate()

  const fromInputRef = useRef<HTMLInputElement | null>(null)
  const toInputRef = useRef<HTMLInputElement | null>(null)

  const focusIfNeeded = (el: HTMLInputElement | null) => {
    if (!el) return
    if (typeof document !== 'undefined' && document.activeElement === el) return
    el.focus()
  }

  const showUpdateBanner = isPrimaryUiReady && !installGuide.shouldShow && pwaUpdate.isUpdateReady

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

  /**
   * @param keepPreviousResult
   *   Не гасить показанный маршрут на время пересчёта.
   *
   *   Обычный путь — выбрали новую станцию — обязан очистить экран: старый
   *   маршрут вёл в другое место, и показывать его рядом с новым названием
   *   в шапке нельзя.
   *
   *   Обмен «поменять местами» — другой случай. Это тот же самый маршрут, лишь
   *   пройденный в обратную сторону: та же линия на схеме, то же число
   *   пересадок, почти то же время. Гасить его незачем, а последствия заметные —
   *   детали исчезали, шторка схлопывалась, и через мгновение всё возвращалось
   *   на место. Со стороны это мигание всего интерфейса от нажатия одной кнопки.
   */
  const buildRouteByIds = (fromId: string, toId: string, keepPreviousResult = false) => {
    if (import.meta.env.DEV) {
      console.log(`[perf][route] buildRouteByIds from=${fromId} to=${toId}`)
    }
    setErrorMessage(null)
    setRouteAnnouncement('')
    if (!keepPreviousResult) {
      clearRoutes()
      setRouteSheetOpenState(false)
    }
    routeWorker.stopRouteLoading()
    dismissOnboardingHint()

    const fromStationResolved = stationById.get(fromId)
    const toStationResolved = stationById.get(toId)

    // Дальше идут отказы. Здесь показанный маршрут убрать обязаны в любом
    // режиме: рядом с сообщением об ошибке он читался бы как её результат.
    if (!fromStationResolved || !toStationResolved) {
      clearRoutes()
      setErrorMessage('Не удалось найти одну из станций. Выбери её из списка подсказок.')
      return
    }

    if (fromId === toId) {
      clearRoutes()
      setErrorMessage('Начальная и конечная станции не могут совпадать. Выбери другую станцию.')
      return
    }

    setFromStationId(fromId)
    setToStationId(toId)

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

    const sent = routeWorker.postRoute(
      {
        fromId,
        toId,
        fromTitleEffective: stationTitleById.get(fromId) ?? fromStationResolved.title,
        toTitleEffective: stationTitleById.get(toId) ?? toStationResolved.title,
        isDesktop,
      },
      { edgeOverrides, extraEdges: Object.values(manualEdges) },
    )

    if (!sent) {
      setErrorMessage('Не удалось запустить вычисление маршрута. Обнови страницу.')
    }
  }

  const buildRouteByIdsRef = useRef(buildRouteByIds)

  useEffect(() => {
    buildRouteByIdsRef.current = buildRouteByIds
  })

  const handleRetryRoute = useCallback(() => {
    const last = routeWorker.getLastRequest()
    if (!last) {
      setErrorMessage(null)
      return
    }
    buildRouteByIdsRef.current(last.fromId, last.toId)
  }, [routeWorker])

  // Deep link при холодном старте: если в URL есть обе станции и обе нашлись
  // в графе — сразу строим маршрут. Если параметров нет, сценарий не меняется.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!routeWorker.hasWorker()) return
    if (!routeWorker.claimDeepLinkSlot()) return

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
  }, [stationById, stationTitleById, routeWorker])

  const {
    fromSuggestions: fromTypedSuggestions,
    toSuggestions: toTypedSuggestions,
    fromDefaultSuggestions,
    toDefaultSuggestions,
    fromNoMatches: fromNoMatchesRaw,
    toNoMatches: toNoMatchesRaw,
    fromFieldHint,
    toFieldHint,
  } = useStationSuggestions({
    allStations,
    stationOverrides,
    lineByNumericId,
    fromStation,
    toStation,
    fromFixed,
    toFixed,
    sameStationField,
    fromStationId,
    toStationId,
    recentRoutes: savedRoutes.recents,
    favoriteRoutes: savedRoutes.favorites,
    nearbyStations: nearby.stations,
  })

  /**
   * Подсказки в ПУСТОМ поле: раньше список открывался только после ввода, и
   * клик в поле не давал ничего — человек упирался в пустой прямоугольник и
   * должен был угадать, что делать. Теперь фокус на пустом поле показывает
   * короткий список «рядом / недавнее / избранное» (см. useStationSuggestions).
   *
   * Список закрывается по Escape (флаг dismissed) и по уходу фокуса. Закрытие
   * по blur отложено: на тач-экране палец сначала снимает фокус с поля и лишь
   * потом доводит click до строки списка — без задержки строка исчезала бы
   * из-под пальца.
   */
  const SUGGESTIONS_BLUR_CLOSE_MS = 180
  const [isFromFieldFocused, setIsFromFieldFocused] = useState(false)
  const [isToFieldFocused, setIsToFieldFocused] = useState(false)
  const [areFromSuggestionsDismissed, setAreFromSuggestionsDismissed] = useState(false)
  const [areToSuggestionsDismissed, setAreToSuggestionsDismissed] = useState(false)
  const fromBlurTimeoutRef = useRef<number | null>(null)
  const toBlurTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (fromBlurTimeoutRef.current != null) window.clearTimeout(fromBlurTimeoutRef.current)
      if (toBlurTimeoutRef.current != null) window.clearTimeout(toBlurTimeoutRef.current)
    }
  }, [])

  const handleFromFocus = () => {
    if (fromBlurTimeoutRef.current != null) {
      window.clearTimeout(fromBlurTimeoutRef.current)
      fromBlurTimeoutRef.current = null
    }
    setAreFromSuggestionsDismissed(false)
    setIsFromFieldFocused(true)
  }

  const handleFromBlur = () => {
    if (fromBlurTimeoutRef.current != null) window.clearTimeout(fromBlurTimeoutRef.current)
    fromBlurTimeoutRef.current = window.setTimeout(() => {
      fromBlurTimeoutRef.current = null
      setIsFromFieldFocused(false)
    }, SUGGESTIONS_BLUR_CLOSE_MS)
  }

  const handleToFocus = () => {
    if (toBlurTimeoutRef.current != null) {
      window.clearTimeout(toBlurTimeoutRef.current)
      toBlurTimeoutRef.current = null
    }
    setAreToSuggestionsDismissed(false)
    setIsToFieldFocused(true)
  }

  const handleToBlur = () => {
    if (toBlurTimeoutRef.current != null) window.clearTimeout(toBlurTimeoutRef.current)
    toBlurTimeoutRef.current = window.setTimeout(() => {
      toBlurTimeoutRef.current = null
      setIsToFieldFocused(false)
    }, SUGGESTIONS_BLUR_CLOSE_MS)
  }

  const showFromDefaultSuggestions =
    isFromFieldFocused && !fromStation.trim() && fromDefaultSuggestions.length > 0
  const showToDefaultSuggestions =
    isToFieldFocused && !toStation.trim() && toDefaultSuggestions.length > 0

  /**
   * Единственный список, с которым дальше работают и разметка, и клавиатура:
   * иначе Enter и стрелки ходили бы по одному набору, а на экране был другой.
   */
  const fromSuggestions = areFromSuggestionsDismissed
    ? []
    : fromTypedSuggestions.length > 0
      ? fromTypedSuggestions
      : showFromDefaultSuggestions
        ? fromDefaultSuggestions
        : []
  const toSuggestions = areToSuggestionsDismissed
    ? []
    : toTypedSuggestions.length > 0
      ? toTypedSuggestions
      : showToDefaultSuggestions
        ? toDefaultSuggestions
        : []
  const fromNoMatches = fromNoMatchesRaw && !areFromSuggestionsDismissed
  const toNoMatches = toNoMatchesRaw && !areToSuggestionsDismissed

  const { shareHint, shareRoute } = useShareRoute({
    fromStationId,
    toStationId,
    stationTitleById,
  })

  const routeResult = routeAlternatives[activeRouteIndex] ?? null

  const {
    routeArrivalTimeLabel,
    activeRouteEndpoints,
    routeStationIds,
    routeEdgeKeys,
    routeLongTransferEdgeKeys,
    routeAlternativeLineColors,
    decoratedSegments,
  } = useRouteDerivations({
    routeResult,
    routeAlternatives,
    fromStationId,
    toStationId,
    fromStation,
    toStation,
    stationById,
    stationTitleById,
    lineByNumericId,
  })

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

  const handleFromChange = (value: string) => {
    dismissOnboardingHint()
    // Любой ввод возвращает список, закрытый Escape'ом.
    setAreFromSuggestionsDismissed(false)
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
    setAreToSuggestionsDismissed(false)
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

  /** Цвет линии станции для точки в шапке поповера. */
  const getPopoverLineColor = (stationId: string): string | undefined => {
    const st = stationById.get(stationId)
    const override = stationOverrides[stationId]
    const lineNumericId = (override?.lineNumericId ?? st?.lineNumericId) ?? null
    if (lineNumericId == null) return undefined
    return lineByNumericId.get(lineNumericId)?.colorHex
  }

  /**
   * Тап по станции: пока есть пустое поле — заполняем его молча (первый тап —
   * «Откуда», второй — «Куда»), это и есть быстрый путь.
   *
   * Когда обе точки уже заданы, тап НИЧЕГО не меняет сам: раньше он подменял
   * «Куда» и маршрут перестраивался неожиданно для человека, который просто
   * ткнул в карту. Теперь такой тап возвращает 'ask', и хук открывает поповер
   * с выбором поля — там же видно, какая станция какую заменит.
   */
  const applyStationByTap = (
    stationId: string,
    stationName: string,
    clientPoint: { x: number; y: number },
  ): 'handled' | 'ask' => {
    const fromId = fromStationId
    const toId = toStationId
    // Подсказка встаёт у станции и красится цветом её линии — так же, как
    // точка в шапке поповера.
    const at = { point: clientPoint, lineColor: getPopoverLineColor(stationId) }

    // Тап по уже выбранной станции — почти всегда промах: сообщаем и выходим,
    // поповер тут ничего полезного не предложит.
    if (fromId && stationId === fromId) {
      showStationHint('info', `${stationName} уже выбрана как «Откуда»`, at)
      return 'handled'
    }

    if (toId && stationId === toId) {
      showStationHint('info', `${stationName} уже выбрана как «Куда»`, at)
      return 'handled'
    }

    if (!fromId) {
      applyStationToField('from', stationId, stationName)
      showStationHint('from', `Откуда: ${stationName}`, at)
      return 'handled'
    }

    if (!toId) {
      applyStationToField('to', stationId, stationName)
      showStationHint('to', `Куда: ${stationName}`, at)
      return 'handled'
    }

    return 'ask'
  }

  const stationPickPopover = useStationPickPopover({
    onStationTap: applyStationByTap,
    onBeforeSelect: dismissOnboardingHint,
    popoverRef: stationPickPopoverRef,
  })

  const handleStationPickPopoverPick = (mode: 'from' | 'to') => {
    const data = stationPickPopover.data
    if (!data) return

    if (import.meta.env.DEV) {
      console.log(`[perf][popover] button=${mode} station=${data.stationId}`)
    }

    // Выбор станции прямо на схеме — второй способ задать маршрут, помимо
    // ввода названия. Который из двух в ходу, из журнала не видно.
    trackEvent('station_pick')

    const rivalId = mode === 'from' ? toStationId : fromStationId
    const isSameStation = rivalId != null && data.stationId === rivalId

    startTransition(() => {
      stationPickPopover.setPressed(mode)
      applyStationToField(mode, data.stationId, data.stationName)
    })

    // Подтверждения успеха здесь нет намеренно. Человек только что сам нажал
    // «Откуда» или «Куда» — сообщать ему о том, что он сделал, незачем, а
    // результат виден в шапке над картой. Всплывашка остаётся только на ОТКАЗ:
    // действие не состоялось, и без объяснения это выглядит как поломка.
    if (isSameStation) {
      showStationHint(
        'info',
        `${data.stationName} уже выбрана как «${mode === 'from' ? 'Куда' : 'Откуда'}»`,
        { point: data.clientPoint, lineColor: getPopoverLineColor(data.stationId) },
      )
    }

    stationPickPopover.closeAnimated({ delayMs: 120 })
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
    setSameStationField(null)

    if (fromIsValid && toIsValid) {
      if (nextFromId === nextToId) {
        clearRoutes()
        setRouteSheetOpenState(false)
        setErrorMessage('Начальная и конечная станции не могут совпадать. Выбери другую станцию.')
        return
      }
      // Маршрут держим на экране, пока считается обратный: см. комментарий
      // у buildRouteByIds. Иначе одно нажатие «поменять местами» гасит и
      // возвращает весь интерфейс.
      buildRouteByIds(nextFromId!, nextToId!, true)
    } else {
      clearRoutes()
      setRouteSheetOpenState(false)
    }
  }

  const handleFromKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // Escape закрывает список, не трогая ни фокус, ни введённый текст.
    if (event.key === 'Escape') {
      if (fromSuggestions.length > 0 || fromNoMatches) {
        event.preventDefault()
        setAreFromSuggestionsDismissed(true)
        setFromSuggestionIndex(-1)
      }
      return
    }

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
    if (event.key === 'Escape') {
      if (toSuggestions.length > 0 || toNoMatches) {
        event.preventDefault()
        setAreToSuggestionsDismissed(true)
        setToSuggestionIndex(-1)
      }
      return
    }

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

  const handleMapInteraction = useCallback(() => {
    markPerfInteraction()
    if (!isDesktop && routeResult && !errorMessage) {
      setRouteSheetOpenState(false)
    }
  }, [markPerfInteraction, isDesktop, routeResult, errorMessage, setRouteSheetOpenState])

  // Какое поле получит следующий тап по карте. Совпадает с логикой
  // applyStationByTap: пустое «Откуда» → «Откуда», иначе → «Куда». Когда заняты
  // оба поля, тап ничего не заполняет сам (спрашивает), но подсветку карты
  // оставляем на «Куда» — это самый частый выбор в поповере.
  const currentSelectionMode: 'from' | 'to' = !fromStationId ? 'from' : 'to'
  const isSplashActive = isSplashMounted

  const isRouteLoading = routeWorker.isRouteLoading

  // Подсказка первого запуска: показываем только на «чистом» экране и только
  // когда основной UI уже виден и ничего не перекрывает.
  const showOnboardingHint =
    isOnboardingHintVisible &&
    !effectiveEditMode &&
    !installGuide.shouldShow &&
    !isRouteLoading &&
    !errorMessage &&
    !fromStationId &&
    !toStationId &&
    routeAlternatives.length === 0

  const trimmedFrom = fromStation.trim()
  const trimmedTo = toStation.trim()

  // Шапка всегда говорит на одном языке: «откуда → куда», а незаполненный конец
  // остаётся вопросом. Прежде формулировок было три — «Откуда: X», «Куда: Y» и
  // «X → Y», — и при заполнении второго поля надпись меняла не только значение,
  // но и структуру: прочитать её как одно состояние маршрута было нельзя.
  const headerTitle = `${trimmedFrom || 'Откуда?'} → ${trimmedTo || 'Куда?'}`

  let headerChipClassName = 'app-header-chip'
  if (routeResult) {
    headerChipClassName += ' app-header-chip--has-route'
  }
  if (isRouteSheetOpen) {
    headerChipClassName += ' app-header-chip--sheet-open'
  }

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
          onDone={markSplashDone}
          onHidden={markSplashHidden}
        />
      )}

      <div className="app-map-layer">
        <MetroMap
          selectionMode={currentSelectionMode}
          onSelectStation={stationPickPopover.handleMapSelect}
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
          onInitialViewportReady={markMapReady}
          // editMode, collisionDebug, onLayoutChange, editorLayoutOverrides,
          // editorLayoutApplyToken, onEditStationInspect, stationTitleOverrides,
          // editorFocusCommand — имена и семантика те же, просто собраны
          // редактором. Точный список — EditorMapProps в editor/editorTypes.ts.
          {...editor.mapProps}
          routeSheetOpen={isRouteSheetOpen}
        />
      </div>

      {!effectiveEditMode && isPrimaryUiReady && <ThemeToggle />}

      {!effectiveEditMode && stationPickPopover.data && (
        <StationPickPopover
          data={stationPickPopover.data}
          isClosing={stationPickPopover.isClosing}
          pressed={stationPickPopover.pressed}
          position={stationPickPopover.position}
          popoverRef={stationPickPopoverRef}
          lineColor={getPopoverLineColor(stationPickPopover.data.stationId)}
          currentFromTitle={fromStationId ? fromStation : null}
          currentToTitle={toStationId ? toStation : null}
          onPick={handleStationPickPopoverPick}
        />
      )}

      {!effectiveEditMode && <ThemeStationHint hint={stationHint} />}

      <div className="app-overlay">
        {!effectiveEditMode && isPrimaryUiReady && (
          <>
            <RouteHeader
              logoSrc={appLogo}
              logoAlt="Метро Москвы"
              headerTitle={headerTitle}
              headerChipClassName={headerChipClassName}
              isDesktop={isDesktop}
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
              {...sheet.touchHandlers}
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
                      Первый тап по станции — «Откуда», второй — «Куда». Когда оба поля заняты, тап
                      спросит, что заменить. Долгое нажатие даёт выбор поля всегда.
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

                {/* Условие видимости больше НЕ содержит `nearby.status !== 'error'`:
                    при отказе в геолокации вся строка чипов вместе с кнопкой
                    «Рядом» пропадала с экрана, и заботливо написанный текст
                    ошибки не показывался никогда — пользователь думал, что
                    сломал приложение. */}
                {!isSmartSuggestionsOpen && (
                  <div className="smart-suggestions-inline">
                    {savedRoutes.recents.length > 0 && (
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
                        if (nearby.status !== 'loading' && nearby.stations.length === 0) {
                          nearby.request()
                        }
                      }}
                      aria-label="Показать станции рядом"
                    >
                      <IconPin className="inline-icon" />
                      Рядом
                    </button>
                    {savedRoutes.favorites.length > 0 && (
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
                      {savedRoutes.favorites.length === 0 && (
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

                      {savedRoutes.favorites.length > 0 && (
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
                            {savedRoutes.favorites.map((route) => (
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

                      {savedRoutes.recents.length > 0 && (
                        <div className="smart-suggestions-section">
                          <div className="smart-suggestions-header">
                            <div className="smart-suggestions-title">Недавние</div>
                            <button
                              type="button"
                              className="smart-suggestions-clear"
                              onClick={savedRoutes.clearRecents}
                            >
                              Очистить
                            </button>
                          </div>
                          <div className="smart-suggestions-row">
                            {savedRoutes.recents.map((route) => (
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
                        {nearby.status === 'idle' && nearby.stations.length === 0 && (
                          <button
                            type="button"
                            className="smart-suggestion-chip smart-suggestion-chip--ghost"
                            onClick={nearby.request}
                          >
                            Показать станции рядом
                          </button>
                        )}
                        {nearby.status === 'loading' && (
                          <div className="smart-suggestions-hint">
                            Определяем ближайшие станции…
                          </div>
                        )}
                        {nearby.status === 'error' && (
                          <>
                            <div className="smart-suggestions-error" role="alert">
                              {nearby.error || 'Не удалось определить местоположение.'}
                            </div>
                            <button
                              type="button"
                              className="smart-suggestion-chip smart-suggestion-chip--ghost"
                              onClick={nearby.request}
                            >
                              Попробовать ещё раз
                            </button>
                          </>
                        )}
                        {nearby.status !== 'loading' && nearby.stations.length > 0 && (
                          <div className="smart-suggestions-row">
                            {nearby.stations.map((station) => (
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
                {errorLog.entries.length > 0 && (
                  <div className="smart-suggestions-inline">
                    <button
                      type="button"
                      className="theme-error-log-trigger"
                      onClick={errorLog.open}
                      aria-label={`Показать журнал ошибок, записей: ${errorLog.entries.length}`}
                    >
                      Журнал ошибок ({errorLog.entries.length})
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
                  onFromFocus={handleFromFocus}
                  onFromBlur={handleFromBlur}
                  onToFocus={handleToFocus}
                  onToBlur={handleToBlur}
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
                    <div className="bottom-route-summary-scroll" ref={routeChoicesScrollRef}>
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
                isFavoriteRoute={savedRoutes.isFavorite(activeRouteEndpoints)}
                onToggleFavoriteRoute={() => {
                  if (!activeRouteEndpoints) return
                  savedRoutes.toggleFavorite(activeRouteEndpoints)
                }}
                routeLineColors={routeAlternativeLineColors}
                onShareRoute={activeRouteEndpoints ? shareRoute : undefined}
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
          <UpdateBanner onUpdate={pwaUpdate.applyUpdate} onLater={pwaUpdate.dismissUpdate} />
        )}

        {errorLog.isOpen && (
          <ThemeErrorLogPanel
            entries={errorLog.entries}
            onClose={errorLog.close}
            onEntriesChange={errorLog.setEntries}
          />
        )}

        {installGuide.shouldShow && (
          <div
            className="install-guide-backdrop"
            onClick={(event: MouseEvent<HTMLDivElement>) => {
              // Клик мимо карточки закрывает её, клик по самой карточке — нет.
              if (event.target !== event.currentTarget) return
              installGuide.close()
            }}
          >
            <InstallGuideCard platform={installGuide.platform} onClose={installGuide.close} />
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
