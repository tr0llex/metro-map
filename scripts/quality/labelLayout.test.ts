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
 * запускается тем же `npx vitest run`, что и весь остальной набор, и падает
 * с конкретным списком расхождений.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { LABEL_BASE_FONT_PX } from './render.ts'
import { computeLabelPlacements } from './labelLayout.ts'
import {
  GOLDEN_PATH,
  HEAVY_LAYOUT_TIMEOUT_MS,
  ROOT,
  describeDiff,
  digest,
  loadRenderModel,
} from './labelLayoutFixture.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const LAYOUT_MODULE = resolve(ROOT, 'src', 'components', 'MetroMapLabelLayout.ts')
// Файлы самого сторожа: они содержат отпечатки в виде строк и импортируют
// алгоритм, но реализацией не являются. Перечислены явно, а не по маске
// *.test.ts — маска заодно спрятала бы настоящую копию, если её кто-нибудь
// принесёт в файл с таким именем.
const GUARD_FILES = [
  resolve(HERE, 'labelLayout.test.ts'),
  resolve(HERE, 'labelLayoutRepeat.test.ts'),
  resolve(HERE, 'labelLayoutFixture.ts'),
]

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
  // Отпечатки намеренно не привязаны к ЗНАЧЕНИЯМ весов: подбор весов —
  // законная работа над раскладкой, а сторож ловит появление второй копии.
  { name: 'вес наложения подписей', re: /labelOverlap\s*:/i },
  { name: 'вес отрыва подписи', re: /detachedStep\s*:/i },
  { name: 'вес перечёркивания линией', re: /lineCrossFirst\s*:/i },
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
  return out.filter((f) => !GUARD_FILES.includes(f))
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

describe('раскладка подписей: результат на реальной схеме', () => {
  const { model } = loadRenderModel()
  const placements = computeLabelPlacements(model, LABEL_BASE_FONT_PX)

  it(
    'совпадает с эталоном позиция в позицию',
    () => {
      const actual = placements.map(digest)
      if (process.env.UPDATE_LABEL_GOLDEN === '1') {
        writeFileSync(GOLDEN_PATH, actual.join('\n') + '\n', 'utf8')
        return
      }
      const expected = readFileSync(GOLDEN_PATH, 'utf8').trimEnd().split('\n')
      if (actual.length !== expected.length || actual.some((l, i) => l !== expected[i])) {
        throw new Error(describeDiff(actual, expected))
      }
    },
    HEAVY_LAYOUT_TIMEOUT_MS,
  )
})
