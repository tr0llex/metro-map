import { useLayoutEffect, useRef, useState } from 'react'

import './ThemeStationHint.css'

export type StationHintKind = 'from' | 'to' | 'info'

export type StationHint = {
  /** Меняется на каждый показ: нужен как key, чтобы анимация проигрывалась заново. */
  id: number
  kind: StationHintKind
  text: string
  /** Точка тапа во вьюпорте — подсказка встаёт над ней. Без неё — по центру сверху. */
  point?: { x: number; y: number } | null
  /** Цвет линии станции: им красится точка перед текстом. */
  lineColor?: string | null
}

interface ThemeStationHintProps {
  hint: StationHint | null
}

/** Отступ подсказки от точки тапа: чтобы не оказаться под пальцем. */
const GAP_FROM_TAP_PX = 44
/** Минимальный зазор до края экрана. */
const EDGE_PADDING_PX = 12

/**
 * Всплывающее подтверждение «станция назначена в поле».
 *
 * Показывается только когда поле выбрано БЕЗ поповера — то есть тапом по
 * пустому полю. Если поле выбирал человек в поповере, подтверждать нечего: он
 * сам нажал кнопку, а результат виден в шапке над картой.
 *
 * ПОЧЕМУ БЕЗ БУКВЫ A/B. Раньше слева стоял цветной кружок с латинской буквой —
 * той же, что рисуется маркером на карте. Рядом с русским текстом «Куда: …»
 * латинская B неотличима от кириллической В и читалась как предлог: на экране
 * получалось «В Куда: Лубянка», где «В» ещё и другого цвета. Букву заменила
 * точка цвета линии — так же, как в поповере выбора поля.
 *
 * ПОЧЕМУ У СТАНЦИИ, А НЕ ПОД ШАПКОЙ. Подсказка отвечает на вопрос «куда попал
 * мой тап», и искать ответ на другом конце экрана неправильно: палец в этот
 * момент на станции.
 */
export function ThemeStationHint({ hint }: ThemeStationHintProps) {
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  // Позицию считаем после отрисовки: до неё неизвестны размеры подсказки, а
  // значит нечем прижать её к краям экрана.
  useLayoutEffect(() => {
    const point = hint?.point
    if (!point) {
      setPosition(null)
      return
    }
    const node = nodeRef.current
    if (!node) return

    const rect = node.getBoundingClientRect()
    const maxLeft = window.innerWidth - rect.width - EDGE_PADDING_PX
    const left = Math.max(EDGE_PADDING_PX, Math.min(point.x - rect.width / 2, maxLeft))

    // Над точкой, а если сверху не помещается — под ней.
    const above = point.y - GAP_FROM_TAP_PX - rect.height
    const top = above >= EDGE_PADDING_PX ? above : point.y + GAP_FROM_TAP_PX

    setPosition({ left, top })
  }, [hint])

  const anchored = Boolean(hint?.point)

  return (
    <div
      className={`theme-station-hint-dock${anchored ? ' theme-station-hint-dock--anchored' : ''}`}
      role="status"
      aria-live="polite"
    >
      {hint && (
        <div
          key={hint.id}
          ref={nodeRef}
          className="theme-station-hint"
          data-kind={hint.kind}
          style={
            anchored
              ? position
                ? { left: position.left, top: position.top }
                : // Пока не измерили — держим прозрачной, иначе виден рывок из угла.
                  { left: 0, top: 0, opacity: 0 }
              : undefined
          }
        >
          {hint.kind !== 'info' && (
            <span
              className="theme-station-hint-dot"
              style={hint.lineColor ? { backgroundColor: hint.lineColor } : undefined}
              aria-hidden="true"
            />
          )}
          <span className="theme-station-hint-text">{hint.text}</span>
        </div>
      )}
    </div>
  )
}

export default ThemeStationHint
