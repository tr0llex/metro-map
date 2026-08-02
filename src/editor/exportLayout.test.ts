import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { buildLayoutFile } from './exportLayout.ts'
import { fullGraphStations } from '../metro/fullGraph.ts'

const layoutPath = fileURLToPath(new URL('../../data/layout.json', import.meta.url))
const layoutOnDisk = readFileSync(layoutPath, 'utf8')

describe('buildLayoutFile — состав выгружаемого файла', () => {
  it('пишет ровно три ключа в порядке, ожидаемом солвером', () => {
    const file = buildLayoutFile({ layout: {}, canonicalRingShapes: {} })
    expect(Object.keys(file)).toEqual(['$readme', 'stations', 'rings'])
  })

  it('координаты пишутся парой [x, y], а не объектом', () => {
    const file = buildLayoutFile({
      layout: { '1/a': { x: 10.5, y: -3 } },
      canonicalRingShapes: {},
    })
    expect(file.stations).toEqual({ '1/a': [10.5, -3] })
  })

  it('ключи отсортированы: правка одной станции не должна давать диф на все', () => {
    const file = buildLayoutFile({
      layout: {
        '9/z': { x: 1, y: 1 },
        '1/a': { x: 2, y: 2 },
        '10/m': { x: 3, y: 3 },
      },
      canonicalRingShapes: {},
    })
    expect(Object.keys(file.stations)).toEqual(['1/a', '10/m', '9/z'])
  })

  it('станции с нечисловыми координатами выбрасываются, а не пишутся как null', () => {
    const file = buildLayoutFile({
      layout: {
        '1/ok': { x: 1, y: 2 },
        '1/nan': { x: Number.NaN, y: 2 },
        '1/inf': { x: 1, y: Number.POSITIVE_INFINITY },
      },
      canonicalRingShapes: {},
    })
    expect(Object.keys(file.stations)).toEqual(['1/ok'])
  })

  /**
   * Формы колец по умолчанию НЕ пишутся. Солвер подбирает их по станциям, и
   * молчаливая запись ключа переключила бы геометрию на жёстко заданную форму
   * без единого следа в выводе.
   */
  it('rings пустой, пока не попросили явно', () => {
    const shapes = { '5': { kind: 'circle' as const, cx: 1, cy: 2, r: 3 } }
    expect(buildLayoutFile({ layout: {}, canonicalRingShapes: shapes }).rings).toEqual({})
  })

  it('rings пишется по явному includeRingShapes', () => {
    const shapes = { '5': { kind: 'circle' as const, cx: 1, cy: 2, r: 3 } }
    const file = buildLayoutFile({
      layout: {},
      canonicalRingShapes: shapes,
      includeRingShapes: true,
    })
    expect(file.rings).toEqual(shapes)
  })
})

describe('круг «редактор -> data/layout.json»', () => {
  /**
   * Главная гарантия редактора: без единой правки выгрузка обязана совпасть с
   * файлом на диске ПОБАЙТОВО.
   *
   * Пока это не выполнялось, кнопка выгружала координаты, которые видит рантайм,
   * то есть результат ПОСЛЕ проекции колец и разведения станций. Вставляя их
   * обратно, человек скармливал солверу его собственный выход: первое
   * сохранение сдвигало 151 станцию из 304 на ~6px, второе — те же станции ещё
   * на 24px. Схема не сходилась, а расползалась с каждым сохранением.
   */
  it('без правок выгрузка совпадает с data/layout.json побайтово', () => {
    const layout: Record<string, { x: number; y: number }> = {}
    for (const st of fullGraphStations) {
      // Ровно то, что делает снимок раскладки для нетронутой станции.
      if (typeof st.sourceX !== 'number' || typeof st.sourceY !== 'number') continue
      layout[st.id] = { x: st.sourceX, y: st.sourceY }
    }

    const file = buildLayoutFile({ layout, canonicalRingShapes: {} })
    expect(JSON.stringify(file, null, 2) + '\n').toBe(layoutOnDisk)
  })

  it('у каждой станции графа есть исходные координаты — иначе выгрузка потеряет её', () => {
    const without = fullGraphStations
      .filter((s) => typeof s.sourceX !== 'number' || typeof s.sourceY !== 'number')
      .map((s) => s.id)
    expect(without).toEqual([])
  })

  /**
   * sourceX/sourceY — это ВХОД солвера, layoutX/layoutY — его выход. Если бы
   * они совпадали у всех станций, поле было бы бессмысленным, а если бы
   * расходились у всех — солвер переставлял бы схему целиком.
   */
  it('исходные координаты отличаются от итоговых у части станций, но не у всех', () => {
    const moved = fullGraphStations.filter(
      (s) => s.sourceX !== s.layoutX || s.sourceY !== s.layoutY,
    )
    expect(moved.length).toBeGreaterThan(0)
    expect(moved.length).toBeLessThan(fullGraphStations.length)
  })

  it('подвинутая станция попадает в выгрузку с новой координатой', () => {
    const first = fullGraphStations[0]
    const layout: Record<string, { x: number; y: number }> = {}
    for (const st of fullGraphStations) {
      layout[st.id] = { x: st.sourceX as number, y: st.sourceY as number }
    }
    layout[first.id] = { x: 4242, y: -17 }

    const file = buildLayoutFile({ layout, canonicalRingShapes: {} })
    expect(file.stations[first.id]).toEqual([4242, -17])
    // Остальные не поехали.
    const second = fullGraphStations[1]
    expect(file.stations[second.id]).toEqual([second.sourceX, second.sourceY])
  })
})
