/**
 * Аналитические формы кольцевых линий.
 *
 * Точные копии getRingShapeForLine / projectPointToRingShape / resolveRingShapeForLine
 * из src/components/MetroMap.tsx: рантайм рисует кольца именно этой кривой,
 * поэтому метрики обязаны использовать ту же математику, символ в символ.
 *
 * ВАЖНО: рантайм больше НЕ проецирует станции на форму — координаты берутся из
 * данных как есть. Форма приходит из fullGraph.json → ringShapes; подгонка по
 * станциям (getRingShapeForLine) осталась только фолбэком для старых данных.
 * projectPointToRingShape используется метриками для измерения того, насколько
 * станция отстоит от нарисованной кривой.
 */

export interface Pt {
  x: number
  y: number
}

export type RingShape =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }

/**
 * Точная копия resolveRingShapeForLine из MetroMap.tsx: форма из данных, если она
 * есть, иначе — подгонка по станциям.
 */
export function resolveRingShapeForLine(
  lineId: number,
  lineStationIds: string[],
  positions: Map<string, Pt>,
  shapesFromData?: Record<string, RingShape>,
): RingShape | null {
  const fromData = shapesFromData?.[String(lineId)]
  if (fromData) return fromData
  return getRingShapeForLine(lineId, lineStationIds, positions)
}

/** Точная копия getRingShapeForLine из MetroMap.tsx (фолбэк-ветка). */
export function getRingShapeForLine(
  lineId: number,
  lineStationIds: string[],
  positions: Map<string, Pt>,
): RingShape | null {
  const pts: Pt[] = []
  for (const id of lineStationIds) {
    const st = positions.get(id)
    if (!st) continue
    pts.push(st)
  }
  if (pts.length < 3) return null

  let cx = 0
  let cy = 0
  for (const p of pts) {
    cx += p.x
    cy += p.y
  }
  cx /= pts.length
  cy /= pts.length

  let rSum = 0
  let sumDx2 = 0
  let sumDy2 = 0
  for (const p of pts) {
    const dx = p.x - cx
    const dy = p.y - cy
    rSum += Math.hypot(dx, dy)
    sumDx2 += dx * dx
    sumDy2 += dy * dy
  }
  const baseR = rSum / pts.length
  if (!Number.isFinite(baseR) || baseR <= 0) return null

  // Только БКЛ (97) рисуется эллипсом; остальные кольца — окружностью.
  if (lineId === 97) {
    const varX = sumDx2 / pts.length
    const varY = sumDy2 / pts.length
    if (Number.isFinite(varX) && Number.isFinite(varY) && varX > 0 && varY > 0) {
      let ratio = Math.sqrt(varX / varY)
      if (ratio < 1.1) ratio = 1.1
      else if (ratio > 3.0) ratio = 3.0
      const den = Math.sqrt((ratio * ratio + 1) / 2)
      if (!Number.isFinite(den) || den <= 0) return null
      const s = baseR / den
      const rx = ratio * s
      const ry = s
      if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx <= 0 || ry <= 0) return null
      return { kind: 'ellipse', cx, cy, rx, ry }
    }
  }

  return { kind: 'circle', cx, cy, r: baseR }
}

/** Точная копия projectPointToRingShape из MetroMap.tsx. */
export function projectPointToRingShape(shape: RingShape, x: number, y: number): Pt {
  if (shape.kind === 'circle') {
    const ang = Math.atan2(y - shape.cy, x - shape.cx)
    return { x: shape.cx + shape.r * Math.cos(ang), y: shape.cy + shape.r * Math.sin(ang) }
  }
  const ang = Math.atan2((y - shape.cy) / shape.ry, (x - shape.cx) / shape.rx)
  return { x: shape.cx + shape.rx * Math.cos(ang), y: shape.cy + shape.ry * Math.sin(ang) }
}

/** Точка на форме кольца по параметру t (0..2π). */
export function pointOnShape(shape: RingShape, t: number): Pt {
  if (shape.kind === 'circle') {
    return { x: shape.cx + shape.r * Math.cos(t), y: shape.cy + shape.r * Math.sin(t) }
  }
  return { x: shape.cx + shape.rx * Math.cos(t), y: shape.cy + shape.ry * Math.sin(t) }
}
