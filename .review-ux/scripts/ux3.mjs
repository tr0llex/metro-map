import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { chromium, devices } from 'playwright'

const APP_DIR = '/app/dist'; const OUT_DIR = '/out'; const PORT = 4173
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1'); let rel = decodeURIComponent(url.pathname); if (rel.endsWith('/')) rel += 'index.html'
    let f = path.join(APP_DIR, path.normalize(rel).replace(/^([/\\])+/, ''))
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { if (path.extname(f) === '') f = path.join(APP_DIR, 'index.html'); else return void res.writeHead(404).end('nf') }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(await fsp.readFile(f))
  })
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)))
}
const BASE = `http://127.0.0.1:${PORT}/`
const out = {}; const note = (k, v) => { out[k] = v; console.log(`[note] ${k}: ${JSON.stringify(v).slice(0, 1400)}`) }
let browser
async function mk(opts = {}) {
  const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow', ...opts })
  await context.addInitScript(`try{localStorage.setItem('kitty-metro-install-guide-seen','1');localStorage.setItem('kitty-metro-onboarding-hint-seen','1')}catch(e){}`)
  const page = await context.newPage(); await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.bottom-sheet'); await page.waitForTimeout(1600); return { context, page }
}
const shot = (page, n) => page.screenshot({ path: path.join(OUT_DIR, `${n}.png`) }).then(() => console.log(`  [shot] ${n}`))
async function pick(page, which, title) {
  const input = page.getByRole('combobox', { name: which === 'from' ? 'Станция отправления' : 'Станция назначения' })
  await input.click(); await input.fill(''); await input.pressSequentially(title.slice(0, Math.max(4, title.length - 3)), { delay: 25 })
  const opt = page.getByRole('option', { name: title, exact: true }).first(); await opt.waitFor({ timeout: 10000 }); await opt.click(); await page.waitForTimeout(300)
}
async function tap(page, x, y, hold) {
  await page.evaluate(({ x, y }) => { const c = document.querySelector('canvas.metro-map-svg'); const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true }; window.dispatchEvent(new PointerEvent('pointerdown', o)); c.dispatchEvent(new PointerEvent('pointerdown', o)) }, { x, y })
  if (hold) await page.waitForTimeout(hold)
  await page.evaluate(({ x, y }) => document.querySelector('canvas.metro-map-svg').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y })), { x, y })
  await page.waitForTimeout(150)
}
async function findStation(page, y, x0 = 30, x1 = 360, step = 4) {
  for (let x = x0; x < x1; x += step) {
    await tap(page, x, y, 540); await page.waitForTimeout(140)
    const n = await page.evaluate(() => document.querySelector('.station-pick-popover-title')?.textContent?.trim() ?? null)
    if (n) { await page.keyboard.press('Escape'); await page.waitForTimeout(240); return { x, y, name: n } }
  }
  return null
}

// A. Короткий маршрут: сколько альтернатив, что видно, доступны ли детали с клавиатуры
async function shortRoute() {
  const { context, page } = await mk()
  await pick(page, 'from', 'Сокол'); await pick(page, 'to', 'Аэропорт')
  await page.waitForTimeout(1800)
  await shot(page, 'mobile-y-short-collapsed')
  note('short.state', await page.evaluate(() => ({
    chips: document.querySelectorAll('.bottom-route-chip').length,
    header: document.querySelector('.app-header-chip')?.innerText?.replace(/\s+/g, ' '),
    detailsOpen: !!document.querySelector('.bottom-route-details--open'),
    visibleSheetText: document.querySelector('.bottom-sheet-min')?.innerText?.replace(/\s+/g, ' '),
  })))
  // пробуем открыть детали клавиатурой
  const res = []
  for (let i = 0; i < 22; i += 1) {
    await page.keyboard.press('Tab')
    const a = await page.evaluate(() => `${document.activeElement?.tagName}|${(document.activeElement?.getAttribute('aria-label') || '').slice(0, 40)}`)
    res.push(a)
    if (a.includes('Потянуть')) {
      await page.keyboard.press('Enter'); await page.waitForTimeout(800)
      note('short.enterOnHandleOpensDetails', await page.evaluate(() => !!document.querySelector('.bottom-route-details--open')))
      await page.keyboard.press('Space'); await page.waitForTimeout(800)
      note('short.spaceOnHandleOpensDetails', await page.evaluate(() => !!document.querySelector('.bottom-route-details--open')))
      break
    }
  }
  note('short.tabWalk', res)
  // а мышью/тапом по шапке?
  await page.locator('.app-header-chip').click(); await page.waitForTimeout(900)
  note('short.headerChipOpensDetails', await page.evaluate(() => !!document.querySelector('.bottom-route-details--open')))
  await shot(page, 'mobile-y-short-after-header')
  await context.close()
}

// B. Самый длинный вариант: достаётся ли низ деталей свайпом
async function longRoute() {
  const { context, page } = await mk()
  await pick(page, 'from', 'Планерная'); await pick(page, 'to', 'Бунинская аллея')
  await page.waitForTimeout(1800)
  const chips = await page.locator('.bottom-route-chip').all()
  // берём вариант с максимальным числом пересадок
  let idx = 0, best = -1
  for (let i = 0; i < chips.length; i += 1) {
    const t = await chips[i].innerText()
    const m = t.match(/Пересадок:\s*(\d+)/)
    if (m && Number(m[1]) > best) { best = Number(m[1]); idx = i }
  }
  await chips[idx].click(); await page.waitForTimeout(1600)
  note('long.variant', { idx, transfers: best })
  const before = await page.evaluate(() => {
    const d = document.querySelector('.bottom-route-details')
    const steps = [...document.querySelectorAll('.route-step')]
    return { detailsH: Math.round(d.getBoundingClientRect().height), steps: steps.length, lastBottom: Math.round(steps[steps.length - 1].getBoundingClientRect().bottom), vh: window.innerHeight }
  })
  note('long.before', before)
  const client = await page.context().newCDPSession(page)
  const swipe = async () => {
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: 760 }] })
    for (let i = 1; i <= 14; i += 1) { await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: 760 - (560 * i) / 14 }] }); await page.waitForTimeout(16) }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await page.waitForTimeout(700)
  }
  const trace = []
  for (let i = 0; i < 8; i += 1) {
    await swipe()
    trace.push(await page.evaluate(() => {
      const steps = [...document.querySelectorAll('.route-step')]
      const last = steps[steps.length - 1]
      return { lastBottom: Math.round(last.getBoundingClientRect().bottom), visible: last.getBoundingClientRect().bottom <= window.innerHeight + 2, scrollTop: document.querySelector('.route-result-scroll')?.scrollTop }
    }))
  }
  note('long.swipeTrace', trace)
  await shot(page, 'mobile-y-long-swiped')
  await context.close()
}

// C. Поповер: врёт ли подсказка, когда действие не применилось
async function popoverLie() {
  const { context, page } = await mk()
  const a = await findStation(page, 320)
  note('pop.stationA', a)
  if (!a) { await context.close(); return }
  await tap(page, a.x, a.y); await page.waitForTimeout(500)   // Откуда = A
  const st0 = await page.evaluate(() => ({ from: document.querySelectorAll('.bottom-input')[0].value, to: document.querySelectorAll('.bottom-input')[1].value }))
  note('pop.afterFirstTap', st0)
  // долгое нажатие по той же станции → жмём «Куда» (станция уже «Откуда»)
  await tap(page, a.x, a.y, 600); await page.waitForTimeout(500)
  const has = await page.evaluate(() => !!document.querySelector('.station-pick-popover'))
  note('pop.opened', has)
  if (has) {
    await page.locator('.station-pick-popover-button').nth(1).click()   // «Куда»
    await page.waitForTimeout(700)
    note('pop.afterPressKuda', await page.evaluate(() => ({
      from: document.querySelectorAll('.bottom-input')[0].value,
      to: document.querySelectorAll('.bottom-input')[1].value,
      hint: document.querySelector('.theme-station-hint')?.innerText?.replace(/\s+/g, ' ') ?? null,
    })))
    await shot(page, 'mobile-y-popover-lie')
  }
  await context.close()
}

// D. Что видно в шторке, когда открыты подсказки станций (перекрытие клавиатурой)
async function suggestionsLayout() {
  const { context, page } = await mk()
  const input = page.getByRole('combobox', { name: 'Станция отправления' })
  await input.click(); await input.pressSequentially('а', { delay: 40 })
  await page.waitForTimeout(700)
  note('sug.count', await page.evaluate(() => document.querySelectorAll('.suggestion-item').length))
  note('sug.box', await page.evaluate(() => {
    const ul = document.querySelector('.field-suggestions'); if (!ul) return null
    const r = ul.getBoundingClientRect(); const cs = getComputedStyle(ul)
    const items = [...ul.querySelectorAll('li')].map((li) => Math.round(li.getBoundingClientRect().height))
    return { y: Math.round(r.y), h: Math.round(r.height), maxH: cs.maxHeight, itemHeights: items, vh: window.innerHeight }
  }))
  await shot(page, 'mobile-y-suggestions')
  // сколько подсказок для распространённого префикса
  await input.fill(''); await input.pressSequentially('пар', { delay: 40 })
  await page.waitForTimeout(600)
  note('sug.par', await page.evaluate(() => [...document.querySelectorAll('.suggestion-item')].map((i) => i.innerText.trim())))
  await shot(page, 'mobile-y-suggestions-par')
  await context.close()
}

async function main() {
  const server = await startServer()
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'] })
  const all = { short: shortRoute, long: longRoute, pop: popoverLie, sug: suggestionsLayout }
  try {
    for (const [k, fn] of Object.entries(all)) { console.log(`\n=== ${k} ===`); try { await fn() } catch (e) { note(`FAILED.${k}`, String(e.message).slice(0, 300)); console.error(e) } }
  } finally { await browser.close(); server.close(); await fsp.writeFile(path.join(OUT_DIR, 'ux3.json'), JSON.stringify(out, null, 2), 'utf8') }
}
main().catch((e) => { console.error(e); process.exit(1) })
