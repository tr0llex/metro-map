// UX-ревью: собственные сценарии поверх того же стенда (Docker + Chromium).
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { chromium, devices } from 'playwright'

const APP_DIR = process.env.QA_APP_DIR || '/app/dist'
const OUT_DIR = process.env.QA_OUT_DIR || '/out'
const PORT = 4173
const SCENARIOS = (process.env.UX_SCENARIOS || 'all').split(',').map((s) => s.trim())

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      let rel = decodeURIComponent(url.pathname)
      if (rel.endsWith('/')) rel += 'index.html'
      let filePath = path.join(APP_DIR, path.normalize(rel).replace(/^([/\\])+/, ''))
      if (!filePath.startsWith(APP_DIR)) return void res.writeHead(403).end('forbidden')
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        if (path.extname(filePath) === '') filePath = path.join(APP_DIR, 'index.html')
        else return void res.writeHead(404).end('not found')
      }
      const body = await fsp.readFile(filePath)
      res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-store' })
      res.end(body)
    } catch (err) { res.writeHead(500).end(String(err)) }
  })
  return new Promise((resolve, reject) => { server.on('error', reject); server.listen(PORT, '127.0.0.1', () => resolve(server)) })
}

const BASE = `http://127.0.0.1:${PORT}/`

const MOBILE = {
  ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
  isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow',
}
const DESKTOP = {
  viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false,
  locale: 'ru-RU', timezoneId: 'Europe/Moscow',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
}

const out = { startedAt: new Date().toISOString(), findings: {}, console: [], pageErrors: [] }
function note(key, value) {
  out.findings[key] = value
  console.log(`[note] ${key}:`, JSON.stringify(value).slice(0, 1200))
}

let browser
async function ctx(profile, { clean = false, extra = {} } = {}) {
  const context = await browser.newContext({ ...(profile === 'mobile' ? MOBILE : DESKTOP), ...extra })
  if (!clean) {
    await context.addInitScript(`try{
      localStorage.setItem('kitty-metro-install-guide-seen','1');
      localStorage.setItem('kitty-metro-onboarding-hint-seen','1');
    }catch(e){}`)
  }
  const page = await context.newPage()
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') out.console.push({ t: m.type(), text: m.text().slice(0, 300) }) })
  page.on('pageerror', (e) => out.pageErrors.push(String(e && e.message).slice(0, 400)))
  return { context, page }
}
async function shot(page, name, opts = {}) {
  await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), ...opts })
  console.log(`  [shot] ${name}.png`)
}
async function ready(page) {
  await page.waitForSelector('.bottom-sheet', { timeout: 25000 })
  await page.waitForTimeout(1400)
}

// --- вспомогательное: тап по канвасу через синтетические события -------------
async function tapCanvas(page, x, y, { holdMs = 0 } = {}) {
  await page.evaluate(({ x, y }) => {
    const c = document.querySelector('canvas.metro-map-svg')
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', isPrimary: true }
    window.dispatchEvent(new PointerEvent('pointerdown', opts))
    c.dispatchEvent(new PointerEvent('pointerdown', opts))
  }, { x, y })
  if (holdMs) await page.waitForTimeout(holdMs)
  await page.evaluate(({ x, y }) => {
    const c = document.querySelector('canvas.metro-map-svg')
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y }
    c.dispatchEvent(new MouseEvent('click', opts))
  }, { x, y })
  await page.waitForTimeout(120)
}

// Долгое нажатие — недеструктивный «щуп»: открывает поповер, если попали в станцию.
async function probeStation(page, x, y) {
  await tapCanvas(page, x, y, { holdMs: 540 })
  await page.waitForTimeout(180)
  const name = await page.evaluate(() => {
    const el = document.querySelector('.station-pick-popover-title')
    return el ? el.textContent.trim() : null
  })
  if (name) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(260)
  }
  return name
}

// ============================================================================
async function scenarioFirstRun() {
  for (const profile of ['mobile', 'desktop']) {
    const { context, page } = await ctx(profile, { clean: true })
    const t0 = Date.now()
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    const timeline = []
    for (const ms of [250, 700, 1300, 2000, 2800, 3600]) {
      await page.waitForTimeout(Math.max(0, ms - (Date.now() - t0)))
      const state = await page.evaluate(() => ({
        splash: !!document.querySelector('.app-splash:not(.app-splash--hidden)'),
        install: !!document.querySelector('.install-guide-card'),
        hint: !!document.querySelector('.onboarding-hint'),
        sheet: !!document.querySelector('.bottom-sheet'),
        theme: !!document.querySelector('.theme-toggle'),
      }))
      timeline.push({ ms, ...state })
      await shot(page, `${profile}-fr-${String(ms).padStart(4, '0')}`)
    }
    note(`firstRun.timeline.${profile}`, timeline)

    // Текст карточки установки
    const card = await page.evaluate(() => {
      const el = document.querySelector('.install-guide-card')
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const bd = document.querySelector('.install-guide-backdrop')
      return {
        text: el.innerText.replace(/\s+/g, ' ').slice(0, 600),
        rect: { w: Math.round(r.width), h: Math.round(r.height) },
        bg: cs.backgroundColor, backdropFilter: cs.backdropFilter,
        backdropBg: bd ? getComputedStyle(bd).backgroundColor : null,
        buttons: [...el.querySelectorAll('button')].map((b) => b.innerText.trim() || b.getAttribute('aria-label')),
        role: el.getAttribute('role'), ariaModal: el.getAttribute('aria-modal'),
      }
    })
    note(`firstRun.installCard.${profile}`, card)

    // Что фокусируется по Tab, пока висит карточка (ловушка фокуса?)
    const trap = []
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab')
      trap.push(await page.evaluate(() => {
        const a = document.activeElement
        if (!a) return null
        return `${a.tagName}.${String(a.className).slice(0, 40)}|${(a.getAttribute('aria-label') || a.innerText || '').slice(0, 40).replace(/\s+/g, ' ')}`
      }))
    }
    note(`firstRun.focusTrap.${profile}`, trap)

    const close = page.locator('.install-guide-close-button').first()
    if (await close.count()) { await close.click(); await page.waitForTimeout(700) }
    await shot(page, `${profile}-fr-after-install`)
    const hintText = await page.evaluate(() => {
      const el = document.querySelector('.onboarding-hint')
      return el ? el.innerText.replace(/\s+/g, ' ') : null
    })
    note(`firstRun.onboardingHint.${profile}`, hintText)

    // Сколько «шума» на первом экране: перечислим все видимые кликабельные элементы
    const firstScreen = await page.evaluate(() => {
      const res = []
      document.querySelectorAll('button, input, [role="button"]').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) return
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none') return
        res.push({
          label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 50),
          w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y),
        })
      })
      return res
    })
    note(`firstRun.controls.${profile}`, firstScreen)
    await context.close()
  }
}

// ============================================================================
async function scenarioTapFlow() {
  const { context, page } = await ctx('mobile')
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await ready(page)
  await shot(page, 'mobile-tap-00-start')

  const box = await page.locator('canvas.metro-map-svg').boundingBox()
  // Ищем первую станцию сканом по горизонтали через середину карты.
  const yScan = Math.round(box.y + box.height * 0.42)
  let hit = null
  for (let x = Math.round(box.x + 60); x < box.x + box.width - 60 && !hit; x += 7) {
    const name = await probeStation(page, x, yScan)
    if (name) hit = { x, y: yScan, name }
  }
  note('tap.firstHit', hit)

  // Размер тач-цели: скан по горизонтали вокруг найденной точки с шагом 2px.
  if (hit) {
    let left = hit.x, right = hit.x
    for (let x = hit.x; x > hit.x - 40; x -= 2) {
      const n = await probeStation(page, x, hit.y)
      if (n === hit.name) left = x; else break
    }
    for (let x = hit.x; x < hit.x + 40; x += 2) {
      const n = await probeStation(page, x, hit.y)
      if (n === hit.name) right = x; else break
    }
    note('tap.hitWidthCssPx.defaultZoom', { station: hit.name, left, right, width: right - left })
  }

  // Плотность попаданий: грубая сетка по всему канвасу.
  let hits = 0, total = 0
  const gridPts = []
  for (let gx = 0; gx < 12; gx += 1) {
    for (let gy = 0; gy < 10; gy += 1) {
      const x = Math.round(box.x + 30 + (box.width - 60) * (gx / 11))
      const y = Math.round(box.y + 90 + (box.height - 300) * (gy / 9))
      const n = await probeStation(page, x, y)
      total += 1
      if (n) { hits += 1; gridPts.push({ x, y, n }) }
    }
  }
  note('tap.gridHitRate', { hits, total, rate: +(hits / total).toFixed(3), sample: gridPts.slice(0, 12) })

  await context.close()
}

// ============================================================================
async function scenarioTapRoute() {
  const { context, page } = await ctx('mobile')
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await ready(page)
  const box = await page.locator('canvas.metro-map-svg').boundingBox()

  // Находим три станции щупом
  const found = []
  const yScan = Math.round(box.y + box.height * 0.38)
  for (let x = Math.round(box.x + 50); x < box.x + box.width - 50 && found.length < 3; x += 6) {
    const n = await probeStation(page, x, yScan)
    if (n && !found.some((f) => f.name === n)) found.push({ x, y: yScan, name: n })
  }
  note('tapRoute.stations', found)
  if (found.length < 2) { await context.close(); return }

  const readState = () => page.evaluate(() => ({
    from: document.querySelectorAll('.bottom-input')[0]?.value ?? null,
    to: document.querySelectorAll('.bottom-input')[1]?.value ?? null,
    hint: document.querySelector('.theme-station-hint')?.innerText?.trim() ?? null,
    chips: document.querySelectorAll('.bottom-route-chip').length,
    header: document.querySelector('.app-header-chip')?.innerText?.replace(/\s+/g, ' ') ?? null,
    sheetOpen: !!document.querySelector('.bottom-route-details--open'),
    summary: document.querySelector('.route-summary-main')?.innerText?.replace(/\s+/g, ' ') ?? null,
  }))

  await tapCanvas(page, found[0].x, found[0].y)
  await page.waitForTimeout(400)
  note('tapRoute.afterFirstTap', await readState())
  await shot(page, 'mobile-tap-01-first')

  await tapCanvas(page, found[1].x, found[1].y)
  await page.waitForTimeout(1800)
  note('tapRoute.afterSecondTap', await readState())
  await shot(page, 'mobile-tap-02-route')

  if (found[2]) {
    await tapCanvas(page, found[2].x, found[2].y)
    await page.waitForTimeout(1800)
    note('tapRoute.afterThirdTap', await readState())
    await shot(page, 'mobile-tap-03-replaced')
  }

  // Долгое нажатие → поповер
  await tapCanvas(page, found[0].x, found[0].y, { holdMs: 560 })
  await page.waitForTimeout(400)
  const pop = await page.evaluate(() => {
    const el = document.querySelector('.station-pick-popover')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return {
      text: el.innerText.replace(/\s+/g, ' '),
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      buttons: [...el.querySelectorAll('button')].map((b) => { const br = b.getBoundingClientRect(); return { t: b.innerText.trim(), w: Math.round(br.width), h: Math.round(br.height) } }),
    }
  })
  note('tapRoute.longPressPopover', pop)
  await shot(page, 'mobile-tap-04-popover')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // Как начать заново? Ищем что-то похожее на сброс
  const resetControls = await page.evaluate(() => [...document.querySelectorAll('button')]
    .map((b) => (b.getAttribute('aria-label') || b.innerText || '').trim().replace(/\s+/g, ' '))
    .filter(Boolean))
  note('tapRoute.availableControls', resetControls)
  await context.close()
}

// ============================================================================
async function pickByInput(page, which, title) {
  const label = which === 'from' ? 'Станция отправления' : 'Станция назначения'
  const input = page.getByRole('combobox', { name: label })
  await input.click()
  await input.fill('')
  await input.pressSequentially(title.slice(0, Math.max(4, title.length - 3)), { delay: 30 })
  const opt = page.getByRole('option', { name: title, exact: true }).first()
  await opt.waitFor({ timeout: 10000 })
  await opt.click()
  await page.waitForTimeout(300)
}

async function scenarioResult() {
  for (const profile of ['mobile', 'desktop']) {
    const { context, page } = await ctx(profile)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await ready(page)
    await pickByInput(page, 'from', 'Планерная')
    await pickByInput(page, 'to', 'Бунинская аллея')
    await page.waitForTimeout(2200)
    await shot(page, `${profile}-res-01-built`)

    const info = await page.evaluate(() => {
      const chips = [...document.querySelectorAll('.bottom-route-chip')].map((c) => c.innerText.replace(/\s+/g, ' '))
      return {
        chips,
        header: document.querySelector('.app-header-chip')?.innerText?.replace(/\s+/g, ' ') ?? null,
        summary: document.querySelector('.route-summary-main')?.innerText?.replace(/\s+/g, ' ') ?? null,
        detailsOpen: !!document.querySelector('.bottom-route-details--open'),
        steps: [...document.querySelectorAll('.route-step')].map((s) => s.innerText.replace(/\s+/g, ' ').slice(0, 160)),
      }
    })
    note(`result.${profile}`, info)

    // Раскрываем шторку
    const chip = page.locator('.bottom-route-chip').first()
    if (await chip.count()) { await chip.click(); await page.waitForTimeout(1400) }
    else {
      const handle = page.locator('.bottom-sheet-handle').first()
      if (await handle.count()) { await handle.click(); await page.waitForTimeout(1200) }
    }
    await shot(page, `${profile}-res-02-details`)

    const scrollInfo = await page.evaluate(() => {
      const el = document.querySelector('.route-result-scroll')
      if (!el) return null
      return { clientH: el.clientHeight, scrollH: el.scrollHeight, needScroll: el.scrollHeight > el.clientHeight + 4 }
    })
    note(`result.scroll.${profile}`, scrollInfo)

    await page.evaluate(() => { const el = document.querySelector('.route-result-scroll'); if (el) el.scrollTop = el.scrollHeight })
    await page.waitForTimeout(500)
    await shot(page, `${profile}-res-03-details-bottom`)

    // Избранное + поделиться
    const fav = page.locator('.route-favorite-button').first()
    if (await fav.count()) {
      await page.evaluate(() => { const el = document.querySelector('.route-result-scroll'); if (el) el.scrollTop = 0 })
      await page.waitForTimeout(300)
      await fav.click(); await page.waitForTimeout(600)
      note(`result.favToggled.${profile}`, await page.evaluate(() => ({
        pressed: document.querySelector('.route-favorite-button')?.getAttribute('aria-pressed'),
        stored: localStorage.getItem('kitty-metro-favorites-v1'),
      })))
      await shot(page, `${profile}-res-04-fav`)
    }
    const share = page.locator('.route-share-button').first()
    if (await share.count()) {
      await share.click(); await page.waitForTimeout(700)
      note(`result.shareHint.${profile}`, await page.evaluate(() => document.querySelector('.route-share-hint')?.innerText ?? null))
      await shot(page, `${profile}-res-05-share`)
    }
    await context.close()
  }
}

// ============================================================================
async function scenarioReturn() {
  // 1. Недавние/избранное после перезагрузки
  const { context, page } = await ctx('mobile')
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await ready(page)
  await pickByInput(page, 'from', 'Сокол')
  await pickByInput(page, 'to', 'Динамо')
  await page.waitForTimeout(1800)
  const fav = page.locator('.route-favorite-button').first()
  if (await fav.count()) {
    const chip = page.locator('.bottom-route-chip').first()
    if (await chip.count()) { await chip.click(); await page.waitForTimeout(900) }
    await fav.click(); await page.waitForTimeout(500)
  }
  await page.reload({ waitUntil: 'domcontentloaded' })
  await ready(page)
  await shot(page, 'mobile-ret-01-relaunch')
  note('return.storage', await page.evaluate(() => ({
    recents: localStorage.getItem('kitty-metro-recents-v1'),
    favorites: localStorage.getItem('kitty-metro-favorites-v1'),
  })))
  note('return.inlineChips', await page.evaluate(() => [...document.querySelectorAll('.smart-suggestions-inline-chip')].map((c) => c.innerText.trim())))
  const recBtn = page.locator('.smart-suggestions-inline-chip').first()
  if (await recBtn.count()) { await recBtn.click(); await page.waitForTimeout(600) }
  await shot(page, 'mobile-ret-02-suggestions')
  note('return.panel', await page.evaluate(() => document.querySelector('.smart-suggestions')?.innerText?.replace(/\s+/g, ' ') ?? null))
  await context.close()

  // 2. Геолокация: разрешена
  {
    const { context, page } = await ctx('mobile', { extra: { permissions: ['geolocation'], geolocation: { latitude: 55.7558, longitude: 37.6173 } } })
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await ready(page)
    const nearBtn = page.locator('.smart-suggestions-inline-chip', { hasText: 'Рядом' }).first()
    if (await nearBtn.count()) { await nearBtn.click(); await page.waitForTimeout(1800) }
    await shot(page, 'mobile-ret-03-nearby-ok')
    note('return.nearbyOk', await page.evaluate(() => document.querySelector('.smart-suggestions')?.innerText?.replace(/\s+/g, ' ') ?? null))
    await context.close()
  }

  // 3. Геолокация: запрещена
  {
    const { context, page } = await ctx('mobile')
    await context.grantPermissions([])
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await ready(page)
    const nearBtn = page.locator('.smart-suggestions-inline-chip', { hasText: 'Рядом' }).first()
    if (await nearBtn.count()) { await nearBtn.click(); await page.waitForTimeout(2500) }
    await shot(page, 'mobile-ret-04-nearby-denied')
    note('return.nearbyDenied', await page.evaluate(() => document.querySelector('.smart-suggestions')?.innerText?.replace(/\s+/g, ' ') ?? null))
    await context.close()
  }

  // 4. Deep link
  for (const [name, url] of [
    ['valid', `${BASE}?from=${encodeURIComponent('mos-7-7.111')}&to=${encodeURIComponent('mos-12-12.167')}`],
    ['broken', `${BASE}?from=nope&to=alsonope`],
    ['half', `${BASE}?from=${encodeURIComponent('mos-7-7.111')}`],
  ]) {
    const { context, page } = await ctx('mobile')
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await ready(page)
    await page.waitForTimeout(1500)
    await shot(page, `mobile-ret-05-deeplink-${name}`)
    note(`return.deeplink.${name}`, await page.evaluate(() => ({
      from: document.querySelectorAll('.bottom-input')[0]?.value ?? null,
      to: document.querySelectorAll('.bottom-input')[1]?.value ?? null,
      header: document.querySelector('.app-header-chip')?.innerText?.replace(/\s+/g, ' ') ?? null,
      err: document.querySelector('.error-text')?.innerText ?? null,
      url: location.href,
    })))
    await context.close()
  }
}

// ============================================================================
async function scenarioErrors() {
  // Одинаковые станции
  {
    const { context, page } = await ctx('mobile')
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await ready(page)
    await pickByInput(page, 'from', 'Сокол')
    const input = page.getByRole('combobox', { name: 'Станция назначения' })
    await input.click(); await input.pressSequentially('Сокол', { delay: 30 })
    await page.waitForTimeout(500)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(900)
    await shot(page, 'mobile-err-01-same-station')
    note('errors.sameStation', await page.evaluate(() => ({
      err: document.querySelector('.error-text')?.innerText ?? null,
      retry: !!document.querySelector('.route-retry-button'),
      errVisible: (() => { const e = document.querySelector('.route-placeholder'); if (!e) return null; const r = e.getBoundingClientRect(); return { y: Math.round(r.y), h: Math.round(r.height), inView: r.y > 0 && r.bottom < window.innerHeight } })(),
    })))
    await context.close()
  }

  // Ввод несуществующей станции
  {
    const { context, page } = await ctx('mobile')
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await ready(page)
    const input = page.getByRole('combobox', { name: 'Станция отправления' })
    await input.click(); await input.pressSequentially('Ждановская', { delay: 25 })
    await page.waitForTimeout(600)
    note('errors.unknownStation.suggestions', await page.evaluate(() => document.querySelectorAll('.suggestion-item').length))
    await page.keyboard.press('Enter')
    await page.waitForTimeout(700)
    await shot(page, 'mobile-err-02-unknown')
    note('errors.unknownStation', await page.evaluate(() => ({
      err: document.querySelector('.error-text')?.innerText ?? null,
      value: document.querySelectorAll('.bottom-input')[0]?.value,
    })))
    await context.close()
  }

  // Офлайн: прогреваем SW, потом уходим в офлайн и перезагружаемся
  {
    const { context, page } = await ctx('mobile')
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await ready(page)
    const swState = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return 'no-sw-api'
      const reg = await navigator.serviceWorker.getRegistration()
      return reg ? (reg.active ? 'active' : 'registered') : 'none'
    })
    note('errors.swState', swState)
    await page.waitForTimeout(2500)
    await context.setOffline(true)
    let reloadErr = null
    try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }) } catch (e) { reloadErr = String(e.message).slice(0, 200) }
    await page.waitForTimeout(3000)
    await shot(page, 'mobile-err-03-offline')
    note('errors.offline', {
      reloadErr,
      bodyText: (await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300))),
      hasSheet: await page.evaluate(() => !!document.querySelector('.bottom-sheet')),
    })
    // строится ли маршрут офлайн
    try {
      await ready(page)
      await pickByInput(page, 'from', 'Сокол')
      await pickByInput(page, 'to', 'Динамо')
      await page.waitForTimeout(1500)
      note('errors.offlineRoute', await page.evaluate(() => document.querySelector('.app-header-chip')?.innerText?.replace(/\s+/g, ' ') ?? null))
      await shot(page, 'mobile-err-04-offline-route')
    } catch (e) { note('errors.offlineRoute', `FAIL: ${String(e.message).slice(0, 200)}`) }
    await context.close()
  }

  // Баннер обновления — форсируем показ через внутренний ключ? Смотрим только вёрстку через CSS-инъекцию невозможно;
  // фиксируем факт наличия компонента и его текста из бандла.
}

// ============================================================================
async function scenarioA11y() {
  for (const profile of ['mobile', 'desktop']) {
    const { context, page } = await ctx(profile)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await ready(page)

    // Обход по Tab
    const walk = []
    for (let i = 0; i < 20; i += 1) {
      await page.keyboard.press('Tab')
      const info = await page.evaluate(() => {
        const a = document.activeElement
        if (!a || a === document.body) return { el: 'BODY' }
        const r = a.getBoundingClientRect()
        const cs = getComputedStyle(a)
        return {
          el: `${a.tagName}.${String(a.className).slice(0, 40)}`,
          label: (a.getAttribute('aria-label') || a.getAttribute('placeholder') || a.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 50),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
          inViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth,
          outline: cs.outlineStyle === 'none' ? null : `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`,
          boxShadow: cs.boxShadow === 'none' ? null : cs.boxShadow.slice(0, 60),
        }
      })
      walk.push(info)
      if (info.el === 'BODY' && walk.length > 3) break
    }
    note(`a11y.tabWalk.${profile}`, walk)
    await shot(page, `${profile}-a11y-01-focus`)

    // Размеры тач-целей
    const targets = await page.evaluate(() => {
      const res = []
      document.querySelectorAll('button, input, [role="button"], [role="option"], li.suggestion-item').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) return
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return
        res.push({
          label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.innerText || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 44),
          w: Math.round(r.width), h: Math.round(r.height),
        })
      })
      return res.filter((t) => t.w < 44 || t.h < 44)
    })
    note(`a11y.smallTargets.${profile}`, targets)

    // Живые области / landmark-разметка
    note(`a11y.landmarks.${profile}`, await page.evaluate(() => ({
      lang: document.documentElement.lang,
      title: document.title,
      h1: [...document.querySelectorAll('h1,h2,h3')].map((h) => `${h.tagName}: ${h.innerText.trim().slice(0, 40)}`),
      liveRegions: [...document.querySelectorAll('[aria-live],[role=status],[role=alert]')].map((e) => `${e.className}|${e.getAttribute('aria-live') || e.getAttribute('role')}`),
      canvasAria: (() => { const c = document.querySelector('canvas.metro-map-svg'); return c ? { role: c.getAttribute('role'), label: c.getAttribute('aria-label'), tabindex: c.getAttribute('tabindex') } : null })(),
      mapWrapper: (() => { const c = document.querySelector('.metro-map-wrapper'); return c ? c.outerHTML.slice(0, 300) : null })(),
    })))

    // Контраст ключевого текста
    const contrast = await page.evaluate(() => {
      function parse(c) { const m = c.match(/[\d.]+/g); return m ? m.slice(0, 3).map(Number) : null }
      function lum([r, g, b]) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
      function bgOf(el) {
        let e = el
        while (e) { const c = getComputedStyle(e).backgroundColor; const p = parse(c); if (p && !/rgba\(.*,\s*0\)/.test(c)) return p; e = e.parentElement }
        return [255, 255, 255]
      }
      const sel = ['.bottom-input', '.app-header-chip', '.onboarding-hint-text', '.summary-time', '.summary-arrival', '.summary-transfers', '.step-meta', '.step-title', '.step-station-name', '.bottom-route-chip-sub', '.smart-suggestions-inline-chip', '.app-splash-credits']
      const res = []
      for (const s of sel) {
        const el = document.querySelector(s)
        if (!el) continue
        const cs = getComputedStyle(el)
        const fg = parse(cs.color); const bg = bgOf(el)
        if (!fg) continue
        const l1 = lum(fg), l2 = lum(bg)
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
        res.push({ sel: s, color: cs.color, bg: `rgb(${bg.join(',')})`, fontSize: cs.fontSize, ratio: +ratio.toFixed(2) })
      }
      return res
    })
    note(`a11y.contrast.${profile}`, contrast)
    await context.close()
  }

  // reduced-motion
  {
    const { context, page } = await ctx('mobile', { extra: { reducedMotion: 'reduce' } })
    const t0 = Date.now()
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(600)
    await shot(page, 'mobile-a11y-02-reduced-splash')
    await ready(page)
    await shot(page, 'mobile-a11y-03-reduced-map')
    const anim = await page.evaluate(() => {
      const running = []
      document.querySelectorAll('*').forEach((el) => {
        const cs = getComputedStyle(el)
        if (cs.animationName && cs.animationName !== 'none' && parseFloat(cs.animationDuration) > 0.05) {
          running.push(`${el.tagName}.${String(el.className).slice(0, 40)} :: ${cs.animationName} ${cs.animationDuration}`)
        }
      })
      return running.slice(0, 40)
    })
    note('a11y.reducedMotion.runningAnimations', anim)
    note('a11y.reducedMotion.splashMs', Date.now() - t0)
    await pickByInput(page, 'from', 'Сокол')
    await pickByInput(page, 'to', 'Динамо')
    await page.waitForTimeout(1500)
    await shot(page, 'mobile-a11y-04-reduced-route')
    await context.close()
  }

  // Крупный системный шрифт
  {
    const { context, page } = await ctx('mobile')
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await ready(page)
    await page.addStyleTag({ content: 'html{font-size:22px !important}' })
    await page.waitForTimeout(600)
    await shot(page, 'mobile-a11y-05-bigfont')
    await pickByInput(page, 'from', 'Планерная')
    await pickByInput(page, 'to', 'Бунинская аллея')
    await page.waitForTimeout(2000)
    const chip = page.locator('.bottom-route-chip').first()
    if (await chip.count()) { await chip.click(); await page.waitForTimeout(1200) }
    await shot(page, 'mobile-a11y-06-bigfont-route')
    note('a11y.bigFont.overflow', await page.evaluate(() => {
      const bad = []
      document.querySelectorAll('.bottom-sheet *, .app-header *').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) return
        if (r.right - window.innerWidth > 3 || -r.left > 3) bad.push({ cls: String(el.className).slice(0, 50), over: Math.round(r.right - window.innerWidth) })
      })
      return bad.slice(0, 20)
    }))
    await context.close()
  }
}

// ============================================================================
async function scenarioTheme() {
  const { context, page } = await ctx('mobile')
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await ready(page)
  await pickByInput(page, 'from', 'Планерная')
  await pickByInput(page, 'to', 'Бунинская аллея')
  await page.waitForTimeout(1800)
  const chip = page.locator('.bottom-route-chip').first()
  if (await chip.count()) { await chip.click(); await page.waitForTimeout(1200) }

  const opts = await page.locator('.theme-toggle-option').all()
  note('theme.options', await page.evaluate(() => [...document.querySelectorAll('.theme-toggle-option')].map((b) => {
    const r = b.getBoundingClientRect()
    return { label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'), w: Math.round(r.w || r.width), h: Math.round(r.height) }
  })))
  const names = ['system', 'light', 'dark']
  for (let i = 0; i < opts.length; i += 1) {
    await opts[i].click()
    await page.waitForTimeout(700)
    await shot(page, `mobile-theme-${names[i] ?? i}`)
    note(`theme.applied.${names[i] ?? i}`, await page.evaluate(() => ({
      dataTheme: document.documentElement.getAttribute('data-theme'),
      themeColor: document.querySelector('meta[name=theme-color]')?.getAttribute('content'),
      stored: localStorage.getItem('kitty-metro-theme') ?? localStorage.getItem('kitty-metro-theme-preference'),
    })))
  }
  // тёмная + системная тёмная
  await context.close()
  {
    const { context, page } = await ctx('mobile', { extra: { colorScheme: 'dark' } })
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await ready(page)
    await shot(page, 'mobile-theme-system-dark')
    await pickByInput(page, 'from', 'Планерная')
    await pickByInput(page, 'to', 'Бунинская аллея')
    await page.waitForTimeout(1800)
    const c = page.locator('.bottom-route-chip').first()
    if (await c.count()) { await c.click(); await page.waitForTimeout(1200) }
    await shot(page, 'mobile-theme-system-dark-route')
    await context.close()
  }
}

// ============================================================================
const ALL = {
  firstrun: scenarioFirstRun,
  tapflow: scenarioTapFlow,
  taproute: scenarioTapRoute,
  result: scenarioResult,
  return: scenarioReturn,
  errors: scenarioErrors,
  a11y: scenarioA11y,
  theme: scenarioTheme,
}

async function main() {
  await fsp.mkdir(OUT_DIR, { recursive: true })
  const server = await startServer()
  browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'] })
  try {
    for (const [name, fn] of Object.entries(ALL)) {
      if (SCENARIOS[0] !== 'all' && !SCENARIOS.includes(name)) continue
      console.log(`\n=== ${name} ===`)
      try { await fn() } catch (e) { note(`FAILED.${name}`, String(e.message).slice(0, 500)); console.error(e) }
    }
  } finally {
    await browser.close()
    server.close()
    out.finishedAt = new Date().toISOString()
    await fsp.writeFile(path.join(OUT_DIR, `ux-report-${SCENARIOS.join('_')}.json`), JSON.stringify(out, null, 2), 'utf8')
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
