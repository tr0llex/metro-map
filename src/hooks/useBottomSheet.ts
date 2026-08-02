import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TouchEvent } from 'react'

/**
 * Нижняя шторка: физика, жесты и пересчёт высоты.
 *
 * Шторка живёт вне React-состояния: положение — это `transform` на элементе,
 * который двигают requestAnimationFrame-цикл пружины и обработчики жестов
 * напрямую. Состояние React знает только «открыта/закрыта» — иначе каждый кадр
 * перетаскивания был бы перерендером всего приложения.
 *
 * `progress` — 0 (свёрнута до минимальной высоты) … 1 (раскрыта на всю
 * доступную). Реальные пиксели пересчитываются из измерений DOM в
 * recomputeSheetMaxOffsetPx.
 *
 * На десктопе шторка — обычная боковая панель: вся физика выключена.
 */
type BottomSheetOptions = {
  isDesktop: boolean
  /** Экран ошибки: тянуть шторку нечего, жест игнорируем. */
  isDragDisabled: boolean
  /** Есть построенный маршрут, ради которого шторку вообще стоит открывать. */
  hasRoute: boolean
  /**
   * Нижний отступ карты в десктопной раскладке — ref, а не значение: считает его
   * useMapVisibleInsets, которому в свою очередь нужно знать, открыта ли шторка.
   * Ref разрывает этот круг.
   */
  desktopBottomInsetPxRef: { current: number }
  /**
   * Слепок всего, что меняет ВЫСОТУ содержимого шторки. Любое изменение строки
   * заставляет перемерить шторку заново. Строкой, а не массивом: массив в
   * зависимостях эффекта пришлось бы разворачивать спредом, чего правило хуков
   * не допускает.
   */
  contentSignature: string
  markPerfInteraction: () => void
  /**
   * DOM-ссылки на саму шторку, её всегда видимую часть и блок деталей.
   * Их владелец — App (он рисует эту разметку), хук только измеряет и двигает.
   * Возвращать ref наружу из хука нельзя: правило react-hooks/refs считает
   * тогда «ref-подобным» весь возвращённый объект и запрещает читать из него
   * что угодно во время рендера.
   */
  sheetRef: React.RefObject<HTMLDivElement | null>
  minVisibleRef: React.RefObject<HTMLDivElement | null>
  detailsRef: React.RefObject<HTMLDivElement | null>
}

type BottomSheetState = {
  isOpen: boolean
  setOpen: (open: boolean) => void
  isSmartSuggestionsOpen: boolean
  setSmartSuggestionsOpen: (open: boolean) => void
  /** Сколько снизу занимает шторка — карта использует это, чтобы не прятать маршрут под ней. */
  getBottomInsetPx: () => number
  touchHandlers: {
    onTouchStart: (event: TouchEvent) => void
    onTouchMove: (event: TouchEvent) => void
    onTouchEnd: () => void
    onTouchCancel: () => void
  }
}

export function useBottomSheet(options: BottomSheetOptions): BottomSheetState {
  const {
    isDesktop,
    isDragDisabled,
    hasRoute,
    desktopBottomInsetPxRef,
    contentSignature,
    markPerfInteraction,
    sheetRef: bottomSheetRef,
    minVisibleRef: sheetMinVisibleRef,
    detailsRef: routeDetailsRef,
  } = options

  const [isRouteSheetOpen, setIsRouteSheetOpen] = useState(false)
  const [isSmartSuggestionsOpen, setIsSmartSuggestionsOpen] = useState(false)

  const sheetAnimFrameRef = useRef<number | null>(null)
  const sheetAnimTargetRef = useRef<number | null>(null)
  const sheetProgressRef = useRef(0)
  const sheetSpringRafRef = useRef<number | null>(null)
  const sheetSpringTargetRef = useRef<number | null>(null)
  const sheetSpringVelocityRef = useRef(0)
  const sheetSpringLastTimeRef = useRef<number | null>(null)
  const sheetDragLastSampleTimeRef = useRef<number | null>(null)
  const sheetDragLastSampleProgressRef = useRef<number | null>(null)
  const sheetDragVelocityRef = useRef(0)
  const sheetMaxOffsetPxRef = useRef(0)
  const sheetMinHeightPxRef = useRef(0)
  const sheetOpenHeightPxRef = useRef(0)

  const shouldIgnoreSheetTouch = (target: EventTarget | null) => {
    if (typeof document === 'undefined') return false
    if (!(target instanceof Element)) return false
    if (target.closest('.bottom-sheet-handle')) return false
    return Boolean(target.closest('input, textarea, select, a'))
  }
  const sheetTouchStartYRef = useRef<number | null>(null)
  const sheetTouchLastYRef = useRef<number | null>(null)
  const sheetTouchStartXRef = useRef<number | null>(null)
  const sheetTouchLastXRef = useRef<number | null>(null)
  const sheetGestureAxisRef = useRef<'pending' | 'x' | 'y' | null>(null)
  const sheetDeferredRecomputeRef = useRef(false)
  const sheetTouchStartedOnButtonRef = useRef(false)
  const sheetTouchStartedInSmartSuggestionsRef = useRef(false)
  const sheetDragStartProgressRef = useRef<number | null>(null)

  const getBottomInsetPx = useCallback(() => {
    if (isDesktop) return desktopBottomInsetPxRef.current
    const min = sheetMinHeightPxRef.current
    const maxOffset = sheetMaxOffsetPxRef.current
    const progress = sheetProgressRef.current
    const openHeight = min + progress * maxOffset
    // Шторка может быть уже/выше в зависимости от контента и режима.
    // Гарантируем неотрицательное значение.
    return Math.max(0, openHeight)
  }, [isDesktop, desktopBottomInsetPxRef])

  const updateSheetTransformDom = useCallback(
    (progress: number) => {
      const el = bottomSheetRef.current
      if (!el) return
      if (isDesktop) return

      const clamped = Math.max(0, Math.min(1, progress))
      sheetProgressRef.current = clamped

      const maxOffsetPx = sheetMaxOffsetPxRef.current
      const translateY = (1 - clamped) * maxOffsetPx
      el.style.transform = `translate3d(0, ${translateY}px, 0)`
    },
    [isDesktop, bottomSheetRef],
  )

  const recomputeSheetMaxOffsetPx = useCallback(() => {
    if (typeof window === 'undefined') return
    if (isDesktop) return
    const sheetEl = bottomSheetRef.current
    const minEl = sheetMinVisibleRef.current
    if (!sheetEl || !minEl) return

    const innerEl = sheetEl.querySelector<HTMLElement>('.bottom-sheet-inner')
    let innerPaddingTop = 0
    let innerPaddingBottom = 0
    if (innerEl) {
      const style = window.getComputedStyle(innerEl)
      const pt = Number.parseFloat(style.paddingTop)
      const pb = Number.parseFloat(style.paddingBottom)
      innerPaddingTop = Number.isFinite(pt) ? pt : 0
      innerPaddingBottom = Number.isFinite(pb) ? pb : 0
    }

    const minHeight = minEl.offsetHeight + innerPaddingTop + innerPaddingBottom

    let detailsHeight = 0
    let detailsMarginTop = 0
    const detailsEl = routeDetailsRef.current
    if (detailsEl) {
      detailsHeight = detailsEl.scrollHeight
      const mt = window.getComputedStyle(detailsEl).marginTop
      const mtPx = Number.parseFloat(mt)
      if (Number.isFinite(mtPx)) {
        detailsMarginTop = mtPx
      }
    }

    const vv = window.visualViewport
    const viewportHeight = vv?.height ?? window.innerHeight
    const rootFontSizeStr = window.getComputedStyle(document.documentElement).fontSize
    const rootFontSize = Number.parseFloat(rootFontSizeStr)
    const remPx = Number.isFinite(rootFontSize) ? rootFontSize : 16

    const maxHeightPxRaw = Math.min(Math.max(0, viewportHeight - remPx * 1.75), viewportHeight * 0.78)
    const maxHeightPx = Math.max(minHeight, maxHeightPxRaw)

    const hasExpandableContent = detailsHeight > 2
    const desiredOpenHeight = hasExpandableContent ? minHeight + detailsMarginTop + detailsHeight : minHeight
    const openHeight = Math.min(desiredOpenHeight, maxHeightPx)

    sheetMinHeightPxRef.current = minHeight
    sheetOpenHeightPxRef.current = openHeight
    sheetMaxOffsetPxRef.current = Math.max(0, openHeight - minHeight)

    sheetEl.style.height = `${openHeight}px`

    updateSheetTransformDom(sheetProgressRef.current)
  }, [isDesktop, updateSheetTransformDom, bottomSheetRef, sheetMinVisibleRef, routeDetailsRef])

  useLayoutEffect(() => {
    recomputeSheetMaxOffsetPx()
  }, [
    recomputeSheetMaxOffsetPx,
    // Шторка монтируется только когда основной UI готов. Без этой зависимости
    // эффект не перезапускался в момент появления шторки, и при открытии по
    // deep link она оставалась неизмеренной: высота бралась по контенту, шторка
    // вылезала за экран и уносила поля ввода вверх за границу.
    contentSignature,
    isDesktop,
    isSmartSuggestionsOpen,
    isRouteSheetOpen,
  ])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (isDesktop) return

    const sheetEl = bottomSheetRef.current
    const minEl = sheetMinVisibleRef.current
    const detailsEl = routeDetailsRef.current
    if (!sheetEl || !minEl) return

    let raf = 0
    const schedule = () => {
      if (sheetTouchStartYRef.current != null) {
        sheetDeferredRecomputeRef.current = true
        return
      }
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        recomputeSheetMaxOffsetPx()
      })
    }

    const onResize = () => schedule()
    window.addEventListener('resize', onResize)

    const vv = window.visualViewport
    vv?.addEventListener('resize', onResize)
    vv?.addEventListener('scroll', onResize)

    let ro: ResizeObserver | null = null
    if (typeof window.ResizeObserver === 'function') {
      ro = new window.ResizeObserver(() => schedule())
      ro.observe(sheetEl)
      ro.observe(minEl)
      if (detailsEl) {
        ro.observe(detailsEl)
      }
    }

    return () => {
      window.removeEventListener('resize', onResize)
      vv?.removeEventListener('resize', onResize)
      vv?.removeEventListener('scroll', onResize)
      if (raf) {
        window.cancelAnimationFrame(raf)
      }
      if (ro) {
        ro.disconnect()
      }
    }
  }, [
    isDesktop,
    // Те же зависимости, что и у измеряющего layout-эффекта: ResizeObserver должен
    // подписаться на шторку сразу, как только она появилась в DOM.
    contentSignature,
    recomputeSheetMaxOffsetPx,
    isRouteSheetOpen,
    isSmartSuggestionsOpen,
    bottomSheetRef,
    sheetMinVisibleRef,
    routeDetailsRef,
  ])

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (isDesktop) return

    const sheetEl = bottomSheetRef.current
    const innerEl = sheetEl?.querySelector<HTMLElement>('.bottom-sheet-inner')
    if (!innerEl) return

    const onTouchMove = (event: globalThis.TouchEvent) => {
      if (sheetTouchStartYRef.current == null) return
      if (sheetGestureAxisRef.current !== 'y') return
      event.preventDefault()
    }

    innerEl.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      innerEl.removeEventListener('touchmove', onTouchMove)
    }
  }, [isDesktop, bottomSheetRef])

  const stopSheetSpring = useCallback(() => {
    if (typeof window === 'undefined') return
    if (sheetSpringRafRef.current != null) {
      window.cancelAnimationFrame(sheetSpringRafRef.current)
      sheetSpringRafRef.current = null
    }
    sheetSpringLastTimeRef.current = null
  }, [])

  const startSheetSpring = useCallback(
    (targetProgress: number, initialVelocity?: number) => {
      if (typeof window === 'undefined') return
      if (isDesktop) return

      const clampedTarget = Math.max(0, Math.min(1, targetProgress))
      sheetSpringTargetRef.current = clampedTarget
      if (typeof initialVelocity === 'number' && Number.isFinite(initialVelocity)) {
        sheetSpringVelocityRef.current = initialVelocity
      }

      if (sheetSpringRafRef.current != null) {
        return
      }

      const step = (timestamp: number) => {
        sheetSpringRafRef.current = null
        const target = sheetSpringTargetRef.current
        if (target == null) {
          sheetSpringLastTimeRef.current = null
          return
        }

        const lastTime = sheetSpringLastTimeRef.current
        const dtMs = lastTime == null ? 16 : Math.min(32, Math.max(8, timestamp - lastTime))
        sheetSpringLastTimeRef.current = timestamp
        const dt = dtMs / 1000

        const x = sheetProgressRef.current
        const v0 = sheetSpringVelocityRef.current

        const k = 420
        const c = 70

        const a = k * (target - x) - c * v0
        const v1 = v0 + a * dt
        const x1 = x + v1 * dt

        sheetSpringVelocityRef.current = v1
        updateSheetTransformDom(x1)

        const done = Math.abs(target - x1) < 0.002 && Math.abs(v1) < 0.02
        if (done) {
          updateSheetTransformDom(target)
          sheetSpringVelocityRef.current = 0
          sheetSpringLastTimeRef.current = null
          return
        }

        sheetSpringRafRef.current = window.requestAnimationFrame(step)
      }

      sheetSpringRafRef.current = window.requestAnimationFrame(step)
    },
    [isDesktop, updateSheetTransformDom],
  )

  const setRouteSheetOpenState = useCallback((open: boolean) => {
    setIsRouteSheetOpen(open)
    if (!open) {
      setIsSmartSuggestionsOpen(false)
    }
    if (!isDesktop) {
      if (!open) {
        const hasRange = sheetMaxOffsetPxRef.current > 0
        if (hasRange) {
          startSheetSpring(0, 0)
        } else {
          stopSheetSpring()
          updateSheetTransformDom(0)
        }
        return
      }

      // Открытие: откладываем тяжёлые layout-риды (scrollHeight/getComputedStyle)
      // на следующий кадр, чтобы не блокировать первый paint контента на слабых устройствах.
      window.requestAnimationFrame(() => {
        recomputeSheetMaxOffsetPx()
        const hasRange = sheetMaxOffsetPxRef.current > 0
        if (hasRange) {
          startSheetSpring(1, 0)
        } else {
          stopSheetSpring()
          updateSheetTransformDom(0)
        }
      })
    }
  }, [
    isDesktop,
    recomputeSheetMaxOffsetPx,
    startSheetSpring,
    stopSheetSpring,
    updateSheetTransformDom,
  ])

  const handleSheetTouchStart = (event: TouchEvent) => {
    if (isDragDisabled) return
    if (isDesktop) return
    if (event.touches.length === 0) return
    if (shouldIgnoreSheetTouch(event.target)) return

    markPerfInteraction()

    // Важно: НЕ делаем recomputeSheetMaxOffsetPx() внутри touchstart.
    // Там куча layout-ридов (scrollHeight/getComputedStyle) и на low-tier
    // это даёт фризы на сотни миллисекунд.
    if (sheetMaxOffsetPxRef.current <= 0) return

    stopSheetSpring()
    sheetTouchStartedOnButtonRef.current =
      event.target instanceof Element && Boolean(event.target.closest('button, [role="button"]'))
    sheetTouchStartedInSmartSuggestionsRef.current =
      event.target instanceof Element &&
      Boolean(
        event.target.closest(
          '.smart-suggestions-inline, .smart-suggestions, .smart-suggestions-row, .smart-suggestion-chip, .smart-suggestions-inline-chip',
        ),
      )
    const touch = event.touches[0]
    sheetTouchStartYRef.current = touch.screenY
    sheetTouchLastYRef.current = touch.screenY
    sheetTouchStartXRef.current = touch.screenX
    sheetTouchLastXRef.current = touch.screenX
    sheetGestureAxisRef.current = 'pending'
    sheetDeferredRecomputeRef.current = false
    sheetDragStartProgressRef.current = sheetProgressRef.current

    const now =
      typeof event.timeStamp === 'number' && event.timeStamp > 0 ? event.timeStamp : performance.now()
    sheetDragLastSampleTimeRef.current = now
    sheetDragLastSampleProgressRef.current = sheetProgressRef.current
    sheetDragVelocityRef.current = 0
  }

  const handleSheetTouchMove = (event: TouchEvent) => {
    if (sheetTouchStartYRef.current == null) return
    if (event.touches.length === 0) return
    markPerfInteraction()
    const touch = event.touches[0]
    sheetTouchLastYRef.current = touch.screenY
    sheetTouchLastXRef.current = touch.screenX
    const gestureThresholdPx = sheetTouchStartedOnButtonRef.current
      ? sheetTouchStartedInSmartSuggestionsRef.current
        ? 18
        : 12
      : 6
    const axis = sheetGestureAxisRef.current
    if (axis === 'pending') {
      const startX = sheetTouchStartXRef.current ?? touch.screenX
      const startY = sheetTouchStartYRef.current ?? touch.screenY
      const dx = touch.screenX - startX
      const dy = touch.screenY - startY
      if (Math.abs(dx) >= gestureThresholdPx || Math.abs(dy) >= gestureThresholdPx) {
        sheetGestureAxisRef.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      } else {
        return
      }
    }
    if (sheetGestureAxisRef.current !== 'y') return
    const startY = sheetTouchStartYRef.current
    const dragRange = sheetMaxOffsetPxRef.current
    if (!dragRange || dragRange <= 0) return
    const startProgress =
      sheetDragStartProgressRef.current != null
        ? sheetDragStartProgressRef.current
        : isRouteSheetOpen
          ? 1
          : 0
    const deltaY = touch.screenY - startY
    const nextProgress = Math.max(0, Math.min(1, startProgress - deltaY / dragRange))

    const now =
      typeof event.timeStamp === 'number' && event.timeStamp > 0 ? event.timeStamp : performance.now()
    const lastTime = sheetDragLastSampleTimeRef.current
    const lastProgress = sheetDragLastSampleProgressRef.current
    if (lastTime != null && lastProgress != null) {
      const dtMs = now - lastTime
      if (dtMs > 0 && dtMs < 200) {
        const dt = dtMs / 1000
        const rawV = (nextProgress - lastProgress) / dt
        const clampedV = Math.max(-4, Math.min(4, rawV))
        sheetDragVelocityRef.current = sheetDragVelocityRef.current * 0.7 + clampedV * 0.3
      }
    }
    sheetDragLastSampleTimeRef.current = now
    sheetDragLastSampleProgressRef.current = nextProgress

    sheetAnimTargetRef.current = nextProgress
    if (sheetAnimFrameRef.current == null) {
      sheetAnimFrameRef.current = window.requestAnimationFrame(() => {
        sheetAnimFrameRef.current = null
        const target = sheetAnimTargetRef.current
        if (target == null) return
        updateSheetTransformDom(target)
      })
    }
  }

  const handleSheetTouchEnd = () => {
    markPerfInteraction()
    const axis = sheetGestureAxisRef.current
    const startY = sheetTouchStartYRef.current
    const lastY = sheetTouchLastYRef.current
    sheetTouchStartYRef.current = null
    sheetTouchLastYRef.current = null
    sheetTouchStartXRef.current = null
    sheetTouchLastXRef.current = null
    sheetGestureAxisRef.current = null
    sheetTouchStartedOnButtonRef.current = false
    sheetTouchStartedInSmartSuggestionsRef.current = false
    sheetDragStartProgressRef.current = null

    // Очищаем отложенный кадр анимации drag'а, чтобы не было лишних
    // setState уже после завершения жеста.
    const pendingTarget = sheetAnimTargetRef.current
    if (sheetAnimFrameRef.current != null) {
      window.cancelAnimationFrame(sheetAnimFrameRef.current)
      sheetAnimFrameRef.current = null
    }
    sheetAnimTargetRef.current = null

    let releasedProgress = sheetProgressRef.current
    if (pendingTarget != null) {
      releasedProgress = pendingTarget
      updateSheetTransformDom(pendingTarget)
    }

    sheetDragLastSampleTimeRef.current = null
    sheetDragLastSampleProgressRef.current = null

    if (sheetDeferredRecomputeRef.current) {
      sheetDeferredRecomputeRef.current = false
      window.requestAnimationFrame(() => {
        recomputeSheetMaxOffsetPx()
      })
    }

    if (axis !== 'y') {
      const targetProgress = isRouteSheetOpen ? 1 : 0
      startSheetSpring(targetProgress, 0)
      return
    }

    if (startY == null || lastY == null) return

    const dragVelocity = sheetDragVelocityRef.current
    sheetDragVelocityRef.current = 0

    const velocityThreshold = 1.2
    const targetOpen =
      dragVelocity > velocityThreshold
        ? true
        : dragVelocity < -velocityThreshold
          ? false
          : releasedProgress >= 0.5

    setIsRouteSheetOpen(targetOpen)
    if (!targetOpen) {
      setIsSmartSuggestionsOpen(false)
    }

    const targetProgress = targetOpen ? 1 : 0
    let initialVelocity = dragVelocity
    if (targetOpen && initialVelocity < 0) initialVelocity = 0
    if (!targetOpen && initialVelocity > 0) initialVelocity = 0
    startSheetSpring(targetProgress, initialVelocity * 0.35)
  }

  const handleSheetTouchCancel = () => {
    const axis = sheetGestureAxisRef.current
    sheetTouchStartYRef.current = null
    sheetTouchLastYRef.current = null
    sheetTouchStartXRef.current = null
    sheetTouchLastXRef.current = null
    sheetGestureAxisRef.current = null
    sheetTouchStartedOnButtonRef.current = false
    sheetTouchStartedInSmartSuggestionsRef.current = false
    sheetDragStartProgressRef.current = null

    if (sheetAnimFrameRef.current != null) {
      window.cancelAnimationFrame(sheetAnimFrameRef.current)
      sheetAnimFrameRef.current = null
    }
    const pendingTarget = sheetAnimTargetRef.current
    sheetAnimTargetRef.current = null
    if (pendingTarget != null) {
      updateSheetTransformDom(pendingTarget)
    }

    sheetDragLastSampleTimeRef.current = null
    sheetDragLastSampleProgressRef.current = null
    sheetDragVelocityRef.current = 0

    if (sheetDeferredRecomputeRef.current) {
      sheetDeferredRecomputeRef.current = false
      window.requestAnimationFrame(() => {
        recomputeSheetMaxOffsetPx()
      })
    }

    if (axis === 'y' || axis === 'pending') {
      const targetProgress = isRouteSheetOpen ? 1 : 0
      startSheetSpring(targetProgress, 0)
    }
  }
  // Панель быстрых маршрутов раскрывает шторку; исчезновение маршрута —
  // сворачивает её обратно.
  useEffect(() => {
    if (isDesktop) return

    if (isSmartSuggestionsOpen) {
      if (!isRouteSheetOpen) {
        setIsRouteSheetOpen(true)
      }
      startSheetSpring(1, 0)
      return
    }

    if (!hasRoute) {
      stopSheetSpring()
      updateSheetTransformDom(0)
      if (isRouteSheetOpen) {
        setIsRouteSheetOpen(false)
      }
    }
  }, [
    isDesktop,
    isSmartSuggestionsOpen,
    isRouteSheetOpen,
    hasRoute,
    startSheetSpring,
    stopSheetSpring,
    updateSheetTransformDom,
  ])

  // Пересчёт после смены содержимого: панель быстрых маршрутов и появление
  // маршрута меняют высоту шторки, положение при этом сохраняем.
  useEffect(() => {
    if (isDesktop) return

    if (isSmartSuggestionsOpen) {
      recomputeSheetMaxOffsetPx()
      updateSheetTransformDom(sheetProgressRef.current)
      return
    }

    if (!hasRoute) {
      stopSheetSpring()
      updateSheetTransformDom(0)
      return
    }

    recomputeSheetMaxOffsetPx()
    updateSheetTransformDom(sheetProgressRef.current)
  }, [
    isDesktop,
    isSmartSuggestionsOpen,
    hasRoute,
    recomputeSheetMaxOffsetPx,
    stopSheetSpring,
    updateSheetTransformDom,
  ])

  return {
    isOpen: isRouteSheetOpen,
    setOpen: setRouteSheetOpenState,
    isSmartSuggestionsOpen,
    setSmartSuggestionsOpen: setIsSmartSuggestionsOpen,
    getBottomInsetPx,
    touchHandlers: {
      onTouchStart: handleSheetTouchStart,
      onTouchMove: handleSheetTouchMove,
      onTouchEnd: handleSheetTouchEnd,
      onTouchCancel: handleSheetTouchCancel,
    },
  }
}
