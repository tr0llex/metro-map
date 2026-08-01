/**
 * Раскладка подписей для метрик качества.
 *
 * Раньше здесь лежал построчный ПОРТ computeStationLabelPlacements из
 * src/components/MetroMap.tsx — ~900 строк, обязанных совпадать с рантаймом
 * 1:1, без единой проверки этого совпадения. Порт удалён: алгоритм переехал в
 * src/components/MetroMapLabelLayout.ts, и рантайм со скриптами качества
 * исполняют один и тот же код.
 *
 * Здесь остался только адаптер: RenderModel → входы раскладки и подстановка
 * измерителя текста. В Node нет Canvas, поэтому ширина берётся из табличного
 * приближения (scripts/quality/textMetrics.ts) — это ЕДИНСТВЕННОЕ, чем
 * измерения метрик отличаются от браузера, см. docs/QUALITY.md.
 */

import {
  computeStationLabelPlacements,
  type StationLabelPlacement,
} from '../../src/components/MetroMapLabelLayout.ts'
import type { RenderModel } from './render.ts'
import { measureText } from './textMetrics.ts'

export type LabelPlacement = StationLabelPlacement

export function computeLabelPlacements(model: RenderModel, fontPx: number): LabelPlacement[] {
  return computeStationLabelPlacements(
    (text) => measureText(text, fontPx),
    model.stations,
    fontPx,
    model.segmentsByStationId,
    model.segments,
    model.ringShapes,
  )
}
