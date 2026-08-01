/** Элементарная геометрия. Всё детерминировано, без побочных эффектов. */

export interface Rect {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface Seg {
  ax: number
  ay: number
  bx: number
  by: number
}

/** Расстояние от точки до отрезка. */
export function pointSegDistance(px: number, py: number, s: Seg): number {
  const dx = s.bx - s.ax
  const dy = s.by - s.ay
  const len2 = dx * dx + dy * dy
  if (len2 <= 1e-12) return Math.hypot(px - s.ax, py - s.ay)
  let t = ((px - s.ax) * dx + (py - s.ay) * dy) / len2
  if (t < 0) t = 0
  else if (t > 1) t = 1
  return Math.hypot(px - (s.ax + t * dx), py - (s.ay + t * dy))
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2)
}

/** Площадь пересечения прямоугольников. */
export function rectOverlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)
  const h = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1)
  if (w <= 0 || h <= 0) return 0
  return w * h
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  if (Math.abs(v) < 1e-9) return 0
  return v > 0 ? 1 : -1
}

/** Строгое пересечение двух отрезков (без учёта касаний в общих концах). */
export function segmentsIntersect(p: Seg, q: Seg): boolean {
  const o1 = orient(p.ax, p.ay, p.bx, p.by, q.ax, q.ay)
  const o2 = orient(p.ax, p.ay, p.bx, p.by, q.bx, q.by)
  const o3 = orient(q.ax, q.ay, q.bx, q.by, p.ax, p.ay)
  const o4 = orient(q.ax, q.ay, q.bx, q.by, p.bx, p.by)
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4
}

/** Пересекает ли отрезок прямоугольник (включая случай «целиком внутри»). */
export function segIntersectsRect(s: Seg, r: Rect): boolean {
  const inside = (x: number, y: number) => x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2
  if (inside(s.ax, s.ay) || inside(s.bx, s.by)) return true
  const edges: Seg[] = [
    { ax: r.x1, ay: r.y1, bx: r.x2, by: r.y1 },
    { ax: r.x2, ay: r.y1, bx: r.x2, by: r.y2 },
    { ax: r.x2, ay: r.y2, bx: r.x1, by: r.y2 },
    { ax: r.x1, ay: r.y2, bx: r.x1, by: r.y1 },
  ]
  for (const e of edges) {
    if (segmentsIntersect(s, e)) return true
  }
  return false
}

/** Расстояние от центра прямоугольника-подписи до окружности (0, если пересекаются). */
export function circleRectDistance(cx: number, cy: number, r: number, rect: Rect): number {
  const nx = Math.max(rect.x1, Math.min(cx, rect.x2))
  const ny = Math.max(rect.y1, Math.min(cy, rect.y2))
  return Math.max(0, Math.hypot(cx - nx, cy - ny) - r)
}

/** Отклонение направления отрезка от ближайшего угла, кратного 45°, в градусах (0..22.5). */
export function octilinearDeviationDeg(s: Seg): number {
  const ang = Math.atan2(s.by - s.ay, s.bx - s.ax)
  const step = Math.PI / 4
  const snapped = Math.round(ang / step) * step
  let d = Math.abs(ang - snapped)
  while (d > Math.PI) d = Math.abs(d - 2 * Math.PI)
  return (d * 180) / Math.PI
}

/** Перцентиль (linear interpolation) по уже НЕотсортированному массиву. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/** Пространственная сетка для быстрых запросов «сегменты рядом с точкой». */
export class SegmentGrid<T extends Seg> {
  private readonly cell: number
  private readonly buckets = new Map<string, T[]>()

  constructor(segments: T[], cell = 64) {
    this.cell = cell
    for (const s of segments) {
      const minX = Math.floor(Math.min(s.ax, s.bx) / cell)
      const maxX = Math.floor(Math.max(s.ax, s.bx) / cell)
      const minY = Math.floor(Math.min(s.ay, s.by) / cell)
      const maxY = Math.floor(Math.max(s.ay, s.by) / cell)
      for (let gx = minX; gx <= maxX; gx += 1) {
        for (let gy = minY; gy <= maxY; gy += 1) {
          const key = `${gx}:${gy}`
          let arr = this.buckets.get(key)
          if (!arr) {
            arr = []
            this.buckets.set(key, arr)
          }
          arr.push(s)
        }
      }
    }
  }

  /** Все сегменты в клетках, пересекающих квадрат [x±radius, y±radius]. */
  query(x: number, y: number, radius: number): T[] {
    const out: T[] = []
    const seen = new Set<T>()
    const minX = Math.floor((x - radius) / this.cell)
    const maxX = Math.floor((x + radius) / this.cell)
    const minY = Math.floor((y - radius) / this.cell)
    const maxY = Math.floor((y + radius) / this.cell)
    for (let gx = minX; gx <= maxX; gx += 1) {
      for (let gy = minY; gy <= maxY; gy += 1) {
        const arr = this.buckets.get(`${gx}:${gy}`)
        if (!arr) continue
        for (const s of arr) {
          if (seen.has(s)) continue
          seen.add(s)
          out.push(s)
        }
      }
    }
    return out
  }
}
