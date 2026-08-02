/**
 * Сохранённые маршруты: избранное и недавние. Формат и хранилище — общие,
 * различаются только ключ и правила отбора (см. useSavedRoutes).
 */

export type SavedRoute = {
  fromStationId: string
  toStationId: string
  fromTitle: string
  toTitle: string
  lastUsedAt: number
}

export const FAVORITES_STORAGE_KEY = 'metro-map-favorites-v1'
export const RECENTS_STORAGE_KEY = 'metro-map-recents-v1'

/** Сколько недавних маршрутов держим. */
export const RECENTS_LIMIT = 5
/** Сколько избранных маршрутов держим. */
export const FAVORITES_LIMIT = 20

/**
 * Проверка одной записи из localStorage.
 *
 * Проверять только `Array.isArray` недостаточно: одна битая запись внутри
 * массива (например `[null]`) роняла приложение при КАЖДОМ построении маршрута,
 * а экран ошибки localStorage сознательно не чистит — получался вечный цикл
 * падений, из которого нельзя выйти изнутри приложения. Поэтому валидируем
 * каждый элемент и молча выбрасываем мусор.
 */
export function isSavedRoute(value: unknown): value is SavedRoute {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.fromStationId === 'string' &&
    typeof v.toStationId === 'string' &&
    typeof v.fromTitle === 'string' &&
    typeof v.toTitle === 'string' &&
    typeof v.lastUsedAt === 'number' &&
    Number.isFinite(v.lastUsedAt)
  )
}

export function persistRoutesToStorage(key: string, routes: SavedRoute[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(routes))
  } catch {
    // ignore
  }
}
