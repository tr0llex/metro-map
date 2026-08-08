import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fullGraphLines,
  fullGraphStations,
  fullGraphEdges,
  fullGraphRingShapes,
} from '../metro/fullGraph'
import { lineStationPairs } from '../metro/lineSegments'
import type { PositionedStation } from '../metro/types'
import {
  LABEL_NODE_RADIUS_HUB,
  LABEL_NODE_RADIUS_STATION,
  LABEL_W,
  RING_LINE_IDS,
  computeStationLabelPlacements,
  type LabelObstacleSegment,
  type StationLabelPlacement,
} from './MetroMapLabelLayout'
import {
  MIN_SCALE,
  MOBILE_FILL_ZOOM,
  WIDE_PANEL_LAYOUT_MIN_WIDTH,
  computeWorldBounds,
  coverScaleFor,
  fitScaleFor,
} from './MetroMapViewportFit'

/**
 * Чем закончился выбор станции на схеме.
 *
 * Нужен клавиатурному пути: он обязан сказать скринридеру, что именно
 * произошло, а решение принимает не карта, а владелец полей маршрута.
 * `'from'`/`'to'` — станция уехала в это поле, `'ask'` — открыт поповер выбора
 * поля, `'noop'` — ничего не изменилось (например, станция уже выбрана).
 */
export type StationSelectOutcome = 'from' | 'to' | 'ask' | 'noop'

interface MetroMapProps {
  selectionMode: 'from' | 'to'
  onSelectStation: (
    stationId: string,
    stationName: string,
    clientPoint?: { x: number; y: number; t?: number },
  ) => StationSelectOutcome | void
  fromStationName?: string
  toStationName?: string
  fromStationId?: string
  toStationId?: string
  /** Массив ID станций, входящих в текущий маршрут (для подсветки точек/кружков) */
  routeStationIds?: string[]
  /** Массив ключей рёбер маршрута вида "fromId|toId" (независимо от порядка) для точного рисования пути */
  routeEdgeKeys?: string[]
  /** Массив ключей рёбер маршрута, являющихся длинными пересадками (для отдельной подсветки) */
  routeLongTransferEdgeKeys?: string[]
  /** Режим редактирования схемы (drag&drop станций/хабов) */
  editMode?: boolean
  /** Включение визуального режима отладки коллизий подписей */
  collisionDebug?: boolean
  /** Колбэк для передачи наружу текущих оверрайдов координат станций */
  onLayoutChange?: (overrides: Record<string, { x: number; y: number }>) => void
  editorLayoutOverrides?: Record<string, { x: number; y: number }>
  editorLayoutApplyToken?: number
  /** Колбэк при взаимодействии с картой (pan/zoom), например, чтобы сворачивать UI-шторки */
  onMapInteraction?: () => void
  /** Клик по станции в режиме редактирования для открытия окна редактирования хаба */
  onEditStationInspect?: (stationId: string) => void
  /** Отступы невидимой области поверх карты (header, bottom-sheet, редактор), в px */
  visibleInsets?: { top: number; right: number; bottom: number; left: number }
  getBottomInsetPx?: () => number
  /** Переопределения названий станций по id (editor overrides) */
  stationTitleOverrides?: Record<string, string>
  onInitialViewportReady?: () => void
  /** Открыта ли мобильная шторка с деталями маршрута (для учёта её высоты при автофите). */
  routeSheetOpen?: boolean
  editorFocusCommand?: { stationId: string; token: number } | null
}

interface ViewportState {
  scale: number
  offsetX: number
  offsetY: number
}


/** Базовый граф по id — нужен снимку раскладки, чтобы отличить подвинутую станцию от нетронутой. */
const fullGraphStationById = new Map(fullGraphStations.map((s) => [s.id, s]))

const MAX_SCALE = 3
const ROUTE_AUTO_FIT_MAX_SCALE = 1.8
/**
 * Минимальная ширина куска схемы (в мировых px), который обязан остаться в
 * кадре после автоподгонки под маршрут (UX-4). Без этого правила короткий
 * маршрут зумился до предела и терял всякий географический контекст.
 */
const ROUTE_MIN_CONTEXT_WORLD_SPAN = 560
/**
 * Потолок стартового зума: на большом экране схема влезает целиком с запасом,
 * и растягивать её до бесконечности не нужно.
 */
const INITIAL_PREFERRED_SCALE = 1.1
const PAN_CLAMP_VIEWPORT_FRACTION = 0.01

/**
 * Зум колесом (UX-9).
 *
 * Модель: событие колеса не меняет масштаб напрямую, а двигает ЦЕЛЬ в
 * логарифме масштаба; отдельный rAF-цикл ведёт текущий масштаб к цели с
 * ограничением по скорости. Логарифм — потому что зум мультипликативен: равные
 * шаги в логарифме воспринимаются как равномерное движение и на 0.2, и на 2.5.
 *
 * Всё, что зависит от времени, считается через dt кадра, а не «доля за кадр»:
 * иначе на 120-герцевом мониторе зум идёт вдвое быстрее, чем на 60-герцевом,
 * а после пропущенного кадра прилетает двойной шаг — это и ощущается рывками.
 */
/** Перевод пикселей прокрутки в логарифм масштаба: щелчок колеса (100px) ≈ 1.13x. */
const WHEEL_ZOOM_LOG_PER_PX = 0.00125
/**
 * Высота «строки» для deltaMode=1 (Firefox шлёт 3 строки на щелчок).
 * 34px подобраны так, чтобы щелчок в Firefox давал тот же зум, что и в Chrome,
 * где то же событие приходит как ~100px.
 */
const WHEEL_LINE_HEIGHT_PX = 34
/**
 * Потолок вклада одного события. Страничный режим (deltaMode=2) и системное
 * ускорение прокрутки дают дельты в сотни и тысячи пикселей — без потолка
 * один такой пакет перебрасывал бы схему через весь диапазон зума.
 */
const WHEEL_ZOOM_MAX_LOG_PER_EVENT = Math.log(1.35)
/** Пинч на тачпаде приходит как wheel + ctrlKey и требует большего усиления. */
const WHEEL_ZOOM_PINCH_GAIN = 2.5
/** Постоянная времени подхода к цели, мс. */
/**
 * Постоянная времени доводки камеры: за столько миллисекунд отставание от цели
 * сокращается примерно в e раз. 150 мс — заметно плавно, но не вязко: полный
 * переезд укладывается в ~0.4 с.
 */
const VIEWPORT_EASE_TAU_MS = 150

const WHEEL_ZOOM_SMOOTH_MS = 70
/**
 * Инерция самой скорости зума, мс. Сглаживает разницу между «есть щелчок» и
 * «пауза между щелчками»: без неё шаг за кадр пульсирует с частотой щелчков.
 */
const WHEEL_ZOOM_VELOCITY_TAU_MS = 45
/** Остаток, который дожимается одним кадром: обрубает бесконечный экспоненциальный хвост. */
const WHEEL_ZOOM_SNAP_LOG = 0.012
/** Порог «цель достигнута», лог-единиц (0.1% масштаба). */
const WHEEL_ZOOM_EPS_LOG = 0.001
/** Пауза после остановки колеса, после которой возвращается полная отрисовка подписей, мс. */
const WHEEL_ZOOM_IDLE_MS = 120

// Визуальные константы схемы под светлый стеклянный UI
const BASE_LINE_WIDTH = 6.4
const BASE_RING_LINE_WIDTH = 6.4
const BASE_LINE_ALPHA_NO_ROUTE = 1
const BASE_LINE_ALPHA_WITH_ROUTE = 0.3

const ROUTE_LINE_WIDTH = 7.2
const ROUTE_LINE_ALPHA = 1
/**
 * Толщина казинга маршрута сверх самой линии, в мировых px (Дизайн-5).
 * По 2px с каждой стороны — достаточно, чтобы контур читался, и мало,
 * чтобы маршрут не превратился в жирную кляксу в плотном центре.
 */
const ROUTE_CASING_EXTRA_WIDTH = 4

const STATION_RADIUS = 5.2

/**
 * Радиус попадания по станции — в ЭКРАННЫХ пикселях (UX-1).
 *
 * Раньше радиус задавался в мировых единицах (12), из-за чего на стартовом
 * зуме (~0.18) зона попадания превращалась в 4–6 CSS px: попасть пальцем
 * было физически невозможно (замер ревьюера — 4.2% попаданий сеткой).
 * Теперь цель всегда ≈48 CSS px в диаметре независимо от масштаба; риск
 * «схватить не ту станцию» снимается тем, что hit-test и так берёт
 * ближайшую по расстоянию.
 */
const HIT_RADIUS_SCREEN_PX = 24
/**
 * Нижняя граница радиуса в мировых единицах: на глубоком зуме экранные 24px
 * съёживаются в мире, и попадание не должно стать меньше самого кружка.
 */
const HIT_RADIUS_MIN_WORLD = STATION_RADIUS * 1.6
/**
 * В редакторе перетаскивание должно быть точным: там нужен именно тот кружок,
 * по которому пользователь целился, а не ближайший в радиусе пальца.
 */
const HIT_RADIUS_EDIT_WORLD = 12
/**
 * «Магнит» для тача: если в обычный радиус не попали, тап всё равно
 * притягивается к ближайшей станции в этом радиусе (экранные px).
 * Промах пальцем рядом со станцией не должен оставаться без реакции.
 */
const TOUCH_MAGNET_RADIUS_SCREEN_PX = 40

/**
 * Визуально скрытый, но доступный скринридеру блок. Инлайн, потому что стили
 * карты живут вне этого компонента, а текстовая альтернатива схемы — его
 * собственная ответственность (A11Y-1).
 */
const SR_ONLY_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
}
const STATION_SELECTED_RADIUS = 8
const STATION_BORDER_WIDTH = 2
const STATION_FILL_COLOR = '#ffffff'
const HUB_PIE_BASE_ALPHA = 0.96
const HUB_DIM_ALPHA_WHEN_ROUTE = 0.35

const EDITOR_GRID_STEP_PX = 8

const ROUTE_PULSE_DURATION_MS = 1500
const ROUTE_BUILD_DELAY_MS = 180
const ROUTE_BUILD_DURATION_MS = 2100
const STATION_CLICK_PULSE_DURATION_MS = 360

// Типографика подписей станций: выровнена под UI-токены
// Базовый размер соответствует --font-size-md (16px) на iPhone 14,
// цвет — уровню --color-text-secondary (#4b5563) в интерфейсе.
const LABEL_BASE_FONT_PX = 16
const LABEL_FONT_FAMILY =
  'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
const LABEL_FONT_WEIGHT = 400
const LABEL_TEXT_COLOR = '#4b5563'

const HUB_GROUPS_MIN_ZOOM = 0
const FAR_TRANSFERS_MIN_ZOOM = 0

/**
 * Пол читаемости подписи на экране, px. Ниже этого размера текст на схеме
 * превращается в серую рябь (VQA-7: при автофите под длинный маршрут кегль
 * падал до ~5px).
 */
const LABEL_MIN_SCREEN_FONT_PX = 8.5
/**
 * Насколько сильно разрешено укрупнять подписи относительно раскладки.
 * Чем больше укрупнение, тем больше подписей приходится снять прореживанием,
 * поэтому предел выбран так, чтобы на общем плане оставались хотя бы все узлы.
 */
const LABEL_MAX_RENDER_UPSCALE = 2.4
/**
 * Потолок читаемости подписи на экране, px (Дизайн-3).
 *
 * Раньше потолка не было вовсе: кегль задан в мировых координатах, поэтому на
 * экране он равнялся 16 × zoom и на глубоком зуме доходил до 45–48px. Подписи
 * становились крупнее всего интерфейса и налезали друг на друга ровно там, где
 * пользователь пытается разобраться в плотном центре. Значение выбрано в
 * коридоре 12–14px — как на печатных схемах и в картографических приложениях.
 */
const LABEL_MAX_SCREEN_FONT_PX = 13.5
/**
 * Насколько сильно разрешено уменьшать подписи относительно раскладки.
 * Ниже этого предела текст начал бы вылезать за пределы «своего» слота
 * раскладки настолько, что связь подписи со станцией теряется.
 */
const LABEL_MIN_RENDER_DOWNSCALE = 0.32

type RingShape =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }

const getRingShapeForLine = (
  lineId: number,
  lineStationIds: string[],
  positionedById: Map<string, PositionedStation>,
): RingShape | null => {
  const pts: { x: number; y: number }[] = []
  for (const id of lineStationIds) {
    const st = positionedById.get(id)
    if (!st) continue
    pts.push({ x: st.x, y: st.y })
  }
  if (pts.length < 3) return null

  let cx = 0
  let cy = 0
  for (const p of pts) {
    cx += p.x
    cy += p.y
  }
  cx /= pts.length
  cy /= pts.length

  let rSum = 0
  let sumDx2 = 0
  let sumDy2 = 0
  for (const p of pts) {
    const dx = p.x - cx
    const dy = p.y - cy
    rSum += Math.hypot(dx, dy)
    sumDx2 += dx * dx
    sumDy2 += dy * dy
  }
  const baseR = rSum / pts.length
  if (!Number.isFinite(baseR) || baseR <= 0) return null

  if (lineId === 97) {
    const varX = sumDx2 / pts.length
    const varY = sumDy2 / pts.length
    if (Number.isFinite(varX) && Number.isFinite(varY) && varX > 0 && varY > 0) {
      let ratio = Math.sqrt(varX / varY)
      if (ratio < 1.1) ratio = 1.1
      else if (ratio > 3.0) ratio = 3.0

      const den = Math.sqrt((ratio * ratio + 1) / 2)
      if (!Number.isFinite(den) || den <= 0) return null
      const s = baseR / den
      const rx = ratio * s
      const ry = s
      if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx <= 0 || ry <= 0) return null
      return { kind: 'ellipse', cx, cy, rx, ry }
    }
  }

  return { kind: 'circle', cx, cy, r: baseR }
}

/**
 * Формы колец из данных (fullGraph.json → ringShapes), разобранные один раз.
 * Ключ — числовой ID линии.
 */
const RING_SHAPES_FROM_DATA: Map<number, RingShape> = (() => {
  const out = new Map<number, RingShape>()
  for (const [key, shape] of Object.entries(fullGraphRingShapes)) {
    const lineId = Number(key)
    if (!Number.isFinite(lineId)) continue
    out.set(lineId, shape)
  }
  return out
})()

/**
 * Форма кольцевой линии для отрисовки и снапа.
 *
 * Приоритет — форма из данных: солвер уже уложил станции ровно на неё, поэтому
 * пересчитывать её по станциям нельзя (при неравномерном распределении точек
 * центроид не совпадает с центром кривой и форма «уползает»).
 * Фолбэк на подгонку по станциям нужен для данных без поля `ringShapes`.
 */
const resolveRingShapeForLine = (
  lineId: number,
  lineStationIds: string[],
  positionedById: Map<string, PositionedStation>,
): RingShape | null => {
  const fromData = RING_SHAPES_FROM_DATA.get(lineId)
  if (fromData) return fromData
  return getRingShapeForLine(lineId, lineStationIds, positionedById)
}

const projectPointToRingShape = (shape: RingShape, x: number, y: number) => {
  if (shape.kind === 'circle') {
    const dx = x - shape.cx
    const dy = y - shape.cy
    const ang = Math.atan2(dy, dx)
    return { x: shape.cx + shape.r * Math.cos(ang), y: shape.cy + shape.r * Math.sin(ang) }
  }

  const dx = x - shape.cx
  const dy = y - shape.cy
  const ang = Math.atan2(dy / shape.ry, dx / shape.rx)
  return { x: shape.cx + shape.rx * Math.cos(ang), y: shape.cy + shape.ry * Math.sin(ang) }
}

/** Точка на кривой кольца по параметру t (0..2π). */
const pointOnRingShape = (shape: RingShape, t: number) => {
  if (shape.kind === 'circle') {
    return { x: shape.cx + shape.r * Math.cos(t), y: shape.cy + shape.r * Math.sin(t) }
  }
  return { x: shape.cx + shape.rx * Math.cos(t), y: shape.cy + shape.ry * Math.sin(t) }
}

/** На сколько отрезков разбивается кольцо, когда его надо считать препятствием. */
const LABEL_RING_SAMPLES = 360

/** Параллельный сдвиг линий, делящих один перегон (общий коридор). */
const CORRIDOR_OFFSET_WORLD = 3

// Внутренний флаг по умолчанию: отладочный режим коллизий подписей.
// Управляется извне через prop collisionDebug, это значение используется как дефолт.
const LABEL_COLLISION_DEBUG_DEFAULT = false

// Раскладка подписей станций живёт в отдельном модуле MetroMapLabelLayout.ts:
// ровно этот код исполняют и рантайм, и система метрик (npm run quality).
// Раньше алгоритм был продублирован в scripts/quality/**, и совпадение копий
// держалось на честном слове; теперь копия одна. Подробности — в шапке модуля.

export const MetroMap = memo(function MetroMap({
  selectionMode,
  onSelectStation,
  fromStationName,
  toStationName,
  fromStationId,
  toStationId,
  routeStationIds,
  routeEdgeKeys,
  routeLongTransferEdgeKeys,
  editMode = false,
  collisionDebug,
  onLayoutChange,
  editorLayoutOverrides,
  editorLayoutApplyToken,
  onMapInteraction,
  onEditStationInspect,
  visibleInsets,
  getBottomInsetPx,
  stationTitleOverrides,
  onInitialViewportReady,
  editorFocusCommand,
  routeSheetOpen = false,
}: MetroMapProps) {
  const devPerfEnabled = import.meta.env.DEV

  const [mapThemeTokens, setMapThemeTokens] = useState(() => {
    return {
      strongLabelColor: LABEL_TEXT_COLOR,
      weakLabelColor: LABEL_TEXT_COLOR,
      lineHaloColor: 'rgba(249, 250, 251, 0.96)',
      stationFillColor: STATION_FILL_COLOR,
      routeFallbackColor: '#2f3d5b',
      routeCasingColor: 'rgba(17, 24, 39, 0.55)',
      hubLinkColor: 'rgba(100, 116, 139, 0.55)',
      endpointColorA: '#22c1b4',
      endpointColorB: '#ef4444',
      stationSelectedHalo: 'rgba(47, 61, 91, 0.22)',
      labelHaloColor: 'rgba(255, 255, 255, 0.92)',
      hubCapsuleFillColor: 'rgba(255, 255, 255, 0.82)',
      hubCapsuleStrokeColor: 'rgba(100, 116, 139, 0.45)',
      routeBuildOverlayColor: '#f3f4f6',
      routeBuildGlowColor: 'rgba(148, 163, 184, 0.35)',
      endpointShadowColor: 'rgba(15, 23, 42, 0.25)',
      endpointStrokeColor: 'rgba(15, 23, 42, 0.18)',
    }
  })

  const [viewport, setViewport] = useState<ViewportState>({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  })
  const viewportRef = useRef<ViewportState>({
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  })
  const lastRouteFitRef = useRef<
    { routeKey: string | null; bottomInset: number; insetKey: string } | null
  >(null)
  const wheelRafRef = useRef<number | null>(null)
  const isWheelZoomingRef = useRef(false)
  const wheelStopTimeoutRef = useRef<number | null>(null)
  const wheelZoomRafRef = useRef<number | null>(null)
  /** Цель зума в логарифме масштаба; null — жеста нет. */
  const wheelZoomTargetLogRef = useRef<number | null>(null)
  /** Текущая скорость зума, лог-единиц масштаба в миллисекунду. */
  const wheelZoomVelocityRef = useRef(0)
  const wheelZoomLastFrameRef = useRef<number | null>(null)
  const wheelZoomLastClientRef = useRef<{ x: number; y: number } | null>(null)
  const reducedMotionRef = useRef(false)
  /** Значения вьюпорта, записанные жестами напрямую в ref (см. синхронизацию ниже). */
  const viewportSelfWritesRef = useRef<WeakSet<ViewportState>>(new WeakSet())
  /** Куда едет камера. null — доводка не идёт. */
  const viewportTargetRef = useRef<ViewportState | null>(null)
  const viewportEaseRafRef = useRef<number | null>(null)
  const viewportEaseLastTsRef = useRef<number | null>(null)

  /**
   * Доводка камеры до цели.
   *
   * Раньше автоподгонка под маршрут звала setViewport НА КАЖДОМ КАДРЕ цикла
   * длиной до 520 мс: пока разъезжается нижняя шторка, отступы плывут, цель
   * пересчитывается, и карта не ехала к ней, а телепортировалась в новую точку
   * каждый кадр. Это и было «дёрганое перемещение» после выбора станции.
   *
   * Здесь цель можно менять сколько угодно часто: текущее положение
   * экспоненциально подтягивается к ней, и движущаяся цель просто догоняется.
   * Анимация фиксированной длительности тут не годится — она перезапускалась бы
   * при каждой смене цели, давая рывок на каждом перезапуске.
   *
   * Масштаб сглаживается в ЛОГАРИФМЕ: в линейном приближение от 0.3 к 0.6
   * ощущается вдвое быстрее, чем от 0.6 к 1.2, хотя зрительно это один и тот же
   * шаг. Тот же приём уже применён к зуму колесом.
   */
  const stopViewportEase = useCallback(() => {
    if (viewportEaseRafRef.current != null) {
      cancelAnimationFrame(viewportEaseRafRef.current)
      viewportEaseRafRef.current = null
    }
    viewportTargetRef.current = null
    viewportEaseLastTsRef.current = null
  }, [])

  const easeViewportTo = useCallback(
    (target: ViewportState) => {
      // Мгновенно: без анимации по системной настройке и до первого кадра,
      // когда ехать неоткуда.
      if (reducedMotionRef.current) {
        stopViewportEase()
        viewportRef.current = target
        viewportSelfWritesRef.current.add(target)
        setViewport(target)
        return
      }

      viewportTargetRef.current = target
      if (viewportEaseRafRef.current != null) return

      const step = (ts: number) => {
        const goal = viewportTargetRef.current
        if (!goal) {
          viewportEaseRafRef.current = null
          return
        }

        const last = viewportEaseLastTsRef.current
        viewportEaseLastTsRef.current = ts
        // Первый кадр задаёт только точку отсчёта времени.
        const dt = last == null ? 0 : Math.min(64, ts - last)

        const cur = viewportRef.current
        // tau — за сколько миллисекунд отставание сокращается в e раз.
        const k = dt > 0 ? 1 - Math.exp(-dt / VIEWPORT_EASE_TAU_MS) : 0

        const logScale =
          Math.log(cur.scale) + (Math.log(goal.scale) - Math.log(cur.scale)) * k
        const next: ViewportState = {
          scale: Math.exp(logScale),
          offsetX: cur.offsetX + (goal.offsetX - cur.offsetX) * k,
          offsetY: cur.offsetY + (goal.offsetY - cur.offsetY) * k,
        }

        const closeEnough =
          Math.abs(next.offsetX - goal.offsetX) < 0.5 &&
          Math.abs(next.offsetY - goal.offsetY) < 0.5 &&
          Math.abs(next.scale / goal.scale - 1) < 0.001

        const applied = closeEnough ? goal : next
        viewportRef.current = applied
        viewportSelfWritesRef.current.add(applied)
        setViewport(applied)

        if (closeEnough) {
          viewportEaseRafRef.current = null
          viewportTargetRef.current = null
          viewportEaseLastTsRef.current = null
          return
        }
        viewportEaseRafRef.current = requestAnimationFrame(step)
      }

      viewportEaseLastTsRef.current = null
      viewportEaseRafRef.current = requestAnimationFrame(step)
    },
    [stopViewportEase],
  )
  const [isPanning, setIsPanning] = useState(false)
  const lastPointRef = useRef<{ x: number; y: number } | null>(null)
  const [hasDragged, setHasDragged] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const labelCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const canvasRectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null)
  const canvasRectRafRef = useRef<number | null>(null)
  const pinchStartDistanceRef = useRef<number | null>(null)
  /**
   * Жест был многопальцевым. Живёт до полного отрыва всех касаний, поэтому
   * последний поднятый после pinch палец больше не засчитывается как тап
   * по станции (S-1).
   */
  const multiTouchSessionRef = useRef(false)
  const pinchStartScaleRef = useRef<number>(1)
  const pinchCenterWorldRef = useRef<{ x: number; y: number } | null>(null)
  const pinchLastDistanceRef = useRef<number | null>(null)
  const pinchLastTimestampRef = useRef<number | null>(null)
  const pinchVelocityRef = useRef(0)
  const labelPlacementsRef = useRef<{
    stationsRef: PositionedStation[] | null
    placements: StationLabelPlacement[]
  }>({ stationsRef: null, placements: [] })
  const zoomHoldDirectionRef = useRef<1 | -1 | 0>(0)
  const zoomHoldRafRef = useRef<number | null>(null)
  const zoomHoldTimeoutRef = useRef<number | null>(null)
  const zoomSuppressClickRef = useRef(false)
  const zoomClickAnimRafRef = useRef<number | null>(null)
  const panVelocityRef = useRef<{ vx: number; vy: number }>({ vx: 0, vy: 0 })
  const panLastSampleTimeRef = useRef<number | null>(null)
  const panInertiaRafRef = useRef<number | null>(null)
  const lastTapTimeRef = useRef<number | null>(null)
  const lastTapPosRef = useRef<{ x: number; y: number } | null>(null)
  const lastTouchStationClickAtRef = useRef<number>(0)
  const zoomDragActiveRef = useRef(false)
  const zoomDragUsedRef = useRef(false)
  const zoomDragStartScaleRef = useRef(1)
  const zoomDragStartYRef = useRef(0)
  const zoomDragCenterClientRef = useRef<{ x: number; y: number } | null>(null)
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>(
    () => ({ width: 0, height: 0 }),
  )
  /**
   * A11Y-1: станция под клавиатурным фокусом. Canvas принципиально нечитаем
   * скринридером, поэтому «курсор» по станциям живёт здесь, отрисовывается
   * кольцом на схеме и озвучивается через live-region.
   */
  const [keyboardFocusStationId, setKeyboardFocusStationId] = useState<string | null>(null)
  const [mapAnnouncement, setMapAnnouncement] = useState('')
  const [isCanvasKeyboardFocused, setIsCanvasKeyboardFocused] = useState(false)
  const [hasInitialViewport, setHasInitialViewport] = useState(false)
  const initialViewportReportedRef = useRef(false)

  const lastEditorFocusTokenRef = useRef<number | null>(null)

  const routePulseRef = useRef<{ startedAt: number } | null>(null)
  const routeBuildRef = useRef<{ startedAt: number; routeKey: string } | null>(null)
  const clickPulseRef = useRef<{ stationId: string; startedAt: number } | null>(null)
  const animationRafRef = useRef<number | null>(null)
  /** Компонент ещё жив: заградитель от кадра, доехавшего после размонтирования. */
  const isMountedRef = useRef(true)
  const [animationTick, setAnimationTick] = useState(0)

  const clickPulsePerfRef = useRef<
    | {
        stationId: string
        startedAt: number
        lastFrameAt: number
        frames: number
        maxDt: number
        over16: number
        over32: number
      }
    | null
  >(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (typeof document === 'undefined') return

    const readToken = (
      rootStyle: CSSStyleDeclaration,
      name: string,
      fallback: string,
    ) => rootStyle.getPropertyValue(name).trim() || fallback

    const readAll = () => {
      const rootStyle = window.getComputedStyle(document.documentElement)
      setMapThemeTokens({
        strongLabelColor: readToken(rootStyle, '--map-label-color-strong', LABEL_TEXT_COLOR),
        weakLabelColor: readToken(rootStyle, '--map-label-color-weak', LABEL_TEXT_COLOR),
        lineHaloColor: readToken(rootStyle, '--map-line-halo-color', 'rgba(249, 250, 251, 0.96)'),
        stationFillColor: readToken(rootStyle, '--map-station-fill', STATION_FILL_COLOR),
        routeFallbackColor: readToken(rootStyle, '--map-route-fallback-color', '#2f3d5b'),
        routeCasingColor: readToken(
          rootStyle, '--map-route-casing', 'rgba(17, 24, 39, 0.55)',
        ),
        hubLinkColor: readToken(
          rootStyle, '--map-hub-link', 'rgba(100, 116, 139, 0.55)',
        ),
        endpointColorA: readToken(rootStyle, '--map-endpoint-a', '#22c1b4'),
        endpointColorB: readToken(rootStyle, '--map-endpoint-b', '#ef4444'),
        stationSelectedHalo: readToken(
          rootStyle, '--map-station-selected-halo', 'rgba(47, 61, 91, 0.22)',
        ),
        labelHaloColor: readToken(
          rootStyle, '--map-label-halo', 'rgba(255, 255, 255, 0.92)',
        ),
        hubCapsuleFillColor: readToken(
          rootStyle, '--map-hub-capsule-fill', 'rgba(255, 255, 255, 0.82)',
        ),
        hubCapsuleStrokeColor: readToken(
          rootStyle, '--map-hub-capsule-stroke', 'rgba(100, 116, 139, 0.45)',
        ),
        routeBuildOverlayColor: readToken(rootStyle, '--map-route-build-overlay', '#f3f4f6'),
        routeBuildGlowColor: readToken(
          rootStyle, '--map-route-build-glow', 'rgba(148, 163, 184, 0.35)',
        ),
        endpointShadowColor: readToken(
          rootStyle, '--map-endpoint-shadow', 'rgba(15, 23, 42, 0.25)',
        ),
        endpointStrokeColor: readToken(
          rootStyle, '--map-endpoint-stroke', 'rgba(15, 23, 42, 0.18)',
        ),
      })
    }

    readAll()

    const rootEl = document.documentElement
    const obs = new MutationObserver(() => readAll())
    obs.observe(rootEl, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })

    const mql = window.matchMedia?.('(prefers-color-scheme: dark)')
    const onMediaChange = () => readAll()

    if (mql) {
      mql.addEventListener('change', onMediaChange)
    }

    return () => {
      obs.disconnect()
      if (mql) {
        mql.removeEventListener('change', onMediaChange)
      }
    }
  }, [])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      if (animationRafRef.current != null) {
        cancelAnimationFrame(animationRafRef.current)
        animationRafRef.current = null
      }
      if (panInertiaRafRef.current != null) {
        cancelAnimationFrame(panInertiaRafRef.current)
        panInertiaRafRef.current = null
      }
      if (zoomHoldRafRef.current != null) {
        cancelAnimationFrame(zoomHoldRafRef.current)
        zoomHoldRafRef.current = null
      }
      if (zoomClickAnimRafRef.current != null) {
        cancelAnimationFrame(zoomClickAnimRafRef.current)
        zoomClickAnimRafRef.current = null
      }
      if (zoomHoldTimeoutRef.current != null) {
        window.clearTimeout(zoomHoldTimeoutRef.current)
        zoomHoldTimeoutRef.current = null
      }
    }
  }, [])

  const ensureAnimationLoop = useCallback(() => {
    // Заводить цикл на размонтированном компоненте нельзя: он крутил бы кадры
    // до конца пульсации, ни на что не влияя.
    if (!isMountedRef.current) return
    if (animationRafRef.current != null) return

    const loop = (now: number) => {
      let hasActive = false

      if (routePulseRef.current) {
        const elapsed = now - routePulseRef.current.startedAt
        if (elapsed < ROUTE_PULSE_DURATION_MS) {
          hasActive = true
        } else {
          routePulseRef.current = null
        }
      }

      if (routeBuildRef.current) {
        const elapsed = now - routeBuildRef.current.startedAt
        if (elapsed < ROUTE_BUILD_DURATION_MS) {
          hasActive = true
        } else {
          routeBuildRef.current = null
        }
      }

      if (clickPulseRef.current) {
        const elapsed = now - clickPulseRef.current.startedAt
        if (elapsed < STATION_CLICK_PULSE_DURATION_MS) {
          hasActive = true
        } else {
          clickPulseRef.current = null
        }
      }

      if (devPerfEnabled) {
        const active = clickPulseRef.current
        if (active) {
          const perf = clickPulsePerfRef.current
          if (!perf || perf.stationId !== active.stationId) {
            clickPulsePerfRef.current = {
              stationId: active.stationId,
              startedAt: now,
              lastFrameAt: now,
              frames: 0,
              maxDt: 0,
              over16: 0,
              over32: 0,
            }
          } else {
            const dt = now - perf.lastFrameAt
            perf.lastFrameAt = now
            if (dt > 0) {
              perf.frames += 1
              if (dt > perf.maxDt) perf.maxDt = dt
              if (dt > 16.7) perf.over16 += 1
              if (dt > 32) perf.over32 += 1
            }
          }
        } else if (clickPulsePerfRef.current) {
          const perf = clickPulsePerfRef.current
          const elapsed = now - perf.startedAt
          console.log(
            `[perf][clickPulse] station=${perf.stationId} elapsed=${elapsed.toFixed(0)}ms frames=${perf.frames} maxDt=${perf.maxDt.toFixed(
              1,
            )}ms >16=${perf.over16} >32=${perf.over32}`,
          )
          clickPulsePerfRef.current = null
        }
      }

      if (!hasActive) {
        animationRafRef.current = null
        return
      }

      // Обновляем тик на каждом кадре rAF: это автоматически синхронизируется
      // с частотой дисплея (60/100/120/240/... Гц) и даёт максимально плавные
      // пульсации/подсветки.
      setAnimationTick(now)

      animationRafRef.current = requestAnimationFrame(loop)
    }

    animationRafRef.current = requestAnimationFrame(loop)
  }, [devPerfEnabled])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const canvas = canvasRef.current
    if (!canvas) return

    const scheduleRectUpdate = () => {
      if (canvasRectRafRef.current != null) return
      canvasRectRafRef.current = window.requestAnimationFrame(() => {
        canvasRectRafRef.current = null
        const rect = canvas.getBoundingClientRect()
        canvasRectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      })
    }

    scheduleRectUpdate()
    window.addEventListener('resize', scheduleRectUpdate)
    window.addEventListener('scroll', scheduleRectUpdate, true)
    const vv = window.visualViewport
    vv?.addEventListener('resize', scheduleRectUpdate)
    vv?.addEventListener('scroll', scheduleRectUpdate)

    return () => {
      window.removeEventListener('resize', scheduleRectUpdate)
      window.removeEventListener('scroll', scheduleRectUpdate, true)
      vv?.removeEventListener('resize', scheduleRectUpdate)
      vv?.removeEventListener('scroll', scheduleRectUpdate)
      if (canvasRectRafRef.current != null) {
        window.cancelAnimationFrame(canvasRectRafRef.current)
        canvasRectRafRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!routeEdgeKeys || routeEdgeKeys.length === 0) {
      routePulseRef.current = null
      routeBuildRef.current = null
      return
    }
    if (typeof window === 'undefined') return

    // Кадр обязателен к отмене: без неё он доезжал уже после уборки и заново
    // заводил цикл анимации на размонтированном компоненте.
    const rafId = window.requestAnimationFrame((ts) => {
      routePulseRef.current = { startedAt: ts }

      const routeKey = `${routeEdgeKeys.join(',')}|${routeStationIds?.join(',') ?? ''}`
      if (!routeBuildRef.current || routeBuildRef.current.routeKey !== routeKey) {
        routeBuildRef.current = { startedAt: ts + ROUTE_BUILD_DELAY_MS, routeKey }
      }

      ensureAnimationLoop()
    })

    return () => window.cancelAnimationFrame(rafId)
  }, [routeEdgeKeys, routeStationIds, ensureAnimationLoop])

  /**
   * Синхронизация «состояние React → ref».
   *
   * viewportRef — источник правды для жестов (колесо, pan, pinch): они правят
   * его каждый кадр и только зеркалят значение в состояние, чтобы схема
   * перерисовалась. Коммит React приходит с задержкой на один шаг, поэтому
   * безусловное `viewportRef.current = viewport` затирало свежее значение
   * позапрошлым: следующий кадр считал шаг от устаревшей базы, и масштаб
   * ходил «вперёд-назад» через кадр — это и был дёрганый зум колесом (UX-9).
   *
   * Поэтому свои собственные значения (те, что записал жест) мы узнаём по
   * ссылке и не принимаем обратно; чужие — от кнопок зума, автоподгонки
   * маршрута, клавиатуры — принимаем как раньше.
   */
  useEffect(() => {
    if (viewportSelfWritesRef.current.has(viewport)) return
    viewportRef.current = viewport
  }, [viewport])

  /**
   * prefers-reduced-motion учитывается и в JS-анимациях карты: при включённой
   * настройке зум колесом применяется сразу, без доворота.
   */
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    const apply = () => {
      reducedMotionRef.current = mql.matches
    }
    apply()
    mql.addEventListener?.('change', apply)
    return () => {
      mql.removeEventListener?.('change', apply)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (wheelRafRef.current != null) {
        cancelAnimationFrame(wheelRafRef.current)
        wheelRafRef.current = null
      }
      if (wheelZoomRafRef.current != null) {
        cancelAnimationFrame(wheelZoomRafRef.current)
        wheelZoomRafRef.current = null
      }
      if (wheelStopTimeoutRef.current != null) {
        window.clearTimeout(wheelStopTimeoutRef.current)
        wheelStopTimeoutRef.current = null
      }
    }
  }, [])

  // Оверрайды координат станций в редакторе: stationId -> {x,y}
  const [stationOverrides, setStationOverrides] = useState<Record<string, { x: number; y: number }>>(
    {},
  )

  const lastEditorLayoutApplyTokenRef = useRef<number | null>(null)

  useEffect(() => {
    if (!editMode) return
    if (editorLayoutApplyToken == null) return
    if (lastEditorLayoutApplyTokenRef.current === editorLayoutApplyToken) return
    lastEditorLayoutApplyTokenRef.current = editorLayoutApplyToken
    setStationOverrides(editorLayoutOverrides ?? {})
  }, [editMode, editorLayoutApplyToken, editorLayoutOverrides])
  const [selectedStationIds, setSelectedStationIds] = useState<string[]>([])
  const [selectionAnchorId, setSelectionAnchorId] = useState<string | null>(null)
  const [dragStationIds, setDragStationIds] = useState<string[] | null>(null)
  const dragStartWorldRef = useRef<{ x: number; y: number } | null>(null)
  const dragInitialPositionsRef = useRef<Record<string, { x: number; y: number }>>({})
  const dragRingShapesByLineIdRef = useRef<Map<number, RingShape>>(new Map())

  const positionedStations = useMemo(() => {
    const usedStationIds = new Set<string>()
    for (const line of fullGraphLines) {
      for (const sid of line.stationIds) usedStationIds.add(sid)
    }

    const lineColorById = new Map<number, string>()
    for (const line of fullGraphLines) {
      lineColorById.set(line.id, line.colorHex)
    }

    const base: PositionedStation[] = []
    for (const s of fullGraphStations) {
      if (s.lineNumericId == null) continue
      if (!usedStationIds.has(s.id)) continue
      if (typeof s.layoutX !== 'number' || typeof s.layoutY !== 'number') continue

      const color = lineColorById.get(s.lineNumericId) ?? '#000000'
      const titleOverride = stationTitleOverrides?.[s.id]
      const title = titleOverride && titleOverride.trim().length > 0 ? titleOverride : s.title
      base.push({
        id: s.id,
        title,
        lineId: s.lineNumericId,
        hubId: s.hubId,
        x: s.layoutX,
        y: s.layoutY,
        lineColor: color,
      })
    }

    // Применяем оверрайды из редактора, если они есть
    const overrideEntries = Object.entries(stationOverrides)
    const overridesMap = new Map<string, { x: number; y: number }>(overrideEntries)

    const withOverrides =
      overrideEntries.length === 0
        ? base
        : base.map((st) => {
            const ov = overridesMap.get(st.id)
            return ov ? { ...st, x: ov.x, y: ov.y } : st
          })

    // Никакой проекции станций на форму кольца: координаты из данных —
    // это ровно то, что видит пользователь. Проекцию делает оффлайн-солвер,
    // иначе хабы, снапнутые в одну точку, разъезжаются на экране.
    return withOverrides
  }, [stationOverrides, stationTitleOverrides])

  const positionedById = useMemo(() => {
    const map = new Map<string, PositionedStation>()
    for (const st of positionedStations) {
      map.set(st.id, st)
    }
    return map
  }, [positionedStations])

  const visibleLineStationIdsByLineId = useMemo(() => {
    const map = new Map<number, string[]>()
    for (const line of fullGraphLines) {
      const ids: string[] = []
      for (const sid of line.stationIds) {
        if (positionedById.has(sid)) ids.push(sid)
      }
      map.set(line.id, ids)
    }
    return map
  }, [positionedById])

  const farTransferSegments = useMemo(() => {
    const list: { ax: number; ay: number; bx: number; by: number }[] = []
    for (const e of fullGraphEdges) {
      if (!e.isTransfer) continue
      const kind = e.transferKind
      if (kind === 'near') continue
      const a = positionedById.get(e.fromStationId)
      const b = positionedById.get(e.toStationId)
      if (!a || !b) continue
      if (!kind && a.hubId && b.hubId && a.hubId === b.hubId) continue
      list.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y })
    }
    return list
  }, [positionedById])

  const labelSegmentsByStationId = useMemo(() => {
    const segmentsByStationId = new Map<string, { ax: number; ay: number; bx: number; by: number }[]>()
    for (const line of fullGraphLines) {
      const ids = visibleLineStationIdsByLineId.get(line.id) ?? []
      if (ids.length < 2) continue
      const isRing = RING_LINE_IDS.has(line.id)
      const segmentCount = isRing ? ids.length : ids.length - 1
      for (let i = 0; i < segmentCount; i += 1) {
        const aId = ids[i]
        const bId = ids[(i + 1) % ids.length]
        const a = positionedById.get(aId)
        const b = positionedById.get(bId)
        if (!a || !b) continue
        const seg = { ax: a.x, ay: a.y, bx: b.x, by: b.y }
        let listA = segmentsByStationId.get(aId)
        if (!listA) {
          listA = []
          segmentsByStationId.set(aId, listA)
        }
        listA.push(seg)
        let listB = segmentsByStationId.get(bId)
        if (!listB) {
          listB = []
          segmentsByStationId.set(bId, listB)
        }
        listB.push(seg)
      }
    }
    return segmentsByStationId
  }, [visibleLineStationIdsByLineId, positionedById])

  /**
   * Центры кольцевых линий — вход для зонирования подписей.
   * Резолвятся ровно тем же resolveRingShapeForLine, что и при отрисовке колец,
   * поэтому «центр схемы» у раскладки тот же, что у нарисованной Кольцевой.
   */
  const labelRingCenters = useMemo(() => {
    const out = new Map<number, { cx: number; cy: number }>()
    for (const line of fullGraphLines) {
      if (!RING_LINE_IDS.has(line.id)) continue
      const ids = line.stationIds.filter((sid) => positionedById.has(sid))
      if (ids.length < 2) continue
      const shape = resolveRingShapeForLine(line.id, ids, positionedById)
      if (shape) out.set(line.id, { cx: shape.cx, cy: shape.cy })
    }
    return out
  }, [positionedById])

  const teatralnayaWorld = useMemo(() => {
    if (positionedStations.length === 0) return null
    const byId = positionedStations.find((st) => st.id === '2/teatralnaya')
    if (byId) return { x: byId.x, y: byId.y }
    const byTitle = positionedStations.find((st) => st.title === 'Театральная')
    if (byTitle) return { x: byTitle.x, y: byTitle.y }
    return null
  }, [positionedStations])

  const selectedStationIdSet = useMemo(() => {
    return new Set(selectedStationIds)
  }, [selectedStationIds])

  const routeStationIdSet = useMemo(() => {
    if (!routeStationIds || routeStationIds.length === 0) return new Set<string>()
    return new Set(routeStationIds)
  }, [routeStationIds])

  const routeEdgeKeySet = useMemo(() => {
    if (!routeEdgeKeys || routeEdgeKeys.length === 0) return new Set<string>()
    return new Set(routeEdgeKeys)
  }, [routeEdgeKeys])

  const routeLongTransferEdgeKeySet = useMemo(() => {
    if (!routeLongTransferEdgeKeys || routeLongTransferEdgeKeys.length === 0)
      return new Set<string>()
    return new Set(routeLongTransferEdgeKeys)
  }, [routeLongTransferEdgeKeys])

  const viewBoxSize = 600

  const corridorEdgeData = useMemo(() => {
    const corridorEdgeUsage = new Map<string, { lineIds: number[] }>()
    const corridorEdgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

    for (const line of fullGraphLines) {
      const ids = visibleLineStationIdsByLineId.get(line.id) ?? []
      if (ids.length < 2) continue
      const isRing = RING_LINE_IDS.has(line.id)
      const segmentCount = isRing ? ids.length : ids.length - 1

      for (let i = 0; i < segmentCount; i += 1) {
        const aId = ids[i]
        const bId = ids[(i + 1) % ids.length]
        const key = corridorEdgeKey(aId, bId)
        let info = corridorEdgeUsage.get(key)
        if (!info) {
          info = { lineIds: [] }
          corridorEdgeUsage.set(key, info)
        }
        if (!info.lineIds.includes(line.id)) {
          info.lineIds.push(line.id)
        }
      }
    }

    return { corridorEdgeUsage, corridorEdgeKey }
  }, [visibleLineStationIdsByLineId])

  /**
   * Все нарисованные сегменты линий — препятствия для подписей.
   * Строится ровно так же, как рисуется базовый слой линий в drawFrame:
   * кольца берутся аналитической кривой (сэмплируем её ломаной), обычные
   * перегоны — с параллельным сдвигом на общих коридорах.
   * Порт-двойник: scripts/quality/render.ts → model.segments.
   */
  const labelObstacleSegments = useMemo(() => {
    const out: LabelObstacleSegment[] = []
    const { corridorEdgeUsage, corridorEdgeKey } = corridorEdgeData

    for (const line of fullGraphLines) {
      const ids = visibleLineStationIdsByLineId.get(line.id) ?? []
      if (ids.length < 2) continue
      const isRing = RING_LINE_IDS.has(line.id)

      if (isRing) {
        const shape = resolveRingShapeForLine(line.id, ids, positionedById)
        if (shape) {
          for (let i = 0; i < LABEL_RING_SAMPLES; i += 1) {
            const t0 = (i / LABEL_RING_SAMPLES) * Math.PI * 2
            const t1 = ((i + 1) / LABEL_RING_SAMPLES) * Math.PI * 2
            const a = pointOnRingShape(shape, t0)
            const b = pointOnRingShape(shape, t1)
            out.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, lineId: line.id })
          }
          continue
        }
      }

      const segmentCount = isRing ? ids.length : ids.length - 1
      for (let i = 0; i < segmentCount; i += 1) {
        const a = positionedById.get(ids[i])
        const b = positionedById.get(ids[(i + 1) % ids.length])
        if (!a || !b) continue
        let offsetX = 0
        let offsetY = 0
        const usage = corridorEdgeUsage.get(corridorEdgeKey(a.id, b.id))
        if (usage && usage.lineIds.length > 1) {
          const dx = b.x - a.x
          const dy = b.y - a.y
          const len = Math.hypot(dx, dy)
          const index = usage.lineIds.indexOf(line.id)
          if (len > 1e-3 && index !== -1) {
            const offsetIndex = index - (usage.lineIds.length - 1) / 2
            offsetX = (-dy / len) * CORRIDOR_OFFSET_WORLD * offsetIndex
            offsetY = (dx / len) * CORRIDOR_OFFSET_WORLD * offsetIndex
          }
        }
        out.push({
          ax: a.x + offsetX,
          ay: a.y + offsetY,
          bx: b.x + offsetX,
          by: b.y + offsetY,
          lineId: line.id,
        })
      }
    }
    return out
  }, [visibleLineStationIdsByLineId, positionedById, corridorEdgeData])

  const hubGroups = useMemo(() => {
    const groups = new Map<string, PositionedStation[]>()
    for (const st of positionedStations) {
      if (!st.hubId) continue
      const id = st.hubId
      const arr = groups.get(id)
      if (arr) arr.push(st)
      else groups.set(id, [st])
    }
    return groups
  }, [positionedStations])

  const worldBounds = useMemo(
    () => computeWorldBounds(positionedStations),
    [positionedStations],
  )

  const lastLayoutSnapshotRef = useRef<Record<string, { x: number; y: number }>>({})

  // Включение режима редактора обязано заново отправить снимок раскладки.
  //
  // Снимок уходит наверх только когда координаты ИЗМЕНИЛИСЬ, а контроллер
  // редактора выбрасывает накопленное, пока режим выключен. Из-за этого после
  // «смонтировались -> включили редактор» наверху не оставалось ничего: снимок
  // ушёл до включения и был стёрт, а повторно не отправлялся — координаты-то
  // те же. Кнопка «Скопировать data/layout.json» выдавала файл с нулём станций,
  // и такой файл останавливает сборку: солвер требует координаты у каждой.
  // Обнуление ref заставляет эффект ниже увидеть «изменилось» и отправить всё.
  useEffect(() => {
    if (editMode) lastLayoutSnapshotRef.current = {}
  }, [editMode])

  useEffect(() => {
    if (!onLayoutChange) return
    // T-10: в продакшене реального потребителя снапшотов нет —
    // `useNoopEditorController` отдаёт `onLayoutChange` как `noop`, а не как
    // `undefined`, поэтому проверка выше не спасала, и каждый пересчёт
    // раскладки строил снапшот всех станций — результат выбрасывался.
    // Сам редактор в прод-бандл не попадает (tree-shaking в App.tsx), так что
    // считать это имеет смысл только в dev-сборке.
    if (!import.meta.env.DEV) return

    // Станция, которую не двигали, отдаётся ИСХОДНЫМИ координатами из
    // data/layout.json (sourceX/sourceY), а не теми, что видны на экране.
    //
    // На экране лежит результат солвера: проекция колец и разведение станций
    // уже применены. Выгружая их обратно в data/layout.json, редактор скармливал
    // солверу его собственный выход, а проходы итеративные — схема не сходилась,
    // а расползалась: первое сохранение сдвигало 151 станцию на ~6px, второе
    // те же станции ещё на 24px. Теперь без правок выгрузка совпадает с файлом
    // байт в байт, а меняется ровно то, что подвинули руками.
    const snapshot: Record<string, { x: number; y: number }> = {}
    for (const st of positionedStations) {
      const base = fullGraphStationById.get(st.id)
      const untouched =
        base != null &&
        typeof base.sourceX === 'number' &&
        typeof base.sourceY === 'number' &&
        base.layoutX === st.x &&
        base.layoutY === st.y
      snapshot[st.id] = untouched
        ? { x: base.sourceX as number, y: base.sourceY as number }
        : { x: st.x, y: st.y }
    }

    const prev = lastLayoutSnapshotRef.current
    let changed = false

    const prevKeys = Object.keys(prev)
    const nextKeys = Object.keys(snapshot)
    if (prevKeys.length !== nextKeys.length) {
      changed = true
    } else {
      for (const id of nextKeys) {
        const p = prev[id]
        const n = snapshot[id]
        if (!p || !n || p.x !== n.x || p.y !== n.y) {
          changed = true
          break
        }
      }
    }

    if (!changed) return

    lastLayoutSnapshotRef.current = snapshot
    onLayoutChange(snapshot)

  }, [positionedStations, onLayoutChange, editMode])

  useEffect(() => {
    if (!editMode) {
      setSelectedStationIds([])
      setSelectionAnchorId(null)
    }
  }, [editMode])

  /**
   * Фактическая нижняя граница зума на этом экране.
   *
   * T-8: раньше кнопки зума и pinch зажимались в константу MIN_SCALE, тогда
   * как clampViewport специально разрешает отдалиться до «вся схема в кадре».
   * На узком телефоне из-за этого кнопка «−» упиралась раньше, чем pinch.
   */
  const minScaleAllowed = useMemo(() => {
    const fitScale =
      worldBounds && canvasSize.width && canvasSize.height
        ? fitScaleFor(worldBounds.width, worldBounds.height, canvasSize.width, canvasSize.height)
        : MIN_SCALE
    return Math.min(MIN_SCALE, fitScale)
  }, [worldBounds, canvasSize])

  const clampViewport = useCallback((vp: ViewportState): ViewportState => {
    const minScale = minScaleAllowed

    let scale = vp.scale
    scale = Math.min(MAX_SCALE, Math.max(minScale, scale))

    // Если ещё не знаем границы мира или размера canvas — не трогаем pan
    if (!worldBounds || !canvasSize.width || !canvasSize.height) {
      return { scale, offsetX: vp.offsetX, offsetY: vp.offsetY }
    }

    const displayWidth = canvasSize.width
    const displayHeight = canvasSize.height

    // Используем полный размер холста: схема центрируется по Canvas,
    // а не по «свободной зоне» между UI-панелями.
    const halfViewportWorldWidth = displayWidth / scale / 2
    const halfViewportWorldHeight = displayHeight / scale / 2

    const clampHalfWorldWidth = halfViewportWorldWidth * PAN_CLAMP_VIEWPORT_FRACTION
    const clampHalfWorldHeight = halfViewportWorldHeight * PAN_CLAMP_VIEWPORT_FRACTION

    // Увеличенный отступ в мировых координатах, чтобы на краях оставалось место под подписи
    const paddingWorld = 180 / scale

    // Текущий центр экрана в мировых координатах
    let centerWorldX = -vp.offsetX / scale
    let centerWorldY = -vp.offsetY / scale

    // Разрешённый диапазон для центра, чтобы карта не «улетала» за пределы точек и линий.
    // Если видимая область по какой-то оси больше карты + паддинги,
    // просто не ограничиваем центр по этой оси (оставляем как есть),
    // чтобы на очень широких/высоких экранах не блокировать панорамирование.
    const rawMinCenterX = worldBounds.minX - paddingWorld + halfViewportWorldWidth
    const rawMaxCenterX = worldBounds.maxX + paddingWorld - halfViewportWorldWidth
    const rawMinCenterY = worldBounds.minY - paddingWorld + halfViewportWorldHeight
    const rawMaxCenterY = worldBounds.maxY + paddingWorld - halfViewportWorldHeight

    const minCenterX = worldBounds.minX - paddingWorld + clampHalfWorldWidth
    const maxCenterX = worldBounds.maxX + paddingWorld - clampHalfWorldWidth
    const minCenterY = worldBounds.minY - paddingWorld + clampHalfWorldHeight
    const maxCenterY = worldBounds.maxY + paddingWorld - clampHalfWorldHeight

    if (rawMinCenterX <= rawMaxCenterX) {
      centerWorldX = Math.min(maxCenterX, Math.max(minCenterX, centerWorldX))
    }
    if (rawMinCenterY <= rawMaxCenterY) {
      centerWorldY = Math.min(maxCenterY, Math.max(minCenterY, centerWorldY))
    }

    // Возвращаемся к offsetX/offsetY так, чтобы центр экрана
    // действительно указывал на вычисленный центр мира.
    const offsetX = -centerWorldX * scale
    const offsetY = -centerWorldY * scale

    return { scale, offsetX, offsetY }
  }, [worldBounds, canvasSize, minScaleAllowed])

  useEffect(() => {
    if (editMode) return
    if (!canvasSize.width || !canvasSize.height) return
    if (!worldBounds) return

    if (routeStationIdSet.size === 0) {
      lastRouteFitRef.current = null
      return
    }

    let rafId: number | null = null
    const routeKey = Array.from(routeStationIdSet).join(',')

    const computeAutoFit = () => {
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity

      routeStationIdSet.forEach((id) => {
        const st = positionedById.get(id)
        if (!st) return
        if (st.x < minX) minX = st.x
        if (st.x > maxX) maxX = st.x
        if (st.y < minY) minY = st.y
        if (st.y > maxY) maxY = st.y
      })

      if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minY) || !Number.isFinite(maxY)) {
        return
      }

      const routeWidth = maxX - minX || 1
      const routeHeight = maxY - minY || 1
      const displayWidth = canvasSize.width
      const displayHeight = canvasSize.height

      // Небольшие safety-отступы сверху и снизу, чтобы маршрут гарантированно
      // не "подлазил" под header и поднятую шторку даже с учётом ореолов/баблов.
      const headerSafeMarginPx = 10
      const bottomSafeMarginPx = 14

      // Базовые инпуты из props для десктопа и горизонтальных отступов.
      const insetTopRaw = visibleInsets?.top ?? 0
      const insetBottomRaw = getBottomInsetPx ? getBottomInsetPx() : (visibleInsets?.bottom ?? 0)
      const insetLeftRaw = visibleInsets?.left ?? 0
      const insetRightRaw = visibleInsets?.right ?? 0

      const insetTop = Math.round(insetTopRaw + headerSafeMarginPx)
      const insetBottom = Math.round(insetBottomRaw + bottomSafeMarginPx)
      const insetLeft = Math.round(insetLeftRaw)
      const insetRight = Math.round(insetRightRaw)

      const insetKey = `${insetTop}|${insetRight}|${insetBottom}|${insetLeft}`
      const lastFit = lastRouteFitRef.current
      if (lastFit && lastFit.routeKey === routeKey && lastFit.insetKey === insetKey) {
        return insetKey
      }

      const visibleWidth = Math.max(50, displayWidth - insetLeft - insetRight)
      const visibleHeight = Math.max(50, displayHeight - insetTop - insetBottom)

      // Адаптивные внутренние отступы для автофита: на маленьком окне
      // уменьшаем вертикальные паддинги сильнее, чтобы маршрут занимал
      // почти всю доступную область между хедером и шторкой.
      const maxPaddingX = visibleWidth / 4
      const maxPaddingY = visibleHeight < 520 ? visibleHeight / 8 : visibleHeight / 4
      const paddingX = Math.min(80, maxPaddingX)
      const paddingY = Math.min(72, maxPaddingY)

      const scaleX = (visibleWidth - paddingX * 2) / routeWidth
      const scaleY = (visibleHeight - paddingY * 2) / routeHeight
      let targetScale = Math.min(scaleX, scaleY) * 0.9
      if (!Number.isFinite(targetScale) || targetScale <= 0) {
        targetScale = minScaleAllowed
      }

      // UX-4: короткий маршрут (Сокол → Аэропорт) подгонялся до предела —
      // в кадре оставалось пять подписей и цветная клякса, по которой
      // невозможно понять, где это в Москве и в какую сторону ехать.
      // Поэтому автофит дополнительно ограничен снизу по объёму контекста:
      // в кадр обязан попасть кусок схемы шириной хотя бы
      // ROUTE_MIN_CONTEXT_WORLD_SPAN мировых px. На длинном маршруте правило
      // не срабатывает — там масштаб и так мельче.
      const contextScaleCap =
        Math.min(visibleWidth, visibleHeight) / ROUTE_MIN_CONTEXT_WORLD_SPAN
      if (Number.isFinite(contextScaleCap) && contextScaleCap > 0) {
        targetScale = Math.min(targetScale, contextScaleCap)
      }

      targetScale = Math.max(
        minScaleAllowed,
        Math.min(ROUTE_AUTO_FIT_MAX_SCALE, targetScale),
      )

      const centerWorldX = (minX + maxX) / 2
      const centerWorldY = (minY + maxY) / 2

      const screenCenterX = displayWidth / 2
      const screenCenterY = displayHeight / 2
      const visibleCenterX = insetLeft + visibleWidth / 2
      const visibleCenterY = insetTop + visibleHeight / 2

      const offsetX = visibleCenterX - screenCenterX - centerWorldX * targetScale
      const offsetY = visibleCenterY - screenCenterY - centerWorldY * targetScale

      // Цель, а не прыжок: пока разъезжается шторка, она пересчитывается каждый
      // кадр, и камера её плавно догоняет (см. easeViewportTo).
      easeViewportTo({ scale: targetScale, offsetX, offsetY })

      lastRouteFitRef.current = { routeKey, bottomInset: insetBottom, insetKey }
      return insetKey
    }

    if (typeof window !== 'undefined') {
      let lastInsetKey: string | null = null
      let stableFrames = 0
      let startedAt: number | null = null

      const MAX_TRACK_MS = 520
      const MAX_STABLE_FRAMES = 2
      const MIN_TRACK_MS_BEFORE_EARLY_STOP = 200

      const tick = (timestamp: number) => {
        if (startedAt == null) {
          startedAt = timestamp
        }

        const nextInsetKey = computeAutoFit() ?? null

        if (nextInsetKey === lastInsetKey) {
          stableFrames += 1
        } else {
          lastInsetKey = nextInsetKey
          stableFrames = 0
        }

        const elapsed = timestamp - startedAt
        const canStopEarly =
          elapsed >= MIN_TRACK_MS_BEFORE_EARLY_STOP && stableFrames >= MAX_STABLE_FRAMES
        if (elapsed < MAX_TRACK_MS && !canStopEarly) {
          rafId = window.requestAnimationFrame(tick)
        } else {
          rafId = null
        }
      }

      rafId = window.requestAnimationFrame(tick)
    } else {
      computeAutoFit()
    }

    return () => {
      if (rafId != null && typeof window !== 'undefined') {
        window.cancelAnimationFrame(rafId)
      }
    }
  }, [
    routeStationIdSet,
    canvasSize,
    worldBounds,
    positionedById,
    minScaleAllowed,
    visibleInsets,
    getBottomInsetPx,
    editMode,
    routeSheetOpen,
    easeViewportTo,
  ])

  useEffect(() => {
    if (editMode) return
    if (!canvasSize.width || !canvasSize.height) return
    if (!worldBounds) return
    if (routeStationIdSet.size > 0) return

    // T-2: центрируемся по id, а не по названию. Названий-дублей в схеме 43,
    // и поиск по имени брал первую попавшуюся станцию из порядка данных —
    // логика неверная и ломается при любой правке геометрии. Имя оставлено
    // только фолбэком на случай, когда id снаружи ещё не проставлен.
    const targetId = selectionMode === 'from' ? fromStationId : toStationId
    const name = selectionMode === 'from' ? fromStationName : toStationName
    const q = name?.trim().toLowerCase()
    if (!targetId && !q) return

    const targetStation = targetId
      ? positionedById.get(targetId) ?? null
      : positionedStations.find((st) => st.title.toLowerCase() === q) ?? null
    if (!targetStation) return

    const displayWidth = canvasSize.width
    const displayHeight = canvasSize.height

    const headerSafeMarginPx = 10
    const bottomSafeMarginPx = 14

    const insetTopRaw = visibleInsets?.top ?? 0
    const insetBottomRaw = getBottomInsetPx ? getBottomInsetPx() : (visibleInsets?.bottom ?? 0)
    const insetRightRaw = visibleInsets?.right ?? 0
    const insetLeftRaw = visibleInsets?.left ?? 0

    const insetTop = Math.round(insetTopRaw + headerSafeMarginPx)
    const insetBottom = Math.round(insetBottomRaw + bottomSafeMarginPx)
    const insetRight = Math.round(insetRightRaw)
    const insetLeft = Math.round(insetLeftRaw)

    const visibleWidth = Math.max(50, displayWidth - insetLeft - insetRight)
    const visibleHeight = Math.max(50, displayHeight - insetTop - insetBottom)

    const screenCenterX = displayWidth / 2
    const screenCenterY = displayHeight / 2
    const visibleCenterX = insetLeft + visibleWidth / 2
    const visibleCenterY = insetTop + visibleHeight / 2

    const prev = viewportRef.current
    const scale = Math.min(MAX_SCALE, Math.max(minScaleAllowed, prev.scale || 1))
    easeViewportTo({
      scale,
      offsetX: visibleCenterX - screenCenterX - targetStation.x * scale,
      offsetY: visibleCenterY - screenCenterY - targetStation.y * scale,
    })
  }, [
    selectionMode,
    fromStationName,
    toStationName,
    fromStationId,
    toStationId,
    positionedById,
    minScaleAllowed,
    routeStationIdSet,
    canvasSize,
    worldBounds,
    positionedStations,
    visibleInsets,
    getBottomInsetPx,
    routeSheetOpen,
    clampViewport,
    editMode,
    easeViewportTo,
  ])

  const zoomBy = (factor: number) => {
    setViewport((prev) => {
      const currentScale = prev.scale
      let nextScale = currentScale * factor
      nextScale = Math.min(MAX_SCALE, Math.max(minScaleAllowed, nextScale))
      if (nextScale === currentScale) return prev

      const centerWorldX = -prev.offsetX / currentScale
      const centerWorldY = -prev.offsetY / currentScale

      return clampViewport({
        scale: nextScale,
        offsetX: -centerWorldX * nextScale,
        offsetY: -centerWorldY * nextScale,
      })
    })
  }

  const zoomByAroundPoint = (factor: number, clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvasRectRef.current ?? canvas.getBoundingClientRect()
    canvasRectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    const centerX = rect.width / 2
    const centerY = rect.height / 2
    const xScreen = clientX - rect.left
    const yScreen = clientY - rect.top

    setViewport((prev) => {
      const currentScale = prev.scale
      let nextScale = currentScale * factor
      nextScale = Math.min(MAX_SCALE, Math.max(minScaleAllowed, nextScale))
      if (nextScale === currentScale) return prev

      const worldX = (xScreen - (centerX + prev.offsetX)) / currentScale
      const worldY = (yScreen - (centerY + prev.offsetY)) / currentScale

      const nextOffsetX = xScreen - centerX - worldX * nextScale
      const nextOffsetY = yScreen - centerY - worldY * nextScale

      return clampViewport({
        scale: nextScale,
        offsetX: nextOffsetX,
        offsetY: nextOffsetY,
      })
    })
  }

  const stopZoomClickAnimation = useCallback(() => {
    if (zoomClickAnimRafRef.current != null) {
      cancelAnimationFrame(zoomClickAnimRafRef.current)
      zoomClickAnimRafRef.current = null
    }
  }, [])

  const stepZoomHold = () => {
    if (zoomHoldDirectionRef.current === 0) {
      zoomHoldRafRef.current = null
      return
    }

    // Непрерывный зум по удержанию: небольшой шаг, чтобы движение было плавным и не слишком быстрым.
    const factorPerFrame = zoomHoldDirectionRef.current === 1 ? 1.005 : 1 / 1.005
    zoomBy(factorPerFrame)

    zoomHoldRafRef.current = requestAnimationFrame(stepZoomHold)
  }

  const startZoomHold = (direction: 1 | -1) => {
    zoomHoldDirectionRef.current = direction
    if (zoomHoldRafRef.current == null) {
      zoomHoldRafRef.current = requestAnimationFrame(stepZoomHold)
    }
  }

  const stopZoomHold = () => {
    zoomHoldDirectionRef.current = 0
    if (zoomHoldRafRef.current != null) {
      cancelAnimationFrame(zoomHoldRafRef.current)
      zoomHoldRafRef.current = null
    }
  }

  const clearZoomHoldTimeout = () => {
    if (zoomHoldTimeoutRef.current != null) {
      window.clearTimeout(zoomHoldTimeoutRef.current)
      zoomHoldTimeoutRef.current = null
    }
  }

  const scheduleZoomHold = (direction: 1 | -1) => {
    clearZoomHoldTimeout()
    zoomSuppressClickRef.current = false
    zoomHoldTimeoutRef.current = window.setTimeout(() => {
      zoomHoldTimeoutRef.current = null
      zoomSuppressClickRef.current = true
      startZoomHold(direction)
    }, 180)
  }

  const startZoomClickAnimation = (totalFactor: number) => {
    stopZoomClickAnimation()

    const duration = 280
    let startTime: number | null = null
    let lastEased = 0

    const step = (timestamp: number) => {
      if (startTime == null) startTime = timestamp
      const elapsed = timestamp - startTime
      const t = Math.min(1, elapsed / duration)
      const eased = 1 - (1 - t) * (1 - t) * (1 - t) // ease-out-cubic
      const delta = eased - lastEased

      if (delta > 0) {
        const frameFactor = Math.pow(totalFactor, delta)
        zoomBy(frameFactor)
        lastEased = eased
      }

      if (t < 1) {
        zoomClickAnimRafRef.current = requestAnimationFrame(step)
      } else {
        zoomClickAnimRafRef.current = null
      }
    }

    zoomClickAnimRafRef.current = requestAnimationFrame(step)
  }

  const startZoomClickAnimationAtPoint = (
    totalFactor: number,
    clientX: number,
    clientY: number,
  ) => {
    stopZoomClickAnimation()

    const duration = 280
    let startTime: number | null = null
    let lastEased = 0

    const step = (timestamp: number) => {
      if (startTime == null) startTime = timestamp
      const elapsed = timestamp - startTime
      const t = Math.min(1, elapsed / duration)
      const eased = 1 - (1 - t) * (1 - t) * (1 - t) // ease-out-cubic
      const delta = eased - lastEased

      if (delta > 0) {
        const frameFactor = Math.pow(totalFactor, delta)
        zoomByAroundPoint(frameFactor, clientX, clientY)
        lastEased = eased
      }

      if (t < 1) {
        zoomClickAnimRafRef.current = requestAnimationFrame(step)
      } else {
        zoomClickAnimRafRef.current = null
      }
    }

    zoomClickAnimRafRef.current = requestAnimationFrame(step)
  }

  useEffect(() => {
    if (!editMode) return
    if (!editorFocusCommand) return
    const { stationId, token } = editorFocusCommand
    if (token == null) return
    if (lastEditorFocusTokenRef.current === token) return
    if (!canvasSize.width || !canvasSize.height) return
    const st = positionedById.get(stationId)
    if (!st) return

    lastEditorFocusTokenRef.current = token
    stopZoomClickAnimation()

    const displayWidth = canvasSize.width
    const displayHeight = canvasSize.height
    const insetTop = visibleInsets?.top ?? 0
    const insetRight = visibleInsets?.right ?? 0
    const insetBottom = visibleInsets?.bottom ?? 0
    const insetLeft = visibleInsets?.left ?? 0

    const visibleWidth = Math.max(50, displayWidth - insetLeft - insetRight)
    const visibleHeight = Math.max(50, displayHeight - insetTop - insetBottom)

    const screenCenterX = displayWidth / 2
    const screenCenterY = displayHeight / 2
    const visibleCenterX = insetLeft + visibleWidth / 2
    const visibleCenterY = insetTop + visibleHeight / 2

    setViewport((prev) => {
      const minScale = 1.25
      const nextScale = Math.min(MAX_SCALE, Math.max(prev.scale, minScale))
      const offsetX = visibleCenterX - screenCenterX - st.x * nextScale
      const offsetY = visibleCenterY - screenCenterY - st.y * nextScale
      return clampViewport({ scale: nextScale, offsetX, offsetY })
    })

    ensureAnimationLoop()

    if (typeof window === 'undefined') return

    // См. эффект пульсации маршрута: незаписанный кадр оживал после уборки.
    const rafId = window.requestAnimationFrame((ts) => {
      clickPulseRef.current = { stationId, startedAt: ts }
      ensureAnimationLoop()
    })

    return () => window.cancelAnimationFrame(rafId)
  }, [
    editMode,
    editorFocusCommand,
    canvasSize,
    visibleInsets,
    positionedById,
    clampViewport,
    stopZoomClickAnimation,
    ensureAnimationLoop,
  ])

  const getWorldPointFromMouse = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    if (!canvas) return null

    const rect = canvasRectRef.current ?? canvas.getBoundingClientRect()
    canvasRectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    const centerX = rect.width / 2
    const centerY = rect.height / 2

    const xScreen = event.clientX - rect.left
    const yScreen = event.clientY - rect.top

    const sx = xScreen - (centerX + viewport.offsetX)
    const sy = yScreen - (centerY + viewport.offsetY)

    const worldX = sx / viewport.scale
    const worldY = sy / viewport.scale
    return { x: worldX, y: worldY }
  }

  const hitTestStationAtWorldPoint = (
    worldX: number,
    worldY: number,
    worldRadiusOverride?: number,
  ): PositionedStation | null => {
    const scale = viewportRef.current?.scale || viewport.scale || 1
    const hitRadius =
      worldRadiusOverride ??
      (editMode
        ? HIT_RADIUS_EDIT_WORLD
        : Math.max(HIT_RADIUS_MIN_WORLD, HIT_RADIUS_SCREEN_PX / scale))

    let closest: PositionedStation | null = null
    let minDistSq = hitRadius * hitRadius

    for (const st of positionedStations) {
      const dx = worldX - st.x
      const dy = worldY - st.y
      const distSq = dx * dx + dy * dy
      if (distSq <= minDistSq) {
        minDistSq = distSq
        closest = st
      }
    }

    return closest
  }

  // Подгоняем схему под размер Canvas один раз при инициализации. Панель
  // маршрута и шторка — это интерфейс поверх карты, а не часть кадра: схема
  // центрируется по экрану целиком, а не по свободному от них остатку.
  useEffect(() => {
    if (!worldBounds) return

    const { width: displayWidth, height: displayHeight } = canvasSize
    if (!displayWidth || !displayHeight) return
    if (hasInitialViewport) return

    const worldWidth = worldBounds.width
    const worldHeight = worldBounds.height
    const isWidePanelLayout = displayWidth >= WIDE_PANEL_LAYOUT_MIN_WIDTH

    // Стартуем с «вся схема в кадре»: раньше здесь стоял
    // max(baseScale, INITIAL_PREFERRED_SCALE), из-за чего фит всегда
    // проигрывал 1.1 и приложение открывалось в куске центра (VQA-3).
    const fitScale = fitScaleFor(worldWidth, worldHeight, displayWidth, displayHeight)
    if (!Number.isFinite(fitScale) || fitScale <= 0) return

    // На широком макете (веб) — схема целиком, вписанная по центру экрана.
    // На узком (мобильный) — экран заполняется целиком, с лёгким
    // приближением, а не «вся схема с полями», иначе схема выглядит мелкой
    // картинкой посреди пустого поля.
    const initialScale = isWidePanelLayout
      ? Math.min(MAX_SCALE, INITIAL_PREFERRED_SCALE, fitScale)
      : Math.min(
          MAX_SCALE,
          coverScaleFor(worldWidth, worldHeight, displayWidth, displayHeight) * MOBILE_FILL_ZOOM,
        )

    // Если схема влезла целиком — центрируем её саму. Если экран так велик,
    // что фит упёрся в потолок зума, показываем центр города.
    const showsWholeMap = isWidePanelLayout && initialScale >= fitScale - 1e-6
    const centerWorldX =
      showsWholeMap || !teatralnayaWorld ? worldBounds.centerX : teatralnayaWorld.x
    const centerWorldY =
      showsWholeMap || !teatralnayaWorld ? worldBounds.centerY : teatralnayaWorld.y

    // offsetX/offsetY уже отсчитываются от центра экрана (см. clampViewport
    // ниже по файлу: offsetX = -centerWorldX * scale), поэтому без
    // добавочного screenCenterX-члена — иначе clampViewport его отбросит.
    const offsetX = -centerWorldX * initialScale
    const offsetY = -centerWorldY * initialScale

    setViewport(
      clampViewport({
        scale: initialScale,
        offsetX,
        offsetY,
      }),
    )
    setHasInitialViewport(true)
    if (!initialViewportReportedRef.current && onInitialViewportReady) {
      initialViewportReportedRef.current = true
      onInitialViewportReady()
    }
  }, [
    worldBounds,
    canvasSize,
    hasInitialViewport,
    clampViewport,
    teatralnayaWorld,
    onInitialViewportReady,
  ])

  // Перерисовка схемы при изменении вьюпорта или подсветки
  useEffect(() => {
    if (!canvasSize.width || !canvasSize.height) return
    const canvas = canvasRef.current
    const labelCanvas = labelCanvasRef.current
    if (!canvas || !labelCanvas) return
    const ctx = canvas.getContext('2d')
    const labelCtx = labelCanvas.getContext('2d')
    if (!ctx || !labelCtx) return

    const now = animationTick

    const dpr = window.devicePixelRatio || 1

    const displayWidth = canvasSize.width || viewBoxSize
    const displayHeight = canvasSize.height || viewBoxSize

    // Подгоняем внутренний размер Canvas под CSS и DPR
    const targetWidth = Math.round(displayWidth * dpr)
    const targetHeight = Math.round(displayHeight * dpr)
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth
      canvas.height = targetHeight
      const ctx = canvas.getContext('2d')
      if (ctx) {
        ctx.imageSmoothingEnabled = true
        // high-quality сглаживание для отрисованных элементов
        // (Safari/WebKit игнорирует часть значений, но не портит поведение)
        ;(ctx as CanvasRenderingContext2D & { imageSmoothingQuality?: 'low' | 'medium' | 'high' })
          .imageSmoothingQuality = 'high'
      }
    }
    if (labelCanvas.width !== targetWidth || labelCanvas.height !== targetHeight) {
      labelCanvas.width = targetWidth
      labelCanvas.height = targetHeight
      const labelCtx = labelCanvas.getContext('2d')
      if (labelCtx) {
        labelCtx.imageSmoothingEnabled = true
        ;(
          labelCtx as CanvasRenderingContext2D & {
            imageSmoothingQuality?: 'low' | 'medium' | 'high'
          }
        ).imageSmoothingQuality = 'high'
      }
    }

    // Единицы рисования в CSS-пикселях
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, displayWidth, displayHeight)

    labelCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
    labelCtx.clearRect(0, 0, displayWidth, displayHeight)

    const centerX = displayWidth / 2
    const centerY = displayHeight / 2

    ctx.save()
    ctx.translate(centerX + viewport.offsetX, centerY + viewport.offsetY)
    ctx.scale(viewport.scale, viewport.scale)

    const zoom = viewport.scale || 1
    const clampedZoom = Math.min(Math.max(zoom, 0.7), 2.2)
    const zoomT = (clampedZoom - 0.7) / (2.2 - 0.7)
    const stationScale = 0.95 + zoomT * 0.45
    const stationRadius = STATION_RADIUS * stationScale
    const stationSelectedRadius = STATION_SELECTED_RADIUS * stationScale

    const shouldDrawFarTransfers = zoom >= FAR_TRANSFERS_MIN_ZOOM
    const shouldDrawHubGroups = zoom >= HUB_GROUPS_MIN_ZOOM

    // Подписи рисуются в мировых координатах фиксированным размером,
    // чтобы при зуме их положение и относительный размер к схеме оставались стабильными.
    const labelFontPx = LABEL_BASE_FONT_PX

    const hasRoute = routeEdgeKeySet.size > 0 || routeStationIdSet.size > 0

    const {
      strongLabelColor,
      weakLabelColor,
      lineHaloColor,
      stationFillColor,
      routeFallbackColor,
      routeCasingColor,
      hubLinkColor,
      endpointColorA,
      endpointColorB,
      stationSelectedHalo,
      labelHaloColor,
      hubCapsuleFillColor,
      routeBuildOverlayColor,
      routeBuildGlowColor,
      endpointShadowColor,
      endpointStrokeColor,
    } = mapThemeTokens

    // Общие коридоры: используем уже подготовленный кеш, чтобы знать, какие рёбра делят несколько линий.
    const { corridorEdgeUsage, corridorEdgeKey } = corridorEdgeData

    // Линии (базовый слой) — с учётом общих коридоров: параллельные смещения для общих рёбер.
    for (const line of fullGraphLines) {
      const ids = line.stationIds.filter((sid) => positionedById.has(sid))
      if (ids.length < 2) continue

      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      const isRing = RING_LINE_IDS.has(line.id)
      const baseWidth = isRing ? BASE_RING_LINE_WIDTH : BASE_LINE_WIDTH
      const baseAlpha = hasRoute ? BASE_LINE_ALPHA_WITH_ROUTE : BASE_LINE_ALPHA_NO_ROUTE

      if (isRing) {
        const shape = resolveRingShapeForLine(line.id, ids, positionedById)
        if (shape) {
          // Halo
          ctx.save()
          ctx.strokeStyle = lineHaloColor
          ctx.lineWidth = baseWidth + 2.4
          ctx.globalAlpha = Math.min(1, baseAlpha * 1.35)
          ctx.beginPath()
          if (shape.kind === 'circle') {
            ctx.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2)
          } else {
            ctx.ellipse(shape.cx, shape.cy, shape.rx, shape.ry, 0, 0, Math.PI * 2)
          }
          ctx.stroke()
          ctx.restore()

          // Main stroke
          ctx.strokeStyle = line.colorHex
          ctx.lineWidth = baseWidth
          ctx.globalAlpha = baseAlpha
          ctx.beginPath()
          if (shape.kind === 'circle') {
            ctx.arc(shape.cx, shape.cy, shape.r, 0, Math.PI * 2)
          } else {
            ctx.ellipse(shape.cx, shape.cy, shape.rx, shape.ry, 0, 0, Math.PI * 2)
          }
          ctx.stroke()

          continue
        }
      }

      for (const [aId, bId] of lineStationPairs(line, isRing, (sid) => positionedById.has(sid))) {
        const a = positionedById.get(aId)
        const b = positionedById.get(bId)
        if (!a || !b) continue

        const key = corridorEdgeKey(aId, bId)
        const usage = corridorEdgeUsage.get(key)

        let offsetX = 0
        let offsetY = 0

        if (usage && usage.lineIds.length > 1) {
          const dx = b.x - a.x
          const dy = b.y - a.y
          const len = Math.sqrt(dx * dx + dy * dy)
          if (len > 1e-3) {
            const nx = -dy / len
            const ny = dx / len
            const index = usage.lineIds.indexOf(line.id)
            if (index !== -1) {
              const nLines = usage.lineIds.length
              const offsetIndex = index - (nLines - 1) / 2
              offsetX = nx * CORRIDOR_OFFSET_WORLD * offsetIndex
              offsetY = ny * CORRIDOR_OFFSET_WORLD * offsetIndex
            }
          }
        }

        // Светлый halo-подслой под основной линией
        ctx.save()
        ctx.strokeStyle = lineHaloColor
        ctx.lineWidth = baseWidth + 2.4
        ctx.globalAlpha = Math.min(1, baseAlpha * 1.35)
        ctx.beginPath()
        ctx.moveTo(a.x + offsetX, a.y + offsetY)
        ctx.lineTo(b.x + offsetX, b.y + offsetY)
        ctx.stroke()
        ctx.restore()

        // Основная цветная линия
        ctx.strokeStyle = line.colorHex
        ctx.lineWidth = baseWidth
        ctx.globalAlpha = baseAlpha
        ctx.beginPath()
        ctx.moveTo(a.x + offsetX, a.y + offsetY)
        ctx.lineTo(b.x + offsetX, b.y + offsetY)
        ctx.stroke()
      }
    }


    // Подсветка маршрута поверх базовых линий (по рёбрам маршрута)
    if (routeEdgeKeySet.size > 0) {
      let routePulseScale = 1
      let routeShadowExtra = 0

      let buildOverlayAlphaMul = 0
      let buildDashOffset = 0
      let buildProgressT = 1

      if (routePulseRef.current) {
        const elapsed = now - routePulseRef.current.startedAt
        if (elapsed > 0 && elapsed < ROUTE_PULSE_DURATION_MS) {
          const t = elapsed / ROUTE_PULSE_DURATION_MS
          const eased = 1 - (1 - t) * (1 - t)
          routePulseScale = 1 + 0.14 * (1 - t)
          routeShadowExtra = 5 * eased
        }
      }

      if (routeBuildRef.current) {
        const elapsed = now - routeBuildRef.current.startedAt
        if (elapsed >= 0 && elapsed < ROUTE_BUILD_DURATION_MS) {
          const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
          const smootherstep = (t: number) => {
            const x = clamp01(t)
            return x * x * x * (x * (x * 6 - 15) + 10)
          }

          const rampMs = 260
          const holdMs = 720
          const rampT = smootherstep(elapsed / rampMs)
          const fadeStartMs = rampMs + holdMs
          const tailMs = Math.max(1, ROUTE_BUILD_DURATION_MS - fadeStartMs)
          const fadeT = smootherstep((elapsed - fadeStartMs) / tailMs)
          const peakOverlay = 0.34
          const holdT = elapsed < fadeStartMs ? 1 : 1 - fadeT
          buildOverlayAlphaMul = peakOverlay * rampT * holdT

          buildProgressT = elapsed < fadeStartMs ? smootherstep(elapsed / fadeStartMs) : 1

          const dashT = smootherstep(elapsed / ROUTE_BUILD_DURATION_MS)
          buildDashOffset = -dashT * 120
        }
      }

      ctx.save()
      const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

      const lineRouteEdgeSet = new Set<string>()
      const routeStrokeWidth = ROUTE_LINE_WIDTH * routePulseScale

      // Дизайн-5: казинг (обводка) под маршрутом.
      //
      // Цвет маршрута задан извне — это официальный цвет линии, и менять его
      // нельзя. Поэтому серая Серпуховско-Тимирязевская на белом полотне и
      // тёмно-синяя/коричневая на чёрном оказывались на грани различимости:
      // маршрут читался наполовину, будто расчёт оборвался. Классический
      // картографический приём для случая «цвет объекта фиксирован извне» —
      // подложить под линию контур цветом, противоположным полотну. Тогда
      // порог различимости перестаёт зависеть от собственной светлоты линии.
      const routeCasingWidth = routeStrokeWidth + ROUTE_CASING_EXTRA_WIDTH

      // Проход 0 — казинг, проход 1 — цвет линии поверх него.
      for (const pass of [0, 1] as const) {
        const isCasing = pass === 0

        if (isCasing) {
          ctx.shadowColor = 'transparent'
          ctx.shadowBlur = 0
        } else {
          // Свечение под маршрутом: нейтральное сланцевое, а не брендовое
          // розовое. Цвет маршрута несут сами линии, свечение лишь отделяет
          // их от полотна.
          ctx.shadowColor = 'rgba(100, 116, 139, 0.45)'
          ctx.shadowBlur = 8 + routeShadowExtra
        }

        for (const line of fullGraphLines) {
          const ids = line.stationIds
          if (ids.length < 2) continue
          const isRing = RING_LINE_IDS.has(line.id)

          ctx.strokeStyle = isCasing ? routeCasingColor : line.colorHex
          ctx.lineWidth = isCasing ? routeCasingWidth : routeStrokeWidth
          ctx.globalAlpha = ROUTE_LINE_ALPHA
          ctx.lineCap = 'round'
          ctx.lineJoin = 'round'
          ctx.beginPath()

          let inSegment = false

          for (const [aId, bId] of lineStationPairs(line, isRing)) {
            const a = positionedById.get(aId)
            const b = positionedById.get(bId)
            if (!a || !b) continue
            const key = edgeKey(aId, bId)
            const inRoute = routeEdgeKeySet.has(key)
            if (inRoute) {
              if (isCasing) lineRouteEdgeSet.add(key)
              if (!inSegment) {
                ctx.moveTo(a.x, a.y)
                inSegment = true
              }
              ctx.lineTo(b.x, b.y)
            } else if (inSegment) {
              ctx.stroke()
              ctx.beginPath()
              inSegment = false
            }
          }

          if (inSegment) {
            ctx.stroke()
          }
        }

        // Дополнительные участки маршрута, которые не лежат на последовательностях
        // станций линий (например, ручные рёбра между станциями) — отдельными отрезками.
        if (routeEdgeKeySet.size > 0) {
          ctx.lineWidth = isCasing ? routeCasingWidth : routeStrokeWidth
          ctx.globalAlpha = ROUTE_LINE_ALPHA
          ctx.lineCap = 'round'
          ctx.lineJoin = 'round'

          for (const key of routeEdgeKeySet) {
            if (lineRouteEdgeSet.has(key)) continue
            const [aId, bId] = key.split('|')
            const a = positionedById.get(aId)
            const b = positionedById.get(bId)
            if (!a || !b) continue

            if (isCasing) {
              ctx.strokeStyle = routeCasingColor
            } else {
              const sameColor = a.lineColor && a.lineColor === b.lineColor
              ctx.strokeStyle = sameColor
                ? a.lineColor
                : a.lineColor || b.lineColor || routeFallbackColor
            }

            ctx.beginPath()
            ctx.moveTo(a.x, a.y)
            ctx.lineTo(b.x, b.y)
            ctx.stroke()
          }
        }
      }

      if (buildOverlayAlphaMul > 0) {
        const orderedIds = (() => {
          if (!routeStationIds || routeStationIds.length < 2) return [] as string[]
          const ids = routeStationIds.filter((id) => positionedById.has(id))
          if (ids.length < 2) return []

          if (fromStationId && ids[0] !== fromStationId && ids[ids.length - 1] === fromStationId) {
            ids.reverse()
          }
          if (toStationId && ids[ids.length - 1] !== toStationId && ids[0] === toStationId) {
            ids.reverse()
          }
          return ids
        })()

        if (orderedIds.length >= 2) {
          const segments: { ax: number; ay: number; bx: number; by: number; len: number }[] = []
          for (let i = 0; i < orderedIds.length - 1; i += 1) {
            const a = positionedById.get(orderedIds[i])
            const b = positionedById.get(orderedIds[i + 1])
            if (!a || !b) continue
            const len = Math.hypot(b.x - a.x, b.y - a.y)
            if (len <= 1e-3) continue
            segments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, len })
          }

          let totalLen = 0
          for (const s of segments) totalLen += s.len

          if (totalLen > 1e-3) {
            const headLen = Math.max(0, Math.min(totalLen, totalLen * Math.max(0, Math.min(1, buildProgressT))))

            ctx.save()
            ctx.shadowColor = routeBuildGlowColor
            ctx.shadowBlur = 10 + routeShadowExtra
            ctx.setLineDash([26, 18])
            ctx.lineDashOffset = buildDashOffset
            ctx.strokeStyle = routeBuildOverlayColor
            ctx.lineWidth = ROUTE_LINE_WIDTH * routePulseScale * 1.14
            ctx.globalAlpha = ROUTE_LINE_ALPHA * buildOverlayAlphaMul
            ctx.lineCap = 'round'
            ctx.lineJoin = 'round'

            let remaining = headLen
            let started = false
            ctx.beginPath()
            for (const s of segments) {
              if (remaining <= 0) break
              if (!started) {
                ctx.moveTo(s.ax, s.ay)
                started = true
              }
              if (remaining >= s.len) {
                ctx.lineTo(s.bx, s.by)
                remaining -= s.len
                continue
              }
              const t = remaining / s.len
              ctx.lineTo(s.ax + (s.bx - s.ax) * t, s.ay + (s.by - s.ay) * t)
              break
            }
            if (started) ctx.stroke()

            ctx.setLineDash([])
            ctx.restore()
          }
        }
      }

      ctx.restore()

      // Дополнительная подсветка длинных пересадок, входящих в маршрут:
      // рисуем поверх общих far-переходов более яркий пунктир.
      if (shouldDrawFarTransfers && routeLongTransferEdgeKeySet.size > 0) {
        ctx.save()
        ctx.setLineDash([6, 5])
        ctx.lineWidth = ROUTE_LINE_WIDTH * 0.7
        // Тот же цвет, что у обычных far-переходов (--map-hub-link), но во всю
        // силу и более плотным пунктиром — так «своя» пересадка выделяется, не
        // вводя в схему отдельный брендовый цвет.
        ctx.strokeStyle = hubLinkColor
        ctx.globalAlpha = 1

        const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

        for (const e of fullGraphEdges) {
          if (!e.isTransfer) continue
          const key = edgeKey(e.fromStationId, e.toStationId)
          if (!routeLongTransferEdgeKeySet.has(key)) continue

        const a = positionedById.get(e.fromStationId)
        const b = positionedById.get(e.toStationId)
        if (!a || !b) continue

        // Не подсвечиваем пересадки внутри одного хаба (near-хабы).
        const aHub = a.hubId
        const bHub = b.hubId
        if (aHub && bHub && aHub === bHub) continue

          ctx.beginPath()
          ctx.moveTo(a.x, a.y)
          ctx.lineTo(b.x, b.y)
          ctx.stroke()
        }

        ctx.setLineDash([])
        ctx.restore()
      }
    }

    // Близкие пересадки (near hubs) — общий контур вокруг станций узла.
    //
    // Дизайн-11: раньше здесь рисовался серый скруглённый прямоугольник по
    // bounding box группы. Он смещался относительно кластера точек, внутрь
    // затекали чужие линии, а сами кружки прижимались к краю — графема без
    // значения, которую пользователь читает как сбой отрисовки. Ни одна схема
    // метро так узел не показывает: узел — это перемычка между станциями плюс
    // общий контур вокруг них. Теперь геометрия считается от фактических
    // координат точек: минимальное остовное дерево группы обводится толстым
    // штрихом с закруглёнными концами, поэтому фигура физически не может
    // оказаться смещённой относительно узла.
    if (shouldDrawHubGroups && hubGroups.size > 0) {
      ctx.save()

      const outerRadius = stationRadius * 1.95
      const innerRadius = Math.max(0.6, outerRadius - 1.5)

      for (const group of hubGroups.values()) {
        if (group.length < 2) continue

        // Минимальное остовное дерево (Prim, группы по 2–6 станций):
        // соединяем узел одной непрерывной перемычкой без лишних диагоналей.
        const linked = [group[0]]
        const rest = group.slice(1)
        const links: { ax: number; ay: number; bx: number; by: number }[] = []

        while (rest.length > 0) {
          let bestI = 0
          let bestFrom = linked[0]
          let bestDistSq = Infinity
          for (let i = 0; i < rest.length; i += 1) {
            for (const from of linked) {
              const dx = rest[i].x - from.x
              const dy = rest[i].y - from.y
              const d = dx * dx + dy * dy
              if (d < bestDistSq) {
                bestDistSq = d
                bestI = i
                bestFrom = from
              }
            }
          }
          const next = rest.splice(bestI, 1)[0]
          links.push({ ax: bestFrom.x, ay: bestFrom.y, bx: next.x, by: next.y })
          linked.push(next)
        }

        const isActiveHub = !hasRoute || group.some((st) => routeStationIdSet.has(st.id))
        ctx.globalAlpha = !hasRoute ? 1 : isActiveHub ? 1 : HUB_DIM_ALPHA_WHEN_ROUTE

        const strokePass = (radius: number, color: string) => {
          ctx.strokeStyle = color
          ctx.fillStyle = color
          ctx.lineCap = 'round'
          ctx.lineJoin = 'round'
          ctx.lineWidth = radius * 2
          for (const link of links) {
            ctx.beginPath()
            ctx.moveTo(link.ax, link.ay)
            ctx.lineTo(link.bx, link.by)
            ctx.stroke()
          }
          // Кружки на концах: узел из двух далеко разнесённых станций
          // иначе выглядел бы как «палка» без утолщений.
          for (const st of group) {
            ctx.beginPath()
            ctx.arc(st.x, st.y, radius, 0, Math.PI * 2)
            ctx.fill()
          }
        }

        // Контур цветом «пересадка» и подложка цветом полотна внутри него.
        strokePass(outerRadius, hubLinkColor)
        strokePass(innerRadius, hubCapsuleFillColor)
      }

      ctx.restore()
    }

    // Пироговые иконки пересадочных хабов: один центр на hubId и секторы по цветам линий.
    // Угол сектора выравниваем по направлению на станции соответствующей линии,
    // чтобы кружки оказывались примерно в середине своей цветной дуги.
    if (shouldDrawHubGroups && hubGroups.size > 0) {
      ctx.save()
      const basePieRadius = stationRadius * 1.7
      const innerPieRadius = stationRadius * 0.65

      for (const group of hubGroups.values()) {
        // Хаб из одной станции — не пересадка: «пирог» вместо обычного кружка
        // рисовал бы пересадочный узел там, где его нет. Обводка-капсула выше
        // такие группы уже пропускает, поэтому пропускаем и здесь.
        if (!group || group.length < 2) continue

        const isActiveHub =
          !hasRoute || group.some((st) => routeStationIdSet.has(st.id))
        const hubVisibility = !hasRoute ? 1 : isActiveHub ? 1 : HUB_DIM_ALPHA_WHEN_ROUTE

        let cx = 0
        let cy = 0
        for (const st of group) {
          cx += st.x
          cy += st.y
        }
        const groupCount = group.length
        if (groupCount === 0) continue
        cx /= groupCount
        cy /= groupCount

        // Для каждой линии/цвета накапливаем усреднённый угол направления на станции.
        const colorStats = new Map<string, { sx: number; sy: number }>()
        for (const st of group) {
          const color = st.lineColor
          if (!color) continue

          const dx = st.x - cx
          const dy = st.y - cy
          const r = Math.hypot(dx, dy)
          if (!r) continue

          const ang = Math.atan2(dy, dx)
          let acc = colorStats.get(color)
          if (!acc) {
            acc = { sx: 0, sy: 0 }
            colorStats.set(color, acc)
          }
          acc.sx += Math.cos(ang)
          acc.sy += Math.sin(ang)
        }

        const colorsWithAngle: { color: string; angle: number }[] = []
        for (const [color, acc] of colorStats.entries()) {
          const angle = Math.atan2(acc.sy, acc.sx)
          colorsWithAngle.push({ color, angle })
        }
        if (colorsWithAngle.length === 0) continue

        colorsWithAngle.sort((a, b) => a.angle - b.angle)

        const outerRadius = basePieRadius
        const innerRadius = innerPieRadius
        const sectorAngle = (Math.PI * 2) / colorsWithAngle.length

        // Выбираем базовый старт так, чтобы центр первого сектора совпадал с его целевым углом.
        let startAngle = colorsWithAngle[0].angle - sectorAngle / 2

        ctx.globalAlpha = HUB_PIE_BASE_ALPHA * hubVisibility

        const routeColors = new Set<string>()
        if (hasRoute) {
          for (const st of group) {
            if (routeStationIdSet.has(st.id) && st.lineColor) {
              routeColors.add(st.lineColor)
            }
          }
        }
        const hasRouteColors = hasRoute && routeColors.size > 0

        for (const { color } of colorsWithAngle) {
          const endAngle = startAngle + sectorAngle
          ctx.beginPath()
          ctx.moveTo(cx, cy)
          ctx.arc(cx, cy, outerRadius, startAngle, endAngle)
          ctx.closePath()

          if (hasRouteColors) {
            if (routeColors.has(color)) {
              ctx.globalAlpha = HUB_PIE_BASE_ALPHA * hubVisibility
              ctx.fillStyle = color
            } else {
              ctx.globalAlpha = HUB_PIE_BASE_ALPHA * hubVisibility * HUB_DIM_ALPHA_WHEN_ROUTE
              ctx.fillStyle = color
            }
          } else {
            ctx.globalAlpha = HUB_PIE_BASE_ALPHA * hubVisibility
            ctx.fillStyle = color
          }

          ctx.fill()
          startAngle = endAngle
        }

        ctx.globalAlpha = hubVisibility
        ctx.beginPath()
        ctx.arc(cx, cy, innerRadius, 0, Math.PI * 2)
        ctx.fillStyle = stationFillColor
        ctx.fill()
      }

      ctx.restore()
    }

    // Дальние пересадки (far transfers) — пунктир между станциями.
    // Цвет берём от перемычки узла (--map-hub-link), а не бывший брендовый
    // розовый: он был единственным местом схемы с розовым и вдобавок не
    // менялся между темами.
    // Используем transferKind, чтобы не рисовать служебные/внутрихабовые рёбра.
    if (shouldDrawFarTransfers) {
      ctx.save()
      ctx.setLineDash([4, 8])
      ctx.lineWidth = 0.9
      ctx.globalAlpha = 0.45
      ctx.strokeStyle = hubLinkColor
      for (const seg of farTransferSegments) {
        ctx.beginPath()
        ctx.moveTo(seg.ax, seg.ay)
        ctx.lineTo(seg.bx, seg.by)
        ctx.stroke()
      }

      ctx.restore()
    }

    // Станции: базовые кружки поверх линий/пересадок
    ctx.globalAlpha = 1
    for (const st of positionedStations) {
      ctx.save()

      const isFrom =
        (fromStationId && st.id === fromStationId) ||
        (!fromStationId && fromStationName
          ? st.title.toLowerCase() === fromStationName.toLowerCase()
          : false)
      const isTo =
        (toStationId && st.id === toStationId) ||
        (!toStationId && toStationName
          ? st.title.toLowerCase() === toStationName.toLowerCase()
          : false)
      const isEndpointSelected = !!isFrom || !!isTo
      const isHubStation = st.hubId != null
      const isOnRouteStation = hasRoute && routeStationIdSet.has(st.id)
      const isEditorSelected = selectedStationIdSet.has(st.id)

      let stationAlpha = 1
      if (hasRoute && !isEndpointSelected && !isOnRouteStation && !isEditorSelected) {
        stationAlpha = 0.45
      }
      ctx.globalAlpha = stationAlpha

      // Базовый кружок станции
      const baseRadius =
        isHubStation && shouldDrawHubGroups && !isEndpointSelected ? stationRadius * 0.75 : stationRadius
      const baseBorderWidth = STATION_BORDER_WIDTH
      const effectiveBorderWidth =
        isEditorSelected
          ? baseBorderWidth + 0.8
          : baseBorderWidth

      // Мягкий ореол под выбранной конечной станцией: подсказывает, какой
      // кружок сейчас выбран, ещё до того как пользователь найдёт бабл A/B.
      if (isEndpointSelected || isEditorSelected) {
        ctx.beginPath()
        ctx.arc(st.x, st.y, stationSelectedRadius, 0, Math.PI * 2)
        ctx.fillStyle = stationSelectedHalo
        ctx.fill()
      }

      ctx.beginPath()
      ctx.arc(st.x, st.y, baseRadius, 0, Math.PI * 2)
      ctx.fillStyle = stationFillColor
      ctx.strokeStyle = st.lineColor
      ctx.lineWidth = effectiveBorderWidth
      ctx.fill()
      ctx.stroke()

      // A11Y-1: кольцо клавиатурного фокуса. Видно, где сейчас «курсор» по
      // станциям, — иначе навигация стрелками слепая и для зрячего тоже.
      if (isCanvasKeyboardFocused && keyboardFocusStationId === st.id) {
        ctx.save()
        ctx.globalAlpha = 1
        ctx.beginPath()
        ctx.arc(st.x, st.y, stationSelectedRadius + 3.2, 0, Math.PI * 2)
        ctx.strokeStyle = labelHaloColor
        ctx.lineWidth = 4
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(st.x, st.y, stationSelectedRadius + 3.2, 0, Math.PI * 2)
        ctx.strokeStyle = strongLabelColor
        ctx.lineWidth = 2
        ctx.stroke()
        ctx.restore()
      }

      // Пульс при клике по станции (feedback для редактора/карты)
      if (clickPulseRef.current && clickPulseRef.current.stationId === st.id) {
        const elapsed = now - clickPulseRef.current.startedAt
        if (elapsed > 0 && elapsed < STATION_CLICK_PULSE_DURATION_MS) {
          const t = elapsed / STATION_CLICK_PULSE_DURATION_MS
          const eased = 1 - (1 - t) * (1 - t)
          const radius = stationSelectedRadius + 4 + eased * 5
          const alpha = (1 - t) * 0.45
          ctx.beginPath()
          ctx.arc(st.x, st.y, radius, 0, Math.PI * 2)
          ctx.strokeStyle = `rgba(248, 113, 190, ${alpha.toFixed(3)})`
          ctx.lineWidth = 2
          ctx.stroke()
        }
      }

      ctx.restore()
    }

    ctx.restore()

    // Отдельный Canvas-слой для подписей станций.
    labelCtx.save()
    // Подписи станций: отключаем их в лёгком режиме (pan/wheel-zoom), чтобы разгрузить кадр.
    // При остановке взаимодействия подписи перерисуются одним полным кадром.
    if (positionedStations.length > 0) {
      const labelZoomT = Math.min(
        1,
        Math.max(0, (zoom - MIN_SCALE) / (1.4 - MIN_SCALE || 1)),
      )
      const useWeak = labelZoomT < 0.10
      const labelColor = useWeak ? weakLabelColor : strongLabelColor

      labelCtx.font = `${LABEL_FONT_WEIGHT} ${labelFontPx.toFixed(1)}px ${LABEL_FONT_FAMILY}`
      labelCtx.textBaseline = 'middle'
      labelCtx.fillStyle = labelColor
      labelCtx.globalAlpha = 1
      labelCtx.shadowColor = 'transparent'
      labelCtx.shadowBlur = 0

      // Раскладка подписей зависит только от положения станций и размера шрифта
      // в мировых координатах и не пересчитывается при зуме.
      const isWheelZooming = isWheelZoomingRef.current
      const shouldRecomputeLabelsBase =
        !labelPlacementsRef.current.stationsRef ||
        labelPlacementsRef.current.stationsRef !== positionedStations

      const shouldRecomputeLabels = !isWheelZooming && shouldRecomputeLabelsBase

      if (shouldRecomputeLabels) {
        labelPlacementsRef.current.placements = computeStationLabelPlacements(
          // Шрифт на labelCtx уже выставлен выше — измеритель обязан видеть тот же
          // кегль, по которому потом рисуется текст.
          (text) => labelCtx.measureText(text).width,
          positionedStations,
          labelFontPx,
          labelSegmentsByStationId,
          labelObstacleSegments,
          labelRingCenters,
        )
        labelPlacementsRef.current.stationsRef = positionedStations
      }

      const labelPlacements = labelPlacementsRef.current.placements
      const shouldShowCollisionDebug = collisionDebug ?? LABEL_COLLISION_DEBUG_DEFAULT

      // Для реальной отрисовки применяем ту же мировую трансформацию,
      // что и для линий/станций.
      labelCtx.save()
      labelCtx.translate(centerX + viewport.offsetX, centerY + viewport.offsetY)
      labelCtx.scale(viewport.scale, viewport.scale)

      // Подписи лежат в мировых координатах фиксированным кеглем, поэтому на
      // малом зуме они физически схлопываются: 16px × 0.22 ≈ 3.5px на экране —
      // текст виден, но не читается (VQA-7). Ниже порога читаемости кегль
      // отматывается обратно так, чтобы на экране держался пол в
      // LABEL_MIN_SCREEN_FONT_PX.
      //
      // Раскладка при этом НЕ пересчитывается (иначе разъедется с портом в
      // scripts/quality/labelLayout.ts): увеличенные подписи начинают налезать
      // друг на друга, и лишние снимаются жадным прореживанием по важности —
      // ровно как на бумажных схемах, где на общем плане подписаны только узлы.
      //
      // Дизайн-3: сверху теперь тоже есть потолок. Кегль в мировых координатах
      // означает «на экране 16 × zoom», то есть на глубоком зуме 45–48px —
      // подписи становились крупнее любого элемента интерфейса и налезали друг
      // на друга. Ни одна схема метро и ни одна карта так не делает: кегль
      // читает человек, а не карта, поэтому он экранный. Правка живёт целиком
      // в слое отрисовки — алгоритм размещения (и его порт в
      // scripts/quality/labelLayout.ts) не тронут.
      const screenFontPx = labelFontPx * zoom
      let renderFontScale = 1
      if (screenFontPx < LABEL_MIN_SCREEN_FONT_PX) {
        renderFontScale = Math.min(
          LABEL_MAX_RENDER_UPSCALE,
          LABEL_MIN_SCREEN_FONT_PX / screenFontPx,
        )
      } else if (screenFontPx > LABEL_MAX_SCREEN_FONT_PX) {
        renderFontScale = Math.max(
          LABEL_MIN_RENDER_DOWNSCALE,
          LABEL_MAX_SCREEN_FONT_PX / screenFontPx,
        )
      }
      // Прореживание нужно только при укрупнении: уменьшенные подписи
      // расходятся сами и ничего не перекрывают.
      const shouldDeclutterLabels = renderFontScale > 1.001
      const drawFontPx = labelFontPx * renderFontScale

      if (Math.abs(renderFontScale - 1) > 0.001) {
        labelCtx.font = `${LABEL_FONT_WEIGHT} ${drawFontPx.toFixed(2)}px ${LABEL_FONT_FAMILY}`
      }

      const lineHeight = drawFontPx + 2
      const lineSpacing = drawFontPx * 0.12

      // Важные подписи (узлы, центр) занимают место первыми.
      const orderedForDraw = shouldDeclutterLabels
        ? [...labelPlacements].sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0))
        : labelPlacements
      const keptRects: { x1: number; y1: number; x2: number; y2: number }[] = []
      const declutterGap = 2 * renderFontScale

      for (const placement of orderedForDraw) {
        const text = placement.text
        if (!text) continue

        const sx = centerX + viewport.offsetX + placement.x * viewport.scale
        const sy = centerY + viewport.offsetY + placement.y * viewport.scale
        const margin = 80

        if (sx < -margin || sx > displayWidth + margin || sy < -margin || sy > displayHeight + margin) {
          continue
        }

        if (shouldDeclutterLabels) {
          // Прямоугольник подписи в мировых координатах с учётом укрупнения.
          const w = (placement.width ?? labelCtx.measureText(text).width) * renderFontScale
          const h = (placement.height ?? lineHeight) * renderFontScale
          const x1 = (placement.alignRight ? placement.x - w : placement.x) - declutterGap
          const y1 = placement.y - h / 2 - declutterGap
          const x2 = x1 + w + declutterGap * 2
          const y2 = y1 + h + declutterGap * 2

          let blocked = false
          for (const r of keptRects) {
            if (x1 < r.x2 && x2 > r.x1 && y1 < r.y2 && y2 > r.y1) {
              blocked = true
              break
            }
          }
          if (blocked) continue
          keptRects.push({ x1, y1, x2, y2 })
        }

        const importance = placement.importance ?? 0
        const onRoute =
          hasRoute &&
          placement.stationIds &&
          placement.stationIds.some((id) => routeStationIdSet.has(id))

        if (hasRoute) {
          labelCtx.fillStyle = onRoute ? strongLabelColor : weakLabelColor
        } else {
          labelCtx.fillStyle = labelColor
        }

        const baseAlpha = useWeak ? 0.7 : 0.9
        let alpha = Math.min(1, baseAlpha + importance * 0.06)
        if (hasRoute) {
          if (onRoute) {
            alpha = Math.min(1, alpha * 1.12)
          } else {
            alpha *= 0.45
          }
        }
        labelCtx.globalAlpha = alpha

        const lines = placement.lines && placement.lines.length > 0 ? placement.lines : [text]
        const totalHeight =
          lineHeight * lines.length + lineSpacing * Math.max(0, lines.length - 1)
        let currentY = placement.y - totalHeight / 2 + lineHeight / 2

        labelCtx.textAlign = placement.alignRight ? 'right' : 'left'

        // Выворотка под текстом (VQA-2). В плотном центре подпись физически
        // некуда убрать так, чтобы её не пересекала ни одна линия: часть
        // пересечений неустранима геометрически. Контрастная обводка цветом
        // полотна возвращает тексту читаемость поверх линии — ровно так же
        // сделано на бумажных схемах метро.
        const haloWidth = 3.2 * renderFontScale
        labelCtx.strokeStyle = labelHaloColor
        labelCtx.lineWidth = haloWidth
        labelCtx.lineJoin = 'round'
        labelCtx.miterLimit = 2

        const fillColor = labelCtx.fillStyle
        for (const ln of lines) {
          if (!ln) {
            currentY += lineHeight + lineSpacing
            continue
          }
          labelCtx.strokeText(ln, placement.x, currentY)
          labelCtx.fillText(ln, placement.x, currentY)
          currentY += lineHeight + lineSpacing
        }
        labelCtx.fillStyle = fillColor
      }

      if (shouldShowCollisionDebug) {
        // Прямоугольники ограничивающих рамок подписей.
        labelCtx.lineWidth = 0.7
        labelCtx.strokeStyle = 'rgba(37, 99, 235, 0.7)'
        for (const placement of labelPlacements) {
          const text = placement.text
          if (!text) continue
          const width = placement.width ?? labelCtx.measureText(text).width
          const height = placement.height ?? lineHeight
          const x1 = placement.alignRight ? placement.x - width : placement.x
          const y1 = placement.y - height / 2
          labelCtx.strokeRect(x1, y1, width, height)
        }

        // Запретные зоны вокруг станций: кружок узла плюс комфортный зазор.
        labelCtx.strokeStyle = 'rgba(220, 38, 38, 0.7)'
        labelCtx.lineWidth = 0.8
        for (const st of positionedStations) {
          const nodeRadius =
            st.hubId != null ? LABEL_NODE_RADIUS_HUB : LABEL_NODE_RADIUS_STATION
          labelCtx.beginPath()
          labelCtx.arc(st.x, st.y, nodeRadius + LABEL_W.clearanceGap, 0, Math.PI * 2)
          labelCtx.stroke()
        }
      }

      // Маркеры A/B для конечных станций маршрута — поверх всех слоёв.
      //
      // VQA-9 / UX-4: раньше это был «пин» — шарик на ножке над станцией. Он
      // висел выше кружка, полностью накрывал подпись конечной станции
      // («Сокол», «Аэропорт») и не показывал, к какому именно кружку
      // относится. Теперь буква сидит ровно на самой станции: перекрывать
      // соседние подписи ей больше нечем, а связь «маркер — станция»
      // однозначна. Размер зажат в экранных пикселях, чтобы на общем плане
      // буква оставалась читаемой, а на глубоком зуме не разрасталась.
      const endpointBadgeWorldRadius = (() => {
        const screenRadius = Math.min(13, Math.max(8.5, stationRadius * 1.6 * zoom))
        return screenRadius / (zoom || 1)
      })()

      const drawEndpointBadgeOnLabels = (st: PositionedStation, label: 'A' | 'B') => {
        const baseColor = st.lineColor || (label === 'A' ? endpointColorA : endpointColorB)
        const r = endpointBadgeWorldRadius

        labelCtx.save()
        labelCtx.globalAlpha = 1

        // Выворотка цветом полотна: маркер читается и поверх своей линии.
        labelCtx.beginPath()
        labelCtx.arc(st.x, st.y, r + Math.max(1.2, r * 0.16), 0, Math.PI * 2)
        labelCtx.fillStyle = labelHaloColor
        labelCtx.fill()

        labelCtx.beginPath()
        labelCtx.arc(st.x, st.y, r, 0, Math.PI * 2)
        labelCtx.fillStyle = baseColor
        labelCtx.shadowColor = endpointShadowColor
        labelCtx.shadowBlur = 3
        labelCtx.fill()

        labelCtx.shadowColor = 'transparent'
        labelCtx.shadowBlur = 0
        labelCtx.lineWidth = Math.max(0.8, r * 0.14)
        labelCtx.strokeStyle = endpointStrokeColor
        labelCtx.stroke()

        labelCtx.fillStyle = '#ffffff'
        labelCtx.font = `700 ${(r * 1.28).toFixed(2)}px ${LABEL_FONT_FAMILY}`
        labelCtx.textAlign = 'center'
        labelCtx.textBaseline = 'middle'
        labelCtx.fillText(label, st.x, st.y + r * 0.04)
        labelCtx.restore()
      }

      if (fromStationId) {
        const st = positionedById.get(fromStationId)
        if (st) {
          drawEndpointBadgeOnLabels(st, 'A')
        }
      }

      if (toStationId) {
        const st = positionedById.get(toStationId)
        if (st) {
          drawEndpointBadgeOnLabels(st, 'B')
        }
      }

      labelCtx.restore()
    }

    labelCtx.restore()
  }, [
    positionedStations,
    positionedById,
    viewport,
    isPanning,
    hasDragged,
    fromStationName,
    toStationName,
    fromStationId,
    toStationId,
    routeStationIds,
    routeStationIdSet,
    selectedStationIdSet,
    routeEdgeKeySet,
    routeLongTransferEdgeKeySet,
    canvasSize,
    worldBounds,
    hasInitialViewport,
    editMode,
    collisionDebug,
    animationTick,
    mapThemeTokens,
    corridorEdgeData,
    hubGroups,
    farTransferSegments,
    labelSegmentsByStationId,
    labelObstacleSegments,
    labelRingCenters,
    keyboardFocusStationId,
    isCanvasKeyboardFocused,
  ])

  // Актуализируем внутренний размер при ресайзе окна / изменении доступного места
  useEffect(() => {
    const updateSize = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      canvasRectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      if (!rect.width || !rect.height) return
      setCanvasSize((prev) => {
        if (prev.width === rect.width && prev.height === rect.height) return prev
        return { width: rect.width, height: rect.height }
      })
    }

    updateSize()

    // Основной источник истины — ResizeObserver: он отработает и тогда, когда
    // первое измерение вернуло 0 (стили ещё не применились, вкладка в фоне,
    // холодный старт PWA). Без него размер мог никогда не пересчитаться,
    // карта не рисовалась и приложение навсегда оставалось на сплэше.
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        updateSize()
      })
      const canvas = canvasRef.current
      if (canvas) observer.observe(canvas)
      const wrapper = canvas?.parentElement
      if (wrapper) observer.observe(wrapper)
    }

    // Фолбэк для окружений без ResizeObserver и на смену ориентации.
    window.addEventListener('resize', updateSize)

    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', updateSize)
    }
  }, [])

  const stopPanInertia = () => {
    if (panInertiaRafRef.current != null) {
      cancelAnimationFrame(panInertiaRafRef.current)
      panInertiaRafRef.current = null
    }
  }

  const startPanInertia = () => {
    const { vx, vy } = panVelocityRef.current
    let speed = Math.hypot(vx, vy)
    const maxStartSpeed = 1.5
    const minStartSpeed = 0.01
    const minStopSpeed = 0.004

    // Ограничиваем только совсем экстремальные рывки, но оставляем широкий диапазон
    // для нормальных скоростей, чтобы длина инерции почти линейно зависела от speed.
    if (speed > maxStartSpeed) {
      const scale = maxStartSpeed / speed
      panVelocityRef.current = { vx: vx * scale, vy: vy * scale }
      speed = maxStartSpeed
    }

    // Для очень медленных жестов даём небольшой boost, чтобы эффект был заметен,
    // но жесты средней и высокой скорости не прижимаем к одному значению.
    if (speed > 0 && speed < minStartSpeed) {
      const scale = minStartSpeed / speed
      panVelocityRef.current = { vx: vx * scale, vy: vy * scale }
      speed = minStartSpeed
    }
    if (speed === 0) return

    stopPanInertia()

    if (wheelRafRef.current != null) {
      cancelAnimationFrame(wheelRafRef.current)
      wheelRafRef.current = null
    }

    let lastTime: number | null = null
    const friction = 0.003

    const step = (now: number) => {
      if (lastTime == null) {
        lastTime = now
        panInertiaRafRef.current = requestAnimationFrame(step)
        return
      }

      const dt = Math.min(now - lastTime, 32)
      lastTime = now

      const current = panVelocityRef.current
      const currentSpeed = Math.hypot(current.vx, current.vy)
      if (dt <= 0 || currentSpeed < minStopSpeed) {
        stopPanInertia()
        return
      }

      const decay = Math.exp(-friction * dt)
      const vxNext = current.vx * decay
      const vyNext = current.vy * decay
      panVelocityRef.current = { vx: vxNext, vy: vyNext }

      const dx = vxNext * dt
      const dy = vyNext * dt

      viewportRef.current = clampViewport({
        ...viewportRef.current,
        offsetX: viewportRef.current.offsetX + dx,
        offsetY: viewportRef.current.offsetY + dy,
      })
      commitViewportFromRef()

      const nextSpeed = Math.hypot(vxNext, vyNext)
      if (nextSpeed < minStopSpeed) {
        stopPanInertia()
        return
      }

      panInertiaRafRef.current = requestAnimationFrame(step)
    }

    panInertiaRafRef.current = requestAnimationFrame(step)
  }

  /**
   * Отразить текущий viewportRef в состояние React (перерисовка схемы),
   * пометив значение как «своё»: обратная синхронизация не должна вернуть его
   * в ref с опозданием на кадр.
   */
  const commitViewportFromRef = useCallback(() => {
    viewportSelfWritesRef.current.add(viewportRef.current)
    setViewport(viewportRef.current)
  }, [])

  const scheduleViewportCommit = useCallback(() => {
    if (wheelRafRef.current != null) return
    wheelRafRef.current = requestAnimationFrame(() => {
      wheelRafRef.current = null
      commitViewportFromRef()
    })
  }, [commitViewportFromRef])

  /**
   * Завершение жеста колеса.
   *
   * Подписи станций во время зума не пересчитываются (лёгкий режим), а между
   * щелчками колеса пауза короткая — поэтому полный кадр возвращаем не сразу,
   * а после паузы, иначе тяжёлая раскладка подписей будет дёргаться на каждом
   * щелчке.
   */
  const finishWheelZoom = useCallback(() => {
    if (wheelZoomRafRef.current != null) {
      cancelAnimationFrame(wheelZoomRafRef.current)
      wheelZoomRafRef.current = null
    }
    wheelZoomTargetLogRef.current = null
    wheelZoomVelocityRef.current = 0
    wheelZoomLastFrameRef.current = null

    if (wheelStopTimeoutRef.current != null) {
      window.clearTimeout(wheelStopTimeoutRef.current)
      wheelStopTimeoutRef.current = null
    }
    wheelStopTimeoutRef.current = window.setTimeout(() => {
      wheelStopTimeoutRef.current = null
      isWheelZoomingRef.current = false
      if (typeof window !== 'undefined') {
        window.requestAnimationFrame((ts) => setAnimationTick(ts))
      }
    }, WHEEL_ZOOM_IDLE_MS)
  }, [])

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      if (onMapInteraction) onMapInteraction()
      // Жест забирает управление у доводки камеры немедленно: иначе она
      // продолжит тянуть к своей цели и будет спорить с рукой.
      stopViewportEase()
      event.preventDefault()

      const canvas = canvasRef.current
      if (!canvas) return

      const rect = canvasRectRef.current ?? canvas.getBoundingClientRect()
      canvasRectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }

      // 1. Нормализация ввода. deltaMode различает пиксели / строки / страницы,
      //    а тачпад и колесо дают дельты, отличающиеся на порядок: без общей
      //    единицы (пиксели прокрутки → логарифм масштаба) шаг зума «прыгает».
      const deltaPx =
        event.deltaMode === 1
          ? event.deltaY * WHEEL_LINE_HEIGHT_PX
          : event.deltaMode === 2
            ? event.deltaY * Math.max(1, rect.height)
            : event.deltaY
      if (!Number.isFinite(deltaPx) || deltaPx === 0) return

      const gain = event.ctrlKey ? WHEEL_ZOOM_PINCH_GAIN : 1
      const rawLog = -deltaPx * WHEEL_ZOOM_LOG_PER_PX * gain
      const eventLog = Math.min(
        WHEEL_ZOOM_MAX_LOG_PER_EVENT,
        Math.max(-WHEEL_ZOOM_MAX_LOG_PER_EVENT, rawLog),
      )

      wheelZoomLastClientRef.current = { x: event.clientX, y: event.clientY }

      // 2. Гасим конкурирующих писателей вьюпорта: доворот по кнопке/двойному
      //    клику и инерцию панорамирования. Иначе два цикла одновременно
      //    правят один и тот же viewport, каждый от своей базы.
      if (zoomClickAnimRafRef.current != null) {
        cancelAnimationFrame(zoomClickAnimRafRef.current)
        zoomClickAnimRafRef.current = null
      }
      if (panInertiaRafRef.current != null) {
        cancelAnimationFrame(panInertiaRafRef.current)
        panInertiaRafRef.current = null
      }

      // 3. Двигаем цель. База — уже назначенная цель (если жест идёт), иначе
      //    текущий масштаб. Цель сразу зажимается в разрешённый диапазон,
      //    поэтому на упоре не копится «невидимый долг», который потом
      //    приходится откручивать обратно.
      const minLog = Math.log(minScaleAllowed)
      const maxLog = Math.log(MAX_SCALE)
      const active = wheelZoomRafRef.current != null && wheelZoomTargetLogRef.current != null
      const baseLog = active
        ? (wheelZoomTargetLogRef.current as number)
        : Math.log(viewportRef.current.scale)
      wheelZoomTargetLogRef.current = Math.min(maxLog, Math.max(minLog, baseLog + eventLog))

      isWheelZoomingRef.current = true
      if (wheelStopTimeoutRef.current != null) {
        window.clearTimeout(wheelStopTimeoutRef.current)
        wheelStopTimeoutRef.current = null
      }

      if (wheelZoomRafRef.current != null) return

      wheelZoomLastFrameRef.current = null
      wheelZoomVelocityRef.current = 0

      const step = (now: number) => {
        wheelZoomRafRef.current = null

        const targetLogRaw = wheelZoomTargetLogRef.current
        const canvasNow = canvasRef.current
        const cursor = wheelZoomLastClientRef.current
        if (targetLogRaw == null || !canvasNow || !cursor) {
          finishWheelZoom()
          return
        }

        const lastFrame = wheelZoomLastFrameRef.current
        // dt зажат: после сворачивания вкладки или пропуска кадров не должно
        // прилетать «сразу на полсекунды» зума.
        const dt = lastFrame == null ? 16 : Math.min(50, Math.max(1, now - lastFrame))
        wheelZoomLastFrameRef.current = now

        const current = viewportRef.current
        const currentScale = current.scale
        const targetLog = Math.min(
          Math.log(MAX_SCALE),
          Math.max(Math.log(minScaleAllowed), targetLogRaw),
        )
        wheelZoomTargetLogRef.current = targetLog

        const remaining = targetLog - Math.log(currentScale)
        if (Math.abs(remaining) < WHEEL_ZOOM_EPS_LOG) {
          finishWheelZoom()
          return
        }

        let stepLog: number
        if (reducedMotionRef.current) {
          // prefers-reduced-motion: никакого доворота, шаг применяется целиком.
          stepLog = remaining
        } else {
          // Смена направления прокрутки — скорость обнуляем, иначе зум сначала
          // продолжит ехать «по инерции» в старую сторону.
          if (remaining * wheelZoomVelocityRef.current < 0) wheelZoomVelocityRef.current = 0

          const desiredVelocity = remaining / WHEEL_ZOOM_SMOOTH_MS
          const k = 1 - Math.exp(-dt / WHEEL_ZOOM_VELOCITY_TAU_MS)
          const velocity =
            wheelZoomVelocityRef.current + (desiredVelocity - wheelZoomVelocityRef.current) * k
          wheelZoomVelocityRef.current = velocity

          stepLog = velocity * dt
          // Никогда не проскакиваем цель и не тянем бесконечный хвост.
          if (
            Math.abs(remaining) <= WHEEL_ZOOM_SNAP_LOG ||
            Math.abs(stepLog) > Math.abs(remaining)
          ) {
            stepLog = remaining
          }
        }

        const rectNow = canvasRectRef.current ?? canvasNow.getBoundingClientRect()
        canvasRectRef.current = {
          left: rectNow.left,
          top: rectNow.top,
          width: rectNow.width,
          height: rectNow.height,
        }

        const nextScale = Math.min(
          MAX_SCALE,
          Math.max(minScaleAllowed, currentScale * Math.exp(stepLog)),
        )

        // Якорь считается заново от ФАКТИЧЕСКОГО вьюпорта этого кадра, а не от
        // состояния на момент события: точка под курсором остаётся на месте
        // даже если между кадрами вьюпорт подвинул clampViewport.
        const centerX = rectNow.width / 2
        const centerY = rectNow.height / 2
        const xScreen = cursor.x - rectNow.left
        const yScreen = cursor.y - rectNow.top
        const worldX = (xScreen - (centerX + current.offsetX)) / currentScale
        const worldY = (yScreen - (centerY + current.offsetY)) / currentScale

        viewportRef.current = clampViewport({
          scale: nextScale,
          offsetX: xScreen - centerX - worldX * nextScale,
          offsetY: yScreen - centerY - worldY * nextScale,
        })
        commitViewportFromRef()

        // Упёрлись в предел зума — дальше цикл крутить незачем.
        if (viewportRef.current.scale === currentScale) {
          finishWheelZoom()
          return
        }

        wheelZoomRafRef.current = requestAnimationFrame(step)
      }

      wheelZoomRafRef.current = requestAnimationFrame(step)
    },
    [
      clampViewport,
      commitViewportFromRef,
      finishWheelZoom,
      minScaleAllowed,
      onMapInteraction,
      stopViewportEase,
    ]
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const listener: EventListener = (e) => {
      handleWheel(e as WheelEvent)
    }

    canvas.addEventListener('wheel', listener, { passive: false })
    return () => {
      canvas.removeEventListener('wheel', listener)
    }
  }, [handleWheel])

  const handleZoomIn = () => {
    if (onMapInteraction) onMapInteraction()
    scheduleZoomHold(1)
  }

  const handleZoomOut = () => {
    if (onMapInteraction) onMapInteraction()
    scheduleZoomHold(-1 as 1 | -1)
  }

  const handleMouseDown: React.MouseEventHandler<HTMLCanvasElement> = (event) => {
    stopPanInertia()
    panVelocityRef.current = { vx: 0, vy: 0 }
    panLastSampleTimeRef.current = typeof event.timeStamp === 'number' ? event.timeStamp : null
    if (onMapInteraction) onMapInteraction()
    if (editMode) {
      const world = getWorldPointFromMouse(event)
      if (world) {
        const hit = hitTestStationAtWorldPoint(world.x, world.y)
        if (hit) {
          setHasDragged(false)

          const isMeta = event.metaKey || event.ctrlKey
          const isShift = event.shiftKey

          const nextSelection = new Set<string>(selectedStationIds)

          if (isMeta) {
            if (nextSelection.has(hit.id)) nextSelection.delete(hit.id)
            else nextSelection.add(hit.id)
          } else if (isShift && selectionAnchorId) {
            const anchor = positionedById.get(selectionAnchorId)
            const target = hit
            if (anchor && target && typeof anchor.lineId === 'number' && anchor.lineId === target.lineId) {
              const line = fullGraphLines.find((l) => l.id === anchor.lineId)
              if (line) {
                const ids = line.stationIds
                const startIndex = ids.indexOf(anchor.id)
                const endIndex = ids.indexOf(target.id)
                if (startIndex >= 0 && endIndex >= 0) {
                  const from = Math.min(startIndex, endIndex)
                  const to = Math.max(startIndex, endIndex)
                  for (let i = from; i <= to; i += 1) {
                    nextSelection.add(ids[i])
                  }
                } else {
                  nextSelection.add(hit.id)
                }
              } else {
                nextSelection.add(hit.id)
              }
            } else {
              nextSelection.add(hit.id)
            }
          } else {
            nextSelection.clear()
            const idsForHit: string[] =
              hit.hubId != null
                ? positionedStations.filter((st) => st.hubId === hit.hubId).map((st) => st.id)
                : [hit.id]
            for (const id of idsForHit) {
              nextSelection.add(id)
            }
          }

          let idsToDrag = Array.from(nextSelection)
          if (idsToDrag.length === 0) {
            idsToDrag = [hit.id]
            nextSelection.add(hit.id)
          }

          setSelectedStationIds(idsToDrag)
          setSelectionAnchorId(hit.id)

          const initialPositions: Record<string, { x: number; y: number }> = {}
          for (const id of idsToDrag) {
            const st = positionedById.get(id)
            if (st) {
              initialPositions[id] = { x: st.x, y: st.y }
            }
          }

          setDragStationIds(idsToDrag)
          dragInitialPositionsRef.current = initialPositions
          dragStartWorldRef.current = world

          const nextRingShapes = new Map<number, RingShape>()
          for (const id of idsToDrag) {
            const st = positionedById.get(id)
            if (!st || typeof st.lineId !== 'number' || !RING_LINE_IDS.has(st.lineId)) continue
            if (nextRingShapes.has(st.lineId)) continue
            const line = fullGraphLines.find((l) => l.id === st.lineId)
            if (!line) continue
            const shape = resolveRingShapeForLine(st.lineId, line.stationIds, positionedById)
            if (shape) nextRingShapes.set(st.lineId, shape)
          }
          dragRingShapesByLineIdRef.current = nextRingShapes

          return
        }
      }
    }

    // Если не редактируем или не попали по станции — обычный pan
    stopViewportEase()
    setIsPanning(true)
    lastPointRef.current = { x: event.clientX, y: event.clientY }
    panLastSampleTimeRef.current = null
    setHasDragged(false)
  }

  const handleMouseMove: React.MouseEventHandler<HTMLCanvasElement> = (event) => {
    if (editMode && dragStationIds && dragStartWorldRef.current) {
      const world = getWorldPointFromMouse(event)
      if (!world) return

      const dxWorld = world.x - dragStartWorldRef.current.x
      const dyWorld = world.y - dragStartWorldRef.current.y

      if (!hasDragged) {
        const distSq = dxWorld * dxWorld + dyWorld * dyWorld
        if (distSq > 1) {
          setHasDragged(true)
        }
      }

      setStationOverrides((prev) => {
        const next = { ...prev }
        const initial = dragInitialPositionsRef.current
        for (const id of dragStationIds) {
          const base = initial[id]
          if (!base) continue

          const st = positionedById.get(id)
          if (st && typeof st.lineId === 'number') {
            const shape = dragRingShapesByLineIdRef.current.get(st.lineId)
            if (shape) {
              const p = projectPointToRingShape(shape, base.x + dxWorld, base.y + dyWorld)
              next[id] = { x: p.x, y: p.y }
              continue
            }
          }

          const x = base.x + dxWorld
          const y = base.y + dyWorld
          const sx = Math.round(x / EDITOR_GRID_STEP_PX) * EDITOR_GRID_STEP_PX
          const sy = Math.round(y / EDITOR_GRID_STEP_PX) * EDITOR_GRID_STEP_PX
          next[id] = { x: sx, y: sy }
        }
        return next
      })
      return
    }

    const lastPoint = lastPointRef.current
    if (!isPanning || !lastPoint) return
    const dx = event.clientX - lastPoint.x
    const dy = event.clientY - lastPoint.y

    if (!hasDragged) {
      const distSq = dx * dx + dy * dy
      if (distSq > 9) {
        setHasDragged(true)
      }
    }

    // Обновляем скорость панорамирования для инерции
    const now = typeof event.timeStamp === 'number' ? event.timeStamp : 0
    const lastTime = panLastSampleTimeRef.current
    if (lastTime != null) {
      const dt = now - lastTime
      if (dt > 0) {
        const vxInst = dx / dt
        const vyInst = dy / dt
        const alpha = 0.35
        const prev = panVelocityRef.current
        panVelocityRef.current = {
          vx: prev.vx * (1 - alpha) + vxInst * alpha,
          vy: prev.vy * (1 - alpha) + vyInst * alpha,
        }
      }
    }
    panLastSampleTimeRef.current = now

    lastPointRef.current = { x: event.clientX, y: event.clientY }
    viewportRef.current = clampViewport({
      ...viewportRef.current,
      offsetX: viewportRef.current.offsetX + dx,
      offsetY: viewportRef.current.offsetY + dy,
    })
    scheduleViewportCommit()
  }

  const handleMouseUp: React.MouseEventHandler<HTMLCanvasElement> = () => {
    const hadDrag = hasDragged
    if (editMode && dragStationIds) {
      setDragStationIds(null)
      dragStartWorldRef.current = null
      dragInitialPositionsRef.current = {}
      dragRingShapesByLineIdRef.current = new Map()
    }
    setIsPanning(false)
    lastPointRef.current = null
    if (!editMode && hadDrag) {
      startPanInertia()
    }
  }

  const handleMouseLeave: React.MouseEventHandler<HTMLCanvasElement> = () => {
    if (editMode && dragStationIds) {
      setDragStationIds(null)
      dragStartWorldRef.current = null
      dragInitialPositionsRef.current = {}
      dragRingShapesByLineIdRef.current = new Map()
    }
    setIsPanning(false)
    lastPointRef.current = null
  }

  const getTouchPoint = (event: React.TouchEvent<HTMLCanvasElement>) => {
    const t = event.touches[0]
    return { x: t.clientX, y: t.clientY }
  }

  const getTouchDistance = (touches: React.TouchList) => {
    if (touches.length < 2) return 0
    const t1 = touches[0]
    const t2 = touches[1]
    const dx = t2.clientX - t1.clientX
    const dy = t2.clientY - t1.clientY
    return Math.sqrt(dx * dx + dy * dy)
  }

  const handleTouchStart: React.TouchEventHandler<HTMLCanvasElement> = (event) => {
    if (event.touches.length > 1) {
      multiTouchSessionRef.current = true
    }
    stopPanInertia()
    panVelocityRef.current = { vx: 0, vy: 0 }
    panLastSampleTimeRef.current = typeof event.timeStamp === 'number' ? event.timeStamp : null
    if (onMapInteraction) onMapInteraction()

    if (event.touches.length === 1) {
      const touch = event.touches[0]
      const x = touch.clientX
      const y = touch.clientY

      // Double-tap + drag: если второй тап пришёл быстро и недалеко от предыдущего, запускаем zoom-drag.
      if (!editMode) {
        const now = typeof event.timeStamp === 'number' ? event.timeStamp : 0
        const lastTime = lastTapTimeRef.current
        const lastPos = lastTapPosRef.current
        const DOUBLE_TAP_MAX_DELAY = 320
        const DOUBLE_TAP_MAX_DIST = 40

        if (lastTime != null && lastPos) {
          const dt = now - lastTime
          const dx = x - lastPos.x
          const dy = y - lastPos.y
          const distSq = dx * dx + dy * dy

          if (dt <= DOUBLE_TAP_MAX_DELAY && distSq <= DOUBLE_TAP_MAX_DIST * DOUBLE_TAP_MAX_DIST) {
            zoomDragActiveRef.current = true
            zoomDragUsedRef.current = false
            zoomDragStartScaleRef.current = viewportRef.current.scale
            zoomDragStartYRef.current = y
            zoomDragCenterClientRef.current = { x, y }
            setHasDragged(false)
            pinchStartDistanceRef.current = null
            return
          }
        }
      }

      const world = getWorldPointFromMouse({ clientX: touch.clientX, clientY: touch.clientY })

      if (editMode && world) {
        const hit = hitTestStationAtWorldPoint(world.x, world.y)
        if (hit) {
          setHasDragged(false)
          const idsToDrag: string[] =
            hit.hubId != null
              ? positionedStations.filter((st) => st.hubId === hit.hubId).map((st) => st.id)
              : [hit.id]

          const initialPositions: Record<string, { x: number; y: number }> = {}
          for (const id of idsToDrag) {
            const st = positionedById.get(id)
            if (st) {
              initialPositions[id] = { x: st.x, y: st.y }
            }
          }

          setDragStationIds(idsToDrag)
          dragInitialPositionsRef.current = initialPositions
          dragStartWorldRef.current = world

          const nextRingShapes = new Map<number, RingShape>()
          for (const id of idsToDrag) {
            const st = positionedById.get(id)
            if (!st || typeof st.lineId !== 'number' || !RING_LINE_IDS.has(st.lineId)) continue
            if (nextRingShapes.has(st.lineId)) continue
            const line = fullGraphLines.find((l) => l.id === st.lineId)
            if (!line) continue
            const shape = resolveRingShapeForLine(st.lineId, line.stationIds, positionedById)
            if (shape) nextRingShapes.set(st.lineId, shape)
          }
          dragRingShapesByLineIdRef.current = nextRingShapes

          return
        }
      }

      const p = getTouchPoint(event)
      stopViewportEase()
      setIsPanning(true)
      lastPointRef.current = p
      setHasDragged(false)
      pinchStartDistanceRef.current = null
    } else if (event.touches.length === 2) {
      const distance = getTouchDistance(event.touches)
      stopViewportEase()
      pinchStartDistanceRef.current = distance
      pinchStartScaleRef.current = viewportRef.current.scale
      pinchLastDistanceRef.current = distance
      pinchLastTimestampRef.current = typeof event.timeStamp === 'number' ? event.timeStamp : null
      pinchVelocityRef.current = 0
      const t1 = event.touches[0]
      const t2 = event.touches[1]
      const midClientX = (t1.clientX + t2.clientX) / 2
      const midClientY = (t1.clientY + t2.clientY) / 2
      const worldAtCenter = getWorldPointFromMouse({ clientX: midClientX, clientY: midClientY })
      pinchCenterWorldRef.current = worldAtCenter
      setIsPanning(false)
      lastPointRef.current = null
    }
  }

  const handleTouchMove: React.TouchEventHandler<HTMLCanvasElement> = (event) => {
    if (event.touches.length === 1 && zoomDragActiveRef.current) {
      const touch = event.touches[0]
      const center = zoomDragCenterClientRef.current
      if (!center) return

      const dy = touch.clientY - zoomDragStartYRef.current
      const baseScale = zoomDragStartScaleRef.current
      const SENSITIVITY = 220 // чем больше, тем медленнее меняется масштаб от вертикального движения

      // Игнорируем совсем маленькие движения, чтобы лёгкий дрожащий второй тап
      // не превращался в zoom-drag и не ломал простой double-tap.
      const ACTIVATE_THRESHOLD = 8
      if (!zoomDragUsedRef.current && Math.abs(dy) < ACTIVATE_THRESHOLD) {
        return
      }

      if (!zoomDragUsedRef.current) {
        zoomDragUsedRef.current = true
        setHasDragged(true)
      }

      let targetScale = baseScale * Math.pow(2, -dy / SENSITIVITY)
      targetScale = Math.min(MAX_SCALE, Math.max(minScaleAllowed, targetScale))

      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvasRectRef.current ?? canvas.getBoundingClientRect()
      canvasRectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      const centerX = rect.width / 2
      const centerY = rect.height / 2
      const xScreen = center.x - rect.left
      const yScreen = center.y - rect.top

      setViewport((prev) => {
        const currentScale = prev.scale
        if (targetScale === currentScale) return prev

        const worldX = (xScreen - (centerX + prev.offsetX)) / currentScale
        const worldY = (yScreen - (centerY + prev.offsetY)) / currentScale

        const nextOffsetX = xScreen - centerX - worldX * targetScale
        const nextOffsetY = yScreen - centerY - worldY * targetScale

        return clampViewport({
          scale: targetScale,
          offsetX: nextOffsetX,
          offsetY: nextOffsetY,
        })
      })
      return
    }
    if (event.touches.length === 1 && editMode && dragStationIds && dragStartWorldRef.current) {
      const touch = event.touches[0]
      const world = getWorldPointFromMouse({ clientX: touch.clientX, clientY: touch.clientY })
      if (!world) return

      const dxWorld = world.x - dragStartWorldRef.current.x
      const dyWorld = world.y - dragStartWorldRef.current.y

      if (!hasDragged) {
        const distSq = dxWorld * dxWorld + dyWorld * dyWorld
        if (distSq > 1) {
          setHasDragged(true)
        }
      }

      setStationOverrides((prev) => {
        const next = { ...prev }
        const initial = dragInitialPositionsRef.current
        for (const id of dragStationIds) {
          const base = initial[id]
          if (!base) continue

          const st = positionedById.get(id)
          if (st && typeof st.lineId === 'number') {
            const shape = dragRingShapesByLineIdRef.current.get(st.lineId)
            if (shape) {
              const p = projectPointToRingShape(shape, base.x + dxWorld, base.y + dyWorld)
              next[id] = { x: p.x, y: p.y }
              continue
            }
          }

          next[id] = { x: base.x + dxWorld, y: base.y + dyWorld }
        }
        return next
      })
    } else if (event.touches.length === 1 && isPanning && lastPointRef.current) {
      const p = getTouchPoint(event)
      const dx = p.x - lastPointRef.current.x
      const dy = p.y - lastPointRef.current.y

      if (!hasDragged) {
        const distSq = dx * dx + dy * dy
        if (distSq > 9) {
          setHasDragged(true)
        }
      }

      // Обновляем скорость панорамирования для инерции (тач)
      const now = typeof event.timeStamp === 'number' ? event.timeStamp : 0
      const lastTime = panLastSampleTimeRef.current
      if (lastTime != null) {
        const dt = now - lastTime
        if (dt > 0) {
          const vxInst = dx / dt
          const vyInst = dy / dt
          const alpha = 0.35
          const prev = panVelocityRef.current
          panVelocityRef.current = {
            vx: prev.vx * (1 - alpha) + vxInst * alpha,
            vy: prev.vy * (1 - alpha) + vyInst * alpha,
          }
        }
      }
      panLastSampleTimeRef.current = now

      lastPointRef.current = p
      viewportRef.current = clampViewport({
        ...viewportRef.current,
        offsetX: viewportRef.current.offsetX + dx,
        offsetY: viewportRef.current.offsetY + dy,
      })
      scheduleViewportCommit()
    } else if (event.touches.length === 2 && pinchStartDistanceRef.current) {
      const canvas = canvasRef.current
      if (!canvas) return

      const distance = getTouchDistance(event.touches)
      if (distance <= 0) return

      const now = typeof event.timeStamp === 'number' ? event.timeStamp : 0
      const lastDistance = pinchLastDistanceRef.current
      const lastTime = pinchLastTimestampRef.current
      if (lastDistance != null && lastTime != null) {
        const deltaDist = distance - lastDistance
        const dt = now - lastTime
        if (dt > 0) {
          const instantVelocity = deltaDist / dt
          const alpha = 0.35
          pinchVelocityRef.current =
            pinchVelocityRef.current * (1 - alpha) + instantVelocity * alpha
        }
      }
      pinchLastDistanceRef.current = distance
      pinchLastTimestampRef.current = now

      const ratio = distance / pinchStartDistanceRef.current
      const rawNextScale = pinchStartScaleRef.current * ratio

      const rect = canvasRectRef.current ?? canvas.getBoundingClientRect()
      canvasRectRef.current = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      const centerX = rect.width / 2
      const centerY = rect.height / 2
      const t1 = event.touches[0]
      const t2 = event.touches[1]
      const midClientX = (t1.clientX + t2.clientX) / 2
      const midClientY = (t1.clientY + t2.clientY) / 2
      const xScreen = midClientX - rect.left
      const yScreen = midClientY - rect.top
      const worldAtCenter = pinchCenterWorldRef.current

      let nextScale = rawNextScale
      nextScale = Math.min(MAX_SCALE, Math.max(minScaleAllowed, nextScale))

      const base = viewportRef.current
      let nextViewport: ViewportState
      if (!worldAtCenter) {
        nextViewport = clampViewport({ ...base, scale: nextScale })
      } else {
        const nextOffsetX = xScreen - centerX - worldAtCenter.x * nextScale
        const nextOffsetY = yScreen - centerY - worldAtCenter.y * nextScale
        nextViewport = clampViewport({
          scale: nextScale,
          offsetX: nextOffsetX,
          offsetY: nextOffsetY,
        })
      }

      viewportRef.current = nextViewport
      scheduleViewportCommit()
    }
  }

  const handleTouchEnd: React.TouchEventHandler<HTMLCanvasElement> = (event) => {
    const hadDrag = hasDragged
    if (editMode && dragStationIds) {
      setDragStationIds(null)
      dragStartWorldRef.current = null
      dragInitialPositionsRef.current = {}
      dragRingShapesByLineIdRef.current = new Map()
    }

    if (isPanning) {
      setIsPanning(false)
      lastPointRef.current = null
    }

    // S-1: жест считается многопальцевым до полного отрыва всех касаний,
    // а не только пока жив pinchStartDistanceRef.
    const hadPinch = pinchStartDistanceRef.current != null || multiTouchSessionRef.current
    const pinchJustEnded = pinchStartDistanceRef.current != null
    if (pinchStartDistanceRef.current) {
      pinchStartDistanceRef.current = null
    }

    if (pinchJustEnded) {
      const velocity = pinchVelocityRef.current
      const absVelocity = Math.abs(velocity)
      const minVelocity = 0.01
      if (absVelocity > minVelocity) {
        const maxBoost = 0.35
        const boost = Math.min(maxBoost, absVelocity * 0.12)
        if (boost > 0) {
          const totalFactor = velocity > 0 ? 1 + boost : 1 / (1 + boost)
          startZoomClickAnimation(totalFactor)
        }
      }
    }

    pinchCenterWorldRef.current = null
    pinchLastDistanceRef.current = null
    pinchLastTimestampRef.current = null
    pinchVelocityRef.current = 0

    const wasZoomDrag = zoomDragUsedRef.current
    zoomDragActiveRef.current = false
    zoomDragUsedRef.current = false
    zoomDragCenterClientRef.current = null

    // M-12: после pinch на экране мог остаться палец. Раньше pan не
    // перезапускался и карта «залипала» до полного отрыва.
    if (event.touches.length > 0) {
      if (!editMode && event.touches.length === 1) {
        const remaining = event.touches[0]
        stopViewportEase()
      setIsPanning(true)
        lastPointRef.current = { x: remaining.clientX, y: remaining.clientY }
        panLastSampleTimeRef.current = null
        panVelocityRef.current = { vx: 0, vy: 0 }
      }
      return
    }

    multiTouchSessionRef.current = false

    if (!editMode && !hadPinch && !hadDrag && !wasZoomDrag && event.changedTouches.length === 1) {
      const touch = event.changedTouches[0]
      const x = touch.clientX
      const y = touch.clientY
      const t = typeof event.timeStamp === 'number' ? event.timeStamp : undefined
      const world = getWorldPointFromMouse({ clientX: x, clientY: y })
      if (world) {
        // UX-1: палец толще курсора. Сначала обычный радиус, затем «магнит» —
        // промах рядом со станцией притягивается к ближайшей, а не остаётся
        // немым. Только для тача: мышь целится точно и лишнего притяжения
        // не ждёт.
        const scaleNow = viewportRef.current?.scale || 1

        // Второй тап double-tap'а магнитить нельзя, иначе зум по двойному
        // тапу станет недостижим: на плотной схеме станция найдётся почти
        // под любой точкой.
        const nowTs = typeof event.timeStamp === 'number' ? event.timeStamp : 0
        const prevTapTime = lastTapTimeRef.current
        const prevTapPos = lastTapPosRef.current
        const isPotentialSecondTap =
          prevTapTime != null &&
          prevTapPos != null &&
          nowTs - prevTapTime <= 320 &&
          Math.hypot(x - prevTapPos.x, y - prevTapPos.y) <= 40

        const closest =
          hitTestStationAtWorldPoint(world.x, world.y) ??
          (isPotentialSecondTap
            ? null
            : hitTestStationAtWorldPoint(
                world.x,
                world.y,
                Math.max(HIT_RADIUS_MIN_WORLD, TOUCH_MAGNET_RADIUS_SCREEN_PX / scaleNow),
              ))
        if (closest) {
          lastTouchStationClickAtRef.current = typeof event.timeStamp === 'number' ? event.timeStamp : 0
          handleStationClick(closest, { x, y, t })
          return
        }
      }
    }

    // Double-tap zoom (только для одиночного тапа без drag/pinch/zoom-drag и вне режима редактирования)
    if (!editMode && !hadPinch && !hadDrag && !wasZoomDrag && event.changedTouches.length === 1) {
      const touch = event.changedTouches[0]
      const x = touch.clientX
      const y = touch.clientY
      const now = typeof event.timeStamp === 'number' ? event.timeStamp : 0
      const lastTime = lastTapTimeRef.current
      const lastPos = lastTapPosRef.current
      const DOUBLE_TAP_MAX_DELAY = 320
      const DOUBLE_TAP_MAX_DIST = 40

      if (lastTime != null && lastPos) {
        const dt = now - lastTime
        const dx = x - lastPos.x
        const dy = y - lastPos.y
        const distSq = dx * dx + dy * dy

        if (dt <= DOUBLE_TAP_MAX_DELAY && distSq <= DOUBLE_TAP_MAX_DIST * DOUBLE_TAP_MAX_DIST) {
          // Срабатывание double-tap: зумируем к месту тапа и сбрасываем состояние.
          lastTapTimeRef.current = null
          lastTapPosRef.current = null
          const totalFactor = 2
          startZoomClickAnimationAtPoint(totalFactor, x, y)
          return
        }
      }

      // Первый тап или слишком поздний/далёкий второй тап — просто запоминаем.
      lastTapTimeRef.current = now
      lastTapPosRef.current = { x, y }
    }

    if (!editMode && hadDrag && !hadPinch && !wasZoomDrag) {
      startPanInertia()
    }
  }

  /**
   * M-11: `touchcancel` — это отмена жеста системой (шторка уведомлений,
   * краевой свайп «назад», входящий звонок). Раньше он шёл в `handleTouchEnd`
   * и мог выбрать станцию от жеста, который пользователь не завершал.
   * Здесь только гасим состояние жеста и ничего не выбираем.
   */
  const handleTouchCancel: React.TouchEventHandler<HTMLCanvasElement> = (event) => {
    if (editMode && dragStationIds) {
      setDragStationIds(null)
      dragStartWorldRef.current = null
      dragInitialPositionsRef.current = {}
      dragRingShapesByLineIdRef.current = new Map()
    }

    stopPanInertia()
    setIsPanning(false)
    setHasDragged(false)
    lastPointRef.current = null
    panVelocityRef.current = { vx: 0, vy: 0 }
    panLastSampleTimeRef.current = null

    pinchStartDistanceRef.current = null
    pinchCenterWorldRef.current = null
    pinchLastDistanceRef.current = null
    pinchLastTimestampRef.current = null
    pinchVelocityRef.current = 0

    zoomDragActiveRef.current = false
    zoomDragUsedRef.current = false
    zoomDragCenterClientRef.current = null

    // Отменённый тап не должен становиться первой половиной double-tap.
    lastTapTimeRef.current = null
    lastTapPosRef.current = null

    if (event.touches.length === 0) {
      multiTouchSessionRef.current = false
    }
  }

  const handleStationClick = (
    st: PositionedStation,
    clientPoint?: { x: number; y: number; t?: number },
  ): StationSelectOutcome | void => {
    const startedAt = clientPoint?.t
    clickPulseRef.current = { stationId: st.id, startedAt: typeof startedAt === 'number' ? startedAt : (animationTick || 0) }
    ensureAnimationLoop()
    if (devPerfEnabled) {
      console.log(
        `[perf][stationSelect] station=${st.id} t=${typeof clientPoint?.t === 'number' ? clientPoint.t.toFixed(1) : 'n/a'}`,
      )
    }
    if (editMode && onEditStationInspect) {
      onEditStationInspect(st.id)
      return
    }
    return onSelectStation(st.id, st.title, clientPoint)
  }

  const handleClick: React.MouseEventHandler<HTMLCanvasElement> = (event) => {
    if (!editMode) {
      const dt = (typeof event.timeStamp === 'number' ? event.timeStamp : 0) - lastTouchStationClickAtRef.current
      if (dt >= 0 && dt < 900) {
        return
      }
    }
    if (hasDragged) {
      return
    }

    const world = getWorldPointFromMouse(event)
    if (!world) return
    const closest = hitTestStationAtWorldPoint(world.x, world.y)
    if (closest) {
      handleStationClick(closest, {
        x: event.clientX,
        y: event.clientY,
        t: typeof event.timeStamp === 'number' ? event.timeStamp : undefined,
      })
    }
  }

  // ---------------------------------------------------------------------------
  // A11Y-1: клавиатурная навигация и текстовая альтернатива схемы.
  //
  // Canvas для скринридера — пустое место. Даём ему роль, имя, описание,
  // фокусируемость и «курсор» по станциям: стрелки переводят фокус на
  // ближайшую станцию в нужную сторону, Enter/Пробел выбирает её так же,
  // как тап. Жесты мыши и пальца при этом не меняются.
  // ---------------------------------------------------------------------------

  const describeStation = (st: PositionedStation): string => {
    const line = fullGraphLines.find((l) => l.id === st.lineId)
    const lineName = line?.title ? `, ${line.title}` : ''
    return `${st.title}${lineName}`
  }

  /** Текст для aria-live по фактическому исходу клавиатурного выбора. */
  const describeKeyboardSelectOutcome = (
    st: PositionedStation,
    outcome: StationSelectOutcome | void,
  ): string => {
    const name = describeStation(st)
    switch (outcome) {
      case 'from':
        return `${name} — выбрана как «Откуда»`
      case 'to':
        return `${name} — выбрана как «Куда»`
      case 'ask':
        return `${name}: оба поля заняты, выберите «Откуда» или «Куда» в открывшейся подсказке`
      case 'noop':
        if (fromStationId && st.id === fromStationId) {
          return `${name} уже выбрана как «Откуда»`
        }
        if (toStationId && st.id === toStationId) {
          return `${name} уже выбрана как «Куда»`
        }
        return `${name} — ничего не изменилось`
      default:
        return name
    }
  }

  const ensureStationVisible = (st: PositionedStation) => {
    const width = canvasSize.width
    const height = canvasSize.height
    if (!width || !height) return

    const vp = viewportRef.current
    const screenX = width / 2 + vp.offsetX + st.x * vp.scale
    const screenY = height / 2 + vp.offsetY + st.y * vp.scale

    const guard = 72
    const padLeft = (visibleInsets?.left ?? 0) + guard
    const padRight = (visibleInsets?.right ?? 0) + guard
    const padTop = (visibleInsets?.top ?? 0) + guard
    const padBottom = (visibleInsets?.bottom ?? 0) + guard

    let dx = 0
    let dy = 0
    if (screenX < padLeft) dx = padLeft - screenX
    else if (screenX > width - padRight) dx = width - padRight - screenX
    if (screenY < padTop) dy = padTop - screenY
    else if (screenY > height - padBottom) dy = height - padBottom - screenY

    if (dx === 0 && dy === 0) return

    easeViewportTo(
      clampViewport({ ...vp, offsetX: vp.offsetX + dx, offsetY: vp.offsetY + dy }),
    )
  }

  /**
   * Экранные координаты станции — обратная операция к getWorldPointFromMouse.
   *
   * Клавиатурный выбор обязан отдать точку так же, как тап: к ней привязаны и
   * поповер выбора поля, и всплывающая подсказка. Без точки выбор просто
   * терялся по дороге.
   */
  const getStationClientPoint = (
    st: PositionedStation,
  ): { x: number; y: number } | undefined => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const rect = canvasRectRef.current ?? canvas.getBoundingClientRect()
    const vp = viewportRef.current
    return {
      x: rect.left + rect.width / 2 + vp.offsetX + st.x * vp.scale,
      y: rect.top + rect.height / 2 + vp.offsetY + st.y * vp.scale,
    }
  }

  const focusStationForKeyboard = (st: PositionedStation) => {
    setKeyboardFocusStationId(st.id)
    ensureStationVisible(st)
    setMapAnnouncement(describeStation(st))
  }

  /** Станция, ближайшая к центру видимой области, — стартовая точка курсора. */
  const pickKeyboardEntryStation = (): PositionedStation | null => {
    if (positionedStations.length === 0) return null

    const preferredId = selectionMode === 'to' ? fromStationId : toStationId
    if (preferredId) {
      const preferred = positionedById.get(preferredId)
      if (preferred) return preferred
    }

    const width = canvasSize.width
    const height = canvasSize.height
    if (!width || !height) return positionedStations[0]

    const vp = viewportRef.current
    const centerWorldX = -vp.offsetX / vp.scale
    const centerWorldY = -vp.offsetY / vp.scale

    let best: PositionedStation | null = null
    let bestDistSq = Infinity
    for (const st of positionedStations) {
      const dx = st.x - centerWorldX
      const dy = st.y - centerWorldY
      const distSq = dx * dx + dy * dy
      if (distSq < bestDistSq) {
        bestDistSq = distSq
        best = st
      }
    }
    return best
  }

  const moveKeyboardFocus = (dirX: number, dirY: number) => {
    const current = keyboardFocusStationId ? positionedById.get(keyboardFocusStationId) : null
    if (!current) {
      const entry = pickKeyboardEntryStation()
      if (entry) focusStationForKeyboard(entry)
      return
    }

    let best: PositionedStation | null = null
    let bestCost = Infinity

    for (const st of positionedStations) {
      if (st.id === current.id) continue
      const dx = st.x - current.x
      const dy = st.y - current.y
      const dist = Math.hypot(dx, dy)
      if (dist < 1e-3) continue

      // Проекция на направление должна доминировать: иначе стрелка «вправо»
      // уводит на станцию, лежащую почти строго сверху.
      const along = (dx * dirX + dy * dirY) / dist
      if (along < 0.35) continue

      // Чем ближе станция и чем точнее она в нужной стороне, тем меньше цена.
      const cost = dist / (along * along)
      if (cost < bestCost) {
        bestCost = cost
        best = st
      }
    }

    if (best) focusStationForKeyboard(best)
  }

  const handleCanvasKeyDown: React.KeyboardEventHandler<HTMLCanvasElement> = (event) => {

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault()
        moveKeyboardFocus(-1, 0)
        return
      case 'ArrowRight':
        event.preventDefault()
        moveKeyboardFocus(1, 0)
        return
      case 'ArrowUp':
        event.preventDefault()
        moveKeyboardFocus(0, -1)
        return
      case 'ArrowDown':
        event.preventDefault()
        moveKeyboardFocus(0, 1)
        return
      case 'Enter':
      case ' ':
      case 'Spacebar': {
        const st = keyboardFocusStationId ? positionedById.get(keyboardFocusStationId) : null
        if (!st) return
        event.preventDefault()

        const point = getStationClientPoint(st)
        const outcome = handleStationClick(
          st,
          point
            ? {
                ...point,
                t: typeof event.timeStamp === 'number' ? event.timeStamp : undefined,
              }
            : undefined,
        )

        // Объявляем то, что случилось на самом деле. Раньше здесь безусловно
        // сообщался успех — даже когда выбор вообще не доходил до полей.
        setMapAnnouncement(describeKeyboardSelectOutcome(st, outcome))
        return
      }
      case '+':
      case '=':
        event.preventDefault()
        zoomBy(1.6)
        return
      case '-':
      case '_':
        event.preventDefault()
        zoomBy(1 / 1.6)
        return
      default:
        return
    }
  }

  const handleCanvasFocus: React.FocusEventHandler<HTMLCanvasElement> = () => {
    setIsCanvasKeyboardFocused(true)
    if (keyboardFocusStationId && positionedById.has(keyboardFocusStationId)) {
      const st = positionedById.get(keyboardFocusStationId)
      if (st) setMapAnnouncement(describeStation(st))
      return
    }
    const entry = pickKeyboardEntryStation()
    if (entry) focusStationForKeyboard(entry)
  }

  const handleCanvasBlur: React.FocusEventHandler<HTMLCanvasElement> = () => {
    setIsCanvasKeyboardFocused(false)
  }

  const keyboardFocusedStation = keyboardFocusStationId
    ? positionedById.get(keyboardFocusStationId) ?? null
    : null

  const mapAriaLabel = [
    'Схема метро Москвы',
    fromStationName ? `откуда: ${fromStationName}` : 'откуда: не выбрано',
    toStationName ? `куда: ${toStationName}` : 'куда: не выбрано',
    routeStationIds && routeStationIds.length > 0
      ? `построен маршрут из ${routeStationIds.length} станций`
      : null,
    keyboardFocusedStation ? `выбор на станции ${keyboardFocusedStation.title}` : null,
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <div className="metro-map-wrapper" data-selection-mode={selectionMode}>
      <canvas
        ref={canvasRef}
        className="metro-map-svg"
        width={viewBoxSize}
        height={viewBoxSize}
        tabIndex={0}
        role="application"
        aria-roledescription="Интерактивная схема метро"
        aria-label={mapAriaLabel}
        aria-describedby="metro-map-a11y-hint"
        onKeyDown={handleCanvasKeyDown}
        onFocus={handleCanvasFocus}
        onBlur={handleCanvasBlur}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        onClick={handleClick}
      />
      <canvas
        ref={labelCanvasRef}
        className="metro-map-labels"
        width={viewBoxSize}
        height={viewBoxSize}
        aria-hidden="true"
      />
      <p id="metro-map-a11y-hint" style={SR_ONLY_STYLE}>
        Схема московского метро: {positionedStations.length} станций,{' '}
        {fullGraphLines.length} линий. Управление с клавиатуры: стрелки переводят
        выбор на соседнюю станцию в этом направлении, Enter или пробел выбирает
        станцию как «{selectionMode === 'from' ? 'Откуда' : 'Куда'}», клавиши плюс
        и минус меняют масштаб. Те же станции можно выбрать в полях «Откуда» и
        «Куда» над схемой.
      </p>
      <div role="status" aria-live="polite" aria-atomic="true" style={SR_ONLY_STYLE}>
        {mapAnnouncement}
      </div>
      <div className="metro-map-zoom-controls">
        <button
          type="button"
          className="metro-map-zoom-button"
          onClick={(event) => {
            event.preventDefault()
            if (zoomSuppressClickRef.current) {
              // Клик завершает удержание — не делаем дополнительный шаг.
              zoomSuppressClickRef.current = false
              return
            }
            if (onMapInteraction) onMapInteraction()
            startZoomClickAnimation(2)
          }}
          onMouseDown={(event) => {
            event.preventDefault()
            handleZoomIn()
          }}
          onMouseUp={(event) => {
            event.preventDefault()
            clearZoomHoldTimeout()
            stopZoomHold()
          }}
          onMouseLeave={(event) => {
            event.preventDefault()
            clearZoomHoldTimeout()
            stopZoomHold()
          }}
          onTouchStart={() => {
            handleZoomIn()
          }}
          onTouchEnd={() => {
            clearZoomHoldTimeout()
            stopZoomHold()
          }}
          onTouchCancel={() => {
            clearZoomHoldTimeout()
            stopZoomHold()
          }}
          aria-label="Приблизить карту"
        >
          +
        </button>
        <button
          type="button"
          className="metro-map-zoom-button"
          onClick={(event) => {
            event.preventDefault()
            if (zoomSuppressClickRef.current) {
              zoomSuppressClickRef.current = false
              return
            }
            if (onMapInteraction) onMapInteraction()
            startZoomClickAnimation(0.5)
          }}
          onMouseDown={(event) => {
            event.preventDefault()
            handleZoomOut()
          }}
          onMouseUp={(event) => {
            event.preventDefault()
            clearZoomHoldTimeout()
            stopZoomHold()
          }}
          onMouseLeave={(event) => {
            event.preventDefault()
            clearZoomHoldTimeout()
            stopZoomHold()
          }}
          onTouchStart={() => {
            handleZoomOut()
          }}
          onTouchEnd={() => {
            clearZoomHoldTimeout()
            stopZoomHold()
          }}
          onTouchCancel={() => {
            clearZoomHoldTimeout()
            stopZoomHold()
          }}
          aria-label="Отдалить карту"
        >
          −
        </button>
      </div>
    </div>
  )
})
