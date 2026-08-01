import { useMemo } from 'react'
import { normalizeStationText, rankStationCandidates } from '../utils/stationSearch.ts'
import type { StationSearchCandidate } from '../utils/stationSearch.ts'
import type { RouteSuggestionItem } from '../components/RouteForm.tsx'
import type { FullGraphStation, FullGraphLine } from '../metro/types.ts'

// Сколько подсказок показываем. Лимит применяется ПОСЛЕ ранжирования, поэтому
// его можно держать выше прежних шести: нужная станция уже наверху списка.
const SUGGESTIONS_LIMIT = 8

/** Минимальный структурный тип оверрайдов — см. пояснение в useNearbyStations. */
type StationTitleOverrides = Record<
  string,
  { title?: string; lineNumericId?: number | null } | undefined
>

export type StationSuggestionsState = {
  fromSuggestions: RouteSuggestionItem[]
  toSuggestions: RouteSuggestionItem[]
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

  const fromFieldHint =
    sameStationField === 'from' ? 'Эта станция уже выбрана в поле «Куда»' : null
  const toFieldHint =
    sameStationField === 'to' ? 'Эта станция уже выбрана в поле «Откуда»' : null

  return { fromSuggestions, toSuggestions, fromNoMatches, toNoMatches, fromFieldHint, toFieldHint }
}
