import { startTransition, useCallback, useEffect, useRef, useState } from 'react'

import type { StationSelectOutcome } from '../components/MetroMap.tsx'

// --- Тап по станции ---------------------------------------------------------
// Пока хоть одно поле пустое, тап заполняет его сразу: первый — «Откуда»,
// второй — «Куда» (стандарт Яндекс.Метро и Google Maps). Когда оба поля заняты,
// молча менять маршрут нельзя — тап открывает поповер с выбором поля. Об этом
// решении сообщает сам обработчик тапа: он возвращает 'ask'.
// Долгое нажатие открывает поповер в любом состоянии.
// MetroMap сообщает о выборе только на touchend/click и не отдаёт длительность
// нажатия, поэтому длительность мы засекаем сами: слушаем pointerdown на уровне
// документа (MetroMap правкам не подлежит).
const LONG_PRESS_MS = 480
// Палец всегда немного «плывёт»: сдвиг больше этого — уже не долгое нажатие.
const LONG_PRESS_MAX_MOVE_PX = 14

/** Сколько длится анимация исчезновения поповера. */
const POPOVER_EXIT_MS = 160

export type StationPickPopoverData = {
  stationId: string
  stationName: string
  clientPoint: { x: number; y: number; t?: number }
}

type StationPickPopoverState = {
  /** Открытый поповер (null — закрыт). */
  data: StationPickPopoverData | null
  isClosing: boolean
  /** Кнопка, по которой только что нажали — для мгновенной подсветки. */
  pressed: 'from' | 'to' | null
  setPressed: (value: 'from' | 'to' | null) => void
  /** Позиция в координатах вьюпорта; null — ещё не измерена, поповер невидим. */
  position: { left: number; top: number } | null
  /** Проп onSelectStation для MetroMap. Ссылка стабильна на всё время жизни. */
  handleMapSelect: (
    id: string,
    name: string,
    clientPoint?: { x: number; y: number; t?: number },
  ) => StationSelectOutcome
  closeAnimated: (options?: { delayMs?: number }) => void
}

/**
 * Выбор станции тапом по карте.
 *
 * Короткий тап отдаётся наружу (`onStationTap`) и заполняет пустое поле по
 * правилу «первый — Откуда, второй — Куда». Если оба поля заняты, обработчик
 * возвращает 'ask' — и тап открывает тот же поповер, что и долгое нажатие,
 * вместо молчаливой подмены станции. Поповер позиционируется рядом с точкой
 * нажатия и закрывается по Escape, клику мимо и ресайзу.
 */
export function useStationPickPopover(params: {
  /**
   * Короткий тап по станции. Вызывается всегда со свежим замыканием.
   * Возвращает поле, в которое станция уехала ('from'/'to'), 'noop', если
   * менять было нечего, и 'ask', если решение о поле должен принять
   * пользователь — тогда открывается поповер.
   */
  onStationTap: (
    stationId: string,
    stationName: string,
    clientPoint: { x: number; y: number },
  ) => StationSelectOutcome
  /** Любой выбор станции — повод убрать подсказку первого запуска. */
  onBeforeSelect: () => void
  /**
   * DOM-ссылка на поповер: её владелец — App. Возвращать ref из хука нельзя,
   * иначе правило react-hooks/refs запретит читать из результата что угодно
   * во время рендера (см. useBottomSheet).
   */
  popoverRef: React.RefObject<HTMLDivElement | null>
}): StationPickPopoverState {
  const { onStationTap, onBeforeSelect, popoverRef: stationPickPopoverRef } = params

  const [stationPickPopover, setStationPickPopover] = useState<StationPickPopoverData | null>(null)
  const [stationPickPopoverClosing, setStationPickPopoverClosing] = useState(false)
  const [stationPickPopoverPressed, setStationPickPopoverPressed] = useState<'from' | 'to' | null>(null)
  const [stationPickPopoverPos, setStationPickPopoverPos] = useState<{ left: number; top: number } | null>(
    null,
  )
  const stationPickPopoverCloseTimeoutRef = useRef<number | null>(null)
  const stationPickPopoverPerfRef = useRef<{ openedAt: number; tapAt?: number } | null>(null)
  // Последний pointerdown: единственный доступный источник длительности нажатия,
  // потому что MetroMap правкам не подлежит и отдаёт только момент отпускания.
  const pointerDownRef = useRef<{ at: number; x: number; y: number } | null>(null)

  // Держим коллбэк в ref: handleMapSelect уходит в MetroMap пропом и должен
  // оставаться стабильным, а onStationTap пересоздаётся каждый рендер.
  const onStationTapRef = useRef(onStationTap)
  useEffect(() => {
    onStationTapRef.current = onStationTap
  })

  // Засекаем начало нажатия на уровне документа: MetroMap трогать нельзя, а
  // без момента pointerdown отличить долгое нажатие от обычного тапа негде.
  useEffect(() => {
    if (typeof window === 'undefined') return

    const onPointerDown = (event: PointerEvent) => {
      pointerDownRef.current = {
        at: performance.now(),
        x: event.clientX,
        y: event.clientY,
      }
    }

    // Выбор с клавиатуры долгим нажатием не является. Забываем последний
    // pointerdown: без этого давний клик мимо станции считался «удержанием» и
    // Enter открывал поповер вместо того, чтобы заполнить пустое поле.
    // Слушаем в фазе перехвата — обработчик MetroMap висит выше по дереву.
    const onKeyDown = () => {
      pointerDownRef.current = null
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [])

  const closeStationPickPopoverImmediate = useCallback(() => {
    if (stationPickPopoverCloseTimeoutRef.current != null) {
      window.clearTimeout(stationPickPopoverCloseTimeoutRef.current)
      stationPickPopoverCloseTimeoutRef.current = null
    }
    setStationPickPopoverClosing(false)
    setStationPickPopoverPressed(null)
    setStationPickPopover(null)
    setStationPickPopoverPos(null)
  }, [])

  const closeStationPickPopoverAnimated = useCallback(
    ({ delayMs }: { delayMs?: number } = {}) => {
      const exitMs = POPOVER_EXIT_MS
      const delay = delayMs ?? 0
      if (stationPickPopoverCloseTimeoutRef.current != null) {
        window.clearTimeout(stationPickPopoverCloseTimeoutRef.current)
        stationPickPopoverCloseTimeoutRef.current = null
      }

      stationPickPopoverCloseTimeoutRef.current = window.setTimeout(() => {
        setStationPickPopoverClosing(true)
        stationPickPopoverCloseTimeoutRef.current = window.setTimeout(() => {
          closeStationPickPopoverImmediate()
        }, exitMs)
      }, delay)
    },
    [closeStationPickPopoverImmediate],
  )

  const handleMapSelect = useCallback((
    id: string,
    name: string,
    clientPoint?: { x: number; y: number; t?: number },
  ): StationSelectOutcome => {
    onBeforeSelect()

    // Точка нужна поповеру и подсказке: они встают у станции, а не под шапкой.
    // MetroMap отдаёт её и для клавиатурного выбора, но если источник её всё же
    // не знает — берём центр экрана. Раньше на этом месте стоял молчаливый
    // выход, и выбор станции с клавиатуры не делал вообще ничего.
    const point: { x: number; y: number; t?: number } = clientPoint ?? {
      x: typeof window !== 'undefined' ? window.innerWidth / 2 : 0,
      y: typeof window !== 'undefined' ? window.innerHeight / 2 : 0,
    }

    // Долгое нажатие = «хочу выбрать поле сам» → прежний поповер.
    // Длительность считаем сами: MetroMap отдаёт только момент отпускания.
    const down = pointerDownRef.current
    pointerDownRef.current = null
    let isLongPress = false
    if (down) {
      const heldMs = (typeof performance !== 'undefined' ? performance.now() : 0) - down.at
      const dx = point.x - down.x
      const dy = point.y - down.y
      isLongPress =
        heldMs >= LONG_PRESS_MS &&
        heldMs < 10_000 &&
        dx * dx + dy * dy <= LONG_PRESS_MAX_MOVE_PX * LONG_PRESS_MAX_MOVE_PX
    }

    if (!isLongPress) {
      // Короткий тап сначала пробует заполнить пустое поле. 'ask' означает,
      // что оба поля заняты и выбор за пользователем — падаем в поповер.
      const outcome = onStationTapRef.current(id, name, { x: point.x, y: point.y })
      if (outcome !== 'ask') {
        return outcome
      }
    }

    if (import.meta.env.DEV) {
      stationPickPopoverPerfRef.current = { openedAt: performance.now(), tapAt: point.t }
      console.log(`[perf][popover] open station=${id} tapAt=${point.t != null ? point.t.toFixed(1) : 'n/a'}`)
    }
    if (stationPickPopoverCloseTimeoutRef.current != null) {
      window.clearTimeout(stationPickPopoverCloseTimeoutRef.current)
      stationPickPopoverCloseTimeoutRef.current = null
    }
    startTransition(() => {
      setStationPickPopoverClosing(false)
      setStationPickPopoverPressed(null)
      setStationPickPopover({ stationId: id, stationName: name, clientPoint: point })
    })
    return 'ask'
  }, [onBeforeSelect])

  useEffect(() => {
    if (!stationPickPopover) return
    if (typeof window === 'undefined') return

    let rafId = 0
    rafId = window.requestAnimationFrame(() => {
      const el = stationPickPopoverRef.current
      if (!el) return

      const vw = window.innerWidth
      const vh = window.innerHeight
      const rect = el.getBoundingClientRect()

      const margin = 8
      const gap = 20
      const nudgeX = 10

      const preferTop = stationPickPopover.clientPoint.y - gap - rect.height
      const top = preferTop < margin ? stationPickPopover.clientPoint.y + gap : preferTop
      const left = stationPickPopover.clientPoint.x - rect.width / 2 + nudgeX

      const clampedLeft = Math.min(vw - margin - rect.width, Math.max(margin, left))
      const clampedTop = Math.min(vh - margin - rect.height, Math.max(margin, top))

      setStationPickPopoverPos({ left: clampedLeft, top: clampedTop })

      if (import.meta.env.DEV) {
        const perf = stationPickPopoverPerfRef.current
        if (perf) {
          const now = performance.now()
          const openLatency = now - perf.openedAt
          const tapLatency = perf.tapAt != null ? now - perf.tapAt : null
          console.log(
            `[perf][popover] positioned openLatency=${openLatency.toFixed(1)}ms tapLatency=${tapLatency != null ? tapLatency.toFixed(1) : 'n/a'}ms`,
          )
          stationPickPopoverPerfRef.current = null
        }
      }
    })

    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId)
      }
    }
  }, [stationPickPopover, stationPickPopoverRef])

  useEffect(() => {
    if (!stationPickPopover) return
    if (typeof window === 'undefined') return
    if (typeof document === 'undefined') return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeStationPickPopoverAnimated()
      }
    }

    const onPointerDown = (event: PointerEvent) => {
      const el = stationPickPopoverRef.current
      if (!el) return
      const target = event.target
      if (!(target instanceof Node)) return
      if (el.contains(target)) return
      closeStationPickPopoverAnimated()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', closeStationPickPopoverImmediate)
    document.addEventListener('pointerdown', onPointerDown, true)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', closeStationPickPopoverImmediate)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [
    stationPickPopover,
    stationPickPopoverRef,
    closeStationPickPopoverAnimated,
    closeStationPickPopoverImmediate,
  ])

  return {
    data: stationPickPopover,
    isClosing: stationPickPopoverClosing,
    pressed: stationPickPopoverPressed,
    setPressed: setStationPickPopoverPressed,
    position: stationPickPopoverPos,
    handleMapSelect,
    closeAnimated: closeStationPickPopoverAnimated,
  }
}
