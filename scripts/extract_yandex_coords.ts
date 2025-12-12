import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

// Простейшая нормализация имён станций в духе normalizeStationName из TS/Go
function normalizeStationName(raw: string): string {
  let s = raw.toLowerCase().trim()
  s = s.replace(/ё/g, 'е')
  s = s.replace(/[«»"„]/g, ' ')
  s = s.replace(/\./g, ' ')
  s = s.replace(/\bим\.?\b/gu, ' ')
  s = s.replace(/\bимени\b/gu, ' ')
  s = s.replace(/\s*-\s*/g, '-')
  s = s.replace(/\s+/g, ' ')
  return s
}

interface YandexCoordEntry {
  title: string
  x: number
  y: number
}

// Парсит groups <g class="scheme-objects-view__label"> ... </g>
async function extractCoords(html: string): Promise<Record<string, YandexCoordEntry[]>> {
  const result: Record<string, YandexCoordEntry[]> = {}

  const groupRegex = /<g class="scheme-objects-view__label"[\s\S]*?<\/g>/g
  let m: RegExpExecArray | null

  while ((m = groupRegex.exec(html)) !== null) {
    const chunk = m[0]

    // Имя станции — первый <text> внутри группы (часто продублирован stroke/normal, нас устроит первый не пустой)
    const textMatch = /<text[^>]*>([\s\S]*?)<\/text>/.exec(chunk)
    if (!textMatch) continue
    const rawInner = textMatch[1]
    // Между соседними tspan/br вставляем пробелы, затем выбрасываем остальные теги
    const rawText = rawInner
      .replace(/<br[^>]*>/gi, ' ')
      .replace(/<\/tspan>\s*<tspan[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (!rawText) continue

    // Координаты — первый circle с cx, cy (в группе обычно два кружка, но центры совпадают)
    const circleMatch = /<circle[^>]*\scx="([0-9.]+)"\s*cy="([0-9.]+)"[^>]*>/i.exec(chunk)
    if (!circleMatch) continue
    const cx = Number(circleMatch[1])
    const cy = Number(circleMatch[2])
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue

    const norm = normalizeStationName(rawText)
    const entry: YandexCoordEntry = { title: rawText, x: cx, y: cy }
    const bucket = result[norm] ?? (result[norm] = [])
    // Удаляем точные дубликаты одной и той же точки (например, дубли слоёв SVG)
    if (!bucket.some((e) => e.x === cx && e.y === cy && e.title === rawText)) {
      bucket.push(entry)
    }
  }

  const ensureLabel = (rawTitle: string) => {
    const norm = normalizeStationName(rawTitle)
    if (result[norm] && result[norm].length > 0) return

    const idx = html.indexOf(rawTitle)
    if (idx === -1) return

    const searchStart = html.lastIndexOf('<circle', idx)
    if (searchStart === -1) return

    const slice = html.slice(searchStart, idx + 200)
    const circleMatch = /<circle[^>]*\scx="([0-9.]+)"\s*cy="([0-9.]+)"[^>]*>/i.exec(slice)
    if (!circleMatch) return

    const cx = Number(circleMatch[1])
    const cy = Number(circleMatch[2])
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return

    const entry: YandexCoordEntry = { title: rawTitle, x: cx, y: cy }
    const bucket = result[norm] ?? (result[norm] = [])
    if (!bucket.some((e) => e.x === cx && e.y === cy && e.title === rawTitle)) {
      bucket.push(entry)
    }
  }

  const importantTitles = [
    'Новокузнецкая',
    'Площадь Революции',
    'Бауманская',
    'Калужская',
    'Воронцовская',
    'Деловой центр (Выставочная)',
  ]
  for (const title of importantTitles) {
    ensureLabel(title)
  }

  const aliasPairs: Array<[string, string]> = [
    ['Библиотека им.Ленина', 'Библиотека имени Ленина'],
    ['Деловой центр (Выставочная)', 'Деловой центр'],
  ]
  for (const [csvName, yandexName] of aliasPairs) {
    const srcNorm = normalizeStationName(yandexName)
    const dstNorm = normalizeStationName(csvName)
    const src = result[srcNorm]
    if (!src || src.length === 0) continue
    const dst = result[dstNorm] ?? (result[dstNorm] = [])
    for (const e of src) {
      if (!dst.some((d) => d.x === e.x && d.y === e.y && d.title === e.title)) {
        dst.push(e)
      }
    }
  }

  return result
}

async function main() {
  const htmlPath = resolve(process.cwd(), process.argv[2] ?? 'new_map_source/yandex_metro.html')
  const outPath = resolve(process.cwd(), process.argv[3] ?? 'normalized/yandex_coords.json')

  const html = await readFile(htmlPath, 'utf8')
  const coords = await extractCoords(html)

  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, JSON.stringify(coords, null, 2), 'utf8')
  console.log(`Extracted ${Object.keys(coords).length} station labels to ${outPath}`)
}

main().catch((err) => {
  console.error('extract_yandex_coords failed:', err)
  process.exit(1)
})
