import type { KeyboardEvent, RefObject } from 'react'
import type { FullGraphStation } from '../metro/types'

interface RouteFormProps {
  fromStation: string
  toStation: string
  fromSuggestions: FullGraphStation[]
  toSuggestions: FullGraphStation[]
  fromSuggestionIndex: number
  toSuggestionIndex: number
  fromSelectedColor?: string
  toSelectedColor?: string
  fromInputRef: RefObject<HTMLInputElement | null>
  toInputRef: RefObject<HTMLInputElement | null>
  onFromChange: (value: string) => void
  onToChange: (value: string) => void
  onFromKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  onToKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  onSelectFromSuggestion: (stationId: string) => void
  onSelectToSuggestion: (stationId: string) => void
  onSwap: () => void
  onClearFrom: () => void
  onClearTo: () => void
}

export function RouteForm({
  fromStation,
  toStation,
  fromSuggestions,
  toSuggestions,
  fromSuggestionIndex,
  toSuggestionIndex,
  fromSelectedColor,
  toSelectedColor,
  fromInputRef,
  toInputRef,
  onFromChange,
  onToChange,
  onFromKeyDown,
  onToKeyDown,
  onSelectFromSuggestion,
  onSelectToSuggestion,
  onSwap,
  onClearFrom,
  onClearTo,
}: RouteFormProps) {
  return (
    <div className="bottom-fields-row">
      <div className="bottom-field">
        {fromSuggestions.length > 0 && (
          <ul className="field-suggestions">
            {fromSuggestions.map((s, index) => {
              const isActive = index === fromSuggestionIndex
              return (
                <li
                  key={s.id}
                  className={`suggestion-item${isActive ? ' suggestion-item--active' : ''}`}
                  onClick={() => onSelectFromSuggestion(s.id)}
                >
                  {s.title}
                </li>
              )
            })}
          </ul>
        )}
        {fromSelectedColor && (
          <span
            className="bottom-input-line-dot"
            style={{ backgroundColor: fromSelectedColor }}
            aria-hidden="true"
          />
        )}
        <input
          className={`bottom-input${fromSelectedColor ? ' bottom-input--with-line-dot' : ''}`}
          type="text"
          placeholder="Откуда"
          value={fromStation}
          ref={fromInputRef}
          onChange={(e) => onFromChange(e.target.value)}
          onKeyDown={onFromKeyDown}
        />
        {fromStation && (
          <button
            type="button"
            className="bottom-input-clear"
            onClick={onClearFrom}
            aria-label="Очистить поле Откуда"
          >
            ×
          </button>
        )}
      </div>

      <button
        type="button"
        className="swap-button"
        onClick={onSwap}
        aria-label="Поменять местами станции Откуда и Куда"
      >
        ⇅
      </button>

      <div className="bottom-field">
        {toSuggestions.length > 0 && (
          <ul className="field-suggestions">
            {toSuggestions.map((s, index) => {
              const isActive = index === toSuggestionIndex
              return (
                <li
                  key={s.id}
                  className={`suggestion-item${isActive ? ' suggestion-item--active' : ''}`}
                  onClick={() => onSelectToSuggestion(s.id)}
                >
                  {s.title}
                </li>
              )
            })}
          </ul>
        )}
        {toSelectedColor && (
          <span
            className="bottom-input-line-dot"
            style={{ backgroundColor: toSelectedColor }}
            aria-hidden="true"
          />
        )}
        <input
          className={`bottom-input${toSelectedColor ? ' bottom-input--with-line-dot' : ''}`}
          type="text"
          placeholder="Куда"
          value={toStation}
          ref={toInputRef}
          onChange={(e) => onToChange(e.target.value)}
          onKeyDown={onToKeyDown}
        />
        {toStation && (
          <button
            type="button"
            className="bottom-input-clear"
            onClick={onClearTo}
            aria-label="Очистить поле Куда"
          >
            ×
          </button>
        )}
      </div>
    </div>
  )
}
