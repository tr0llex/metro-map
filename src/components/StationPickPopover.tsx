import type { RefObject } from 'react'
import type { StationPickPopoverData } from '../hooks/useStationPickPopover.ts'

export type StationPickPopoverProps = {
  data: StationPickPopoverData
  isClosing: boolean
  /** Кнопка, по которой только что нажали — для мгновенной подсветки. */
  pressed: 'from' | 'to' | null
  /** null — позиция ещё не измерена, поповер рисуется скрытым. */
  position: { left: number; top: number } | null
  popoverRef: RefObject<HTMLDivElement | null>
  lineColor?: string
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
  onPick,
}: StationPickPopoverProps) {
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
        <button
          type="button"
          className="station-pick-popover-button"
          data-pressed={pressed === 'from' ? 'true' : undefined}
          onClick={(event) => {
            event.preventDefault()
            onPick('from')
          }}
        >
          Откуда
        </button>
        <button
          type="button"
          className="station-pick-popover-button"
          data-pressed={pressed === 'to' ? 'true' : undefined}
          onClick={(event) => {
            event.preventDefault()
            onPick('to')
          }}
        >
          Куда
        </button>
      </div>
    </div>
  )
}
