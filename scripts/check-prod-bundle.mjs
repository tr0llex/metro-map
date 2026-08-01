#!/usr/bin/env node
/**
 * Регресс-тест на утечку редактора в продакшн-бандл.
 *
 * Редактор схемы (состояние, undo/redo, экспорт data/layout.json, панель
 * хабов) доступен только в dev- и editor-сборке. Вырезание держится на том, что
 * Rollup сворачивает `EDITOR_ENABLED ? useEditorController : useNoopEditorController`
 * в мёртвую ветку. Это хрупко: любая ссылка на редакторский модуль вне мёртвой
 * ветки — импорт типа как значения, побочный эффект на уровне модуля — молча
 * вернёт ~14 КБ редактора в прод, и заметить это по глазам невозможно.
 *
 * Поэтому проверяем факт: характерных редакторских строк в dist быть не должно.
 *
 * Запуск: node scripts/check-prod-bundle.mjs   (после `npm run build`)
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIST_DIR = 'dist/assets'

/** Строки, которые существуют ТОЛЬКО в редакторском коде. */
const FORBIDDEN = [
  'data/layout.json',
  'Правок не по координатам',
  'Хаб отзеркален',
  'Все изменения сброшены',
  'Настройки хаба сброшены',
  'Сбросить все изменения редактора',
  'hubMinOverrides',
  'canonicalRingShapes',
  'nominatim',
]

function collectFiles(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    console.error(`✗ Нет директории ${dir}. Сначала выполните: npm run build`)
    process.exit(1)
  }
  const files = []
  for (const name of entries) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) files.push(...collectFiles(full))
    else if (name.endsWith('.js')) files.push(full)
  }
  return files
}

const files = collectFiles(DIST_DIR)
if (files.length === 0) {
  console.error(`✗ В ${DIST_DIR} нет ни одного .js — сборка пустая?`)
  process.exit(1)
}

const leaks = []
for (const file of files) {
  const content = readFileSync(file, 'utf8')
  for (const needle of FORBIDDEN) {
    if (content.includes(needle)) leaks.push({ file, needle })
  }
}

if (leaks.length > 0) {
  console.error('✗ Редакторский код утёк в продакшн-бандл:\n')
  for (const { file, needle } of leaks) {
    console.error(`  ${file} — найдена строка «${needle}»`)
  }
  console.error(
    '\nПричина почти всегда одна: появилась ссылка на src/editor/** вне мёртвой ветки\n' +
      'EDITOR_ENABLED, и Rollup больше не может выкинуть модуль. Проверьте импорты в src/App.tsx.',
  )
  process.exit(1)
}

console.log(`✓ Редактора нет в продакшн-бандле (проверено ${files.length} чанков, ${FORBIDDEN.length} маркеров)`)
