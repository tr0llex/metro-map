import type { RouteResult, RouteStep, FullGraphEdge } from './types'

export interface NeighborEdge {
  toStationId: string
  travelMinutes: number
  isTransfer?: boolean
}

// Базовый штраф за пересадку в минутах: среднее время перехода между линиями.
// Ненулевое значение обязательно — иначе набор штрафов в findRouteAlternativesFullGraph
// вырождается в [0, 0, 0] и все прогоны Дейкстры дают один и тот же путь.
export const TRANSFER_PENALTY_MINUTES = 2

type HeapItem = {
  id: string
  dist: number
}

class MinHeap {
  private data: HeapItem[] = []

  size(): number {
    return this.data.length
  }

  push(item: HeapItem): void {
    this.data.push(item)
    this.bubbleUp(this.data.length - 1)
  }

  pop(): HeapItem | undefined {
    const n = this.data.length
    if (n === 0) return undefined
    const top = this.data[0]
    const last = this.data.pop()!
    if (n > 1) {
      this.data[0] = last
      this.bubbleDown(0)
    }
    return top
  }

  private bubbleUp(index: number): void {
    let i = index
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.data[parent].dist <= this.data[i].dist) break
      const tmp = this.data[parent]
      this.data[parent] = this.data[i]
      this.data[i] = tmp
      i = parent
    }
  }

  private bubbleDown(index: number): void {
    let i = index
    const n = this.data.length
    while (true) {
      const left = i * 2 + 1
      if (left >= n) break
      const right = left + 1
      let smallest = left
      if (right < n && this.data[right].dist < this.data[left].dist) {
        smallest = right
      }
      if (this.data[i].dist <= this.data[smallest].dist) break
      const tmp = this.data[i]
      this.data[i] = this.data[smallest]
      this.data[smallest] = tmp
      i = smallest
    }
  }
}

export function undirectedEdgeKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

export function buildEdgeByKey(edges: FullGraphEdge[]): Map<string, FullGraphEdge> {
  const map = new Map<string, FullGraphEdge>()
  for (const e of edges) {
    const key = undirectedEdgeKey(e.fromStationId, e.toStationId)
    const existing = map.get(key)
    if (!existing || (!existing.isTransfer && e.isTransfer)) {
      map.set(key, e)
    }
  }
  return map
}

export function buildRouteResultFromPath(
  path: string[],
  edgeByKey: Map<string, FullGraphEdge>,
): RouteResult {
  const steps: RouteStep[] = []
  let transfersCount = 0

  for (let i = 0; i < path.length - 1; i += 1) {
    const from = path[i]
    const to = path[i + 1]
    const edge = edgeByKey.get(undirectedEdgeKey(from, to))
    if (!edge) continue

    const isTransferStep = !!edge.isTransfer
    if (isTransferStep) {
      transfersCount += 1
    }

    steps.push({
      fromStationId: from,
      toStationId: to,
      lineId: '',
      travelMinutes: edge.medianTravelSeconds / 60,
      isTransfer: isTransferStep,
      transferKind: edge.transferKind,
    })
  }

  // TRANSFER_PENALTY_MINUTES — это стоимость пересадки ТОЛЬКО для поиска
  // (чтобы Дейкстра предпочитала маршруты с меньшим числом пересадок).
  // В отображаемое время его не добавляем: реальное время перехода уже заложено
  // в medianTravelSeconds пересадочного ребра, иначе оно считалось бы дважды.
  const rawTotalMinutes = steps.reduce((sum, s) => sum + s.travelMinutes, 0)
  const totalMinutes = Math.ceil(rawTotalMinutes)

  return {
    steps,
    totalMinutes,
    transfersCount,
  }
}

export function shortestPathFullGraphWithPenalty(
  startId: string,
  targetId: string,
  transferPenaltyMinutes: number,
  adjacency: Map<string, NeighborEdge[]>,
  edgeByKey: Map<string, FullGraphEdge>,
  stationIds: string[],
): { path: string[]; route: RouteResult } | null {
  if (startId === targetId) {
    const empty: RouteResult = {
      steps: [],
      totalMinutes: 0,
      transfersCount: 0,
    }
    return { path: [startId], route: empty }
  }

  void stationIds

  const dist = new Map<string, number>()
  const prev = new Map<string, string>()
  dist.set(startId, 0)

  const heap = new MinHeap()
  heap.push({ id: startId, dist: 0 })

  while (heap.size() > 0) {
    const top = heap.pop()!
    const current = top.id
    const currentDist = dist.get(current)
    if (currentDist === undefined || top.dist !== currentDist) {
      continue
    }

    if (current === targetId) {
      break
    }

    const neighbors = adjacency.get(current) ?? []
    for (const edge of neighbors) {
      const extra = edge.travelMinutes + (edge.isTransfer ? transferPenaltyMinutes : 0)
      const alt = currentDist + extra
      const existing = dist.get(edge.toStationId) ?? Infinity
      if (alt < existing) {
        dist.set(edge.toStationId, alt)
        prev.set(edge.toStationId, current)
        heap.push({ id: edge.toStationId, dist: alt })
      }
    }
  }

  if (startId !== targetId && !prev.has(targetId)) {
    return null
  }

  const path: string[] = []
  let u: string | undefined = targetId
  while (u && u !== startId) {
    path.push(u)
    u = prev.get(u)
  }
  if (u === startId) path.push(startId)
  path.reverse()

  const route = buildRouteResultFromPath(path, edgeByKey)
  return { path, route }
}

export function canonicalPathKey(path: string[]): string {
  return path.join('>')
}

export function cloneAdjacencyWithPathPenalty(
  base: Map<string, NeighborEdge[]>,
  path: string[],
  penaltyFactor: number,
): Map<string, NeighborEdge[]> {
  const bannedPairs = new Set<string>()
  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i]
    const b = path[i + 1]
    bannedPairs.add(`${a}|${b}`)
    bannedPairs.add(`${b}|${a}`)
  }

  const cloned = new Map<string, NeighborEdge[]>()
  for (const [from, edges] of base.entries()) {
    const clonedEdges: NeighborEdge[] = edges.map((edge) => {
      const key = `${from}|${edge.toStationId}`
      if (bannedPairs.has(key)) {
        return {
          toStationId: edge.toStationId,
          travelMinutes: edge.travelMinutes * penaltyFactor,
          isTransfer: edge.isTransfer,
        }
      }
      return { ...edge }
    })
    cloned.set(from, clonedEdges)
  }

  return cloned
}

export function buildAdjacencyListFromFullGraph(
  edges: FullGraphEdge[],
): Map<string, NeighborEdge[]> {
  const map = new Map<string, NeighborEdge[]>()

  const addEdge = (from: string, to: string, seconds: number, isTransfer?: boolean) => {
    if (!map.has(from)) map.set(from, [])
    const minutes = seconds / 60
    map.get(from)!.push({ toStationId: to, travelMinutes: minutes, isTransfer })
  }

  for (const e of edges) {
    addEdge(e.fromStationId, e.toStationId, e.medianTravelSeconds, e.isTransfer)
    addEdge(e.toStationId, e.fromStationId, e.medianTravelSeconds, e.isTransfer)
  }

  return map
}
