import { readFileSync } from 'fs'
import { join } from 'path'
import type { FullGraphExport, FullGraphLine, FullGraphStation } from '../src/metro/types'

const KOLTSEVAYA_LINE_ID = 5
const MCC_LINE_ID = 95
const BKL_LINE_ID = 97
const RING_LINE_IDS = new Set<number>([KOLTSEVAYA_LINE_ID, MCC_LINE_ID, BKL_LINE_ID])

function analyzeLayout() {
  const projectRoot = process.cwd()
  const graphPath = join(projectRoot, 'normalized', 'fullGraph.json')
  const graph: FullGraphExport = JSON.parse(readFileSync(graphPath, 'utf8'))

  const stationMap = new Map<string, FullGraphStation>()
  for (const st of graph.stations) {
    stationMap.set(st.id, st)
  }

  const lineMap = new Map<number, FullGraphLine>()
  for (const line of graph.lines) {
    lineMap.set(line.id, line)
  }

  console.log('=== АНАЛИЗ LAYOUT ===\n')

  // Анализ колец
  for (const ringId of [KOLTSEVAYA_LINE_ID, MCC_LINE_ID, BKL_LINE_ID]) {
    const line = lineMap.get(ringId)
    if (!line) continue

    const coords: { x: number; y: number }[] = []
    for (const sid of line.stationIds) {
      const st = stationMap.get(sid)
      if (st && typeof st.layoutX === 'number' && typeof st.layoutY === 'number') {
        coords.push({ x: st.layoutX, y: st.layoutY })
      }
    }
    if (coords.length < 3) continue

    let cx = 0
    let cy = 0
    for (const p of coords) {
      cx += p.x
      cy += p.y
    }
    cx /= coords.length
    cy /= coords.length

    let rSum = 0
    let rMin = Infinity
    let rMax = -Infinity
    for (const p of coords) {
      const dx = p.x - cx
      const dy = p.y - cy
      const r = Math.sqrt(dx * dx + dy * dy)
      rSum += r
      if (r < rMin) rMin = r
      if (r > rMax) rMax = r
    }
    const radius = rSum / coords.length
    const eccentricity = (rMax - rMin) / radius

    console.log(`Кольцо "${line.title}" (id=${ringId}):`)
    console.log(`  Станций: ${coords.length}`)
    console.log(`  Центр: (${cx.toFixed(1)}, ${cy.toFixed(1)})`)
    console.log(`  Средний радиус: ${radius.toFixed(1)}`)
    console.log(`  Эксцентриситет: ${(eccentricity * 100).toFixed(1)}%`)
    console.log(`  Разброс: min=${rMin.toFixed(1)}, max=${rMax.toFixed(1)}\n`)
  }

  // Анализ станций внутри Кольцевой
  const koltsevayaLine = lineMap.get(KOLTSEVAYA_LINE_ID)
  if (koltsevayaLine) {
    const ringCoords: { x: number; y: number }[] = []
    for (const sid of koltsevayaLine.stationIds) {
      const st = stationMap.get(sid)
      if (st && typeof st.layoutX === 'number' && typeof st.layoutY === 'number') {
        ringCoords.push({ x: st.layoutX, y: st.layoutY })
      }
    }
    if (ringCoords.length >= 3) {
      let cx = 0
      let cy = 0
      for (const p of ringCoords) {
        cx += p.x
        cy += p.y
      }
      cx /= ringCoords.length
      cy /= ringCoords.length

      let rSum = 0
      for (const p of ringCoords) {
        const dx = p.x - cx
        const dy = p.y - cy
        rSum += Math.sqrt(dx * dx + dy * dy)
      }
      const ringRadius = rSum / ringCoords.length

      const innerStations: FullGraphStation[] = []
      const innerBorder = ringRadius * 0.90

      for (const st of graph.stations) {
        if (st.lineNumericId != null && RING_LINE_IDS.has(st.lineNumericId)) continue
        if (typeof st.layoutX !== 'number' || typeof st.layoutY !== 'number') continue

        const dx = st.layoutX - cx
        const dy = st.layoutY - cy
        const r = Math.sqrt(dx * dx + dy * dy)
        if (r < innerBorder) {
          innerStations.push(st)
        }
      }

      console.log(`Станции внутри Кольцевой (радиус кольца=${ringRadius.toFixed(1)}, граница=${innerBorder.toFixed(1)}):`)
      console.log(`  Всего внутри: ${innerStations.length}`)

      // Находим самые близкие пары
      const closePairs: { a: FullGraphStation; b: FullGraphStation; dist: number }[] = []
      for (let i = 0; i < innerStations.length; i += 1) {
        for (let j = i + 1; j < innerStations.length; j += 1) {
          const a = innerStations[i]
          const b = innerStations[j]
          if (!a.layoutX || !a.layoutY || !b.layoutX || !b.layoutY) continue

          const dist = Math.sqrt(
            (a.layoutX - b.layoutX) ** 2 + (a.layoutY - b.layoutY) ** 2,
          )
          if (dist < 50) {
            closePairs.push({ a, b, dist })
          }
        }
      }
      closePairs.sort((x, y) => x.dist - y.dist)

      console.log(`  Близкие пары (<50px): ${closePairs.length}`)
      for (const pair of closePairs.slice(0, 5)) {
        console.log(
          `    "${pair.a.title}" ↔ "${pair.b.title}": ${pair.dist.toFixed(1)}px`,
        )
      }
      console.log()
    }
  }

  // Анализ зигзагов в линиях
  console.log('Проверка резких поворотов в линиях:')
  let totalSharpTurns = 0
  for (const line of graph.lines) {
    if (RING_LINE_IDS.has(line.id)) continue
    const ids = line.stationIds
    if (ids.length < 3) continue

    let sharpTurns = 0
    for (let i = 1; i < ids.length - 1; i += 1) {
      const prev = stationMap.get(ids[i - 1])
      const cur = stationMap.get(ids[i])
      const next = stationMap.get(ids[i + 1])
      if (
        !prev ||
        !cur ||
        !next ||
        typeof prev.layoutX !== 'number' ||
        typeof prev.layoutY !== 'number' ||
        typeof cur.layoutX !== 'number' ||
        typeof cur.layoutY !== 'number' ||
        typeof next.layoutX !== 'number' ||
        typeof next.layoutY !== 'number'
      ) {
        continue
      }

      const dx1 = cur.layoutX - prev.layoutX
      const dy1 = cur.layoutY - prev.layoutY
      const dx2 = next.layoutX - cur.layoutX
      const dy2 = next.layoutY - cur.layoutY

      const angle1 = Math.atan2(dy1, dx1)
      const angle2 = Math.atan2(dy2, dx2)
      let angleDiff = angle2 - angle1

      // Нормализуем угол в [-π, π]
      while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI
      while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI

      const angleDeg = Math.abs((angleDiff * 180) / Math.PI)

      // Резкий поворот = больше 120 градусов
      if (angleDeg > 120) {
        sharpTurns += 1
      }
    }

    if (sharpTurns > 0) {
      console.log(
        `  "${line.title}": ${sharpTurns} резких поворотов (>120°)`,
      )
      totalSharpTurns += sharpTurns
    }
  }
  console.log(`Всего резких поворотов: ${totalSharpTurns}\n`)

  // Общая статистика
  console.log('Общая статистика:')
  console.log(`  Линий: ${graph.lines.length}`)
  console.log(`  Станций: ${graph.stations.length}`)
  console.log(`  Рёбер: ${graph.edges.length}`)
  console.log(`  Хабов: ${graph.transferHubs.length}`)

  const withLayout = graph.stations.filter(
    (s) => typeof s.layoutX === 'number' && typeof s.layoutY === 'number',
  ).length
  console.log(`  Станций с layoutX/Y: ${withLayout}`)
}

analyzeLayout()

