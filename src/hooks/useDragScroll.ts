import { useCallback } from 'react'

/**
 * Горизонтальная прокрутка ленты мышью: перетаскиванием («хватай и тяни») и
 * колесом.
 *
 * Лента вариантов маршрута прокручивалась только пальцем: мышью её было не
 * сдвинуть, а на десктопе скроллбар тонкий и наплывающий. Хук вешает
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
 *
 * Колесо. Вертикальное колесо над лентой браузер горизонтальной прокруткой не
 * считает — для этого надо держать Shift, о чём знают немногие. Наведя курсор
 * на ленту, человек крутит колесо и ожидает, что поедет она; вместо этого
 * ехала страница под ней. Хук переводит вертикальный шаг в горизонтальный.
 */
const DRAG_THRESHOLD_PX = 5

/**
 * Сколько пикселей в одном «шаге» колеса, когда браузер меряет его строками
 * (deltaMode === DOM_DELTA_LINE, так делает Firefox для обычной мыши).
 */
const WHEEL_LINE_HEIGHT_PX = 16

/**
 * Какую долю оставшегося пути лента проходит за кадр. Прокрутка идёт не рывком
 * на весь шаг колеса, а догоняющей анимацией: цель копится отдельно от текущего
 * положения, поэтому несколько быстрых щелчков складываются в одно движение, а
 * не перебивают друг друга.
 */
const WHEEL_EASING = 0.22

/** Ближе этого к цели дотягиваем сразу: остаток уже неразличим. */
const WHEEL_SNAP_PX = 0.5

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
    /** Куда лента едет по колесу. null — анимации нет. */
    let wheelTargetLeft: number | null = null
    let wheelRafId: number | null = null

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

      // Схватились за ленту рукой — догоняющая анимация колеса больше не нужна:
      // иначе она продолжала бы тянуть ленту из-под курсора.
      stopWheelAnimation()

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

    const stopWheelAnimation = () => {
      if (wheelRafId != null) {
        window.cancelAnimationFrame(wheelRafId)
        wheelRafId = null
      }
      wheelTargetLeft = null
    }

    function stepWheelAnimation() {
      wheelRafId = null
      if (wheelTargetLeft == null) return

      const distance = wheelTargetLeft - el.scrollLeft
      if (Math.abs(distance) <= WHEEL_SNAP_PX) {
        el.scrollLeft = wheelTargetLeft
        wheelTargetLeft = null
        return
      }

      el.scrollLeft += distance * WHEEL_EASING
      wheelRafId = window.requestAnimationFrame(stepWheelAnimation)
    }

    const prefersReducedMotion = () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const onWheel = (event: WheelEvent) => {
      // Горизонтальный жест (в том числе Shift + колесо, который браузер сам
      // кладёт в deltaX) отдаём браузеру: он уже делает ровно то, что нужно.
      if (event.deltaX !== 0) return
      if (event.deltaY === 0) return

      const maxScrollLeft = el.scrollWidth - el.clientWidth
      if (maxScrollLeft <= 0) return

      const step =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? event.deltaY * WHEEL_LINE_HEIGHT_PX
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? event.deltaY * el.clientWidth
            : event.deltaY

      // Считаем от НЕДОКРУЧЕННОЙ цели, а не от текущего положения: пока лента
      // догоняет, следующий щелчок колеса должен добавиться к пути, а не
      // отмерить свой шаг заново от середины анимации — иначе быстрая
      // прокрутка проезжает заметно меньше, чем накрутили.
      const from = wheelTargetLeft ?? el.scrollLeft
      const next = Math.max(0, Math.min(maxScrollLeft, from + step))
      // Лента упёрлась в край — событие не наше, пусть прокручивается страница.
      // Иначе колесо над лентой намертво запирало бы прокрутку всего экрана.
      if (next === from) return

      event.preventDefault()

      if (prefersReducedMotion()) {
        stopWheelAnimation()
        el.scrollLeft = next
        return
      }

      wheelTargetLeft = next
      if (wheelRafId == null) {
        wheelRafId = window.requestAnimationFrame(stepWheelAnimation)
      }
    }

    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('click', onClickCapture, true)
    // passive: false — иначе preventDefault() не работает и страница уедет
    // вместе с лентой.
    el.addEventListener('wheel', onWheel, { passive: false })

    return () => {
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('click', onClickCapture, true)
      el.removeEventListener('wheel', onWheel)
      stopWheelAnimation()
      finishPointer()
    }
  }, [])
}
