import { describe, expect, it } from 'vitest'
import { findShortestRouteFullGraph } from './routing'
import { fullGraphEdges } from './fullGraph'

describe('findShortestRouteFullGraph', () => {
  it('returns empty route for identical start and target', () => {
    const edge = fullGraphEdges[0]
    const id = edge.fromStationId
    const result = findShortestRouteFullGraph(id, id)

    expect(result).not.toBeNull()
    expect(result!.steps.length).toBe(0)
    expect(result!.totalMinutes).toBe(0)
    expect(result!.transfersCount).toBe(0)
  })

  it('finds a direct route between neighboring non-transfer stations', () => {
    const nonTransferEdge = fullGraphEdges.find((e) => !e.isTransfer)
    expect(nonTransferEdge).toBeDefined()
    if (!nonTransferEdge) return

    const result = findShortestRouteFullGraph(
      nonTransferEdge.fromStationId,
      nonTransferEdge.toStationId,
    )

    expect(result).not.toBeNull()
    const r = result!

    expect(r.steps.length).toBeGreaterThanOrEqual(1)
    const firstStep = r.steps[0]

    expect(firstStep.fromStationId).toBe(nonTransferEdge.fromStationId)
    expect(firstStep.toStationId).toBe(nonTransferEdge.toStationId)
    expect(r.totalMinutes).toBe(Math.ceil(firstStep.travelMinutes))
  })

  it('counts transfers when using transfer edge, if present in the dataset', () => {
    const transferEdge = fullGraphEdges.find((e) => e.isTransfer)
    if (!transferEdge) {
      // Датасет без явных пересадочных рёбер
      return
    }

    const result = findShortestRouteFullGraph(
      transferEdge.fromStationId,
      transferEdge.toStationId,
    )

    expect(result).not.toBeNull()
    const r = result!

    expect(r.steps.length).toBeGreaterThanOrEqual(1)
    const hasTransferStep = r.steps.some((s) => s.isTransfer)
    expect(hasTransferStep).toBe(true)
    expect(r.transfersCount).toBeGreaterThanOrEqual(1)

    if (r.steps.length === 1) {
      const step = r.steps[0]
      expect(step.isTransfer).toBe(true)
      expect(r.totalMinutes).toBe(Math.ceil(step.travelMinutes))
    }
  })
})
