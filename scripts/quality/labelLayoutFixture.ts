/**
 * Общая часть сторожей раскладки подписей.
 *
 * Сторож живёт в двух файлах, и это не разделение по смыслу, а разделение по
 * ЦЕНЕ. Полный прогон раскладки по реальной схеме — перебор позиций для ~250
 * подписей: секунда чистого счёта, но под инструментацией v8 (`--coverage`)
 * тот же цикл идёт в двадцать раз дольше, 15–25 секунд.
 *
 * Сверок, которым нужен свой прогон алгоритма, три, то есть под покрытием они
 * стоили около минуты — а покрытие модуля раскладки даёт ЛЮБАЯ из них,
 * одинаково: строки исполняются те же. Поэтому:
 *
 *   labelLayout.test.ts        — сверка с эталоном. Идёт С покрытием: один
 *                                инструментированный прогон, он и покрывает
 *                                src/components/MetroMapLabelLayout.ts.
 *   labelLayoutRepeat.test.ts  — сверки, которым нужны ПОВТОРНЫЕ прогоны
 *                                (адаптер и детерминированность). Идут БЕЗ
 *                                покрытия: инструментировать их нечего,
 *                                покрытие уже снято соседним файлом.
 *
 * Проверки при этом не ослаблены ни на одну: расхождение с эталоном, с прямым
 * вызовом алгоритма или между двумя прогонами по-прежнему валит сборку.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildRenderModel } from './render.ts'
import { type LabelPlacement } from './labelLayout.ts'
import type { RawGraph } from './types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

export const ROOT = resolve(HERE, '..', '..')
export const GRAPH_PATH = resolve(ROOT, 'normalized', 'fullGraph.json')
export const GOLDEN_PATH = resolve(HERE, 'labelLayout.golden.txt')

/**
 * Срок ожидания для сверок, которые считают раскладку.
 *
 * Под `--coverage` горячий числовой цикл идёт ~15–25 секунд вместо секунды, и
 * умолчание vitest в 5 секунд под это не подходит: тесты падали по таймауту,
 * ничего не проверив. Значение оставлено щедрым и для прогона без покрытия —
 * запас ничего не стоит, а холодная машина в CI бывает вдвое медленнее.
 */
export const HEAVY_LAYOUT_TIMEOUT_MS = 120_000

/** Разбор реальной схемы. Один и тот же вход у обоих файлов сторожа. */
export function loadRenderModel() {
  const graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf8')) as RawGraph
  return { graph, model: buildRenderModel(graph) }
}

/** Одна подпись — одна строка эталона. Всё, что видит пользователь и метрики. */
export function digest(p: LabelPlacement): string {
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
export function describeDiff(actual: string[], expected: string[], limit = 12): string {
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
