import { useCallback } from 'react'

/**
 * Горизонтальная прокрутка перетаскиванием («хватай и тяни»).
 *
 * Лента вариантов маршрута прокручивалась только колесом и пальцем: мышью её
 * было не сдвинуть, а на десктопе скроллбар тонкий и наплывающий. Хук вешает
 * обработчики на сам контейнер и превращает зажатую мышь в прокрутку.
 *
 * Главная сложность — не сломать обычный клик по карточке. Решение:
 *
 *   • прокрутка начинается только после порога в DRAG_THRESHOLD_PX, поэтому
 *     клик с микросдвигом (а он есть почти всегда) остаётся кликом;
 *   • после РЕАЛЬНОГО перетаскивания гасим ровно один следующий `click` в фазе
 *     перехвата — иначе отпускание кнопки выбирало бы тот вариант, над которым
 *     случайно оказался курсор;
 *   • флаг подавления сбрасывается на следующем pointerdown, чтобы «съеденный»
 *     клик не мог утечь в другое взаимодействие.
 *
 * Тач и перо не трогаем: там прокрутка нативная и уже работает.
 */
const DRAG_THRESHOLD_PX = 5

// Ref-колбэк, а не ref-объект: лента маршрутов монтируется и размонтируется
// вместе с вариантами, и обработчики надо снимать в этот же момент. React 19
// умеет забирать функцию очистки прямо из ref-колбэка.
export function useDragScroll<T extends HTMLElement = HTMLDivElement>(): (
  node: T | null,
) => (() => void) | undefined {
  return useCallback((node: T | null) => {
    if (!node) return
    if (typeof window === 'undefined') return

    // Отдельная константа: внутри function-деклараций сужение типа `node`
    // по проверке выше не сохраняется.
    const el: T = node

    let activePointerId: number | null = null
    let startX = 0
    let startScrollLeft = 0
    let isDragging = false
    let suppressNextClick = false
    let prevUserSelect = ''

    const finishPointer = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerCancel)
      activePointerId = null
      if (isDragging) {
        isDragging = false
        el.style.userSelect = prevUserSelect
        delete el.dataset.dragging
      }
    }

    function onPointerMove(event: PointerEvent) {
      if (activePointerId == null || event.pointerId !== activePointerId) return

      const dx = event.clientX - startX
      if (!isDragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX) return
        isDragging = true
        prevUserSelect = el.style.userSelect
        el.style.userSelect = 'none'
        // Крючок для стилей (курсор «схвачено») — сами стили живут в CSS.
        el.dataset.dragging = 'true'
      }

      // Без этого браузер начинает выделять текст внутри карточек.
      event.preventDefault()
      el.scrollLeft = startScrollLeft - dx
    }

    function onPointerUp(event: PointerEvent) {
      if (activePointerId == null || event.pointerId !== activePointerId) return
      const wasDragging = isDragging
      finishPointer()
      if (wasDragging) {
        suppressNextClick = true
      }
    }

    function onPointerCancel(event: PointerEvent) {
      if (activePointerId == null || event.pointerId !== activePointerId) return
      finishPointer()
    }

    const onPointerDown = (event: PointerEvent) => {
      // Прокрутка мышью. Тач и перо прокручивают ленту сами.
      if (event.pointerType !== 'mouse') return
      if (event.button !== 0) return
      if (activePointerId != null) return

      // Клик от прошлого перетаскивания уже должен был прийти и быть съеден.
      // Если его не случилось (курсор ушёл с ленты), сбрасываем флаг здесь,
      // чтобы он не погасил ни в чём не повинный следующий клик.
      suppressNextClick = false

      activePointerId = event.pointerId
      startX = event.clientX
      startScrollLeft = el.scrollLeft
      isDragging = false

      window.addEventListener('pointermove', onPointerMove, { passive: false })
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerCancel)
    }

    const onClickCapture = (event: MouseEvent) => {
      if (!suppressNextClick) return
      suppressNextClick = false
      event.preventDefault()
      event.stopPropagation()
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('click', onClickCapture, true)

    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('click', onClickCapture, true)
      finishPointer()
    }
  }, [])
}
