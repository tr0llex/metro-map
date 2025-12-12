import type { CSSProperties, Ref } from 'react'
import type { RouteResult } from '../metro/types'

export type DecoratedRideSegment = {
  type: 'ride'
  key: string
  fromTitle: string
  toTitle: string
  lineColor?: string
  stationTitles: string[]
  travelMinutes: number
}

export type DecoratedTransferSegment = {
  type: 'transfer'
  key: string
  fromTitle: string
  toTitle: string
  fromLineColor?: string
  toLineColor?: string
  travelMinutes: number
  isFar: boolean
}

export type DecoratedSegment = DecoratedRideSegment | DecoratedTransferSegment

interface RouteDetailsSheetProps {
  routeResult: RouteResult | null
  routeAlternatives: RouteResult[]
  activeRouteIndex: number
  onChangeActiveRoute: (index: number) => void
  onOpenRouteSheet: () => void
  errorMessage: string | null
  isDesktop: boolean
  isRouteSheetOpen: boolean
  detailsStyle?: CSSProperties
  decoratedSegments: DecoratedSegment[]
  getRouteVariantLabel: (index: number, routes: RouteResult[]) => string
  arrivalTimeLabel?: string | null
  detailsRef?: Ref<HTMLDivElement>
  isFavoriteRoute?: boolean
  onToggleFavoriteRoute?: () => void
}

export function RouteDetailsSheet({
  routeResult,
  routeAlternatives,
  activeRouteIndex,
  onChangeActiveRoute,
  onOpenRouteSheet,
  errorMessage,
  isDesktop,
  isRouteSheetOpen,
  detailsStyle,
  decoratedSegments,
  getRouteVariantLabel,
  arrivalTimeLabel,
  detailsRef,
  isFavoriteRoute,
  onToggleFavoriteRoute,
}: RouteDetailsSheetProps) {
  const hasAlternatives = routeAlternatives.length > 1

  return (
    <>
      {hasAlternatives && !errorMessage && !isDesktop && (
        <div className="bottom-route-summary-wrapper">
          <div className="bottom-route-summary-scroll">
            {routeAlternatives.map((route, index) => {
              const isActive = index === activeRouteIndex
              const label = getRouteVariantLabel(index, routeAlternatives)
              return (
                <button
                  key={index}
                  type="button"
                  className={`bottom-route-chip${isActive ? ' bottom-route-chip--active' : ''}`}
                  tabIndex={0}
                  onClick={() => {
                    onChangeActiveRoute(index)
                    onOpenRouteSheet()
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      onChangeActiveRoute(index)
                      onOpenRouteSheet()
                    }
                  }}
                  aria-label={`Выбрать маршрут: ${label}, ~${route.totalMinutes} мин, пересадок ${route.transfersCount}`}
                >
                  <div className="bottom-route-chip-main">
                    {label} • ⏱ {route.totalMinutes} мин
                  </div>
                  <div className="bottom-route-chip-sub">
                    Пересадок: {route.transfersCount}
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {routeResult && !errorMessage && (
        <div
          className={`bottom-route-details${
            isRouteSheetOpen ? ' bottom-route-details--open' : ' bottom-route-details--closed'
          }`}
          style={detailsStyle}
          ref={detailsRef}
        >
          <div className="route-result">
            {hasAlternatives && isDesktop && (
              <div className="route-choices-desktop">
                <div className="route-choices-desktop-track">
                  {routeAlternatives.map((route, index) => {
                    const isActive = index === activeRouteIndex
                    const label = getRouteVariantLabel(index, routeAlternatives)
                    return (
                      <button
                        key={index}
                        type="button"
                        className={`bottom-route-chip route-choice-chip${
                          isActive ? ' bottom-route-chip--active' : ''
                        }`}
                        onClick={() => {
                          onChangeActiveRoute(index)
                        }}
                      >
                        <div className="bottom-route-chip-main">{label}</div>
                        <div className="bottom-route-chip-sub">
                          ⏱ {route.totalMinutes} мин • Пересадок: {route.transfersCount}
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            <div className="route-result-scroll">
              <div className="route-summary">
                <div className="route-summary-main">
                  <span className="summary-time">
                    ⏱ {routeResult.totalMinutes} мин
                  </span>
                  {arrivalTimeLabel && (
                    <span className="summary-arrival">
                      Прибытие ~{arrivalTimeLabel}
                    </span>
                  )}
                  <span className="summary-transfers">
                    Пересадок: {routeResult.transfersCount}
                  </span>
                </div>
                {onToggleFavoriteRoute && (
                  <button
                    type="button"
                    className={`route-favorite-button${
                      isFavoriteRoute ? ' route-favorite-button--active' : ''
                    }`}
                    onClick={onToggleFavoriteRoute}
                    aria-pressed={isFavoriteRoute === true}
                    aria-label={
                      isFavoriteRoute
                        ? 'Убрать маршрут из избранного'
                        : 'Добавить маршрут в избранное'
                    }
                  >
                    ★
                  </button>
                )}
              </div>
              <ol className="route-steps">
                {decoratedSegments.map((segment) => {
                  if (segment.type === 'transfer') {
                    return (
                      <li key={segment.key} className="route-step route-step--transfer">
                        <div className="line-pill line-pill--dual">
                          <span
                            className="line-pill-half"
                            style={
                              segment.fromLineColor
                                ? { backgroundColor: segment.fromLineColor }
                                : undefined
                            }
                          />
                          <span
                            className="line-pill-half"
                            style={
                              segment.toLineColor
                                ? { backgroundColor: segment.toLineColor }
                                : undefined
                            }
                          />
                        </div>
                        <div className="step-body">
                          <div className="step-title">
                            {segment.isFar ? 'Дальний переход' : 'Пересадка'}: {segment.fromTitle} →{' '}
                            {segment.toTitle}
                          </div>
                          <div className="step-meta">
                            {segment.isFar ? 'Дальний переход' : 'Переход'} • ~
                            {Math.round(segment.travelMinutes)} мин
                          </div>
                        </div>
                      </li>
                    )
                  }

                  return (
                    <li key={segment.key} className="route-step">
                      <div
                        className="line-pill"
                        style={
                          segment.lineColor
                            ? { backgroundColor: segment.lineColor }
                            : undefined
                        }
                      />
                      <div className="step-body">
                        <div className="step-title">
                          Поезд: {segment.fromTitle} → {segment.toTitle}
                        </div>
                        <div className="step-meta">
                          Поездка • {segment.stationTitles.length} станций • ~
                          {Math.round(segment.travelMinutes)} мин
                        </div>
                        <ul className="step-station-list">
                          {segment.stationTitles.map((title, index) => (
                            <li
                              key={`${segment.key}-station-${index}`}
                              className="step-station-item"
                            >
                              <span className="step-station-bullet" />
                              <span className="step-station-name">{title}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </li>
                  )
                })}
              </ol>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
