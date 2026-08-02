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
