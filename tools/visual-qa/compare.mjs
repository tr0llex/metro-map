#!/usr/bin/env node
/**
 * Сравнение свежих снимков приёмки с эталоном.
 *
 * Зачем. Стенд снимал 32 скриншота и складывал их рядом с прежними — увидеть
 * регресс можно было только глазами, открыв обе картинки. `MetroMap.tsx` при
 * этом самый большой файл проекта и не покрыт юнит-тестами: канву ими ловить
 * бессмысленно, а вот попиксельное сравнение ловит ровно то, что видит человек.
 *
 * Эталон — снимки, лежащие в `docs/visual-qa/`. Свежие берутся из каталога
 * прогона. Отличия пишутся картинками `*.diff.png` рядом со свежими.
 *
 * Запуск:
 *   node tools/visual-qa/compare.mjs <каталог-со-свежими> [--update]
 *
 * `--update` перезаписывает эталон свежими снимками — так фиксируется
 * ОСОЗНАННОЕ изменение внешнего вида.
 *
 * Код возврата: 0 — расхождений нет, 1 — есть (или пропал снимок).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

const BASELINE_DIR = 'docs/visual-qa'

/**
 * Доля различающихся пикселей, ниже которой считаем снимок совпавшим.
 *
 * Ноль поставить нельзя: сглаживание текста и субпиксельный рендер канвы дают
 * единичные пиксели разницы между запусками даже без правок. 0.1% от кадра
 * 1280x800 — это около тысячи пикселей: меньше, чем занимает одна подпись
 * станции, поэтому реальный сдвиг схемы порог перешагнёт.
 */
const DIFF_SHARE_LIMIT = 0.001

/** Порог различия цвета одного пикселя (0..1). Значение по умолчанию pixelmatch. */
const PIXEL_THRESHOLD = 0.1

const [, , freshDir, ...flags] = process.argv
const update = flags.includes('--update')

if (!freshDir) {
  console.error('Укажите каталог со свежими снимками: node tools/visual-qa/compare.mjs <dir>')
  process.exit(2)
}
if (!existsSync(freshDir)) {
  console.error(`Каталога ${freshDir} нет`)
  process.exit(2)
}

const freshShots = readdirSync(freshDir).filter((n) => n.endsWith('.png') && !n.endsWith('.diff.png'))
if (freshShots.length === 0) {
  console.error(`В ${freshDir} нет ни одного .png`)
  process.exit(2)
}

if (update) {
  mkdirSync(BASELINE_DIR, { recursive: true })
  for (const name of freshShots) {
    writeFileSync(join(BASELINE_DIR, name), readFileSync(join(freshDir, name)))
  }
  console.log(`Эталон обновлён: ${freshShots.length} снимков -> ${BASELINE_DIR}`)
  process.exit(0)
}

const results = []

for (const name of freshShots) {
  const basePath = join(BASELINE_DIR, name)
  const freshPath = join(freshDir, name)

  if (!existsSync(basePath)) {
    results.push({ name, status: 'new', detail: 'в эталоне такого снимка нет' })
    continue
  }

  const base = PNG.sync.read(readFileSync(basePath))
  const fresh = PNG.sync.read(readFileSync(freshPath))

  if (base.width !== fresh.width || base.height !== fresh.height) {
    results.push({
      name,
      status: 'size',
      detail: `размер ${base.width}x${base.height} -> ${fresh.width}x${fresh.height}`,
    })
    continue
  }

  const diff = new PNG({ width: base.width, height: base.height })
  const changed = pixelmatch(base.data, fresh.data, diff.data, base.width, base.height, {
    threshold: PIXEL_THRESHOLD,
  })
  const share = changed / (base.width * base.height)

  if (share > DIFF_SHARE_LIMIT) {
    const diffPath = join(freshDir, `${basename(name, '.png')}.diff.png`)
    writeFileSync(diffPath, PNG.sync.write(diff))
    results.push({
      name,
      status: 'changed',
      detail: `${changed} px (${(share * 100).toFixed(3)}%), карта отличий: ${diffPath}`,
    })
  } else {
    results.push({ name, status: 'same', detail: `${changed} px` })
  }
}

// Пропавшие снимки — тоже регресс: сценарий приёмки перестал сниматься.
const freshSet = new Set(freshShots)
for (const name of readdirSync(BASELINE_DIR).filter((n) => n.endsWith('.png'))) {
  if (!freshSet.has(name)) {
    results.push({ name, status: 'missing', detail: 'есть в эталоне, но не снят' })
  }
}

const bad = results.filter((r) => r.status !== 'same')
const same = results.length - bad.length

console.log(`Сравнено с эталоном: ${same} совпало, ${bad.length} с расхождениями\n`)
for (const r of bad) {
  const label = {
    changed: 'ИЗМЕНИЛСЯ',
    size: 'ДРУГОЙ РАЗМЕР',
    new: 'НОВЫЙ',
    missing: 'ПРОПАЛ',
  }[r.status]
  console.log(`  ${label.padEnd(14)} ${r.name} — ${r.detail}`)
}

if (bad.length > 0) {
  console.log(
    '\nЕсли изменение внешнего вида осознанное — зафиксируйте эталон:\n' +
      `  node tools/visual-qa/compare.mjs ${freshDir} --update`,
  )
  process.exit(1)
}
