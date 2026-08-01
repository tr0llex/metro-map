/**
 * Сторож раскладки подписей.
 *
 * Метрики категории «Подписи» имеют смысл только если считаются по ТОЙ ЖЕ
 * раскладке, которую видит пользователь. Раньше это обеспечивалось построчным
 * портом алгоритма в scripts/quality/ и комментарием «правьте оба места» — без
 * единой проверки. Теперь реализация одна (src/components/MetroMapLabelLayout.ts),
 * а этот файл сторожит два свойства, которые ещё могут сломаться:
 *
 *  1. КОПИЯ НЕ ВЕРНУЛАСЬ. Никто не «оптимизировал» рантайм, вставив в MetroMap.tsx
 *     или в scripts/quality/ вторую реализацию алгоритма.
 *  2. РАСКЛАДКА НЕ ИЗМЕНИЛАСЬ МОЛЧА. Результат на реальных данных
 *     (normalized/fullGraph.json) сверяется позиция-в-позицию с эталоном
 *     labelLayout.golden.txt: текст, координаты, выравнивание, разбиение на
 *     строки, важность, габариты, прямоугольник и состав станций.
 *
 * Обе реализации получают одинаковый измеритель текста: в Node нет Canvas,
 * поэтому ширина берётся из табличной метрики scripts/quality/textMetrics.ts.
 * Сравнивать с настоящим ctx.measureText нельзя — расхождение ±4% по ширине
 * дало бы ложные срабатывания на каждой второй подписи.
 *
 * Эталон перегенерируется осознанно:
 *   UPDATE_LABEL_GOLDEN=1 npx vitest run scripts/quality/labelLayout.test.ts
 *
 * Почему vitest, а не отдельная команда в CI: сторож должен срабатывать в том
 * же цикле, в котором живут остальные проверки кода. Отдельную команду надо
 * помнить и отдельно втыкать в CI — а забытый сторож не сторож. Тест же
 * запускается тем же `npx vitest run`, что и все 191 остальных, и падает с
 * конкретным списком расхождений.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { computeStationLabelPlacements } from '../../src/components/MetroMapLabelLayout.ts'
import { LABEL_BASE_FONT_PX, buildRenderModel } from './render.ts'
import { computeLabelPlacements, type LabelPlacement } from './labelLayout.ts'
import { measureText } from './textMetrics.ts'
import type { RawGraph } from './types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const GRAPH_PATH = resolve(ROOT, 'normalized', 'fullGraph.json')
const GOLDEN_PATH = resolve(HERE, 'labelLayout.golden.txt')
const LAYOUT_MODULE = resolve(ROOT, 'src', 'components', 'MetroMapLabelLayout.ts')
const SELF = resolve(HERE, 'labelLayout.test.ts')

// --------------------------------------------------------------------------
// 1. Единственность реализации
// --------------------------------------------------------------------------

/**
 * Отпечатки алгоритма раскладки: фрагменты, которые невозможно написать
 * случайно и которые обязаны встречаться ровно в одном файле репозитория.
 * Поиск нечувствителен к регистру, поэтому переименование LABEL_W → W или
 * labelPlaceOne → placeOne сторожа не обманет.
 */
const ALGORITHM_FINGERPRINTS: { name: string; re: RegExp }[] = [
  { name: 'вес наложения подписей', re: /labelOverlap:\s*60000/i },
  { name: 'вес отрыва подписи', re: /detachedStep:\s*5000/i },
  { name: 'вес перечёркивания линией', re: /lineCrossFirst:\s*10000/i },
  { name: 'подбор позиции одной подписи', re: /const\s+placeOne\s*=\s*\(\s*index:\s*number/i },
  { name: 'подсчёт перечёркивающих линий', re: /countCrossingLines\s*\(\s*x1:\s*number/i },
  { name: 'сортировка углов-кандидатов', re: /anglesSortedByMisfit\s*\(/i },
  { name: 'радиальные смещения по зонам', re: /radiusOffsetsForZone\s*\(/i },
  { name: 'точное пересечение отрезка с прямоугольником', re: /segmentIntersectsRect\s*\(/i },
  { name: 'разбиение названия на две строки', re: /splitToTwoLines\s*\(/i },
  { name: 'число углов-кандидатов', re: /CANDIDATE_ANGLE_COUNT/i },
]

function collectSourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (extname(full) === '.ts' || extname(full) === '.tsx') out.push(full)
    }
  }
  walk(resolve(ROOT, 'src'))
  walk(resolve(ROOT, 'scripts'))
  // Сам сторож содержит отпечатки в виде строк — он не реализация.
  return out.filter((f) => f !== SELF)
}

describe('раскладка подписей: единственная реализация', () => {
  const files = collectSourceFiles()
  const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))

  it.each(ALGORITHM_FINGERPRINTS)(
    'алгоритм не продублирован: $name',
    ({ re }) => {
      const owners = files.filter((f) => re.test(sources.get(f)!))
      const rel = (f: string) => f.slice(ROOT.length + 1).split('\\').join('/')
      expect(
        owners.map(rel),
        'этот кусок алгоритма обязан жить ровно в одном файле — ' +
          'src/components/MetroMapLabelLayout.ts. Если копия появилась снова, ' +
          'метрики качества снова начнут расходиться с картинкой.',
      ).toEqual([rel(LAYOUT_MODULE)])
    },
  )

  it('рантайм берёт раскладку из общего модуля, а не из своего кода', () => {
    const metroMap = readFileSync(resolve(ROOT, 'src', 'components', 'MetroMap.tsx'), 'utf8')
    expect(metroMap).toMatch(/import\s*{[^}]*computeStationLabelPlacements[^}]*}\s*from\s*'\.\/MetroMapLabelLayout'/s)
  })

  it('метрики берут раскладку из того же общего модуля', () => {
    const adapter = readFileSync(resolve(HERE, 'labelLayout.ts'), 'utf8')
    expect(adapter).toMatch(/from\s*'\.\.\/\.\.\/src\/components\/MetroMapLabelLayout\.ts'/)
  })
})

// --------------------------------------------------------------------------
// 2. Результат на реальных данных
// --------------------------------------------------------------------------

/** Одна подпись — одна строка эталона. Всё, что видит пользователь и метрики. */
function digest(p: LabelPlacement): string {
  const n = (v: number) => v.toFixed(4)
  return [
    p.text,
    p.lines.join('⏎'),
    `x=${n(p.x)}`,
    `y=${n(p.y)}`,
    p.alignRight ? 'align=right' : 'align=left',
    `imp=${p.importance}`,
    `w=${n(p.width)}`,
    `h=${n(p.height)}`,
    `rect=${n(p.rect.x1)},${n(p.rect.y1)},${n(p.rect.x2)},${n(p.rect.y2)}`,
    `zone=${n(p.zoneRadius)}`,
    `anchor=${n(p.anchorX)},${n(p.anchorY)}`,
    `ids=${p.stationIds.join('+')}`,
  ].join(' | ')
}

/** Конкретные различия двух наборов подписей — а не «не совпало». */
function describeDiff(actual: string[], expected: string[], limit = 12): string {
  const diffs: string[] = []
  const max = Math.max(actual.length, expected.length)
  for (let i = 0; i < max && diffs.length < limit; i += 1) {
    if (actual[i] === expected[i]) continue
    diffs.push(
      `  #${i}\n    ожидалось: ${expected[i] ?? '(подписи нет)'}\n    получено:  ${actual[i] ?? '(подписи нет)'}`,
    )
  }
  const total = actual.filter((line, i) => line !== expected[i]).length
  const head =
    `раскладка разошлась с эталоном: ${total} подписей из ${max}` +
    (actual.length !== expected.length ? ` (было ${expected.length}, стало ${actual.length})` : '')
  const tail = total > diffs.length ? `\n  …ещё ${total - diffs.length}` : ''
  return `${head}\n${diffs.join('\n')}${tail}\n` +
    '\nЕсли изменение раскладки осознанное — перегенерируйте эталон:\n' +
    '  UPDATE_LABEL_GOLDEN=1 npx vitest run scripts/quality/labelLayout.test.ts\n' +
    'и не забудьте npm run quality (normalized/quality_report.json — базовая линия CI).'
}

describe('раскладка подписей: результат на реальной схеме', () => {
  const graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf8')) as RawGraph
  const model = buildRenderModel(graph)
  const placements = computeLabelPlacements(model, LABEL_BASE_FONT_PX)

  it('совпадает с эталоном позиция в позицию', () => {
    const actual = placements.map(digest)
    if (process.env.UPDATE_LABEL_GOLDEN === '1') {
      writeFileSync(GOLDEN_PATH, actual.join('\n') + '\n', 'utf8')
      return
    }
    const expected = readFileSync(GOLDEN_PATH, 'utf8').trimEnd().split('\n')
    if (actual.length !== expected.length || actual.some((l, i) => l !== expected[i])) {
      throw new Error(describeDiff(actual, expected))
    }
  })

  it('адаптер метрик не искажает вход общего алгоритма', () => {
    // Тот же вызов, собранный вручную: если scripts/quality/labelLayout.ts
    // начнёт подсовывать раскладке другой кегль, другой набор сегментов или
    // другие центры колец — результаты разойдутся.
    const direct = computeStationLabelPlacements(
      (text) => measureText(text, LABEL_BASE_FONT_PX),
      model.stations,
      LABEL_BASE_FONT_PX,
      model.segmentsByStationId,
      model.segments,
      model.ringShapes,
    )
    const actual = placements.map(digest)
    const reference = direct.map(digest)
    if (actual.length !== reference.length || actual.some((l, i) => l !== reference[i])) {
      throw new Error(describeDiff(actual, reference))
    }
  })

  it('детерминирована: повторный прогон даёт тот же результат', () => {
    const again = computeLabelPlacements(buildRenderModel(graph), LABEL_BASE_FONT_PX)
    expect(again.map(digest)).toEqual(placements.map(digest))
  })
})
