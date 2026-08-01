import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { IconClose, IconSwap } from './icons.tsx'

export type RouteSuggestionItem = {
  id: string
  title: string
  color?: string
  /**
   * Название линии. Заполняется только у одноимённых станций (Киевская ×3,
   * Арбатская ×2 …), где без него строки списка неразличимы.
   */
  lineTitle?: string
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
  isDesktop: boolean
  /**
   * Запрос введён, но не совпал ни с одной станцией. Раньше список в этом случае
   * просто исчезал, и опечатка была неотличима от «приложение зависло»; чаще
   * всего причина — латинская раскладка.
   */
  fromNoMatches?: boolean
  toNoMatches?: boolean
  /**
   * Подсказка под конкретным полем — сейчас это единственный случай, когда
   * выбранная станция уже занята соседним полем. Раньше об этом сообщал только
   * общий блок ошибки под формой: далеко от поля, которое надо исправить.
   */
  fromHint?: string | null
  toHint?: string | null
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
  isDesktop,
  fromNoMatches = false,
  toNoMatches = false,
  fromHint = null,
  toHint = null,
}: RouteFormProps) {
  const uid = useId()
  const fromInputId = `route-from-${uid}`
  const toInputId = `route-to-${uid}`
  const fromListboxId = `route-from-listbox-${uid}`
  const toListboxId = `route-to-listbox-${uid}`
  const fromHintId = `route-from-hint-${uid}`
  const toHintId = `route-to-hint-${uid}`

  const renderFieldHint = (id: string, text: string) => (
    <p id={id} className="bottom-field-hint bottom-field-hint--error" role="status" aria-live="polite">
      {text}
    </p>
  )

  const exitMs = 160

  /**
   * Список открыт и когда совпадений нет: там показывается пустое состояние.
   * Раньше всё было завязано на `suggestions.length > 0`, поэтому пустое
   * состояние физически некуда было положить.
   */
  const fromListOpen = fromSuggestions.length > 0 || fromNoMatches
  const toListOpen = toSuggestions.length > 0 || toNoMatches

  /**
   * A11Y: пока по списку не ходили стрелками, индекс равен -1, и раньше
   * `aria-activedescendant` не выставлялся вовсе — скринридер не называл ни
   * одного варианта, хотя Enter уже выбирал первый. Поэтому при открытом
   * списке указываем на тот элемент, который сработает по Enter.
   */
  const getActiveOptionId = (listboxId: string, activeIndex: number, suggestions: RouteSuggestionItem[]) => {
    if (suggestions.length === 0) return undefined
    const index = activeIndex >= 0 && activeIndex < suggestions.length ? activeIndex : 0
    return `${listboxId}-opt-${index}`
  }

  const fromActiveOptionId = getActiveOptionId(fromListboxId, fromSuggestionIndex, fromSuggestions)
  const toActiveOptionId = getActiveOptionId(toListboxId, toSuggestionIndex, toSuggestions)

  const [fromAnchorRect, setFromAnchorRect] = useState<DOMRect | null>(null)
  const [toAnchorRect, setToAnchorRect] = useState<DOMRect | null>(null)

  const [fromSuggestionsClosing, setFromSuggestionsClosing] = useState(false)
  const [toSuggestionsClosing, setToSuggestionsClosing] = useState(false)
  const [fromSuggestionsLast, setFromSuggestionsLast] = useState<RouteSuggestionItem[]>([])
  const [toSuggestionsLast, setToSuggestionsLast] = useState<RouteSuggestionItem[]>([])
  const fromCloseTimeoutRef = useRef<number | null>(null)
  const toCloseTimeoutRef = useRef<number | null>(null)
  const fromMeasureRafRef = useRef<number | null>(null)
  const toMeasureRafRef = useRef<number | null>(null)

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

  const scheduleMeasureFromAnchor = useCallback(() => {
    if (fromMeasureRafRef.current != null) return
    fromMeasureRafRef.current = window.requestAnimationFrame(() => {
      fromMeasureRafRef.current = null
      measureFromAnchor()
    })
  }, [measureFromAnchor])

  const scheduleMeasureToAnchor = useCallback(() => {
    if (toMeasureRafRef.current != null) return
    toMeasureRafRef.current = window.requestAnimationFrame(() => {
      toMeasureRafRef.current = null
      measureToAnchor()
    })
  }, [measureToAnchor])

  useEffect(() => {
    return () => {
      if (fromCloseTimeoutRef.current != null) {
        window.clearTimeout(fromCloseTimeoutRef.current)
        fromCloseTimeoutRef.current = null
      }
      if (toCloseTimeoutRef.current != null) {
        window.clearTimeout(toCloseTimeoutRef.current)
        toCloseTimeoutRef.current = null
      }
      if (fromMeasureRafRef.current != null) {
        window.cancelAnimationFrame(fromMeasureRafRef.current)
        fromMeasureRafRef.current = null
      }
      if (toMeasureRafRef.current != null) {
        window.cancelAnimationFrame(toMeasureRafRef.current)
        toMeasureRafRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (fromSuggestions.length > 0) {
      setFromSuggestionsLast(fromSuggestions)
    }
  }, [fromSuggestions])

  useEffect(() => {
    if (toSuggestions.length > 0) {
      setToSuggestionsLast(toSuggestions)
    }
  }, [toSuggestions])

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return
    if (typeof document === 'undefined') return

    if (!fromListOpen) {
      if (fromAnchorRect && !fromSuggestionsClosing) {
        setFromSuggestionsClosing(true)
        if (fromCloseTimeoutRef.current != null) {
          window.clearTimeout(fromCloseTimeoutRef.current)
        }
        fromCloseTimeoutRef.current = window.setTimeout(() => {
          setFromAnchorRect(null)
          setFromSuggestionsClosing(false)
          fromCloseTimeoutRef.current = null
        }, exitMs)
      }
      return
    }

    if (fromCloseTimeoutRef.current != null) {
      window.clearTimeout(fromCloseTimeoutRef.current)
      fromCloseTimeoutRef.current = null
    }
    setFromSuggestionsClosing(false)
    scheduleMeasureFromAnchor()

    const vv = window.visualViewport
    const onAnyChange = () => scheduleMeasureFromAnchor()
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
  }, [fromListOpen, fromAnchorRect, fromSuggestionsClosing, scheduleMeasureFromAnchor])

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return
    if (typeof document === 'undefined') return

    if (!toListOpen) {
      if (toAnchorRect && !toSuggestionsClosing) {
        setToSuggestionsClosing(true)
        if (toCloseTimeoutRef.current != null) {
          window.clearTimeout(toCloseTimeoutRef.current)
        }
        toCloseTimeoutRef.current = window.setTimeout(() => {
          setToAnchorRect(null)
          setToSuggestionsClosing(false)
          toCloseTimeoutRef.current = null
        }, exitMs)
      }
      return
    }

    if (toCloseTimeoutRef.current != null) {
      window.clearTimeout(toCloseTimeoutRef.current)
      toCloseTimeoutRef.current = null
    }
    setToSuggestionsClosing(false)
    scheduleMeasureToAnchor()

    const vv = window.visualViewport
    const onAnyChange = () => scheduleMeasureToAnchor()
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
  }, [toListOpen, toAnchorRect, toSuggestionsClosing, scheduleMeasureToAnchor])

  const renderSuggestionsPortal = (
    anchorRect: DOMRect | null,
    closing: boolean,
    listboxId: string,
    ariaLabel: string,
    suggestions: RouteSuggestionItem[],
    suggestionsLast: RouteSuggestionItem[],
    activeIndex: number,
    onSelect: (stationId: string) => void,
    showEmpty: boolean,
  ) => {
    if (typeof document === 'undefined') return null
    if (!anchorRect) return null
    const items = suggestions.length > 0 ? suggestions : closing ? suggestionsLast : []
    const renderEmpty = items.length === 0 && showEmpty
    if (items.length === 0 && !renderEmpty) return null

    const vv = typeof window !== 'undefined' ? window.visualViewport : null
    const viewportHeight = vv?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 0)
    const gapPx = 6
    const spaceAbove = Math.max(0, anchorRect.top - gapPx)
    const spaceBelow = Math.max(0, viewportHeight - anchorRect.bottom - gapPx)
    const renderAbove = !isDesktop
    /**
     * Потолок был 144px при восьми подсказках по 44px, а `.field-suggestions`
     * прячет переполнение — пять вариантов из восьми были не просто не видны,
     * до них нельзя было и доскроллить. Потолок поднят до шести строк, а
     * вертикальный скролл включён здесь же (в стилях overflow нужен именно
     * hidden по горизонтали — ради скруглений).
     */
    const maxHeightPx = Math.min(288, Math.max(0, (renderAbove ? spaceAbove : spaceBelow) - gapPx))
    const bottom = Math.max(0, viewportHeight - anchorRect.top + gapPx)
    const top = Math.max(0, anchorRect.bottom + gapPx)

    return createPortal(
      <ul
        className={`field-suggestions${closing ? ' field-suggestions--closing' : ''}`}
        role="listbox"
        id={listboxId}
        aria-label={ariaLabel}
        style={{
          position: 'fixed',
          left: `${anchorRect.left}px`,
          right: 'auto',
          width: `${anchorRect.width}px`,
          top: renderAbove ? 'auto' : `${top}px`,
          bottom: renderAbove ? `${bottom}px` : 'auto',
          maxHeight: `${maxHeightPx}px`,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          WebkitOverflowScrolling: 'touch',
          zIndex: 10000,
          pointerEvents: 'auto',
        }}
      >
        {renderEmpty && (
          <li className="suggestion-empty" role="presentation" aria-live="polite">
            <span>Ничего не нашлось</span>
            <span className="suggestion-empty-hint">Проверь раскладку клавиатуры</span>
          </li>
        )}
        {items.map((s, index) => {
          const isActive = index === activeIndex
          return (
            <li
              key={s.id}
              id={`${listboxId}-opt-${index}`}
              className={`suggestion-item${isActive ? ' suggestion-item--active' : ''}`}
              onPointerDown={(event) => {
                if (event.pointerType === 'mouse') {
                  event.preventDefault()
                }
              }}
              role="option"
              aria-selected={isActive}
              aria-label={s.lineTitle ? `${s.title}, ${s.lineTitle}` : s.title}
              onClick={() => onSelect(s.id)}
            >
              <span
                className="suggestion-line-dot"
                style={s.color ? { backgroundColor: s.color } : undefined}
              />
              <span className="suggestion-item-text">
                <span className="suggestion-item-label">{s.title}</span>
                {/* Название линии есть только у одноимённых станций (Киевская ×3
                    и т.п.) — второй строкой, чтобы не отъедать ширину у названия. */}
                {s.lineTitle && <span className="suggestion-item-line">{s.lineTitle}</span>}
              </span>
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
          fromSuggestionsClosing,
          fromListboxId,
          'Подсказки для поля Откуда',
          fromSuggestions,
          fromSuggestionsLast,
          fromSuggestionIndex,
          onSelectFromSuggestion,
          fromNoMatches,
        )}
        {fromSelectedColor && (
          <span
            className="bottom-input-line-dot"
            style={{ backgroundColor: fromSelectedColor }}
            aria-hidden="true"
          />
        )}
        <input
          id={fromInputId}
          className={`bottom-input${fromSelectedColor ? ' bottom-input--with-line-dot' : ''}`}
          type="text"
          placeholder="Откуда"
          value={fromStation}
          ref={fromInputRef}
          onChange={(e) => onFromChange(e.target.value)}
          onKeyDown={onFromKeyDown}
          role="combobox"
          aria-label="Станция отправления"
          aria-autocomplete="list"
          aria-controls={fromListboxId}
          aria-expanded={fromListOpen}
          aria-activedescendant={fromSuggestions.length > 0 ? fromActiveOptionId : undefined}
          aria-describedby={fromHint ? fromHintId : undefined}
        />
        {fromStation && (
          <button
            type="button"
            className="bottom-input-clear"
            onClick={onClearFrom}
            aria-label="Очистить поле Откуда"
          >
            <IconClose />
          </button>
        )}
        {fromHint && renderFieldHint(fromHintId, fromHint)}
      </div>

      <button
        type="button"
        className="swap-button"
        onClick={onSwap}
        aria-label="Поменять местами станции Откуда и Куда"
      >
        <IconSwap />
      </button>

      <div className="bottom-field">
        {renderSuggestionsPortal(
          toAnchorRect,
          toSuggestionsClosing,
          toListboxId,
          'Подсказки для поля Куда',
          toSuggestions,
          toSuggestionsLast,
          toSuggestionIndex,
          onSelectToSuggestion,
          toNoMatches,
        )}
        {toSelectedColor && (
          <span
            className="bottom-input-line-dot"
            style={{ backgroundColor: toSelectedColor }}
            aria-hidden="true"
          />
        )}
        <input
          id={toInputId}
          className={`bottom-input${toSelectedColor ? ' bottom-input--with-line-dot' : ''}`}
          type="text"
          placeholder="Куда"
          value={toStation}
          ref={toInputRef}
          onChange={(e) => onToChange(e.target.value)}
          onKeyDown={onToKeyDown}
          role="combobox"
          aria-label="Станция назначения"
          aria-autocomplete="list"
          aria-controls={toListboxId}
          aria-expanded={toListOpen}
          aria-activedescendant={toSuggestions.length > 0 ? toActiveOptionId : undefined}
          aria-describedby={toHint ? toHintId : undefined}
        />
        {toStation && (
          <button
            type="button"
            className="bottom-input-clear"
            onClick={onClearTo}
            aria-label="Очистить поле Куда"
          >
            <IconClose />
          </button>
        )}
        {toHint && renderFieldHint(toHintId, toHint)}
      </div>
    </div>
  )
}
