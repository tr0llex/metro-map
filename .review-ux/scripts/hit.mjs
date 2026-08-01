import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { chromium, devices } from 'playwright'

const APP_DIR = '/app/dist'
const OUT_DIR = '/out'
const PORT = 4173
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    let rel = decodeURIComponent(url.pathname); if (rel.endsWith('/')) rel += 'index.html'
    let f = path.join(APP_DIR, path.normalize(rel).replace(/^([/\\])+/, ''))
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { if (path.extname(f) === '') f = path.join(APP_DIR, 'index.html'); else return void res.writeHead(404).end('nf') }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(await fsp.readFile(f))
  })
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)))
}
const BASE = `http://127.0.0.1:${PORT}/`
const out = {}

async function tap(page, x, y, hold) {
  await page.evaluate(({ x, y }) => {
    const c = document.querySelector('canvas.metro-map-svg')
    const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true }
    window.dispatchEvent(new PointerEvent('pointerdown', o)); c.dispatchEvent(new PointerEvent('pointerdown', o))
  }, { x, y })
  if (hold) await page.waitForTimeout(hold)
  await page.evaluate(({ x, y }) => document.querySelector('canvas.metro-map-svg').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y })), { x, y })
  await page.waitForTimeout(100)
}
async function probe(page, x, y) {
  await tap(page, x, y, 540)
  await page.waitForTimeout(150)
  const n = await page.evaluate(() => document.querySelector('.station-pick-popover-title')?.textContent?.trim() ?? null)
  if (n) { await page.keyboard.press('Escape'); await page.waitForTimeout(240) }
  return n
}

async function main() {
  const server = await startServer()
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU' })
  await context.addInitScript(`try{localStorage.setItem('kitty-metro-install-guide-seen','1');localStorage.setItem('kitty-metro-onboarding-hint-seen','1')}catch(e){}`)
  const page = await context.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.bottom-sheet'); await page.waitForTimeout(1600)

  // 2D-скан вокруг известной станции при стартовом зуме
  const measure = async (tag) => {
    // ищем любую станцию сканом
    let seed = null
    outer: for (let y = 200; y < 520; y += 5) {
      for (let x = 30; x < 360; x += 5) {
        const n = await probe(page, x, y)
        if (n) { seed = { x, y, n }; break outer }
      }
    }
    if (!seed) return { tag, seed: null }
    // максимальная ширина попадания: сканируем по строкам вокруг seed
    let best = 0, bestY = seed.y
    for (let y = seed.y - 8; y <= seed.y + 8; y += 2) {
      let w = 0
      for (let x = seed.x - 16; x <= seed.x + 16; x += 1) {
        const n = await probe(page, x, y)
        if (n === seed.n) w += 1
      }
      if (w > best) { best = w; bestY = y }
    }
    return { tag, station: seed.n, seed, maxHitWidthPx: best, atY: bestY }
  }

  out.defaultZoom = await measure('default')
  console.log(JSON.stringify(out.defaultZoom))

  // Сколько нажатий «+» нужно, чтобы цель стала комфортной
  const zoomIn = async (n) => {
    for (let i = 0; i < n; i += 1) { await page.locator('.metro-map-zoom-button').first().click(); await page.waitForTimeout(450) }
    await page.waitForTimeout(600)
  }
  await zoomIn(3)
  out.zoom3 = await measure('zoom+3')
  console.log(JSON.stringify(out.zoom3))
  await zoomIn(3)
  out.zoom6 = await measure('zoom+6')
  console.log(JSON.stringify(out.zoom6))

  await fsp.writeFile(path.join(OUT_DIR, 'hit-report.json'), JSON.stringify(out, null, 2), 'utf8')
  await browser.close(); server.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
