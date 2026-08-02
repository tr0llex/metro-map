/**
 * Сторож стартового вида схемы.
 *
 * MetroMap.tsx рисует канвасом и до сих пор проверялся только визуальной
 * приёмкой скриншотами. Геометрия стартового вида — единственная его часть,
 * которую можно проверить честными числами, и она же та, где ошибка не падает,
 * а тихо портит первое впечатление: схема просто оказывается маленькой
 * картинкой посреди пустого поля.
 *
 * Проверяем три вещи:
 *  1. арифметику fitScaleFor и границ мира;
 *  2. что запас под подписи ПОКРЫВАЕТ реальный вылет подписей за габариты
 *     станций — иначе крайние названия обрежет краем экрана;
 *  3. что на типовых окнах схема действительно заполняет доступное место.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  FIT_EDGE_GUTTER_PX,
  MIN_SCALE,
  WORLD_LABEL_MARGIN_X,
  WORLD_LABEL_MARGIN_Y,
  computeInitialFitRect,
  computeWorldBounds,
  fitScaleFor,
} from './MetroMapViewportFit.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

describe('границы мира', () => {
  it('пустой набор станций — это отсутствие границ, а не нулевой прямоугольник', () => {
    // Ноль отдавать нельзя: на него потом делит fitScaleFor.
    expect(computeWorldBounds([])).toBeNull()
  })

  it('охватывает все станции и знает свой центр', () => {
    const bounds = computeWorldBounds([
      { x: -10, y: 5 },
      { x: 30, y: 5 },
      { x: 10, y: 45 },
    ])
    expect(bounds).toEqual({
      minX: -10,
      maxX: 30,
      minY: 5,
      maxY: 45,
      width: 40,
      height: 40,
      centerX: 10,
      centerY: 25,
    })
  })

  /** Схема из одной станции вырождена, но делить на её размер придётся всё равно. */
  it('вырожденный размер подменяется единицей, а не нулём', () => {
    const bounds = computeWorldBounds([{ x: 7, y: 7 }])
    expect(bounds?.width).toBe(1)
    expect(bounds?.height).toBe(1)
    expect(bounds?.centerX).toBe(7)
  })

  it('нечисловые координаты не превращаются в NaN-границы', () => {
    // NaN просочился бы в масштаб и обнулил весь вьюпорт молча.
    expect(computeWorldBounds([{ x: Number.NaN, y: 0 }])).toBeNull()
  })
})

describe('зум «вся схема в кадре»', () => {
  it('берёт ту ось, по которой теснее', () => {
    // Мир 1000x1000 плюс поля: по ширине 1280, по высоте 1080.
    // В окне 1280x1080 обе оси заполняются ровно, дальше проверяем каждую.
    expect(fitScaleFor(1000, 1000, 1280, 1080)).toBeCloseTo(1, 6)
    // Узкое окно — упираемся в ширину.
    expect(fitScaleFor(1000, 1000, 640, 1080)).toBeCloseTo(0.5, 6)
    // Низкое окно — упираемся в высоту.
    expect(fitScaleFor(1000, 1000, 1280, 540)).toBeCloseTo(0.5, 6)
  })

  /**
   * Запас разный по осям, и это не описка: подписи растут вбок, а не вверх.
   * Тест ловит попытку «упростить» формулу обратно до одного числа.
   */
  it('запас под подписи разный по горизонтали и по вертикали', () => {
    expect(WORLD_LABEL_MARGIN_X).toBeGreaterThan(WORLD_LABEL_MARGIN_Y)
    // Квадратный мир в квадратном окне: масштаб по высоте обязан выйти
    // больше, потому что вертикального запаса резервируется меньше.
    const w = fitScaleFor(1000, 1000, 1000, 1e9)
    const h = fitScaleFor(1000, 1000, 1e9, 1000)
    expect(h).toBeGreaterThan(w)
    expect(w).toBeCloseTo(1000 / (1000 + WORLD_LABEL_MARGIN_X * 2), 9)
    expect(h).toBeCloseTo(1000 / (1000 + WORLD_LABEL_MARGIN_Y * 2), 9)
  })

  it('вырожденный вход не отдаёт ноль и не отдаёт NaN', () => {
    // Ноль или NaN в масштабе — это деление на ноль в обратном
    // преобразовании координат и мгновенно пустой экран.
    expect(fitScaleFor(0, 0, 0, 0)).toBe(MIN_SCALE)
    expect(fitScaleFor(100, 100, 0, 500)).toBe(MIN_SCALE)
    expect(fitScaleFor(100, 100, 500, -1)).toBe(MIN_SCALE)
  })
})

describe('свободный прямоугольник под схему', () => {
  it('на широком макете верх и низ отдаются схеме, кроме поля по краям', () => {
    // Регресс, ради которого всё затевалось: раньше здесь глухо
    // резервировались 96px сверху и 56px снизу — 17% высоты окна 900px,
    // хотя ни шапка, ни панель маршрута карту сверху не перекрывают.
    const rect = computeInitialFitRect(1440, 900, { top: 0, right: 60, bottom: 0, left: 448 })
    expect(rect.top).toBe(FIT_EDGE_GUTTER_PX)
    expect(rect.height).toBe(900 - FIT_EDGE_GUTTER_PX * 2)
    expect(rect.left).toBe(448)
    expect(rect.width).toBe(1440 - 448 - 60)
  })

  it('измеренная шапка всё же учитывается, если она реально накрыла карту', () => {
    // Поле по краям — это минимум, а не потолок.
    const rect = computeInitialFitRect(1440, 900, { top: 96, right: 0, bottom: 0, left: 448 })
    expect(rect.top).toBe(96)
  })

  /**
   * Эффект автофита срабатывает один раз, и на первом кадре измеренные
   * инсеты ещё нулевые. Без запасной оценки левый край схемы уезжал
   * под панель маршрута.
   */
  it('нулевой измеренный левый инсет подменяется оценкой по CSS-геометрии панели', () => {
    const rect = computeInitialFitRect(1440, 900, { top: 0, right: 0, bottom: 0, left: 0 })
    expect(rect.left).toBeCloseTo(28 + 420, 6)
    expect(computeInitialFitRect(1200, 900).left).toBeCloseTo(28 + 360, 6)
    expect(computeInitialFitRect(1100, 900).left).toBeCloseTo(28 + 340, 6)
  })

  it('на телефоне резерв под шапку и шторку остаётся прежним', () => {
    // Там шторка снизу физически накрывает карту, и отдавать ей место надо.
    const rect = computeInitialFitRect(375, 812, { top: 0, right: 0, bottom: 0, left: 0 })
    expect(rect.top).toBeCloseTo(Math.min(96, 812 * 0.12), 6)
    expect(rect.height).toBeCloseTo(812 - Math.min(96, 812 * 0.12) - Math.min(210, 812 * 0.25), 6)
    expect(rect.left).toBe(0)
    expect(rect.width).toBe(375)
  })

  it('абсурдные инсеты не схлопывают прямоугольник в ноль или в минус', () => {
    const rect = computeInitialFitRect(1440, 900, { top: 0, right: 2000, bottom: 0, left: 2000 })
    expect(rect.width).toBe(50)
    expect(rect.height).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Проверки на реальных данных
// ---------------------------------------------------------------------------

/**
 * Габариты кружков станций и габариты подписей на текущей схеме.
 *
 * Подписи берутся из эталона раскладки scripts/quality/labelLayout.golden.txt:
 * это единственный записанный в репозитории результат настоящего алгоритма
 * размещения на настоящих данных. Пересчитывать раскладку прямо здесь нельзя —
 * она требует Canvas и занимает секунды, а эталон и так стережётся
 * scripts/quality/labelLayout.test.ts и обновляется вместе с раскладкой.
 */
const realGeometry = (() => {
  const graph = JSON.parse(
    readFileSync(resolve(ROOT, 'normalized', 'fullGraph.json'), 'utf8'),
  ) as {
    lines: { stationIds: string[] }[]
    stations: { id: string; lineNumericId: number | null; layoutX?: number; layoutY?: number }[]
  }

  const used = new Set<string>()
  for (const line of graph.lines) for (const id of line.stationIds) used.add(id)

  const stations = graph.stations
    .filter(
      (s) =>
        s.lineNumericId != null &&
        used.has(s.id) &&
        typeof s.layoutX === 'number' &&
        typeof s.layoutY === 'number',
    )
    .map((s) => ({ x: s.layoutX as number, y: s.layoutY as number }))

  const bounds = computeWorldBounds(stations)
  if (!bounds) throw new Error('в normalized/fullGraph.json нет станций с раскладкой')

  const golden = readFileSync(
    resolve(ROOT, 'scripts', 'quality', 'labelLayout.golden.txt'),
    'utf8',
  )
  let labelMinX = Infinity
  let labelMaxX = -Infinity
  let labelMinY = Infinity
  let labelMaxY = -Infinity
  for (const line of golden.split('\n')) {
    const m = /rect=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/.exec(line)
    if (!m) continue
    labelMinX = Math.min(labelMinX, Number(m[1]))
    labelMinY = Math.min(labelMinY, Number(m[2]))
    labelMaxX = Math.max(labelMaxX, Number(m[3]))
    labelMaxY = Math.max(labelMaxY, Number(m[4]))
  }

  return {
    bounds,
    overhang: {
      left: bounds.minX - labelMinX,
      right: labelMaxX - bounds.maxX,
      top: bounds.minY - labelMinY,
      bottom: labelMaxY - bounds.maxY,
    },
  }
})()

describe('запас под подписи на реальной схеме', () => {
  /**
   * Главный сторож правки, ради которой запас развели по осям: уменьшать его
   * дальше нельзя — крайние подписи («Пятницкое шоссе» слева, «Новокосино»
   * справа) начнёт срезать краем экрана на стартовом виде.
   */
  it('покрывает фактический вылет подписей за габариты станций', () => {
    const { overhang } = realGeometry
    expect(overhang.left).toBeGreaterThan(0)
    expect(overhang.right).toBeGreaterThan(0)
    expect(WORLD_LABEL_MARGIN_X).toBeGreaterThanOrEqual(Math.max(overhang.left, overhang.right))
    expect(WORLD_LABEL_MARGIN_Y).toBeGreaterThanOrEqual(Math.max(overhang.top, overhang.bottom))
  })

  /**
   * Обратная сторона: запас, взятый «с потолка», крадёт масштаб. Вертикальный
   * держим в пределах полутора замеренных вылетов — на укрупнение подписей на
   * малом зуме (LABEL_MIN_SCREEN_FONT_PX) этого хватает, а лишнего места
   * схема не отдаёт.
   */
  it('вертикальный запас не раздут: не больше полутора реальных вылетов', () => {
    const { overhang } = realGeometry
    const worst = Math.max(overhang.top, overhang.bottom)
    expect(WORLD_LABEL_MARGIN_Y).toBeLessThanOrEqual(worst * 1.5)
  })
})

describe('заполнение экрана на стартовом виде', () => {
  const fillFor = (
    displayWidth: number,
    displayHeight: number,
    insets: { top: number; right: number; bottom: number; left: number },
  ) => {
    const { bounds, overhang } = realGeometry
    const rect = computeInitialFitRect(displayWidth, displayHeight, insets)
    const scale = fitScaleFor(bounds.width, bounds.height, rect.width, rect.height)
    // Доступное место — это холст без боковой панели: сверху и снизу на
    // широком макете интерфейс карту не перекрывает.
    const availableWidth = displayWidth - insets.left
    return {
      scale,
      widthFill: ((bounds.width + overhang.left + overhang.right) * scale) / availableWidth,
      heightFill: ((bounds.height + overhang.top + overhang.bottom) * scale) / displayHeight,
    }
  }

  /**
   * Числа замерены в браузере на дев-сервере (playwright, bounding box
   * непрозрачных пикселей обоих канвасов). До правки было 68% ширины и 74%
   * высоты; порог поставлен ниже достигнутого, чтобы тест ловил ухудшение,
   * а не колебания раскладки в пределах пары процентов.
   */
  it('на десктопе 1440x900 схема заполняет доступное место', () => {
    const fill = fillFor(1440, 900, { top: 0, right: 60, bottom: 0, left: 448 })
    expect(fill.heightFill).toBeGreaterThan(0.9)
    expect(fill.widthFill).toBeGreaterThan(0.8)
  })

  it('на 1920x1080 схема тоже заполняет высоту, а не жмётся в центр', () => {
    const fill = fillFor(1920, 1080, { top: 0, right: 60, bottom: 0, left: 448 })
    expect(fill.heightFill).toBeGreaterThan(0.9)
  })

  /**
   * Телефон: там подгонка упирается в ширину, и схема обязана занимать её
   * целиком. Заодно сторожит, что рост горизонтального запаса под подписи
   * не сожмёт схему на узком экране — цена там платится сразу.
   */
  it('на телефоне 375x812 схема занимает всю ширину', () => {
    const fill = fillFor(375, 812, { top: 0, right: 0, bottom: 0, left: 0 })
    expect(fill.widthFill).toBeGreaterThan(0.95)
  })

  /** Схема не должна вылезать за отведённый прямоугольник ни по одной оси. */
  it('вписанная схема вместе с подписями не выходит за свободную область', () => {
    const { bounds, overhang } = realGeometry
    for (const [w, h] of [
      [1440, 900],
      [1920, 1080],
      [2560, 1440],
    ]) {
      const insets = { top: 0, right: 60, bottom: 0, left: 448 }
      const rect = computeInitialFitRect(w, h, insets)
      const scale = fitScaleFor(bounds.width, bounds.height, rect.width, rect.height)
      expect((bounds.width + overhang.left + overhang.right) * scale).toBeLessThanOrEqual(rect.width)
      expect((bounds.height + overhang.top + overhang.bottom) * scale).toBeLessThanOrEqual(
        rect.height,
      )
    }
  })
})
