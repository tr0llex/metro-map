import { useCallback, useEffect, useState } from 'react'
import {
  FAVORITES_LIMIT,
  FAVORITES_STORAGE_KEY,
  RECENTS_LIMIT,
  RECENTS_STORAGE_KEY,
  isSavedRoute,
  persistRoutesToStorage,
} from '../features/route/savedRoutes.ts'
import type { SavedRoute } from '../features/route/savedRoutes.ts'

export type RouteEndpoints = {
  fromStationId: string
  toStationId: string
  fromTitle: string
  toTitle: string
}

type SavedRoutesState = {
  favorites: SavedRoute[]
  recents: SavedRoute[]
  /** Есть ли этот маршрут в избранном. */
  isFavorite: (endpoints: RouteEndpoints | null) => boolean
  toggleFavorite: (endpoints: RouteEndpoints) => void
  /** Запомнить построенный маршрут в «Недавних» (поднимает существующий наверх). */
  rememberRecent: (endpoints: RouteEndpoints) => void
  clearRecents: () => void
}

/** Избранные и недавние маршруты: чтение при старте, запись в localStorage при каждом изменении. */
export function useSavedRoutes(): SavedRoutesState {
  const [favorites, setFavorites] = useState<SavedRoute[]>([])
  const [recents, setRecents] = useState<SavedRoute[]>([])

  useEffect(() => {
    if (typeof window === 'undefined') return

    try {
      const rawFavorites = window.localStorage.getItem(FAVORITES_STORAGE_KEY)
      if (rawFavorites) {
        const parsed = JSON.parse(rawFavorites) as unknown
        if (Array.isArray(parsed)) {
          setFavorites(parsed.filter(isSavedRoute))
        }
      }
    } catch {
      // ignore
    }

    try {
      const rawRecents = window.localStorage.getItem(RECENTS_STORAGE_KEY)
      if (rawRecents) {
        const parsedRaw = JSON.parse(rawRecents) as unknown
        const parsed = Array.isArray(parsedRaw) ? parsedRaw.filter(isSavedRoute) : null
        if (parsed) {
          const limited = parsed.slice(0, RECENTS_LIMIT)
          setRecents(limited)

          if (limited.length !== (parsedRaw as unknown[]).length) {
            try {
              window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(limited))
            } catch {
              // ignore storage errors
            }
          }
        } else {
          try {
            window.localStorage.removeItem(RECENTS_STORAGE_KEY)
          } catch {
            // ignore storage errors
          }
          setRecents([])
        }
      }
    } catch {
      try {
        window.localStorage.removeItem(RECENTS_STORAGE_KEY)
      } catch {
        // ignore storage errors
      }
      setRecents([])
    }
  }, [])

  const clearRecents = useCallback(() => {
    setRecents([])
    persistRoutesToStorage(RECENTS_STORAGE_KEY, [])
  }, [])

  const rememberRecent = useCallback((endpoints: RouteEndpoints) => {
    setRecents((prev: SavedRoute[]) => {
      const filtered = prev.filter(
        (item) =>
          !(
            item.fromStationId === endpoints.fromStationId &&
            item.toStationId === endpoints.toStationId
          ),
      )
      const next: SavedRoute[] = [
        {
          ...endpoints,
          // Именно время, а не порядковый номер: поле называется «когда
          // использовали», избранное пишет туда Date.now(), и после
          // перезагрузки счётчик всё равно начинался заново с единицы.
          lastUsedAt: Date.now(),
        },
        ...filtered,
      ].slice(0, RECENTS_LIMIT)

      persistRoutesToStorage(RECENTS_STORAGE_KEY, next)
      return next
    })
  }, [])

  const isFavorite = useCallback(
    (endpoints: RouteEndpoints | null) =>
      !!(
        endpoints &&
        favorites.some(
          (item) =>
            item.fromStationId === endpoints.fromStationId &&
            item.toStationId === endpoints.toStationId,
        )
      ),
    [favorites],
  )

  const toggleFavorite = useCallback(
    (endpoints: RouteEndpoints) => {
      const { fromStationId: fromId, toStationId: toId, fromTitle, toTitle } = endpoints

      const prevRoutes = favorites
      const exists = prevRoutes.some(
        (item) => item.fromStationId === fromId && item.toStationId === toId,
      )
      let next: SavedRoute[]
      if (exists) {
        next = prevRoutes.filter(
          (item) => !(item.fromStationId === fromId && item.toStationId === toId),
        )
      } else {
        const now = Date.now()
        next = [
          {
            fromStationId: fromId,
            toStationId: toId,
            fromTitle,
            toTitle,
            lastUsedAt: now,
          },
          ...prevRoutes,
        ].slice(0, FAVORITES_LIMIT)
      }

      persistRoutesToStorage(FAVORITES_STORAGE_KEY, next)
      setFavorites(next)
    },
    [favorites],
  )

  return { favorites, recents, isFavorite, toggleFavorite, rememberRecent, clearRecents }
}
