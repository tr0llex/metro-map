import { useCallback, useEffect, useState } from 'react'

// Максимальное время ожидания готовности карты, после которого UI показывается принудительно.
const MAP_READY_FALLBACK_MS = 3500

// Минимальная длительность заставки. Держим её короткой: заставка — это «привет»,
// а не загрузочный экран, реальную готовность карты сторожит MAP_READY_FALLBACK_MS.
const SPLASH_MIN_DURATION_MS = 1200

export type SplashGate = {
  /** Заставка отработала минимальную длительность. */
  isSplashDone: boolean
  /** Заставка ещё в DOM (доигрывает анимацию исчезновения). */
  isSplashMounted: boolean
  /** Карта отчиталась о готовности viewport (или сработала страховка по таймауту). */
  isMapReady: boolean
  /** И заставка отработала, и карта готова — основной UI можно показывать. */
  isPrimaryUiReady: boolean
  markSplashDone: () => void
  markSplashHidden: () => void
  markMapReady: () => void
}

/**
 * Показ основного UI: заставка + готовность карты.
 *
 * Страховка обязательна: пользователь никогда не должен застрять на заставке
 * навсегда. Если карта не отчиталась о готовности viewport за
 * MAP_READY_FALLBACK_MS, выставляем готовность принудительно.
 */
export function useSplashGate(): SplashGate {
  const [isSplashDone, setIsSplashDone] = useState(false)
  const [isSplashMounted, setIsSplashMounted] = useState(true)
  const [isMapReady, setIsMapReady] = useState(false)

  const markMapReady = useCallback(() => {
    setIsMapReady(true)
  }, [])

  useEffect(() => {
    if (isMapReady) return
    const timeoutId = window.setTimeout(() => {
      setIsMapReady(true)
    }, MAP_READY_FALLBACK_MS)
    return () => window.clearTimeout(timeoutId)
  }, [isMapReady])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setIsSplashDone(true)
    }, SPLASH_MIN_DURATION_MS)

    return () => window.clearTimeout(timeoutId)
  }, [])

  return {
    isSplashDone,
    isSplashMounted,
    isMapReady,
    isPrimaryUiReady: isSplashDone && isMapReady,
    markSplashDone: useCallback(() => setIsSplashDone(true), []),
    markSplashHidden: useCallback(() => setIsSplashMounted(false), []),
    markMapReady,
  }
}
