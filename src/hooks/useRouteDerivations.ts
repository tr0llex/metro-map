import { useEffect, useMemo, useState } from 'react'
import { startMinuteTicker } from '../utils/minuteTicker.ts'
import type { DecoratedSegment } from '../components/RouteDetailsSheet.tsx'
import type { FullGraphLine, FullGraphStation, RouteResult } from '../metro/types.ts'

export type RouteEndpoints = {
  fromStationId: string
  toStationId: string
  fromTitle: string
  toTitle: string
}

type RouteDerivations = {
  /** «Прибытие ~HH:MM»; пересчитывается по границе минуты, пока маршрут на экране. */
  routeArrivalTimeLabel: string | null
  /** Концы активного маршрута — для избранного и «Поделиться». null, если маршрута нет. */
  activeRouteEndpoints: RouteEndpoints | null
  /** Станции маршрута по порядку — карта подсвечивает их. */
  routeStationIds: string[]
  /** Рёбра маршрута (нормализованные ключи `a|b`). */
  routeEdgeKeys: string[]
  /** Из них — длинные пересадки, которые карта рисует иначе. */
  routeLongTransferEdgeKeys: string[]
  /** Цвета линий по каждому варианту — для «пилюль» в чипах выбора. */
  routeAlternativeLineColors: string[][]
  /** Готовые к отрисовке участки активного маршрута. */
  decoratedSegments: DecoratedSegment[]
}

/**
 * Всё, что выводится из результата расчёта: подсветка на карте, участки для
 * шторки, цвета вариантов, время прибытия.
 *
 * Здесь нет ни одного побочного эффекта, кроме тикера минут: это чистые
 * производные от `routeAlternatives` и справочников станций и линий.
 */
export function useRouteDerivations(params: {
  routeResult: RouteResult | null
  routeAlternatives: RouteResult[]
  fromStationId: string | null
  toStationId: string | null
  fromStation: string
  toStation: string
  stationById: Map<string, FullGraphStation>
  stationTitleById: Map<string, string>
  lineByNumericId: Map<number, FullGraphLine>
}): RouteDerivations {
  const {
    routeResult,
    routeAlternatives,
    fromStationId,
    toStationId,
    fromStation,
    toStation,
    stationById,
    stationTitleById,
    lineByNumericId,
  } = params

  // «Прибытие ~HH:MM» считалось один раз при смене маршрута: с открытой шторкой
  // через двадцать минут значение врало ровно на двадцать минут. Тикаем по
  // границе минуты и только когда есть что показывать.
  const [arrivalClockTick, setArrivalClockTick] = useState(0)

  useEffect(() => {
    if (!routeResult) return
    return startMinuteTicker(() => {
      setArrivalClockTick((v) => v + 1)
    })
  }, [routeResult])

  const routeArrivalTimeLabel = useMemo(() => {
    if (!routeResult) return null

    const now = new Date()
    const arrival = new Date(now.getTime() + routeResult.totalMinutes * 60 * 1000)

    return arrival.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })
    // arrivalClockTick — намеренная зависимость-таймер: без неё значение
    // замерзает на моменте построения маршрута.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeResult, arrivalClockTick])

  const activeRouteEndpoints = useMemo(() => {
    if (!routeResult) return null
    if (!fromStationId || !toStationId) return null

    const fromTitleSource = stationTitleById.get(fromStationId)
    const toTitleSource = stationTitleById.get(toStationId)

    const fromTitleEffective = (fromTitleSource ?? fromStation.trim()) || ''
    const toTitleEffective = (toTitleSource ?? toStation.trim()) || ''

    if (!fromTitleEffective || !toTitleEffective) return null

    return {
      fromStationId,
      toStationId,
      fromTitle: fromTitleEffective,
      toTitle: toTitleEffective,
    }
  }, [routeResult, fromStationId, toStationId, stationTitleById, fromStation, toStation])

  const routeStationIds = useMemo(() => {
    if (!routeResult) return []

    const ids: string[] = []
    for (const step of routeResult.steps) {
      if (ids.length === 0) {
        ids.push(step.fromStationId)
      }
      const last = ids[ids.length - 1]
      if (last !== step.toStationId) {
        ids.push(step.toStationId)
      }
    }

    return ids
  }, [routeResult])

  const routeEdgeKeys = useMemo(() => {
    if (!routeResult) return []

    const keys: string[] = []
    const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

    for (const step of routeResult.steps) {
      keys.push(edgeKey(step.fromStationId, step.toStationId))
    }

    return Array.from(new Set(keys))
  }, [routeResult])

  const routeLongTransferEdgeKeys = useMemo(() => {
    if (!routeResult) return []

    const keys: string[] = []
    const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

    for (const step of routeResult.steps) {
      if (!step.isTransfer) continue

      const kind = step.transferKind
      const isFarKind = kind === 'far' || kind === 'out_of_station' || kind === 'mcc'

      const isFarByTime = step.travelMinutes >= 6

      if (isFarKind || (!kind && isFarByTime)) {
        keys.push(edgeKey(step.fromStationId, step.toStationId))
      }
    }

    return Array.from(new Set(keys))
  }, [routeResult])

  // Цвета линий по каждому варианту маршрута — для «пилюль» в чипах выбора.
  // Логика та же, что у decoratedSegments (цвет берём у линии станции отправления
  // перегона), но считаем сразу для всех альтернатив и без сборки текстов.
  // Мемоизация обязательна: вариантов до 6, у каждого — десятки шагов.
  const routeAlternativeLineColors = useMemo<string[][]>(() => {
    return routeAlternatives.map((route) => {
      const colors: string[] = []

      for (const step of route.steps) {
        if (step.isTransfer) continue

        const fromStationResolved = stationById.get(step.fromStationId)
        const toStationResolved = stationById.get(step.toStationId)

        const fromLineNumericId = fromStationResolved?.lineNumericId ?? null
        const toLineNumericId = toStationResolved?.lineNumericId ?? null

        const color =
          (fromLineNumericId != null ? lineByNumericId.get(fromLineNumericId)?.colorHex : undefined) ??
          (toLineNumericId != null ? lineByNumericId.get(toLineNumericId)?.colorHex : undefined)

        if (!color) continue
        if (colors[colors.length - 1] === color) continue
        colors.push(color)
      }

      return colors
    })
  }, [routeAlternatives, stationById, lineByNumericId])

  const decoratedSegments = useMemo<DecoratedSegment[]>(
    () => {
      if (!routeResult) return []

      type RideSegment = {
        type: 'ride'
        key: string
        fromTitle: string
        toTitle: string
        lineColor?: string
        stationTitles: string[]
        travelMinutes: number
      }

      type TransferSegment = {
        type: 'transfer'
        key: string
        fromTitle: string
        toTitle: string
        fromLineColor?: string
        toLineColor?: string
        travelMinutes: number
        isFar: boolean
      }

      type Segment = RideSegment | TransferSegment

      const segments: Segment[] = []
      let currentRide: RideSegment | null = null

      const flushRide = () => {
        if (currentRide) {
          segments.push(currentRide)
          currentRide = null
        }
      }

      routeResult.steps.forEach((step, index) => {
        const fromTitle = stationTitleById.get(step.fromStationId) ?? step.fromStationId
        const toTitle = stationTitleById.get(step.toStationId) ?? step.toStationId

        const fromStation = stationById.get(step.fromStationId)
        const toStation = stationById.get(step.toStationId)

        const fromLineNumericId = fromStation?.lineNumericId ?? null
        const toLineNumericId = toStation?.lineNumericId ?? null

        const fromLine = fromLineNumericId != null ? lineByNumericId.get(fromLineNumericId) : undefined
        const toLine = toLineNumericId != null ? lineByNumericId.get(toLineNumericId) : undefined

        if (step.isTransfer) {
          flushRide()

          const kind = step.transferKind
          const isFar =
            kind === 'far' ||
            kind === 'out_of_station' ||
            kind === 'mcc' ||
            (!kind && step.travelMinutes >= 6)

          const transferSegment: TransferSegment = {
            type: 'transfer',
            key: `${step.fromStationId}-${step.toStationId}-${index}`,
            fromTitle,
            toTitle,
            travelMinutes: step.travelMinutes,
            fromLineColor: fromLine?.colorHex,
            toLineColor: toLine?.colorHex,
            isFar,
          }

          segments.push(transferSegment)
        } else {
          const lineColor = fromLine?.colorHex ?? toLine?.colorHex

          if (
            currentRide &&
            currentRide.lineColor === lineColor &&
            currentRide.toTitle === fromTitle
          ) {
            // Продолжаем поездку по той же линии: добавляем станцию и время
            currentRide = {
              ...currentRide,
              toTitle,
              travelMinutes: currentRide.travelMinutes + step.travelMinutes,
              stationTitles: [...currentRide.stationTitles, toTitle],
            }
          } else {
            // Начинаем новый сегмент поездки по линии
            flushRide()
            currentRide = {
              type: 'ride',
              key: `${step.fromStationId}-${step.toStationId}-${index}`,
              fromTitle,
              toTitle,
              lineColor,
              travelMinutes: step.travelMinutes,
              stationTitles: [fromTitle, toTitle],
            }
          }
        }
      })

      flushRide()

      return segments
    },
    [routeResult, stationTitleById, stationById, lineByNumericId],
  )

  return {
    routeArrivalTimeLabel,
    activeRouteEndpoints,
    routeStationIds,
    routeEdgeKeys,
    routeLongTransferEdgeKeys,
    routeAlternativeLineColors,
    decoratedSegments,
  }
}
