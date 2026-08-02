import type { RefObject } from 'react'
import type { StationPickPopoverData } from '../hooks/useStationPickPopover.ts'

type StationPickPopoverProps = {
  data: StationPickPopoverData
  isClosing: boolean
  /** Кнопка, по которой только что нажали — для мгновенной подсветки. */
  pressed: 'from' | 'to' | null
  /** null — позиция ещё не измерена, поповер рисуется скрытым. */
  position: { left: number; top: number } | null
  popoverRef: RefObject<HTMLDivElement | null>
  lineColor?: string
  /**
   * Что сейчас стоит в полях. Нужно, чтобы кнопка честно говорила, какую
   * станцию заменит выбор: поповер теперь открывается и по обычному тапу при
   * двух заполненных полях, и «Куда» без пояснения читалось бы как «добавить».
   */
  currentFromTitle?: string | null
  currentToTitle?: string | null
  onPick: (mode: 'from' | 'to') => void
}

/**
 * Поповер выбора поля после долгого нажатия на станцию.
 *
 * Только отрисовка: и позиционирование, и правила закрытия живут в
 * useStationPickPopover, а что происходит по нажатию кнопки — решает App.
 */
export function StationPickPopover({
  data,
  isClosing,
  pressed,
  position,
  popoverRef,
  lineColor,
  currentFromTitle,
  currentToTitle,
  onPick,
}: StationPickPopoverProps) {
  const renderButton = (mode: 'from' | 'to', label: string, currentTitle?: string | null) => {
    const occupied = Boolean(currentTitle && currentTitle !== data.stationName)
    return (
      <button
        type="button"
        className="station-pick-popover-button"
        data-pressed={pressed === mode ? 'true' : undefined}
        aria-label={
          occupied
            ? `Поставить «${data.stationName}» в поле «${label}» вместо «${currentTitle}»`
            : `Поставить «${data.stationName}» в поле «${label}»`
        }
        onClick={(event) => {
          event.preventDefault()
          onPick(mode)
        }}
      >
        <span className="station-pick-popover-button-label">{label}</span>
        {/* Пробел между строками намеренно в разметке: пока `-sub` не получил
            собственных стилей, подпись читается как «Откуда вместо Крылатское»
            в одну строку, а не слипается в «Откудавместо». */}
        {occupied && ' '}
        {occupied && (
          <span className="station-pick-popover-button-sub" aria-hidden="true">
            вместо {currentTitle}
          </span>
        )}
      </button>
    )
  }

  return (
    <div
      ref={popoverRef}
      className={`station-pick-popover${isClosing ? ' station-pick-popover--closing' : ''}`}
      style={
        position
          ? { left: position.left, top: position.top }
          : { left: 0, top: 0, visibility: 'hidden' }
      }
      role="dialog"
      aria-label="Выбор поля для станции"
    >
      <div className="station-pick-popover-header">
        <span
          className="station-pick-popover-line-dot"
          style={{ backgroundColor: lineColor ?? 'var(--color-accent)' }}
          aria-hidden="true"
        />
        <div className="station-pick-popover-title">{data.stationName}</div>
      </div>

      <div className="station-pick-popover-actions">
        {renderButton('from', 'Откуда', currentFromTitle)}
        {renderButton('to', 'Куда', currentToTitle)}
      </div>
    </div>
  )
}
