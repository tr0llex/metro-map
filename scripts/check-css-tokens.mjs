#!/usr/bin/env node
/**
 * Сторож необъявленных CSS-переменных.
 *
 * Зачем. `var(--foo)` без объявления и без фолбэка делает НЕВАЛИДНЫМ всё
 * правило целиком — не только это свойство. Строчка `padding: var(--space-3)`
 * с необъявленным токеном схлопывает отступ в ноль, и вёрстка едет по всему
 * приложению.
 *
 * Почему нужен отдельный скрипт. Этот класс ошибок не ловит НИЧЕГО из
 * стандартных проверок: `tsc` не смотрит в CSS, ESLint не разбирает CSS,
 * сборка Vite не валидирует пользовательские свойства, тесты не рендерят
 * стили. Реальный случай: введена шкала отступов, 283 использования
 * `var(--space-*)` и НОЛЬ объявлений — `tsc`, `eslint`, `vitest` и `vite build`
 * были зелёными, а приложение осталось без отступов, теней и цвета кнопок.
 *
 * Запуск: node scripts/check-css-tokens.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src'

/**
 * Переменные, которые задаются не в CSS, а из JS (inline style) или собираются
 * из префикса. Для них объявления в стилях нет и быть не должно.
 */
const ALLOWED_WITHOUT_DECLARATION = new Set([
  '--stagger-index', // ставится инлайном на <li> для лестничной анимации шагов
  '--step-line-color', // ставится инлайном: цвет линии конкретного шага маршрута
])

/** `var(--rgb-` + суффикс: имя собирается динамически, статически не проверяется. */
const DYNAMIC_PREFIXES = ['--rgb-']

function collectCss(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...collectCss(full))
    else if (name.endsWith('.css')) out.push(full)
  }
  return out
}

const files = collectCss(ROOT)
const declared = new Set()
const used = new Map() // имя -> [{file, line}]

for (const file of files) {
  const text = readFileSync(file, 'utf8')

  // Объявления: `--name:` в начале строки (в блоке правил).
  for (const m of text.matchAll(/^\s*(--[A-Za-z0-9_-]+)\s*:/gm)) declared.add(m[1])

  // Комментарии вырезаем целиком по всему файлу, а не построчно: они бывают
  // многострочными, и внутри встречаются примеры вроде `var(--space-N)`.
  // Переводы строк сохраняем, чтобы номера строк не поехали.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' '))

  // Использования без фолбэка: var(--name) — но не var(--name, что-то).
  code.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g)) {
      const name = m[1]
      if (!used.has(name)) used.set(name, [])
      used.get(name).push({ file, line: i + 1 })
    }
  })
}

const missing = [...used.entries()]
  .filter(([name]) => !declared.has(name))
  .filter(([name]) => !ALLOWED_WITHOUT_DECLARATION.has(name))
  .filter(([name]) => !DYNAMIC_PREFIXES.some((p) => name === p))
  .sort((a, b) => b[1].length - a[1].length)

if (missing.length > 0) {
  console.error('✗ Использованы необъявленные CSS-переменные:\n')
  for (const [name, places] of missing) {
    const first = places[0]
    const more = places.length > 1 ? ` и ещё ${places.length - 1}` : ''
    console.error(`  ${name} — ${places.length} использований`)
    console.error(`      ${first.file}:${first.line}${more}`)
  }
  console.error(
    '\nvar(--foo) без объявления делает невалидным ВСЁ правило, а не одно свойство:\n' +
      'padding схлопывается в ноль, тени пропадают, кнопки теряют фон.\n' +
      'Объявите переменную (обычно в src/index.css, во всех трёх блоках тем)\n' +
      'либо задайте фолбэк: var(--foo, 8px).',
  )
  process.exit(1)
}

console.log(
  `✓ Все CSS-переменные объявлены (${files.length} файлов, ${declared.size} объявлено, ${used.size} использовано)`,
)
