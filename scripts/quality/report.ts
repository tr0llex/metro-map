/** Человекочитаемый вывод в консоль + сборка машинного отчёта. */

import type { MetricResult, QualityReport, Verdict } from './types.ts'

const CATEGORY_TITLES: Record<string, string> = {
  integrity: 'Целостность данных',
  hubs: 'Пересадочные узлы',
  rings: 'Кольцевые линии',
  geometry: 'Геометрия схемы',
  labels: 'Подписи станций',
}

const USE_COLOR = process.stdout.isTTY === true && process.env.NO_COLOR == null

const c = (code: string, s: string) => (USE_COLOR ? `[${code}m${s}[0m` : s)
const green = (s: string) => c('32', s)
const yellow = (s: string) => c('33', s)
const red = (s: string) => c('31', s)
const dim = (s: string) => c('2', s)
const bold = (s: string) => c('1', s)

const paintVerdict = (v: Verdict) =>
  v === 'PASS' ? green('PASS') : v === 'WARN' ? yellow('WARN') : red('FAIL')

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))
const padLeft = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s)

function fmt(v: number): string {
  if (!Number.isFinite(v)) return '∞'
  return Number.isInteger(v) ? String(v) : v.toFixed(2)
}

export function buildReport(source: string, metrics: MetricResult[]): QualityReport {
  const pass = metrics.filter((m) => m.verdict === 'PASS').length
  const warn = metrics.filter((m) => m.verdict === 'WARN').length
  const fail = metrics.filter((m) => m.verdict === 'FAIL').length
  const verdict: Verdict = fail > 0 ? 'FAIL' : warn > 0 ? 'WARN' : 'PASS'
  const score = metrics.length > 0 ? Math.round(((pass * 100 + warn * 50) / metrics.length) * 10) / 10 : 0
  return {
    // 2: labels.crossedByLines стала зонально-взвешенной, добавлена
    //    labels.crossedByLinesCenter — набор метрик изменился несовместимо.
    schemaVersion: 2,
    source,
    summary: { total: metrics.length, pass, warn, fail, verdict, score },
    metrics,
  }
}

export function printReport(report: QualityReport, showOffenders: boolean): void {
  const lines: string[] = []
  lines.push('')
  lines.push(bold('  Качество схемы метро  ') + dim(`(${report.source})`))
  lines.push('')

  const order = ['integrity', 'hubs', 'rings', 'geometry', 'labels']
  const NAME_W = 42
  const VAL_W = 10
  const TGT_W = 18

  for (const cat of order) {
    const items = report.metrics.filter((m) => m.category === cat)
    if (items.length === 0) continue
    lines.push(bold(`  ${CATEGORY_TITLES[cat] ?? cat}`))
    lines.push(
      dim(
        `  ${pad('метрика', NAME_W)}${padLeft('значение', VAL_W)}  ${pad('цель / провал', TGT_W)}вердикт`,
      ),
    )
    for (const m of items) {
      const value = `${fmt(m.value)}${m.unit === '%' ? '%' : ''}`
      const unitSuffix = m.unit === '%' ? '' : ` ${m.unit}`
      const goal =
        m.direction === 'lower'
          ? `≤${fmt(m.target)} / >${fmt(m.fail)}`
          : `≥${fmt(m.target)} / <${fmt(m.fail)}`
      lines.push(
        `  ${pad(m.name, NAME_W)}${padLeft(value, VAL_W)}${dim(pad(unitSuffix, 5))}${pad(goal, TGT_W)}${paintVerdict(m.verdict)}`,
      )
      if (showOffenders && m.verdict !== 'PASS' && m.offenders.length > 0) {
        for (const o of m.offenders.slice(0, 5)) {
          lines.push(dim(`      • ${o.label}${o.detail ? ` — ${o.detail}` : ` (${fmt(o.value)})`}`))
        }
        if (m.offenders.length > 5) {
          lines.push(dim(`      • …ещё ${m.offenders.length - 5} в normalized/quality_report.json`))
        }
      }
    }
    lines.push('')
  }

  const s = report.summary
  const verdictLine =
    s.verdict === 'PASS'
      ? green('СХЕМА В ПОРЯДКЕ')
      : s.verdict === 'WARN'
        ? yellow('ЕСТЬ ЗАМЕЧАНИЯ')
        : red('ЕСТЬ КРИТИЧНЫЕ ПРОБЛЕМЫ')
  lines.push(
    `  Итог: ${verdictLine}  ${green(`${s.pass} PASS`)} / ${yellow(`${s.warn} WARN`)} / ${red(`${s.fail} FAIL`)}  ·  оценка ${bold(String(s.score))}/100`,
  )
  lines.push('')

  process.stdout.write(lines.join('\n') + '\n')
}
