import { useCallback, useEffect, useRef } from 'react'

/**
 * Отметка «прямо сейчас идёт жест».
 *
 * На время взаимодействия на <html> висит класс `perf-interaction` — по нему
 * CSS отключает дорогие эффекты. Класс снимается через 180 мс тишины.
 *
 * В dev-режиме параллельно снимаются длительности кадров ВО ВРЕМЯ жеста
 * и изредка логируются: это единственный способ заметить, что шторка или карта
 * начали дёргаться, не открывая профайлер.
 */
export function usePerfInteraction(): () => void {
  const perfInteractionActiveRef = useRef(false)
  const perfInteractionTimeoutRef = useRef<number | null>(null)

  const markPerfInteraction = useCallback(() => {
    if (typeof window === 'undefined') return
    if (typeof document === 'undefined') return

    const root = document.documentElement
    if (!perfInteractionActiveRef.current) {
      perfInteractionActiveRef.current = true
      root.classList.add('perf-interaction')
    }

    if (perfInteractionTimeoutRef.current != null) {
      window.clearTimeout(perfInteractionTimeoutRef.current)
      perfInteractionTimeoutRef.current = null
    }

    perfInteractionTimeoutRef.current = window.setTimeout(() => {
      perfInteractionTimeoutRef.current = null
      perfInteractionActiveRef.current = false
      root.classList.remove('perf-interaction')
    }, 180)
  }, [])

  const perfLastFrameTsRef = useRef<number | null>(null)
  const perfFrameSamplesRef = useRef<number[]>([])
  const perfLogCooldownRef = useRef<number>(0)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (typeof window === 'undefined') return

    let raf = 0
    const tick = (ts: number) => {
      raf = window.requestAnimationFrame(tick)
      if (!perfInteractionActiveRef.current) {
        perfLastFrameTsRef.current = ts
        return
      }

      const last = perfLastFrameTsRef.current
      perfLastFrameTsRef.current = ts
      if (last == null) return

      const dt = ts - last
      if (!Number.isFinite(dt) || dt <= 0) return

      const samples = perfFrameSamplesRef.current
      samples.push(dt)
      if (samples.length > 80) samples.shift()

      const now = performance.now()
      if (now < perfLogCooldownRef.current) return
      if (samples.length < 40) return

      const sorted = [...samples].sort((a, b) => a - b)
      const p50 = sorted[Math.floor(sorted.length * 0.5)]
      const p95 = sorted[Math.floor(sorted.length * 0.95)]
      const max = sorted[sorted.length - 1]
      // логируем редко, чтобы не заспамить консоль
      perfLogCooldownRef.current = now + 1500
      console.log('[perf] interaction frame dt ms', {
        p50: Number(p50?.toFixed(1)),
        p95: Number(p95?.toFixed(1)),
        max: Number(max?.toFixed(1)),
      })
    }

    raf = window.requestAnimationFrame(tick)
    return () => {
      if (raf) window.cancelAnimationFrame(raf)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && perfInteractionTimeoutRef.current != null) {
        window.clearTimeout(perfInteractionTimeoutRef.current)
        perfInteractionTimeoutRef.current = null
      }
      if (typeof document !== 'undefined') {
        document.documentElement.classList.remove('perf-interaction')
      }
      perfInteractionActiveRef.current = false
    }
  }, [])

  return markPerfInteraction
}
