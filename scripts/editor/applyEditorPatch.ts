/**
 * Применение правок редактора к файлам каталога `data/`.
 *
 * Почему патч, а не «клиент присылает готовые файлы». Редактор видит только
 * `normalized/fullGraph.json` — результат сборки. В нём нет ни имён файлов
 * линий, ни структуры ответвлений, ни комментариев `$readme`. Собери он файлы
 * сам — потерял бы всё это, а заодно скормил бы солверу его собственный выход.
 * Поэтому редактор присылает СМЫСЛ правки, а сервер накладывает её на
 * настоящие файлы.
 *
 * Функция чистая: на вход — разобранное содержимое файлов, на выход — новое
 * содержимое. Ввод-вывод живёт в vite-плагине, чтобы это можно было проверить
 * тестами без файловой системы.
 */

export type EditorPatch = {
  /** Полная раскладка: id станции -> [x, y]. */
  layout?: Record<string, [number, number]>
  /** Правки полей станции. Отсутствующее поле означает «не трогать». */
  stations?: Record<string, { title?: string; lat?: number; lon?: number }>
  /** Время перегона: ключ `откуда>куда` (направление как в файле линии). */
  rides?: Record<string, number>
  transfers?: {
    /** Добавить или изменить. Пара станций в любом порядке. */
    upsert?: { stations: [string, string]; kind?: string; seconds?: number | null }[]
    /** Удалить пересадку между этими станциями. */
    remove?: [string, string][]
  }
}

export type DataStation = {
  id: string
  title: string
  lat?: number
  lon?: number
  toNextSeconds?: number
}

export type DataBranch = {
  title?: string
  from: string
  fromSeconds?: number
  stations: DataStation[]
}

export type DataLineFile = {
  $readme?: string
  id: number
  title: string
  color: string
  ring: boolean
  stations: DataStation[]
  branches?: DataBranch[]
}

export type DataTransfer = {
  stations: [string, string]
  kind: string
  seconds?: number
}

export type DataTransfersFile = {
  $readme?: string[]
  defaults: {
    rideSeconds: number
    hubMinSeconds: number
    kindSeconds: Record<string, number>
  }
  transfers: DataTransfer[]
}

export type DataLayoutFile = {
  $readme?: string[]
  stations: Record<string, [number, number]>
  rings: Record<string, unknown>
}

export type DataFiles = {
  /** Ключ — имя файла внутри `data/lines/`. */
  lines: Record<string, DataLineFile>
  transfers: DataTransfersFile
  layout: DataLayoutFile
}

export type ApplyResult = {
  files: DataFiles
  /** Что именно изменилось — уходит в интерфейс редактора и в лог сервера. */
  changes: string[]
  /** Файлы, содержимое которых отличается от исходного. */
  changedFiles: string[]
}

/**
 * Типы пересадок, которые сервер соглашается записать. Экспортируется, чтобы
 * список в редакторе (`src/editor/transferKinds.ts`) можно было сверить
 * тестом: разойдутся — и сервер отвергнет патч целиком.
 */
export const TRANSFER_KINDS = new Set(['near', 'far', 'mcc', 'out_of_station'])

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** Все станции линии: основной ход и ответвления. */
function allStations(line: DataLineFile): DataStation[] {
  return [...line.stations, ...(line.branches ?? []).flatMap((b) => b.stations)]
}

/**
 * Соседние пары внутри линии с направлением, как оно записано в файле.
 * Ключ совпадает с тем, что присылает редактор в `rides`.
 */
function rideSlots(line: DataLineFile): { key: string; set: (seconds: number) => void }[] {
  const slots: { key: string; set: (seconds: number) => void }[] = []

  const walk = (list: DataStation[], ring: boolean) => {
    for (let i = 0; i < list.length; i += 1) {
      const next = i + 1 < list.length ? list[i + 1] : ring ? list[0] : null
      if (!next) continue
      const station = list[i]
      slots.push({
        key: `${station.id}>${next.id}`,
        set: (seconds: number) => {
          station.toNextSeconds = seconds
        },
      })
    }
  }

  walk(line.stations, line.ring)
  for (const branch of line.branches ?? []) {
    if (branch.stations.length > 0) {
      slots.push({
        key: `${branch.from}>${branch.stations[0].id}`,
        set: (seconds: number) => {
          branch.fromSeconds = seconds
        },
      })
    }
    walk(branch.stations, false)
  }

  return slots
}

export function applyEditorPatch(input: DataFiles, patch: EditorPatch): ApplyResult {
  // Копия целиком: функция не имеет права править то, что ей дали.
  const files: DataFiles = JSON.parse(JSON.stringify(input)) as DataFiles
  const changes: string[] = []

  const stationById = new Map<string, DataStation>()
  const lineOfStation = new Map<string, number>()
  for (const line of Object.values(files.lines)) {
    for (const st of allStations(line)) {
      stationById.set(st.id, st)
      lineOfStation.set(st.id, line.id)
    }
  }

  // --- Станции: название и география ---

  for (const [id, fields] of Object.entries(patch.stations ?? {})) {
    const station = stationById.get(id)
    if (!station) throw new Error(`станции ${id} нет ни в одном файле линии`)

    if (fields.title !== undefined) {
      const title = fields.title.trim()
      if (!title) throw new Error(`пустое название у станции ${id}`)
      if (title !== station.title) {
        changes.push(`${id}: название «${station.title}» -> «${title}»`)
        station.title = title
      }
    }
    for (const key of ['lat', 'lon'] as const) {
      const value = fields[key]
      if (value === undefined) continue
      if (!Number.isFinite(value)) throw new Error(`${id}: ${key} = ${value}`)
      if (station[key] !== value) {
        changes.push(`${id}: ${key} ${station[key] ?? '—'} -> ${value}`)
        station[key] = value
      }
    }
  }

  // --- Времена перегонов ---

  if (patch.rides && Object.keys(patch.rides).length > 0) {
    const slots = new Map<string, (seconds: number) => void>()
    const current = new Map<string, number | undefined>()
    for (const line of Object.values(files.lines)) {
      for (const slot of rideSlots(line)) slots.set(slot.key, slot.set)
    }
    for (const line of Object.values(files.lines)) {
      for (const st of allStations(line)) current.set(st.id, st.toNextSeconds)
    }

    for (const [key, seconds] of Object.entries(patch.rides)) {
      const set = slots.get(key)
      if (!set) throw new Error(`перегона ${key} нет ни на одной линии`)
      if (!Number.isFinite(seconds) || seconds <= 0) {
        throw new Error(`перегон ${key}: время ${seconds} с`)
      }
      const from = key.split('>')[0]
      if (current.get(from) !== seconds) {
        changes.push(`перегон ${key}: ${current.get(from) ?? 'по умолчанию'} -> ${seconds} с`)
      }
      set(seconds)
    }
  }

  // --- Пересадки ---

  const transfersByPair = new Map<string, DataTransfer>()
  for (const t of files.transfers.transfers) {
    transfersByPair.set(pairKey(t.stations[0], t.stations[1]), t)
  }

  for (const [a, b] of patch.transfers?.remove ?? []) {
    const key = pairKey(a, b)
    if (!transfersByPair.delete(key)) continue
    changes.push(`пересадка ${a} <-> ${b} удалена`)
  }

  for (const item of patch.transfers?.upsert ?? []) {
    const [a, b] = item.stations
    if (!stationById.has(a)) throw new Error(`станции ${a} нет ни на одной линии`)
    if (!stationById.has(b)) throw new Error(`станции ${b} нет ни на одной линии`)
    if (lineOfStation.get(a) === lineOfStation.get(b)) {
      throw new Error(`${a} и ${b} на одной линии — это перегон, а не пересадка`)
    }

    const key = pairKey(a, b)
    const existing = transfersByPair.get(key)
    const kind = item.kind ?? existing?.kind ?? 'near'
    if (!TRANSFER_KINDS.has(kind)) throw new Error(`неизвестный тип пересадки «${kind}»`)

    const defaultSeconds = files.transfers.defaults.kindSeconds[kind]
    if (defaultSeconds === undefined) {
      throw new Error(`для типа «${kind}» нет значения в defaults.kindSeconds`)
    }
    if (item.seconds != null && (!Number.isFinite(item.seconds) || item.seconds <= 0)) {
      throw new Error(`пересадка ${a} <-> ${b}: время ${item.seconds} с`)
    }

    const pair: [string, string] = a < b ? [a, b] : [b, a]
    const next: DataTransfer = { stations: pair, kind }
    // Время пишем только когда оно отличается от типового: иначе в файле не
    // видно настоящих исключений.
    if (item.seconds != null && item.seconds !== defaultSeconds) next.seconds = item.seconds

    if (!existing) changes.push(`пересадка ${a} <-> ${b} добавлена (${kind})`)
    else if (existing.kind !== kind) changes.push(`пересадка ${a} <-> ${b}: тип -> ${kind}`)
    else if (existing.seconds !== next.seconds) {
      changes.push(`пересадка ${a} <-> ${b}: время -> ${next.seconds ?? defaultSeconds} с`)
    }

    transfersByPair.set(key, next)
  }

  files.transfers.transfers = [...transfersByPair.values()].sort(
    (x, y) =>
      x.stations[0].localeCompare(y.stations[0]) || x.stations[1].localeCompare(y.stations[1]),
  )

  // --- Раскладка ---

  if (patch.layout) {
    const known = new Set(stationById.keys())
    const next: Record<string, [number, number]> = {}
    for (const [id, xy] of Object.entries(patch.layout)) {
      if (!known.has(id)) throw new Error(`координаты для несуществующей станции ${id}`)
      if (!Array.isArray(xy) || xy.length !== 2 || !xy.every((v) => Number.isFinite(v))) {
        throw new Error(`станция ${id}: координаты должны быть [x, y]`)
      }
      next[id] = [xy[0], xy[1]]
    }
    const missing = [...known].filter((id) => !(id in next))
    if (missing.length > 0) {
      throw new Error(
        `нет координат у ${missing.length} станций: ${missing.slice(0, 5).join(', ')}`,
      )
    }

    let moved = 0
    for (const [id, xy] of Object.entries(next)) {
      const was = files.layout.stations[id]
      if (!was || was[0] !== xy[0] || was[1] !== xy[1]) moved += 1
    }
    if (moved > 0) changes.push(`раскладка: сдвинуто станций — ${moved}`)

    files.layout.stations = Object.fromEntries(
      Object.entries(next).sort(([x], [y]) => x.localeCompare(y)),
    )
  }

  // --- Что реально изменилось ---

  const changedFiles: string[] = []
  for (const [name, line] of Object.entries(files.lines)) {
    if (JSON.stringify(line) !== JSON.stringify(input.lines[name])) {
      changedFiles.push(`data/lines/${name}`)
    }
  }
  if (JSON.stringify(files.transfers) !== JSON.stringify(input.transfers)) {
    changedFiles.push('data/transfers.json')
  }
  if (JSON.stringify(files.layout) !== JSON.stringify(input.layout)) {
    changedFiles.push('data/layout.json')
  }

  return { files, changes, changedFiles }
}
