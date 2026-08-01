import { useCallback, useMemo } from 'react'
import { normalizeStationText, rankStationCandidates } from '../utils/stationSearch.ts'
import type { StationSearchCandidate } from '../utils/stationSearch.ts'
import type { RouteSuggestionItem } from '../components/RouteForm.tsx'
import type { FullGraphStation, FullGraphLine } from '../metro/types.ts'
import type { SavedRoute } from '../features/route/savedRoutes.ts'

// Сколько подсказок показываем. Лимит применяется ПОСЛЕ ранжирования, поэтому
// его можно держать выше прежних шести: нужная станция уже наверху списка.
const SUGGESTIONS_LIMIT = 8

/**
 * Сколько строк показываем в ПУСТОМ поле. Меньше, чем при поиске: это не
 * результат запроса, а короткий список «скорее всего, тебе сюда», и длинная
 * простыня поверх карты тут только мешает.
 */
const DEFAULT_SUGGESTIONS_LIMIT = 6

/** Минимальный структурный тип оверрайдов — см. пояснение в useNearbyStations. */
type StationTitleOverrides = Record<
  string,
  { title?: string; lineNumericId?: number | null } | undefined
>

export type StationSuggestionsState = {
  fromSuggestions: RouteSuggestionItem[]
  toSuggestions: RouteSuggestionItem[]
  /** Что показать в ПУСТОМ поле сразу по фокусу (недавние, избранные, рядом). */
  fromDefaultSuggestions: RouteSuggestionItem[]
  toDefaultSuggestions: RouteSuggestionItem[]
  /** «Ввели что-то, но не нашли ничего» — повод показать пустое состояние. */
  fromNoMatches: boolean
  toNoMatches: boolean
  fromFieldHint: string | null
  toFieldHint: string | null
}

/** Поиск станций и подсказки автодополнения для обоих полей. */
export function useStationSuggestions(params: {
  allStations: FullGraphStation[]
  stationOverrides: StationTitleOverrides
  lineByNumericId: Map<number, FullGraphLine>
  fromStation: string
  toStation: string
  /** Станция в поле уже выбрана — подсказки не нужны. */
  fromFixed: boolean
  toFixed: boolean
  /** В какое поле попытались положить станцию, уже занятую соседним. */
  sameStationField: 'from' | 'to' | null
  /** Уже выбранные станции — их не предлагаем и учитываем при подборе пар. */
  fromStationId: string | null
  toStationId: string | null
  /** Недавние и избранные маршруты — источник подсказок для пустого поля. */
  recentRoutes: SavedRoute[]
  favoriteRoutes: SavedRoute[]
  /**
   * Станции рядом. Берём только уже загруженные: сам фокус в поле не должен
   * поднимать браузерный запрос геолокации.
   */
  nearbyStations: FullGraphStation[]
}): StationSuggestionsState {
  const {
    allStations,
    stationOverrides,
    lineByNumericId,
    fromStation,
    toStation,
    fromFixed,
    toFixed,
    sameStationField,
    fromStationId,
    toStationId,
    recentRoutes,
    favoriteRoutes,
    nearbyStations,
  } = params

  /**
   * Кандидаты автодополнения. Считаются один раз на набор станций, а не на
   * каждое нажатие клавиши: наложение оверрайдов на 300+ станций в обработчике
   * ввода — лишняя работа на слабом телефоне.
   *
   * Название линии заполняется ТОЛЬКО у неуникальных названий (Киевская ×3,
   * Арбатская ×2, Деловой центр ×3 …): в остальных строках это лишний шум.
   */
  const stationSearchCandidates = useMemo<StationSearchCandidate[]>(() => {
    const titleCounts = new Map<string, number>()

    const rows = allStations.map((s) => {
      const ov = stationOverrides[s.id]
      const title = ov?.title?.trim() || s.title
      const effectiveLineNumericId =
        ov && ov.lineNumericId !== undefined ? ov.lineNumericId : s.lineNumericId
      const line =
        effectiveLineNumericId != null ? lineByNumericId.get(effectiveLineNumericId) : undefined

      const key = normalizeStationText(title)
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1)

      return { id: s.id, title, color: line?.colorHex, lineTitle: line?.title, key }
    })

    return rows.map(({ key, id, title, color, lineTitle }) => ({
      id,
      title,
      color,
      lineTitle: (titleCounts.get(key) ?? 0) > 1 ? lineTitle : undefined,
    }))
  }, [allStations, stationOverrides, lineByNumericId])

  /**
   * Список закрывается и после отказа «эта станция уже занята соседним полем»:
   * иначе он остаётся висеть поверх подсказки под полем, да и повторно
   * предлагать ровно ту станцию, которую только что отклонили, — издёвка.
   * Достаточно любого ввода (он сбрасывает sameStationField), чтобы список
   * вернулся.
   */
  const fromSuggestions = useMemo<RouteSuggestionItem[]>(() => {
    if (fromFixed || sameStationField === 'from') return []
    return rankStationCandidates(stationSearchCandidates, fromStation, SUGGESTIONS_LIMIT)
  }, [fromStation, fromFixed, sameStationField, stationSearchCandidates])

  const toSuggestions = useMemo<RouteSuggestionItem[]>(() => {
    if (toFixed || sameStationField === 'to') return []
    return rankStationCandidates(stationSearchCandidates, toStation, SUGGESTIONS_LIMIT)
  }, [toStation, toFixed, sameStationField, stationSearchCandidates])

  /**
   * «Ввели что-то, но не нашли ничего». Именно этот случай — а не пустое поле,
   * не уже выбранная станция и не отказ по совпадению (там своя подсказка под
   * полем) — показывает пустое состояние подсказок.
   */
  const fromNoMatches =
    !fromFixed &&
    sameStationField !== 'from' &&
    fromStation.trim().length > 0 &&
    fromSuggestions.length === 0
  const toNoMatches =
    !toFixed &&
    sameStationField !== 'to' &&
    toStation.trim().length > 0 &&
    toSuggestions.length === 0

  /** Быстрый доступ к оформлению строки (цвет линии, уточнение линии). */
  const candidateById = useMemo(() => {
    const map = new Map<string, StationSearchCandidate>()
    for (const candidate of stationSearchCandidates) {
      map.set(candidate.id, candidate)
    }
    return map
  }, [stationSearchCandidates])

  /**
   * Список для пустого поля.
   *
   * Что показываем и почему: человек, ткнувший в пустое поле, чаще всего едет
   * своим же привычным маршрутом или от того места, где стоит. Поэтому берём
   * только то, что уже известно про него самого:
   *
   *   • «Откуда» — сначала станции рядом (это буквально «я здесь»), потом
   *     точки отправления избранных и недавних маршрутов;
   *   • «Куда» — сначала цели избранных и недавних поездок, потом «рядом»
   *     (уехать домой от текущей точки — тоже частый сценарий).
   *
   * Абстрактной «популярности» у нас нет и взять её неоткуда: выдумывать
   * список «топовых» станций — значит показывать шум вместо подсказки.
   *
   * Если соседнее поле уже заполнено, маршруты с ним поднимаются наверх: связка
   * «эта станция → вот эта» ценнее, чем просто недавняя станция.
   */
  const buildDefaultSuggestions = useCallback(
    (mode: 'from' | 'to'): RouteSuggestionItem[] => {
      const selfId = mode === 'from' ? fromStationId : toStationId
      const rivalId = mode === 'from' ? toStationId : fromStationId

      const result: RouteSuggestionItem[] = []
      const seen = new Set<string>()
      if (selfId) seen.add(selfId)
      if (rivalId) seen.add(rivalId)

      const push = (stationId: string, fallbackTitle: string, meta: string) => {
        if (result.length >= DEFAULT_SUGGESTIONS_LIMIT) return
        if (seen.has(stationId)) return
        const candidate = candidateById.get(stationId)
        if (!candidate && !fallbackTitle) return
        seen.add(stationId)
        result.push({
          id: stationId,
          title: candidate?.title ?? fallbackTitle,
          color: candidate?.color,
          lineTitle: candidate?.lineTitle,
          meta,
        })
      }

      const pushNearby = () => {
        for (const station of nearbyStations) {
          push(station.id, station.title, 'Рядом')
        }
      }

      /**
       * Станции из сохранённых маршрутов. `endpoint` — какой конец маршрута
       * берём: в поле «Куда» осмысленны цели поездок, в «Откуда» — начала.
       */
      const pushRoutes = (routes: SavedRoute[], endpoint: 'from' | 'to', meta: string) => {
        // Маршруты, у которых второй конец совпадает с уже выбранной станцией,
        // идут первыми: это ровно та поездка, которую человек повторяет.
        const paired: SavedRoute[] = []
        const rest: SavedRoute[] = []
        for (const route of routes) {
          const otherId = endpoint === 'from' ? route.toStationId : route.fromStationId
          if (rivalId && otherId === rivalId) paired.push(route)
          else rest.push(route)
        }
        for (const route of [...paired, ...rest]) {
          if (endpoint === 'from') push(route.fromStationId, route.fromTitle, meta)
          else push(route.toStationId, route.toTitle, meta)
        }
      }

      if (mode === 'from') {
        pushNearby()
        pushRoutes(favoriteRoutes, 'from', 'Избранное')
        pushRoutes(recentRoutes, 'from', 'Недавнее')
        pushRoutes(recentRoutes, 'to', 'Недавнее')
      } else {
        pushRoutes(favoriteRoutes, 'to', 'Избранное')
        pushRoutes(recentRoutes, 'to', 'Недавнее')
        pushNearby()
        pushRoutes(recentRoutes, 'from', 'Недавнее')
      }

      return result
    },
    [candidateById, favoriteRoutes, recentRoutes, nearbyStations, fromStationId, toStationId],
  )

  const fromDefaultSuggestions = useMemo(
    () => buildDefaultSuggestions('from'),
    [buildDefaultSuggestions],
  )
  const toDefaultSuggestions = useMemo(
    () => buildDefaultSuggestions('to'),
    [buildDefaultSuggestions],
  )

  const fromFieldHint =
    sameStationField === 'from' ? 'Эта станция уже выбрана в поле «Куда»' : null
  const toFieldHint =
    sameStationField === 'to' ? 'Эта станция уже выбрана в поле «Откуда»' : null

  return {
    fromSuggestions,
    toSuggestions,
    fromDefaultSuggestions,
    toDefaultSuggestions,
    fromNoMatches,
    toNoMatches,
    fromFieldHint,
    toFieldHint,
  }
}
