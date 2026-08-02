import type { FullGraphStation } from '../metro/types.ts'
import type { StationOverride } from './editorTypes.ts'

/**
 * Правки станции как чистые переходы состояния — см. соседний `edgeEdits.ts`
 * о том, зачем это вынесено из хука.
 *
 * Общее правило одно и держится в `commit`: оверрайд, у которого не осталось
 * НИ ОДНОГО поля, удаляется целиком. Проверять поля по отдельности в каждом
 * обработчике уже дважды выходило боком: сначала правка названия теряла
 * координаты из OSM, потом ровно то же повторилось в правке линии.
 */

export type StationOverrides = Record<string, StationOverride>

const isEmpty = (o: StationOverride) =>
  o.title === undefined &&
  o.lineNumericId === undefined &&
  o.lat === undefined &&
  o.lon === undefined

const isSame = (a: StationOverride | undefined, b: StationOverride) =>
  !!a && a.title === b.title && a.lineNumericId === b.lineNumericId && a.lat === b.lat && a.lon === b.lon

function commit(prev: StationOverrides, stationId: string, next: StationOverride) {
  if (isEmpty(next)) {
    if (!(stationId in prev)) return prev
    const cloned = { ...prev }
    delete cloned[stationId]
    return cloned
  }
  if (isSame(prev[stationId], next)) return prev
  return { ...prev, [stationId]: next }
}

export function setTitle(prev: StationOverrides, base: FullGraphStation, title: string) {
  const next: StationOverride = { ...(prev[base.id] ?? {}) }
  const trimmed = title.trim()
  if (!trimmed || trimmed === base.title) delete next.title
  else next.title = trimmed
  return commit(prev, base.id, next)
}

/**
 * Линия задаётся строкой из `<select>`: пустая означает «без линии».
 * Нечисловой ввод не правка, а мусор, и состояние он не трогает.
 */
export function setLine(prev: StationOverrides, base: FullGraphStation, lineIdStr: string) {
  const raw = lineIdStr.trim()
  let line: number | null
  if (raw === '') {
    line = null
  } else {
    const parsed = Number(raw)
    if (!Number.isFinite(parsed)) return prev
    line = parsed
  }

  const next: StationOverride = { ...(prev[base.id] ?? {}) }
  if (line === (base.lineNumericId ?? null)) delete next.lineNumericId
  else next.lineNumericId = line
  return commit(prev, base.id, next)
}

/** Координаты из OSM; совпавшие с графом не хранятся. */
export function setGeo(
  prev: StationOverrides,
  base: FullGraphStation,
  lat: number,
  lon: number,
) {
  const next: StationOverride = { ...(prev[base.id] ?? {}) }
  if (base.lat !== undefined && lat === base.lat) delete next.lat
  else next.lat = lat
  if (base.lon !== undefined && lon === base.lon) delete next.lon
  else next.lon = lon
  return commit(prev, base.id, next)
}

export function forgetStation(prev: StationOverrides, stationId: string) {
  if (!(stationId in prev)) return prev
  const next = { ...prev }
  delete next[stationId]
  return next
}
