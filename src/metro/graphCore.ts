import type { RouteResult, RouteStep, FullGraphEdge } from './types'

export interface NeighborEdge {
  toStationId: string
  travelMinutes: number
  isTransfer?: boolean
}

export const TRANSFER_PENALTY_MINUTES = 0

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

  const rawTotalMinutes = steps.reduce((sum, s) => {
    const transferPenalty = s.isTransfer ? TRANSFER_PENALTY_MINUTES : 0
    return sum + s.travelMinutes + transferPenalty
  }, 0)
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

  const dist = new Map<string, number>()
  const prev = new Map<string, string>()

  for (const id of stationIds) {
    dist.set(id, Infinity)
  }
  dist.set(startId, 0)

  const visited = new Set<string>()

  while (true) {
    let current: string | null = null
    let best = Infinity
    for (const id of stationIds) {
      if (visited.has(id)) continue
      const d = dist.get(id)!
      if (d < best) {
        best = d
        current = id
      }
    }

    if (current === null || best === Infinity) {
      break
    }

    if (current === targetId) {
      break
    }

    visited.add(current)

    const neighbors = adjacency.get(current) ?? []
    for (const edge of neighbors) {
      const extra = edge.travelMinutes + (edge.isTransfer ? transferPenaltyMinutes : 0)
      const alt = dist.get(current)! + extra
      if (alt < dist.get(edge.toStationId)!) {
        dist.set(edge.toStationId, alt)
        prev.set(edge.toStationId, current)
      }
    }
  }

  if (!prev.has(targetId)) {
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
