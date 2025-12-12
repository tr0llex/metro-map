import { readFileSync } from 'fs'
import { join } from 'path'
import type { EditorOverrides, FullGraphExport, FullGraphStation } from '../src/metro/types'

function main() {
  const projectRoot = process.cwd()
  const overridesPath = join(projectRoot, 'normalized', 'editor_overrides.json')
  const graphPath = join(projectRoot, 'normalized', 'fullGraph.json')

  let overridesRaw: string
  let graphRaw: string

  try {
    overridesRaw = readFileSync(overridesPath, 'utf8')
  } catch {
    console.error('editor_overrides.json not found at', overridesPath)
    return
  }

  try {
    graphRaw = readFileSync(graphPath, 'utf8')
  } catch {
    console.error('fullGraph.json not found at', graphPath)
    return
  }

  const overrides = JSON.parse(overridesRaw) as EditorOverrides
  const graph = JSON.parse(graphRaw) as FullGraphExport

  const stationMap = new Map<string, FullGraphStation>()
  for (const st of graph.stations) {
    stationMap.set(st.id, st)
  }

  const layoutCount = Object.keys(overrides.layout || {}).length
  const stationCount = Object.keys(overrides.stations || {}).length
  const lineCount = Object.keys(overrides.lines || {}).length
  const edgeCount = Object.keys(overrides.edges || {}).length
  const hubCount = Object.keys(overrides.hubs || {}).length

  console.log('=== editor_overrides summary ===')
  console.log('layout overrides:', layoutCount)
  console.log('station overrides:', stationCount)
  console.log('line overrides:', lineCount)
  console.log('edge overrides:', edgeCount)
  console.log('hub overrides:', hubCount)
  console.log()

  const unknownStations = new Set<string>()
  for (const id of Object.keys(overrides.stations || {})) {
    if (!stationMap.has(id)) {
      unknownStations.add(id)
    }
  }

  if (unknownStations.size > 0) {
    console.log('Stations referenced in overrides but missing in fullGraph:')
    for (const id of unknownStations) {
      console.log('  -', id)
    }
    console.log()
  }

  const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

  const badEdges: string[] = []
  for (const [key, e] of Object.entries(overrides.edges || {})) {
    if (e.manual) {
      if (!e.fromStationId || !e.toStationId) {
        badEdges.push(`${key} (manual edge without from/to)`)
        continue
      }
      if (!stationMap.has(e.fromStationId)) {
        badEdges.push(`${key} (fromStationId not in fullGraph: ${e.fromStationId})`)
      }
      if (!stationMap.has(e.toStationId)) {
        badEdges.push(`${key} (toStationId not in fullGraph: ${e.toStationId})`)
      }
      const expectedKey = edgeKey(e.fromStationId, e.toStationId)
      if (expectedKey !== key) {
        badEdges.push(`${key} (manual edge key mismatch, expected ${expectedKey})`)
      }
    }
  }

  if (badEdges.length > 0) {
    console.log('Potential problems in edge overrides:')
    for (const msg of badEdges) {
      console.log('  -', msg)
    }
    console.log()
  }

  console.log('Done.')
}

main()
