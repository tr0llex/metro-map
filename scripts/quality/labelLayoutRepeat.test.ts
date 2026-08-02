/**
 * Сторож раскладки подписей: сверки, которым нужен ПОВТОРНЫЙ прогон алгоритма.
 *
 * Почему отдельный файл — в labelLayoutFixture.ts. Коротко: эти две сверки
 * считают раскладку заново, а под инструментацией v8 каждый такой прогон
 * стоит 15–25 секунд вместо секунды. Покрытие модуля раскладки снимает
 * соседний labelLayout.test.ts — строки там исполняются те же, — поэтому
 * повторные прогоны идут без `--coverage` и стоят секунды.
 *
 * Запускается отдельной командой: `npm run test:repeat`. В CI это шаг рядом с
 * основным набором, а не вместо него: пропустить его молча нельзя.
 */

import { describe, expect, it } from 'vitest'

import { computeStationLabelPlacements } from '../../src/components/MetroMapLabelLayout.ts'
import { LABEL_BASE_FONT_PX, buildRenderModel } from './render.ts'
import { computeLabelPlacements } from './labelLayout.ts'
import { measureText } from './textMetrics.ts'
import {
  HEAVY_LAYOUT_TIMEOUT_MS,
  describeDiff,
  digest,
  loadRenderModel,
} from './labelLayoutFixture.ts'

describe('раскладка подписей: повторные прогоны', () => {
  const { graph, model } = loadRenderModel()
  const placements = computeLabelPlacements(model, LABEL_BASE_FONT_PX)

  it(
    'адаптер метрик не искажает вход общего алгоритма',
    () => {
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
    },
    HEAVY_LAYOUT_TIMEOUT_MS,
  )

  it(
    'детерминирована: повторный прогон даёт тот же результат',
    () => {
      const again = computeLabelPlacements(buildRenderModel(graph), LABEL_BASE_FONT_PX)
      expect(again.map(digest)).toEqual(placements.map(digest))
    },
    HEAVY_LAYOUT_TIMEOUT_MS,
  )
})
