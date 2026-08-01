/** Категория «Целостность данных»: без неё маршруты просто не строятся. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { RenderModel } from '../render.ts'
import { makeMetric, type MetricResult, type Offender } from '../types.ts'

/** Связь из исходника new_map_source/connections.json. */
interface SourceConnection {
  from_station: string
  to_station: string
  from_line?: string
  to_line?: string
  type?: string
}

function readSourceConnections(): SourceConnection[] {
  const path = fileURLToPath(new URL('../../../new_map_source/connections.json', import.meta.url))
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? (parsed as SourceConnection[]) : []
  } catch {
    return []
  }
}

/** Нормализация названия для поиска «потерянных» пересадок. */
function normTitle(t: string): string {
  return t.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, ' ').trim()
}

export function integrityMetrics(model: RenderModel): MetricResult[] {
  const { graph, byId } = model
  const out: MetricResult[] = []

  // --- 1. Связность графа (перегоны + пересадки) ---
  const parent = new Map<string, string>()
  const find = (a: string): string => {
    let root = a
    while (parent.get(root) !== root) root = parent.get(root)!
    let cur = a
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb)
  }
  for (const st of model.stations) parent.set(st.id, st.id)
  for (const e of graph.edges) {
    if (byId.has(e.fromStationId) && byId.has(e.toStationId)) union(e.fromStationId, e.toStationId)
  }
  for (const hub of graph.transferHubs) {
    const ids = hub.stationIds.filter((i) => byId.has(i))
    for (let i = 1; i < ids.length; i += 1) union(ids[0], ids[i])
  }
  const components = new Map<string, string[]>()
  for (const st of model.stations) {
    const r = find(st.id)
    const arr = components.get(r)
    if (arr) arr.push(st.id)
    else components.set(r, [st.id])
  }
  const compList = [...components.values()].sort((a, b) => b.length - a.length)
  out.push(
    makeMetric({
      id: 'graph.components',
      category: 'integrity',
      name: 'Компонент связности',
      unit: 'шт',
      value: compList.length,
      target: 1,
      fail: 1,
      direction: 'lower',
      description:
        'Схема должна быть одним связным графом. Лишняя компонента = станции, до которых маршрут физически не построится.',
      offenders: compList.slice(1).map((c, i) => ({
        id: `component-${i + 1}`,
        label: c.map((id) => byId.get(id)?.title ?? id).slice(0, 5).join(', '),
        value: c.length,
        detail: `изолированная группа из ${c.length} станций`,
      })),
    }),
  )

  // --- 2. Пересадки, потерянные пайплайном относительно исходника ---
  //
  // ВАЖНО: не путать с «одноимённые станции без общего хаба». Общий хаб — это
  // решение об ОТРИСОВКЕ (слить в один значок), а не о наличии пересадки.
  // Пересадки типа out-of-station («выход в город», напр. Бульвар Рокоссовского
  // ↔ МЦК, Деловой центр ↔ МЦК) намеренно НЕ сливаются в хаб и рисуются
  // пунктиром — штрафовать за это нельзя, старая система метрик именно на этом
  // и ошибалась. Единственный настоящий дефект целостности — связь, объявленная
  // в new_map_source/connections.json, но отсутствующая в графе как ребро.
  // Сопоставление станции связи с конкретной станцией графа идёт по паре
  // (название, линия). Только по названию нельзя: во-первых, большинство
  // переходов — между одноимёнными станциями разных линий, во-вторых, связь
  // может вести на линию, которой в датасете ещё нет (Бирюлёвская, МЦД) —
  // это не потеря пайплайна, а отсутствие данных, и штрафовать за это нельзя.
  const lineKeyById = new Map<number, string>()
  for (const line of graph.lines) lineKeyById.set(line.id, normTitle(line.title))

  /** «Большая кольцевая (11)» → ключ линии графа, либо null, если такой линии нет. */
  const resolveLineKey = (raw: string | undefined): string | null => {
    const cleaned = normTitle((raw ?? '').replace(/\([^)]*\)/g, ''))
    if (!cleaned) return null
    for (const key of lineKeyById.values()) {
      if (key === cleaned || key.startsWith(cleaned) || cleaned.startsWith(key)) return key
    }
    return null
  }

  const stationKey = (title: string, lineId: number | null | undefined): string =>
    `${normTitle(title)}@${lineId != null ? (lineKeyById.get(lineId) ?? lineId) : '∅'}`

  const knownStationKeys = new Set<string>()
  for (const st of model.stations) knownStationKeys.add(stationKey(st.title, st.lineId))

  const transferPairs = new Set<string>()
  for (const e of graph.edges) {
    if (!e.isTransfer) continue
    const a = byId.get(e.fromStationId)
    const b = byId.get(e.toStationId)
    if (!a || !b) continue
    const ka = stationKey(a.title, a.lineId)
    const kb = stationKey(b.title, b.lineId)
    transferPairs.add(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`)
  }

  const droppedSeen = new Set<string>()
  const droppedOffenders: Offender[] = []
  for (const conn of readSourceConnections()) {
    const lineA = resolveLineKey(conn.from_line)
    const lineB = resolveLineKey(conn.to_line)
    // Линия не представлена в датасете — связь физически некуда приземлить.
    if (!lineA || !lineB) continue

    const ka = `${normTitle(conn.from_station ?? '')}@${lineA}`
    const kb = `${normTitle(conn.to_station ?? '')}@${lineB}`
    if (ka === kb) continue
    if (!knownStationKeys.has(ka) || !knownStationKeys.has(kb)) continue

    const pair = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`
    if (transferPairs.has(pair)) continue
    if (droppedSeen.has(pair)) continue
    droppedSeen.add(pair)
    droppedOffenders.push({
      id: pair,
      label: `${conn.from_station} [${conn.from_line ?? '?'}] ↔ ${conn.to_station} [${conn.to_line ?? '?'}]`,
      value: 1,
      detail: `объявлена в connections.json (type=${conn.type ?? '?'}), но ребра-пересадки в графе нет`,
    })
  }
  droppedOffenders.sort((a, b) => a.id.localeCompare(b.id))
  out.push(
    makeMetric({
      id: 'transfers.droppedFromSource',
      category: 'integrity',
      name: 'Пересадки, потерянные пайплайном',
      unit: 'шт',
      value: droppedOffenders.length,
      target: 0,
      fail: 1,
      direction: 'lower',
      description:
        'Связь объявлена в new_map_source/connections.json, но не доехала до графа как ребро-пересадка. Маршрут сделает крюк вместо реально существующего перехода. Отсутствие общего хаба дефектом НЕ считается: out-of-station переходы по дизайну рисуются пунктиром, а не сливаются в один значок.',
      offenders: droppedOffenders,
    }),
  )

  // --- 3. Рёбра-пересадки без общего хаба ---
  const noHubTransfers: Offender[] = []
  for (const e of graph.edges) {
    if (!e.isTransfer) continue
    if (e.transferKind === 'ignored') continue
    const a = byId.get(e.fromStationId)
    const b = byId.get(e.toStationId)
    if (!a || !b) continue
    if (a.hubId && b.hubId && a.hubId === b.hubId) continue
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    noHubTransfers.push({
      id: `${e.fromStationId}|${e.toStationId}`,
      label: `${a.title} ↔ ${b.title}`,
      value: d,
      detail: `kind=${e.transferKind ?? '?'}, хабы ${a.hubId ?? 'нет'}/${b.hubId ?? 'нет'}, ${d.toFixed(0)}px пунктиром`,
    })
  }
  out.push(
    makeMetric({
      id: 'transfers.edgesWithoutHub',
      category: 'integrity',
      name: 'Пересадки вне хабов',
      unit: 'шт',
      value: noHubTransfers.length,
      target: 8,
      fail: 20,
      direction: 'lower',
      description:
        'Рёбра-пересадки, концы которых не в одном хабе, рисуются розовым пунктиром через всю схему. Немного таких (реальные «выход в город») допустимо, много — визуальный шум.',
      offenders: noHubTransfers,
    }),
  )

  // --- 4. Вырожденные хабы (одна станция) ---
  const degenerate: Offender[] = []
  for (const hub of graph.transferHubs) {
    const present = hub.stationIds.filter((i) => byId.has(i))
    if (present.length >= 2) continue
    degenerate.push({
      id: hub.id,
      label: present.map((i) => byId.get(i)?.title ?? i).join(', ') || hub.id,
      value: hub.stationIds.length - present.length,
      detail: `в хабе ${present.length} отрисованных станций из ${hub.stationIds.length}`,
    })
  }
  out.push(
    makeMetric({
      id: 'transfers.degenerateHubs',
      category: 'integrity',
      name: 'Вырожденные хабы',
      unit: 'шт',
      value: degenerate.length,
      target: 0,
      fail: 3,
      direction: 'lower',
      description:
        'Хаб с одной станцией не даёт пересадки и рисуется как обычная станция — либо в нём потеряна вторая станция, либо хаб лишний.',
      offenders: degenerate,
    }),
  )

  // --- 5. Станции без геометрии ---
  const missing: Offender[] = []
  for (const s of graph.stations) {
    const bad: string[] = []
    if (typeof s.layoutX !== 'number' || typeof s.layoutY !== 'number') bad.push('layoutX/Y')
    if (typeof s.lat !== 'number' || typeof s.lon !== 'number') bad.push('lat/lon')
    if (typeof s.yandexX !== 'number' || typeof s.yandexY !== 'number') bad.push('yandexX/Y')
    if (bad.length === 0) continue
    missing.push({ id: s.id, label: s.title, value: bad.length, detail: `нет ${bad.join(', ')}` })
  }
  out.push(
    makeMetric({
      id: 'data.missingCoords',
      category: 'integrity',
      name: 'Станции без координат',
      unit: 'шт',
      value: missing.length,
      target: 0,
      fail: 1,
      direction: 'lower',
      description:
        'Станция без layoutX/layoutY просто не рисуется. Отсутствие lat/lon или яндекс-якоря ломает пересборку схемы солвером.',
      offenders: missing,
    }),
  )

  return out
}
