import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

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

const rows = []
for (const [file, text] of src) {
  const code = strip(text)
  const names = new Set()
  for (const m of code.matchAll(declRe)) names.add(m[1])
  for (const name of names) {
    const re = new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g')
    let own = 0
    let outside = 0
    const otherFiles = []
    for (const [other, otext] of src) {
      const hits = (strip(otext).match(re) || []).length
      if (hits === 0) continue
      if (other === file) own = hits
      else {
        outside += hits
        otherFiles.push(other)
      }
    }
    rows.push({ file, name, own, out: outside, otherFiles })
  }
}

const totallyDead = rows.filter((r) => r.out === 0 && r.own <= 1)
const internalOnly = rows.filter((r) => r.out === 0 && r.own > 1)

console.log('=== СОВСЕМ НЕ ИСПОЛЬЗУЕТСЯ (объявлено и всё) ===')
for (const r of totallyDead.sort((a, b) => a.file.localeCompare(b.file)))
  console.log('  ' + r.file + ' :: ' + r.name)

console.log('\n=== ИСПОЛЬЗУЕТСЯ ТОЛЬКО ВНУТРИ СВОЕГО ФАЙЛА (лишнее слово export) ===')
const g = new Map()
for (const r of internalOnly) {
  if (!g.has(r.file)) g.set(r.file, [])
  g.get(r.file).push(r.name)
}
for (const [f, ns] of [...g].sort()) console.log('  ' + f + ' :: ' + ns.join(', '))
