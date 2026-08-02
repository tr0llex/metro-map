import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

const roots = ['src', 'scripts', 'tools']
const files = []
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (n === 'node_modules' || n === 'dist' || n === 'coverage') continue
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(ts|tsx|mjs|js)$/.test(n)) files.push(p.replaceAll('\\', '/'))
  }
}
for (const r of roots) {
  try {
    walk(r)
  } catch {}
}

const src = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]))
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const declRe =
  /^export\s+(?:async\s+)?(?:default\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/gm

const dead = []
for (const [file, text] of src) {
  const code = strip(text)
  const names = new Set()
  for (const m of code.matchAll(declRe)) names.add(m[1])
  for (const m of code.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim()
      if (n) names.add(n)
    }
  }
  for (const name of names) {
    let used = false
    for (const [other, otext] of src) {
      if (other === file) continue
      if (new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b').test(strip(otext))) {
        used = true
        break
      }
    }
    if (!used) dead.push({ file, name, isTest: /\.test\./.test(file) })
  }
}

const unimported = []
for (const f of files) {
  if (/\.test\./.test(f)) continue
  const base = basename(f).replace(/\.(ts|tsx|mjs|js)$/, '')
  let referenced = false
  for (const [other, otext] of src) {
    if (other === f) continue
    if (otext.includes('/' + base) || otext.includes('./' + base)) {
      referenced = true
      break
    }
  }
  if (!referenced) unimported.push(f)
}

console.log('=== ЭКСПОРТЫ БЕЗ ВНЕШНИХ ССЫЛОК ===')
const byFile = new Map()
for (const r of dead.filter((r) => !r.isTest)) {
  if (!byFile.has(r.file)) byFile.set(r.file, [])
  byFile.get(r.file).push(r.name)
}
for (const [f, names] of [...byFile].sort()) console.log('  ' + f + ' :: ' + names.join(', '))

console.log('\n=== ФАЙЛЫ БЕЗ ВХОДЯЩИХ ИМПОРТОВ ===')
for (const f of unimported) console.log('  ' + f)
