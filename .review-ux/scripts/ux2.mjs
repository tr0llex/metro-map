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
const note = (k, v) => { out[k] = v; console.log(`[note] ${k}: ${JSON.stringify(v).slice(0, 1400)}`) }

let browser
async function mk(opts = {}) {
  const context = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow', ...opts })
  await context.addInitScript(`try{localStorage.setItem('kitty-metro-install-guide-seen','1');localStorage.setItem('kitty-metro-onboarding-hint-seen','1')}catch(e){}`)
  const page = await context.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.bottom-sheet'); await page.waitForTimeout(1600)
  return { context, page }
}
const shot = (page, n, o = {}) => page.screenshot({ path: path.join(OUT_DIR, `${n}.png`), ...o }).then(() => console.log(`  [shot] ${n}`))

async function pick(page, which, title) {
  const label = which === 'from' ? 'Станция отправления' : 'Станция назначения'
  const input = page.getByRole('combobox', { name: label })
  await input.click(); await input.fill('')
  await input.pressSequentially(title.slice(0, Math.max(4, title.length - 3)), { delay: 25 })
  const opt = page.getByRole('option', { name: title, exact: true }).first()
  await opt.waitFor({ timeout: 10000 }); await opt.click(); await page.waitForTimeout(300)
}

async function tap(page, x, y, hold) {
  await page.evaluate(({ x, y }) => {
    const c = document.querySelector('canvas.metro-map-svg')
    const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true }
    window.dispatchEvent(new PointerEvent('pointerdown', o)); c.dispatchEvent(new PointerEvent('pointerdown', o))
  }, { x, y })
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

// 1. Реальный тач-свайп в деталях: доскроллится ли пользователь до конца маршрута
async function testSheetScroll() {
  const { context, page } = await mk()
  await pick(page, 'from', 'Планерная'); await pick(page, 'to', 'Бунинская аллея')
  await page.waitForTimeout(1800)
  await page.locator('.bottom-route-chip').first().click(); await page.waitForTimeout(1400)

  const before = await page.evaluate(() => {
    const s = document.querySelector('.route-result-scroll')
    const d = document.querySelector('.bottom-route-details')
    const steps = [...document.querySelectorAll('.route-step')]
    return {
      scrollTop: s?.scrollTop, clientH: s?.clientHeight, scrollH: s?.scrollHeight,
      detailsH: d?.getBoundingClientRect().height, detailsTop: d?.getBoundingClientRect().top,
      lastStepBottom: steps.length ? Math.round(steps[steps.length - 1].getBoundingClientRect().bottom) : null,
      vh: window.innerHeight,
      overflowStyle: s ? getComputedStyle(s).overflowY : null,
    }
  })
  note('sheet.before', before)

  const client = await page.context().newCDPSession(page)
  const swipe = async (fromY, toY) => {
    const x = 195
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: fromY }] })
    const steps = 14
    for (let i = 1; i <= steps; i += 1) {
      const y = fromY + ((toY - fromY) * i) / steps
      await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] })
      await page.waitForTimeout(16)
    }
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await page.waitForTimeout(700)
  }
  for (let i = 0; i < 4; i += 1) await swipe(700, 300)
  await shot(page, 'mobile-x-sheet-swiped')
  const after = await page.evaluate(() => {
    const s = document.querySelector('.route-result-scroll')
    const steps = [...document.querySelectorAll('.route-step')]
    const last = steps[steps.length - 1]
    return {
      scrollTop: s?.scrollTop,
      lastStepBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null,
      lastStepVisible: last ? last.getBoundingClientRect().bottom <= window.innerHeight + 2 : null,
      lastStepText: last ? last.innerText.replace(/\s+/g, ' ').slice(0, 80) : null,
      fieldsVisible: (() => { const f = document.querySelector('.bottom-fields-row'); if (!f) return null; const r = f.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight })(),
      headerVisible: (() => { const f = document.querySelector('.app-header-chip'); if (!f) return null; const r = f.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight })(),
    }
  })
  note('sheet.afterSwipe', after)
  await context.close()
}

// 2. Тап-флоу целиком: третий тап заменяет «Куда», долгое нажатие, клик мимо станции
async function testTapFlow() {
  const { context, page } = await mk()
  const a = await findStation(page, 300)
  note('tap2.stationA', a)
  if (!a) { await context.close(); return }
  await tap(page, a.x, a.y); await page.waitForTimeout(500)
  const b = await findStation(page, 420)
  note('tap2.stationB', b)
  if (!b) { await context.close(); return }
  await tap(page, b.x, b.y); await page.waitForTimeout(2200)
  const st1 = await page.evaluate(() => ({ from: document.querySelectorAll('.bottom-input')[0].value, to: document.querySelectorAll('.bottom-input')[1].value }))
  note('tap2.afterRoute', st1)
  await shot(page, 'mobile-x-tap-route')

  // третий тап — ищем станцию заново уже после перестроения вида
  const c = await findStation(page, 500)
  note('tap2.stationC', c)
  if (c) {
    await tap(page, c.x, c.y); await page.waitForTimeout(2200)
    note('tap2.afterThirdTap', await page.evaluate(() => ({
      from: document.querySelectorAll('.bottom-input')[0].value,
      to: document.querySelectorAll('.bottom-input')[1].value,
      hint: document.querySelector('.theme-station-hint')?.innerText?.trim() ?? null,
      header: document.querySelector('.app-header-chip')?.innerText?.replace(/\s+/g, ' '),
    })))
    await shot(page, 'mobile-x-tap-third')
  }

  // повторный тап по той же станции (та же «Куда»)
  if (c) {
    await tap(page, c.x, c.y); await page.waitForTimeout(900)
    note('tap2.tapSameAgain', await page.evaluate(() => document.querySelector('.theme-station-hint')?.innerText?.trim() ?? null))
    await shot(page, 'mobile-x-tap-same')
  }

  // тап мимо станции — есть ли обратная связь
  await tap(page, 200, 700)
  await page.waitForTimeout(600)
  note('tap2.tapEmpty', await page.evaluate(() => ({
    hint: document.querySelector('.theme-station-hint')?.innerText?.trim() ?? null,
    sheetOpen: !!document.querySelector('.bottom-route-details--open'),
  })))

  // долгое нажатие — поповер и клик мимо него
  const d = await findStation(page, 380)
  if (d) {
    await tap(page, d.x, d.y, 600); await page.waitForTimeout(500)
    note('tap2.popover', await page.evaluate(() => {
      const el = document.querySelector('.station-pick-popover')
      if (!el) return null
      const btns = [...el.querySelectorAll('button')].map((b) => { const r = b.getBoundingClientRect(); return { t: b.innerText.trim(), w: Math.round(r.width), h: Math.round(r.height) } })
      const r = el.getBoundingClientRect()
      return { text: el.innerText.replace(/\s+/g, ' '), btns, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    }))
    await shot(page, 'mobile-x-popover')
    // закрывается ли тапом мимо
    await page.mouse.click(20, 700)
    await page.waitForTimeout(600)
    note('tap2.popoverClosedByOutsideClick', await page.evaluate(() => !document.querySelector('.station-pick-popover')))
  }
  await context.close()
}

// 3. Клавиатура: можно ли построить маршрут вообще без мыши
async function testKeyboard() {
  const { context, page } = await mk()
  // Tab до поля «Откуда»
  let steps = 0, reached = false
  for (; steps < 25; steps += 1) {
    await page.keyboard.press('Tab')
    const isFrom = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Станция отправления')
    if (isFrom) { reached = true; break }
  }
  note('kbd.tabsToFromField', { reached, tabs: steps + 1 })
  await page.keyboard.type('Планерн', { delay: 30 })
  await page.waitForTimeout(500)
  note('kbd.suggestionsOpen', await page.evaluate(() => ({
    n: document.querySelectorAll('[role=option]').length,
    activeDescendant: document.activeElement?.getAttribute('aria-activedescendant'),
    expanded: document.activeElement?.getAttribute('aria-expanded'),
  })))
  await page.keyboard.press('ArrowDown'); await page.waitForTimeout(200)
  await shot(page, 'mobile-x-kbd-suggestions')
  await page.keyboard.press('Enter'); await page.waitForTimeout(500)
  note('kbd.afterEnterFrom', await page.evaluate(() => ({
    from: document.querySelectorAll('.bottom-input')[0].value,
    focus: document.activeElement?.getAttribute('aria-label'),
  })))
  await page.keyboard.type('Бунинск', { delay: 30 })
  await page.waitForTimeout(500)
  await page.keyboard.press('Enter'); await page.waitForTimeout(2000)
  note('kbd.afterEnterTo', await page.evaluate(() => ({
    to: document.querySelectorAll('.bottom-input')[1].value,
    header: document.querySelector('.app-header-chip')?.innerText?.replace(/\s+/g, ' '),
    detailsOpen: !!document.querySelector('.bottom-route-details--open'),
    focus: `${document.activeElement?.tagName}|${document.activeElement?.getAttribute('aria-label') ?? ''}`,
  })))
  await shot(page, 'mobile-x-kbd-route')
  // Можно ли добраться до деталей/избранного клавиатурой
  const walk = []
  for (let i = 0; i < 16; i += 1) {
    await page.keyboard.press('Tab')
    walk.push(await page.evaluate(() => {
      const a = document.activeElement
      const r = a?.getBoundingClientRect()
      return `${a?.tagName}.${String(a?.className).slice(0, 30)}|${(a?.getAttribute('aria-label') || a?.innerText || '').slice(0, 36).replace(/\s+/g, ' ')}|vis=${r && r.top >= 0 && r.bottom <= window.innerHeight}`
    }))
  }
  note('kbd.walkAfterRoute', walk)
  await context.close()
}

// 4. Ошибка: одинаковые станции; журнал ошибок; контраст в тёмной теме
async function testMisc() {
  {
    const { context, page } = await mk()
    await pick(page, 'from', 'Сокол')
    await pick(page, 'to', 'Динамо')
    await page.waitForTimeout(1500)
    // теперь меняем «Куда» на «Сокол» вручную
    const input = page.getByRole('combobox', { name: 'Станция назначения' })
    await input.click(); await input.fill(''); await input.pressSequentially('Сокол', { delay: 30 })
    await page.waitForTimeout(600)
    const opt = page.getByRole('option', { name: 'Сокол', exact: true }).first()
    if (await opt.count()) await opt.click()
    await page.waitForTimeout(900)
    await shot(page, 'mobile-x-same-station')
    note('misc.sameStation', await page.evaluate(() => ({
      err: document.querySelector('.error-text')?.innerText ?? null,
      errRect: (() => { const e = document.querySelector('.route-placeholder'); if (!e) return null; const r = e.getBoundingClientRect(); return { y: Math.round(r.y), h: Math.round(r.height) } })(),
      header: document.querySelector('.app-header-chip')?.innerText?.replace(/\s+/g, ' '),
      chips: document.querySelectorAll('.bottom-route-chip').length,
    })))
    await context.close()
  }
  // Тёмная тема: контраст
  {
    const { context, page } = await mk({ colorScheme: 'dark' })
    await pick(page, 'from', 'Планерная'); await pick(page, 'to', 'Бунинская аллея')
    await page.waitForTimeout(1800)
    await page.locator('.bottom-route-chip').first().click(); await page.waitForTimeout(1200)
    note('misc.darkContrast', await page.evaluate(() => {
      const parse = (c) => { const m = c.match(/[\d.]+/g); return m ? m.slice(0, 3).map(Number) : null }
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
      const bgOf = (el) => { let e = el; while (e) { const c = getComputedStyle(e).backgroundColor; if (c && !/, 0\)$/.test(c) && c !== 'transparent') return parse(c); e = e.parentElement } return [255, 255, 255] }
      const sels = ['.bottom-input', '.summary-arrival', '.summary-transfers', '.step-meta', '.step-title', '.step-station-name', '.bottom-route-chip-sub', '.bottom-route-chip--active .bottom-route-chip-sub', '.smart-suggestions-inline-chip', '.suggestion-item-label']
      const res = []
      for (const s of sels) {
        const el = document.querySelector(s); if (!el) continue
        const cs = getComputedStyle(el); const fg = parse(cs.color); const bg = bgOf(el); if (!fg) continue
        const l1 = lum(fg), l2 = lum(bg)
        res.push({ sel: s, fontSize: cs.fontSize, ratio: +(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2)) })
      }
      return res
    }))
    await shot(page, 'mobile-x-dark-details')
    await context.close()
  }
  // Светлая: контраст мелких элементов в деталях
  {
    const { context, page } = await mk()
    await pick(page, 'from', 'Планерная'); await pick(page, 'to', 'Бунинская аллея')
    await page.waitForTimeout(1800)
    await page.locator('.bottom-route-chip').first().click(); await page.waitForTimeout(1200)
    note('misc.lightContrast', await page.evaluate(() => {
      const parse = (c) => { const m = c.match(/[\d.]+/g); return m ? m.slice(0, 3).map(Number) : null }
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
      const bgOf = (el) => { let e = el; while (e) { const c = getComputedStyle(e).backgroundColor; if (c && !/, 0\)$/.test(c) && c !== 'transparent') return parse(c); e = e.parentElement } return [255, 255, 255] }
      const sels = ['.bottom-input', '.summary-time', '.summary-arrival', '.summary-transfers', '.step-meta', '.step-title', '.step-station-name', '.bottom-route-chip-sub', '.bottom-route-chip-time', '.smart-suggestions-inline-chip']
      const res = []
      for (const s of sels) {
        const el = document.querySelector(s); if (!el) continue
        const cs = getComputedStyle(el); const fg = parse(cs.color); const bg = bgOf(el); if (!fg) continue
        const l1 = lum(fg), l2 = lum(bg)
        res.push({ sel: s, color: cs.color, fontSize: cs.fontSize, ratio: +(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2)) })
      }
      return res
    }))
    // Журнал ошибок: пишем запись и смотрим панель
    await page.evaluate(() => { window.dispatchEvent(new ErrorEvent('error', { message: 'ux-review synthetic error', error: new Error('ux-review synthetic error') })) })
    await page.waitForTimeout(800)
    const trig = page.locator('.theme-error-log-trigger')
    note('misc.errorLogTrigger', await trig.count())
    if (await trig.count()) {
      await trig.click(); await page.waitForTimeout(600)
      await shot(page, 'mobile-x-errorlog')
      note('misc.errorLogPanel', await page.evaluate(() => document.querySelector('.theme-error-log-panel')?.innerText?.replace(/\s+/g, ' ').slice(0, 400) ?? null))
    }
    await context.close()
  }
  // Баннер обновления: рендерим принудительно, подменив CSS-классом (только вёрстка)
}

async function main() {
  const server = await startServer()
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'] })
  const only = (process.env.UX2 || 'all').split(',')
  const all = { sheet: testSheetScroll, tap: testTapFlow, kbd: testKeyboard, misc: testMisc }
  try {
    for (const [k, fn] of Object.entries(all)) {
      if (only[0] !== 'all' && !only.includes(k)) continue
      console.log(`\n=== ${k} ===`)
      try { await fn() } catch (e) { note(`FAILED.${k}`, String(e.message).slice(0, 400)); console.error(e) }
    }
  } finally {
    await browser.close(); server.close()
    await fsp.writeFile(path.join(OUT_DIR, `ux2-${only.join('_')}.json`), JSON.stringify(out, null, 2), 'utf8')
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
