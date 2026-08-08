/**
 * Геометрия стартового вида схемы: границы мира и зум «всё влезло».
 *
 * Вынесено из MetroMap.tsx не ради красоты, а чтобы это можно было проверить
 * тестом: сам MetroMap — компонент на 4700 строк с Canvas внутри, и ни одну
 * его формулу не достать без браузера. Здесь только чистые функции, поэтому
 * рядом лежит MetroMapViewportFit.test.ts.
 *
 * Отдельный модуль (а не `export` прямо из MetroMap.tsx) ещё и потому, что
 * react-refresh запрещает файлу-компоненту экспортировать что-либо кроме
 * компонентов. Префикс имени тот же, поэтому в сборке модуль попадает в
 * тот же чанк `map` (см. manualChunks в vite.config.ts).
 */

/**
 * Нижняя граница зума.
 *
 * 0.35 не давала увидеть схему целиком: ширина раскладки ~1527px, на экране
 * 390px это требует зума 0.255. Значение снижено так, чтобы «вся схема + поля»
 * была достижима даже на узком телефоне; фактический предел ещё и считается
 * динамически, а константа задаёт лишь потолок этого предела.
 */
export const MIN_SCALE = 0.18

/**
 * Запас по краям схемы под подписи станций, в мировых пикселях.
 *
 * bounding box одних только кружков — не вся нарисованная схема: подпись
 * отходит от станции до 84px (периферийная зона раскладки) и сама имеет
 * ширину. Запас РАЗНЫЙ по осям, и это не мелочь: подписи растут вбок, а не
 * вверх. Замер реальной раскладки на текущих данных (эталон
 * scripts/quality/labelLayout.golden.txt) даёт вылет за габариты станций
 * 118px влево, 137px вправо и по 29px вверх и вниз.
 *
 * Раньше по обеим осям стоял один запас 140px. По горизонтали он честный, а
 * по вертикали резервировал 140 вместо нужных 29 — то есть добавлял к высоте
 * схемы лишние 222 мировых px (12% высоты). На десктопе подгонка упирается
 * именно в высоту, поэтому эти 12% прямо уменьшали стартовый зум, и схема
 * выглядела маленькой картинкой посреди пустого поля.
 *
 * Вертикальные 40 вместо замеренных 29 — запас на укрупнение подписей на
 * малом зуме (LABEL_MIN_SCREEN_FONT_PX): на стартовом виде десктопа кегль
 * отматывается примерно в 1.15 раза, и вылет растёт вместе с ним.
 */
export const WORLD_LABEL_MARGIN_X = 140
export const WORLD_LABEL_MARGIN_Y = 40

/**
 * Поле между схемой и кромкой экрана на стартовом виде широкого макета,
 * в экранных px. Не «место под интерфейс» (его сверху и снизу нет), а просто
 * воздух: схема, упирающаяся в край окна, читается как обрезанная.
 */
export const FIT_EDGE_GUTTER_PX = 24

/**
 * Зум, при котором вся схема вместе с полями под подписи влезает в
 * прямоугольник width×height.
 *
 * Единая точка правды для стартового вьюпорта и для нижней границы зума:
 * иначе «минимальный зум» снова окажется крупнее, чем нужно, чтобы увидеть
 * схему целиком, и пользователь упрётся в предел, не досмотрев края (VQA-6).
 */
export const fitScaleFor = (
  worldWidth: number,
  worldHeight: number,
  width: number,
  height: number,
): number => {
  const w = worldWidth + WORLD_LABEL_MARGIN_X * 2
  const h = worldHeight + WORLD_LABEL_MARGIN_Y * 2
  if (w <= 0 || h <= 0 || width <= 0 || height <= 0) return MIN_SCALE
  return Math.min(width / w, height / h)
}

/**
 * Зум, при котором схема с полями под подписи заполняет прямоугольник
 * width×height целиком (кадр «обрезает» схему по короткой стороне), в
 * отличие от fitScaleFor, который вписывает схему целиком (кадр остаётся
 * с полями по длинной стороне).
 *
 * Нужен для мобильного стартового вида: там просьба — не «вся схема с
 * полями по краям», а «экран заполнен целиком, с небольшим приближением».
 */
export const coverScaleFor = (
  worldWidth: number,
  worldHeight: number,
  width: number,
  height: number,
): number => {
  const w = worldWidth + WORLD_LABEL_MARGIN_X * 2
  const h = worldHeight + WORLD_LABEL_MARGIN_Y * 2
  if (w <= 0 || h <= 0 || width <= 0 || height <= 0) return MIN_SCALE
  return Math.max(width / w, height / h)
}

/**
 * Множитель поверх «заполнить экран» на стартовом мобильном виде — лёгкое
 * приближение, чтобы схема не казалась вписанной впритык.
 */
export const MOBILE_FILL_ZOOM = 1.15

/** Отступы, занятые интерфейсом поверх карты (см. useMapVisibleInsets). */
export interface MapInsets {
  top: number
  right: number
  bottom: number
  left: number
}

/** Прямоугольник экрана, в который вписывается схема на стартовом виде. */
export interface FitRect {
  left: number
  top: number
  width: number
  height: number
}

/** Ширина холста, с которой панель маршрута переезжает сбоку вместо шторки снизу. */
export const WIDE_PANEL_LAYOUT_MIN_WIDTH = 1024

/**
 * Свободный прямоугольник под схему на стартовом виде.
 *
 * Слева на десктопе висит панель маршрута, справа — кнопки зума; фит по
 * всему холсту уводил левый край схемы под панель, то есть «влезала целиком»
 * она только формально.
 *
 * Верх и низ. На широком макете и шапка (.app-header), и панель
 * (.bottom-sheet) лежат в ОДНОЙ левой колонке и карту по вертикали не
 * перекрывают — измеренный visibleInsets.top на десктопе так и приходит
 * нулевым. Прежний глухой резерв 96px сверху и 56px снизу был данью
 * телефонной раскладке: на окне 900px он съедал 17% высоты, а подгонка на
 * десктопе упирается именно в высоту — схема оставалась маленькой картинкой
 * в пустом поле. Остаётся только поле по краям, чтобы схема не касалась
 * кромки экрана. На узком макете шторка снизу реальна, и резерв под неё
 * сохранён как был.
 *
 * Измеренные инсеты приходят из App и на первом кадре могут быть ещё
 * нулевыми, а эффект автофита отрабатывает один раз и переспросить будет
 * некому. Поэтому на широком макете есть запасная оценка левой панели по её
 * CSS-геометрии (.bottom-sheet: left 1.75rem + width clamp(340px, 30vw, 420px)).
 */
export const computeInitialFitRect = (
  displayWidth: number,
  displayHeight: number,
  visibleInsets?: Partial<MapInsets>,
): FitRect => {
  const isWidePanelLayout = displayWidth >= WIDE_PANEL_LAYOUT_MIN_WIDTH

  const measuredTop = visibleInsets?.top ?? 0
  const measuredLeft = visibleInsets?.left ?? 0
  const measuredRight = visibleInsets?.right ?? 0

  const insetTop = isWidePanelLayout
    ? Math.max(measuredTop, FIT_EDGE_GUTTER_PX)
    : Math.min(96, displayHeight * 0.12)
  const insetBottom = isWidePanelLayout
    ? FIT_EDGE_GUTTER_PX
    : Math.min(210, displayHeight * 0.25)

  const desktopPanelInset = 28 + Math.min(420, Math.max(340, displayWidth * 0.3))
  const insetLeft = isWidePanelLayout
    ? measuredLeft > 0
      ? measuredLeft
      : desktopPanelInset
    : measuredLeft
  const insetRight = measuredRight

  return {
    left: insetLeft,
    top: insetTop,
    width: Math.max(50, displayWidth - insetLeft - insetRight),
    height: Math.max(50, displayHeight - insetTop - insetBottom),
  }
}

export interface WorldBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  width: number
  height: number
  centerX: number
  centerY: number
}

/**
 * Габариты нарисованной сети по КРУЖКАМ станций (без подписей — под них
 * отвечает WORLD_LABEL_MARGIN_*). Вырожденный случай «все станции в одной
 * точке» отдаёт размер 1, а не 0: делить на него потом будет fitScaleFor.
 */
export const computeWorldBounds = (
  stations: readonly { x: number; y: number }[],
): WorldBounds | null => {
  if (stations.length === 0) return null

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity

  for (const st of stations) {
    if (st.x < minX) minX = st.x
    if (st.x > maxX) maxX = st.x
    if (st.y < minY) minY = st.y
    if (st.y > maxY) maxY = st.y
  }

  if (
    !Number.isFinite(minX) ||
    !Number.isFinite(maxX) ||
    !Number.isFinite(minY) ||
    !Number.isFinite(maxY)
  ) {
    return null
  }

  const width = maxX - minX || 1
  const height = maxY - minY || 1
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2

  return { minX, maxX, minY, maxY, width, height, centerX, centerY }
}
