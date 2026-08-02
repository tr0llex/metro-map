/** Категория «Целостность данных»: без неё маршруты просто не строятся. */

import type { RenderModel } from '../render.ts'
import { makeMetric, type MetricResult, type Offender } from '../types.ts'

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

  // --- 2. (удалено) Пересадки, потерянные пайплайном ---
  //
  // Метрика сравнивала список связей из new_map_source/connections.json с
  // рёбрами графа: связь могла быть объявлена в источнике, не сопоставиться по
  // имени станции и молча исчезнуть. Сопоставление по именам исчезло вместе с
  // тем форматом — в data/transfers.json пересадка ссылается на станции по
  // идентификаторам, и неизвестный идентификатор останавливает сборку с
  // ошибкой. Потерять пересадку между источником и графом теперь физически
  // нечем, а метрика, которая не может ничего найти, только создаёт иллюзию
  // проверки.

  // --- 3. Рёбра-пересадки без общего хаба ---
  const noHubTransfers: Offender[] = []
  for (const e of graph.edges) {
    if (!e.isTransfer) continue
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
        'Станция без layoutX/layoutY просто не рисуется, без lat/lon не находится поиском «рядом со мной».',
      offenders: missing,
    }),
  )

  return out
}
