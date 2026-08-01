import { useCallback, useEffect, useState } from 'react'
import type { FullGraphStation } from '../metro/types.ts'

/**
 * Минимальный структурный тип оверрайдов: только то, что нужно этому хуку.
 *
 * Импортировать реальный `StationOverride` из `src/editor/**` нельзя даже как
 * тип — редактора не должно касаться ничего вне мёртвой ветки EDITOR_ENABLED
 * (см. scripts/check-prod-bundle.mjs).
 */
type StationCoordOverrides = Record<string, { lat?: number; lon?: number } | undefined>

/**
 * Человек уже один раз разрешил геолокацию. По этому флагу на следующем запуске
 * пробуем определить станции рядом сразу — но только если разрешение реально
 * действует (спрашиваем Permissions API, а не браузерный диалог).
 */
const NEARBY_ALLOWED_KEY = 'kitty-metro-nearby-allowed'

/** Сколько ближайших станций показываем. */
const NEARBY_LIMIT = 6

const EARTH_RADIUS_M = 6371000

export type NearbyStationsState = {
  stations: FullGraphStation[]
  status: 'idle' | 'loading' | 'error'
  error: string | null
  request: () => void
}

/** Расстояние по большому кругу, метры. */
function haversineMeters(lat1Deg: number, lon1Deg: number, lat2Deg: number, lon2Deg: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const lat1 = toRad(lat1Deg)
  const lon1 = toRad(lon1Deg)
  const lat2 = toRad(lat2Deg)
  const lon2 = toRad(lon2Deg)
  const dLat = lat2 - lat1
  const dLon = lon2 - lon1
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return EARTH_RADIUS_M * c
}

/** Раздел «Рядом»: ближайшие станции по геолокации. */
export function useNearbyStations(params: {
  allStations: FullGraphStation[]
  stationOverrides: StationCoordOverrides
}): NearbyStationsState {
  const { allStations, stationOverrides } = params

  const [stations, setStations] = useState<FullGraphStation[]>([])
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  const request = useCallback(() => {
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      setStatus('error')
      setError('Геолокация доступна только по HTTPS (или на localhost).')
      return
    }
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus('error')
      setError('Геолокация недоступна.')
      return
    }

    setStatus('loading')
    setError(null)

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords
        const withCoords = allStations.filter((s) => {
          const ov = stationOverrides[s.id]
          const lat = ov?.lat ?? s.lat
          const lon = ov?.lon ?? s.lon
          return typeof lat === 'number' && typeof lon === 'number'
        })
        if (withCoords.length === 0) {
          setStatus('error')
          setError('Нет станций с координатами.')
          return
        }

        const scored = withCoords.map((s) => {
          const ov = stationOverrides[s.id]
          const effectiveLat = (ov?.lat ?? s.lat) as number
          const effectiveLon = (ov?.lon ?? s.lon) as number
          return {
            station: s,
            distance: haversineMeters(latitude, longitude, effectiveLat, effectiveLon),
          }
        })

        scored.sort((a, b) => a.distance - b.distance)
        const nearest = scored.slice(0, NEARBY_LIMIT).map((x) => x.station)

        setStations(nearest)
        setStatus('idle')

        if (typeof window !== 'undefined') {
          try {
            window.localStorage.setItem(NEARBY_ALLOWED_KEY, '1')
          } catch {
            // ignore storage errors
          }
        }
      },
      (geoError) => {
        setStatus('error')
        if (geoError?.code === 1) {
          setError('Нет разрешения на местоположение. Разреши доступ в настройках браузера.')
          return
        }
        if (geoError?.code === 2) {
          setError('Не удалось определить местоположение (нет сигнала).')
          return
        }
        if (geoError?.code === 3) {
          setError('Истекло время ожидания геолокации.')
          return
        }
        setError('Не удалось получить местоположение.')
      },
      {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 60000,
      },
    )
  }, [allStations, stationOverrides])

  // Повторный визит с уже выданным разрешением: определяем станции сами, без
  // лишнего нажатия. Никакого браузерного диалога здесь не всплывает — сначала
  // спрашиваем Permissions API и уходим, если разрешение не 'granted'.
  useEffect(() => {
    if (typeof window === 'undefined') return

    let shouldAutoRequest = false
    try {
      shouldAutoRequest = window.localStorage.getItem(NEARBY_ALLOWED_KEY) === '1'
    } catch {
      shouldAutoRequest = false
    }

    if (!shouldAutoRequest) return

    if (typeof navigator === 'undefined') return
    const permissionsApi = (navigator as unknown as { permissions?: Permissions }).permissions
    if (!permissionsApi?.query) {
      return
    }

    void permissionsApi
      .query({ name: 'geolocation' as PermissionName })
      .then((permissionStatus) => {
        if (permissionStatus.state === 'granted') {
          request()
        }
      })
      .catch(() => {
        return
      })
  }, [request])

  return { stations, status, error, request }
}
