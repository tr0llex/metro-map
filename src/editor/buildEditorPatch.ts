import type { EditorPatch } from '../../scripts/editor/applyEditorPatch.ts'
import { lineStationPairs } from '../metro/lineSegments.ts'
import type { EdgeOverride, FullGraphEdge, FullGraphLine, FullGraphStation } from '../metro/types.ts'
import type { StationOverride } from './editorTypes.ts'
import { DEFAULT_TRANSFER_KIND, type TransferKind } from './transferKinds.ts'

export type BuildPatchInput = {
  lines: FullGraphLine[]
  stations: FullGraphStation[]
  edges: FullGraphEdge[]
  ringLineIds: ReadonlySet<number>
  layout: Record<string, { x: number; y: number }>
  stationOverrides: Record<string, StationOverride>
  edgeOverrides: Record<string, EdgeOverride>
  /**
   * Связи, созданные в редакторе кнопкой «Добавить». Ключ — `manual:<edgeKey>`.
   *
   * Раньше их сюда просто не передавали: поля в этом типе не было, а SaveBar
   * его и не заполнял. Новая связь без последующей правки времени исчезала
   * бесследно — счётчик показывал ноль, панель писала «Правок нет».
   *
   * Связь между станциями РАЗНЫХ линий — это пересадка, и она выражается в
   * data/transfers.json. Между станциями одной линии — это добавление станции
   * в ход линии, другая операция; такие честно объявляются неподдержанными.
   */
  manualEdges?: Record<string, FullGraphEdge>
  /**
   * Тип пересадки, выбранный в панели: ключ ребра -> `near`/`far`/`mcc`/
   * `out_of_station`.
   *
   * Раньше тип поменять было нельзя вовсе: панель показывала «близкая/дальняя»
   * по порогу в шесть минут, а в патч всегда уходил kind из графа. Пересадка,
   * заведённая как `near`, оставалась `near`, сколько бы времени ей ни ставили.
   */
  edgeTransferKinds?: Record<string, TransferKind>
  edgeKey: (a: string, b: string) => string
}

export type BuildPatchResult = {
  patch: EditorPatch
  /** Сколько правок каждого вида уедет в файлы. */
  counts: { layout: number; stations: number; rides: number; transfers: number }
  /**
   * Правки, которых формат данных не умеет хранить. Показываются человеку
   * дословно: молча потерять правку хуже, чем отказаться её сохранять.
   */
  unsupported: string[]
}

/**
 * Превращает состояние редактора в патч для `data/`.
 *
 * Здесь же решается, что СОХРАНИТЬ НЕЛЬЗЯ. Редактор умеет больше, чем формат
 * данных: отключить ребро для проверки маршрута — полезный инструмент, но в
 * `data/` такого понятия нет. Раньше подобные правки просто исчезали при
 * выгрузке; теперь они попадают в `unsupported` и показываются в панели.
 */
export function buildEditorPatch(input: BuildPatchInput): BuildPatchResult {
  const {
    lines,
    stations,
    edges,
    ringLineIds,
    layout,
    stationOverrides,
    edgeOverrides,
    manualEdges = {},
    edgeTransferKinds = {},
    edgeKey,
  } = input

  const patch: EditorPatch = {}
  const unsupported: string[] = []

  const stationById = new Map(stations.map((s) => [s.id, s]))
  const titleOf = (id: string) => stationById.get(id)?.title ?? id

  // --- Раскладка ---
  // Отправляем целиком: сервер сверяет полноту и отказывается писать файл,
  // в котором у станции нет координат.
  const layoutOut: Record<string, [number, number]> = {}
  let movedCount = 0
  for (const [id, p] of Object.entries(layout)) {
    if (!Number.isFinite(p?.x) || !Number.isFinite(p?.y)) continue
    layoutOut[id] = [p.x, p.y]
    const base = stationById.get(id)
    if (base && (base.sourceX !== p.x || base.sourceY !== p.y)) movedCount += 1
  }
  if (Object.keys(layoutOut).length > 0) patch.layout = layoutOut

  // --- Станции ---
  const stationsOut: NonNullable<EditorPatch['stations']> = {}
  let stationCount = 0
  for (const [id, override] of Object.entries(stationOverrides)) {
    const base = stationById.get(id)
    if (!base) {
      unsupported.push(`станция ${id} создана в редакторе — добавьте её в data/lines/*.json`)
      continue
    }

    const fields: { title?: string; lat?: number; lon?: number } = {}
    const title = override.title?.trim()
    if (title && title !== base.title) fields.title = title
    if (override.lat !== undefined && override.lat !== base.lat) fields.lat = override.lat
    if (override.lon !== undefined && override.lon !== base.lon) fields.lon = override.lon

    if (override.lineNumericId !== undefined && override.lineNumericId !== base.lineNumericId) {
      unsupported.push(
        `«${base.title}» переносится на другую линию — это правится переносом станции между data/lines/*.json`,
      )
    }

    if (Object.keys(fields).length > 0) {
      stationsOut[id] = fields
      stationCount += 1
    }
  }
  if (stationCount > 0) patch.stations = stationsOut

  // --- Направление перегонов: файл линии хранит время «до следующей» ---
  const rideDirection = new Map<string, string>()
  for (const line of lines) {
    for (const [a, b] of lineStationPairs(line, ringLineIds.has(line.id))) {
      rideDirection.set(edgeKey(a, b), `${a}>${b}`)
    }
  }

  const edgeByKey = new Map<string, FullGraphEdge>()
  for (const e of edges) edgeByKey.set(edgeKey(e.fromStationId, e.toStationId), e)

  /**
   * Линия станции с учётом правки: перенесли станцию на другую линию — связь
   * с прежними соседями становится межлинейной, то есть пересадкой.
   */
  const lineOf = (id: string) => {
    const override = stationOverrides[id]?.lineNumericId
    if (override !== undefined) return override
    return stationById.get(id)?.lineNumericId ?? null
  }

  const ridesOut: NonNullable<EditorPatch['rides']> = {}
  const upsert: NonNullable<NonNullable<EditorPatch['transfers']>['upsert']> = []
  const remove: [string, string][] = []

  /** Тип пересадки с учётом выбранного руками; в графе его может не быть. */
  const kindOf = (key: string, baseKind?: TransferKind) =>
    edgeTransferKinds[key] ?? baseKind ?? DEFAULT_TRANSFER_KIND

  /** Ключи, по которым запись в transfers уже собрана: дублировать нельзя. */
  const decidedKeys = new Set<string>()

  // --- Связи, созданные в редакторе ---
  // Ключ вида `manual:<a>|<b>`; ребро несёт станции и время.
  const manualKeys = new Set<string>()
  for (const edge of Object.values(manualEdges)) {
    const key = edgeKey(edge.fromStationId, edge.toStationId)
    manualKeys.add(key)

    const label = `${titleOf(edge.fromStationId)} — ${titleOf(edge.toStationId)}`

    if (edgeByKey.has(key)) {
      // Связь уже есть в графе: её правки идут обычным путём через
      // edgeOverrides, здесь дублировать нечего.
      continue
    }

    const lineA = lineOf(edge.fromStationId)
    const lineB = lineOf(edge.toStationId)

    if (lineA == null || lineB == null || lineA === lineB) {
      unsupported.push(
        `связь «${label}» соединяет станции одной линии — это добавление станции в ход линии, правьте data/lines/*.json`,
      )
      continue
    }

    // Время правится тут же в панели и приходит в edgeOverrides — оно
    // приоритетнее того, с которым связь создали.
    const seconds =
      edgeOverrides[key]?.medianTravelSeconds ?? edge.medianTravelSeconds

    upsert.push({
      stations: [edge.fromStationId, edge.toStationId],
      kind: kindOf(key, edge.transferKind),
      seconds,
    })
    decidedKeys.add(key)
  }

  for (const [key, override] of Object.entries(edgeOverrides)) {
    const base = edgeByKey.get(key)
    if (!base) {
      // Ручная связь уже разобрана выше: её время учтено в upsert, и повторно
      // жаловаться на неё нельзя. Раньше жалоба звучала всегда, потому что
      // ручные связи сюда просто не доходили.
      if (manualKeys.has(key)) continue
      unsupported.push(`ребро ${key} создано в редакторе — добавьте его в data/`)
      continue
    }

    const label = `${titleOf(base.fromStationId)} — ${titleOf(base.toStationId)}`

    if (override.disabled) {
      unsupported.push(`ребро «${label}» отключено — это проверка маршрута, в данных её нет`)
    }

    // Переключение «это пересадка» = появление или исчезновение записи
    // в data/transfers.json.
    if (override.isTransfer !== undefined && override.isTransfer !== !!base.isTransfer) {
      if (override.isTransfer) {
        upsert.push({
          stations: [base.fromStationId, base.toStationId],
          kind: kindOf(key, base.transferKind),
          seconds: override.medianTravelSeconds ?? base.medianTravelSeconds,
        })
      } else {
        remove.push([base.fromStationId, base.toStationId])
      }
      decidedKeys.add(key)
      continue
    }

    if (
      override.medianTravelSeconds === undefined ||
      override.medianTravelSeconds === base.medianTravelSeconds
    ) {
      continue
    }

    if (base.isTransfer) {
      upsert.push({
        stations: [base.fromStationId, base.toStationId],
        kind: kindOf(key, base.transferKind),
        seconds: override.medianTravelSeconds,
      })
      decidedKeys.add(key)
      continue
    }

    const directed = rideDirection.get(key)
    if (!directed) {
      unsupported.push(`перегон «${label}» не найден ни в одном ходе линии`)
      continue
    }
    ridesOut[directed] = override.medianTravelSeconds
  }

  // --- Смена типа пересадки без всякой другой правки ---
  // Отдельный проход: тип живёт не в edgeOverrides, и без него правка «near ->
  // out_of_station» не порождала бы вообще ничего — ни записи, ни жалобы.
  for (const [key, kind] of Object.entries(edgeTransferKinds)) {
    if (decidedKeys.has(key)) continue

    const base = edgeByKey.get(key)
    if (!base) continue

    const label = `${titleOf(base.fromStationId)} — ${titleOf(base.toStationId)}`

    // Тип есть только у пересадки: у перегона в data/transfers.json нет записи,
    // которой этот тип можно было бы приписать.
    if (!base.isTransfer && edgeOverrides[key]?.isTransfer !== true) {
      unsupported.push(`у перегона «${label}» нет типа пересадки — сначала сделайте его пересадкой`)
      continue
    }

    if (kind === (base.transferKind ?? DEFAULT_TRANSFER_KIND)) continue

    upsert.push({
      stations: [base.fromStationId, base.toStationId],
      kind,
      seconds: edgeOverrides[key]?.medianTravelSeconds ?? base.medianTravelSeconds,
    })
    decidedKeys.add(key)
  }

  if (Object.keys(ridesOut).length > 0) patch.rides = ridesOut
  if (upsert.length > 0 || remove.length > 0) {
    patch.transfers = {}
    if (upsert.length > 0) patch.transfers.upsert = upsert
    if (remove.length > 0) patch.transfers.remove = remove
  }

  return {
    patch,
    counts: {
      layout: movedCount,
      stations: stationCount,
      rides: Object.keys(ridesOut).length,
      transfers: upsert.length + remove.length,
    },
    unsupported: [...new Set(unsupported)],
  }
}

/** Есть ли что сохранять. */
export function hasSavableChanges(result: BuildPatchResult): boolean {
  const { layout, stations, rides, transfers } = result.counts
  return layout + stations + rides + transfers > 0
}
