import { useCallback, useLayoutEffect, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { createPortal } from 'react-dom'

export type RouteSuggestionItem = {
  id: string
  title: string
  color?: string
}

interface RouteFormProps {
  fromStation: string
  toStation: string
  fromSuggestions: RouteSuggestionItem[]
  toSuggestions: RouteSuggestionItem[]
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
  const [fromAnchorRect, setFromAnchorRect] = useState<DOMRect | null>(null)
  const [toAnchorRect, setToAnchorRect] = useState<DOMRect | null>(null)

  const measureFromAnchor = useCallback(() => {
    const el = fromInputRef.current
    if (!el) return
    setFromAnchorRect(el.getBoundingClientRect())
  }, [fromInputRef])

  const measureToAnchor = useCallback(() => {
    const el = toInputRef.current
    if (!el) return
    setToAnchorRect(el.getBoundingClientRect())
  }, [toInputRef])

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return
    if (typeof document === 'undefined') return

    if (fromSuggestions.length === 0) {
      setFromAnchorRect(null)
      return
    }

    measureFromAnchor()

    const vv = window.visualViewport
    const onAnyChange = () => measureFromAnchor()
    window.addEventListener('resize', onAnyChange)
    window.addEventListener('scroll', onAnyChange, true)
    vv?.addEventListener('resize', onAnyChange)
    vv?.addEventListener('scroll', onAnyChange)

    return () => {
      window.removeEventListener('resize', onAnyChange)
      window.removeEventListener('scroll', onAnyChange, true)
      vv?.removeEventListener('resize', onAnyChange)
      vv?.removeEventListener('scroll', onAnyChange)
    }
  }, [fromSuggestions.length, measureFromAnchor])

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return
    if (typeof document === 'undefined') return

    if (toSuggestions.length === 0) {
      setToAnchorRect(null)
      return
    }

    measureToAnchor()

    const vv = window.visualViewport
    const onAnyChange = () => measureToAnchor()
    window.addEventListener('resize', onAnyChange)
    window.addEventListener('scroll', onAnyChange, true)
    vv?.addEventListener('resize', onAnyChange)
    vv?.addEventListener('scroll', onAnyChange)

    return () => {
      window.removeEventListener('resize', onAnyChange)
      window.removeEventListener('scroll', onAnyChange, true)
      vv?.removeEventListener('resize', onAnyChange)
      vv?.removeEventListener('scroll', onAnyChange)
    }
  }, [measureToAnchor, toSuggestions.length])

  const renderSuggestionsPortal = (
    anchorRect: DOMRect | null,
    suggestions: RouteSuggestionItem[],
    activeIndex: number,
    onSelect: (stationId: string) => void,
  ) => {
    if (typeof document === 'undefined') return null
    if (!anchorRect) return null
    if (suggestions.length === 0) return null

    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    const viewportHeight = vv?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 0)
    const gapPx = 6
    const spaceAbove = Math.max(0, anchorRect.top - gapPx)
    const spaceBelow = Math.max(0, viewportHeight - anchorRect.bottom - gapPx)
    const renderAbove = spaceAbove >= spaceBelow
    const maxHeightPx = Math.min(144, Math.max(0, (renderAbove ? spaceAbove : spaceBelow) - gapPx))
    const bottom = Math.max(0, viewportHeight - anchorRect.top + gapPx)
    const top = Math.max(0, anchorRect.bottom + gapPx)

    return createPortal(
      <ul
        className="field-suggestions"
        role="listbox"
        style={{
          position: 'fixed',
          left: `${anchorRect.left}px`,
          right: 'auto',
          width: `${anchorRect.width}px`,
          top: renderAbove ? undefined : `${top}px`,
          bottom: renderAbove ? `${bottom}px` : undefined,
          maxHeight: `${maxHeightPx}px`,
          zIndex: 10000,
          pointerEvents: 'auto',
        }}
      >
        {suggestions.map((s, index) => {
          const isActive = index === activeIndex
          return (
            <li
              key={s.id}
              className={`suggestion-item${isActive ? ' suggestion-item--active' : ''}`}
              onPointerDown={(event) => {
                if (event.pointerType === 'mouse') {
                  event.preventDefault()
                }
              }}
              role="option"
              aria-selected={isActive}
              onClick={() => onSelect(s.id)}
            >
              <span
                className="suggestion-line-dot"
                style={s.color ? { backgroundColor: s.color } : undefined}
              />
              <span className="suggestion-item-label">{s.title}</span>
            </li>
          )
        })}
      </ul>,
      document.body,
    )
  }

  return (
    <div className="bottom-fields-row">
      <div className="bottom-field">
        {renderSuggestionsPortal(
          fromAnchorRect,
          fromSuggestions,
          fromSuggestionIndex,
          onSelectFromSuggestion,
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
        {renderSuggestionsPortal(toAnchorRect, toSuggestions, toSuggestionIndex, onSelectToSuggestion)}
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
