import { readFileSync } from 'fs'
import type { FullGraphExport, FullGraphStation } from '../src/metro/types'

function main() {
  const graphPath = process.cwd() + '/normalized/fullGraph.json'
  const raw = readFileSync(graphPath, 'utf8')
  const graph = JSON.parse(raw) as FullGraphExport

  const stationMap = new Map<string, FullGraphStation>()
  for (const st of graph.stations) {
    stationMap.set(st.id, st)
  }

  type ProblemEdge = {
    fromId: string
    fromTitle: string
    fromLineId: number | null
    fromHubId?: string
    toId: string
    toTitle: string
    toLineId: number | null
    toHubId?: string
    edgeLineNumericId?: number
    medianTravelSeconds: number
  }

  const edgesWithoutCommonHub: ProblemEdge[] = []
  const edgesSameLine: ProblemEdge[] = []

  for (const edge of graph.edges) {
    const from = stationMap.get(edge.fromStationId)
    const to = stationMap.get(edge.toStationId)
    if (!from || !to) continue

    if (!edge.isTransfer) continue

    const sameLine =
      typeof from.lineNumericId === 'number' &&
      typeof to.lineNumericId === 'number' &&
      from.lineNumericId === to.lineNumericId

    if (sameLine) {
      edgesSameLine.push({
        fromId: from.id,
        fromTitle: from.title,
        fromLineId: from.lineNumericId,
        fromHubId: from.hubId,
        toId: to.id,
        toTitle: to.title,
        toLineId: to.lineNumericId,
        toHubId: to.hubId,
        edgeLineNumericId: edge.lineNumericId,
        medianTravelSeconds: edge.medianTravelSeconds,
      })
    }

    const hubA = from.hubId ?? null
    const hubB = to.hubId ?? null
    if (!hubA || !hubB || hubA !== hubB) {
      edgesWithoutCommonHub.push({
        fromId: from.id,
        fromTitle: from.title,
        fromLineId: from.lineNumericId,
        fromHubId: from.hubId,
        toId: to.id,
        toTitle: to.title,
        toLineId: to.lineNumericId,
        toHubId: to.hubId,
        edgeLineNumericId: edge.lineNumericId,
        medianTravelSeconds: edge.medianTravelSeconds,
      })
    }
  }

  console.log('=== transferEdgesSameLine ===')
  console.log(JSON.stringify(edgesSameLine, null, 2))

  console.log('=== transferEdgesWithoutCommonHub ===')
  console.log(JSON.stringify(edgesWithoutCommonHub, null, 2))
}

main()
