import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, Ref } from 'react'
import type { RouteResult } from '../metro/types'
import { RouteLinePills } from './RouteLinePills.tsx'
import { useDragScroll } from '../hooks/useDragScroll.ts'
import { IconClock, IconShare, IconStar } from './icons.tsx'
import {
  formatStationsCount,
  formatTransfersCount,
  formatTransfersForAria,
} from '../utils/plural.ts'

type DecoratedRideSegment = {
  type: 'ride'
  key: string
  fromTitle: string
  toTitle: string
  lineColor?: string
  stationTitles: string[]
  travelMinutes: number
}

type DecoratedTransferSegment = {
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
  errorMessage: string | null
  isDesktop: boolean
  isRouteSheetOpen: boolean
  detailsStyle?: CSSProperties
  decoratedSegments: DecoratedSegment[]
  arrivalTimeLabel?: string | null
  detailsRef?: Ref<HTMLDivElement>
  isFavoriteRoute?: boolean
  onToggleFavoriteRoute?: () => void
  /** Цвета линий по каждому варианту маршрута (индексы совпадают с routeAlternatives). */
  routeLineColors?: string[][]
  onShareRoute?: () => void
  /** Короткое сообщение о результате «Поделиться» (например, «Ссылка скопирована»). */
  shareHint?: string | null
}

export function RouteDetailsSheet({
  routeResult,
  routeAlternatives,
  activeRouteIndex,
  onChangeActiveRoute,
  errorMessage,
  isDesktop,
  isRouteSheetOpen,
  detailsStyle,
  decoratedSegments,
  arrivalTimeLabel,
  detailsRef,
  isFavoriteRoute,
  onToggleFavoriteRoute,
  routeLineColors,
  onShareRoute,
  shareHint,
}: RouteDetailsSheetProps) {
  const hasAlternatives = routeAlternatives.length > 1
  // Ленту вариантов можно тянуть мышью: колесо и тач работали, зажатая мышь — нет.
  const choicesTrackRef = useDragScroll<HTMLDivElement>()

  const [stepsAnimToken, setStepsAnimToken] = useState(0)
  const prevOpenRef = useRef<boolean>(false)

  useEffect(() => {
    const wasOpen = prevOpenRef.current
    prevOpenRef.current = isRouteSheetOpen
    if (isRouteSheetOpen && !wasOpen) {
      setStepsAnimToken((v) => v + 1)
    }
  }, [isRouteSheetOpen])

  useEffect(() => {
    if (!isRouteSheetOpen) return
    setStepsAnimToken((v) => v + 1)
  }, [activeRouteIndex, isRouteSheetOpen])

  return (
    <>
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
                <div className="route-choices-desktop-track" ref={choicesTrackRef}>
                  {routeAlternatives.map((route, index) => {
                    const isActive = index === activeRouteIndex
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
                        aria-label={`Выбрать маршрут: ~${route.totalMinutes} мин, ${formatTransfersForAria(route.transfersCount)}`}
                      >
                        <div className="bottom-route-chip-main">
                          <span className="bottom-route-chip-time">
                            <IconClock className="inline-icon" />
                            {route.totalMinutes} мин
                          </span>
                        </div>
                        <RouteLinePills colors={routeLineColors?.[index] ?? []} />
                        <div className="bottom-route-chip-sub">
                          {formatTransfersCount(route.transfersCount)}
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
                    <IconClock className="inline-icon" />
                    {routeResult.totalMinutes} мин
                  </span>
                  {arrivalTimeLabel && (
                    <span className="summary-arrival">
                      Прибытие ~{arrivalTimeLabel}
                    </span>
                  )}
                  <span className="summary-transfers">
                    {formatTransfersCount(routeResult.transfersCount)}
                  </span>
                </div>
                <div className="route-summary-actions">
                  {onShareRoute && (
                    <button
                      type="button"
                      className="route-share-button"
                      onClick={onShareRoute}
                      aria-label="Поделиться ссылкой на маршрут"
                    >
                      <IconShare />
                    </button>
                  )}
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
                      <IconStar filled={isFavoriteRoute === true} />
                    </button>
                  )}
                </div>
              </div>

              <div className="route-share-hint" role="status" aria-live="polite">
                {shareHint ?? ''}
              </div>
              <ol
                key={stepsAnimToken}
                className={`route-steps${isRouteSheetOpen ? ' route-steps--animate' : ''}`}
              >
                {decoratedSegments.map((segment, index) => {
                  if (segment.type === 'transfer') {
                    return (
                      <li
                        key={segment.key}
                        className="route-step route-step--transfer"
                        style={{ ['--stagger-index' as never]: index } as CSSProperties}
                      >
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
                    <li
                      key={segment.key}
                      className="route-step"
                      /* --step-line-color красит точки станций (.step-station-bullet)
                         в цвет линии: без него весь список промежуточных станций
                         был серым и не связывался с веткой поездки. */
                      style={
                        {
                          ['--stagger-index' as never]: index,
                          ...(segment.lineColor
                            ? { ['--step-line-color' as never]: segment.lineColor }
                            : null),
                        } as CSSProperties
                      }
                    >
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
                          Поездка • {formatStationsCount(segment.stationTitles.length)} • ~
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
