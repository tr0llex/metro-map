/**
 * Константы зонирования подписей для метрик.
 *
 * Раньше в этом файле лежала копия геометрических хелперов раскладки, обязанная
 * совпадать 1:1 с src/components/MetroMap.tsx. Копия удалена: и раскладка, и
 * метрики теперь берут эти величины из src/components/MetroMapLabelLayout.ts,
 * поэтому граница зоны в метрике физически не может разойтись с границей зоны
 * в алгоритме.
 */

export {
  LABEL_CENTER_RADIUS as CENTER_RADIUS,
  LABEL_MIDDLE_RADIUS as MIDDLE_RADIUS,
  labelPreferredMaxDist as preferredMaxDist,
  resolveLabelZoneCenter as resolveZoneCenter,
} from '../../src/components/MetroMapLabelLayout.ts'
