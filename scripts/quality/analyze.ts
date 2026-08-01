/**
 * Оценка качества схемы метро.
 *
 *   npm run quality          — таблица в консоль + normalized/quality_report.json
 *   npm run quality:check    — то же, но exit 1 при любом FAIL (для CI)
 *
 * Флаги: --check, --json (только JSON в stdout), --quiet (без списка виновников).
 *
 * Скрипт полностью детерминирован: никакого времени, случайности и нестабильных
 * сортировок — два запуска на одних данных дают побайтово одинаковый отчёт.
 *
 * Что читаем: normalized/fullGraph.json — ровно тот файл, который грузит рантайм.
 * Как считаем: воспроизводя отрисовку из src/components/MetroMap.tsx
 * (см. scripts/quality/render.ts). Документация метрик — docs/QUALITY.md.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LABEL_BASE_FONT_PX, buildRenderModel } from './render.ts'
import { computeLabelPlacements } from './labelLayout.ts'
import { integrityMetrics } from './metrics/integrity.ts'
import { hubMetrics } from './metrics/hubs.ts'
import { ringMetrics } from './metrics/rings.ts'
import { geometryMetrics } from './metrics/geometry.ts'
import { labelMetrics } from './metrics/labels.ts'
import { buildReport, printReport } from './report.ts'
import type { RawGraph } from './types.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const GRAPH_PATH = resolve(ROOT, 'normalized', 'fullGraph.json')
const OUT_PATH = resolve(ROOT, 'normalized', 'quality_report.json')

function main(): void {
  const argv = process.argv.slice(2)
  const checkMode = argv.includes('--check')
  const jsonOnly = argv.includes('--json')
  const quiet = argv.includes('--quiet')

  const graph = JSON.parse(readFileSync(GRAPH_PATH, 'utf8')) as RawGraph
  const model = buildRenderModel(graph)
  const placements = computeLabelPlacements(model, LABEL_BASE_FONT_PX)

  const metrics = [
    ...integrityMetrics(model),
    ...hubMetrics(model),
    ...ringMetrics(model),
    ...geometryMetrics(model),
    ...labelMetrics(model, placements),
  ]

  const report = buildReport('normalized/fullGraph.json', metrics)

  mkdirSync(dirname(OUT_PATH), { recursive: true })
  writeFileSync(OUT_PATH, JSON.stringify(report, null, 2) + '\n', 'utf8')

  if (jsonOnly) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    printReport(report, !quiet)
    process.stdout.write(
      `  Подробный отчёт: normalized/quality_report.json  ·  описание метрик: docs/QUALITY.md\n\n`,
    )
  }

  if (checkMode && report.summary.fail > 0) process.exit(1)
}

main()
