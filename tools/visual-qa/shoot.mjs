// Визуальная приёмка: поднимает статик-сервер над собранным dist и снимает
// скриншоты настоящим Chromium. Запускается внутри контейнера (см. Dockerfile),
// но работает и локально: QA_APP_DIR / QA_OUT_DIR можно переопределить.
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { chromium, devices } from 'playwright'

const APP_DIR = process.env.QA_APP_DIR || '/app/dist'
const OUT_DIR = process.env.QA_OUT_DIR || '/out'
const PORT = Number(process.env.QA_PORT || 4173)
const ONLY = (process.env.QA_ONLY || '').trim() // фильтр по имени профиля: mobile | desktop

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      let rel = decodeURIComponent(url.pathname)
      if (rel.endsWith('/')) rel += 'index.html'
      let filePath = path.join(APP_DIR, path.normalize(rel).replace(/^([/\\])+/, ''))

      if (!filePath.startsWith(APP_DIR)) {
        res.writeHead(403).end('forbidden')
        return
      }

      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        // SPA-фолбэк только для «страничных» запросов, чтобы не маскировать 404 ассетов.
        if (path.extname(filePath) === '') {
          filePath = path.join(APP_DIR, 'index.html')
        } else {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
          return
        }
      }

      const body = await fsp.readFile(filePath)
      res.writeHead(200, {
        'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
        'cache-control': 'no-store',
      })
      res.end(body)
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(err))
    }
  })

  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(PORT, '127.0.0.1', () => resolve(server))
  })
}

const BASE_URL = `http://127.0.0.1:${PORT}/`

// --- сценарий маршрута ------------------------------------------------------
// Станции взяты из normalized/fullGraph.json. Планерная (7) -> Бунинская аллея (12)
// — длинный маршрут через несколько пересадок, проходит через плотный центр.
const ROUTE_FROM = 'Планерная'
const ROUTE_TO = 'Бунинская аллея'

const PROFILES = [
  {
    name: 'mobile',
    contextOptions: {
      ...devices['iPhone 13'],
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
    },
  },
  {
    name: 'desktop',
    contextOptions: {
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    },
  },
]

const report = {
  startedAt: new Date().toISOString(),
  appDir: APP_DIR,
  baseUrl: BASE_URL,
  route: { from: ROUTE_FROM, to: ROUTE_TO },
  shots: [],
  console: [],
  pageErrors: [],
  network: [],
  notes: [],
}

function attachDiagnostics(page, profile, scenarioRef) {
  page.on('console', (msg) => {
    const type = msg.type()
    if (type !== 'error' && type !== 'warning') return
    report.console.push({
      profile,
      scenario: scenarioRef.current,
      type,
      text: msg.text().slice(0, 800),
      location: msg.location(),
    })
  })
  page.on('pageerror', (err) => {
    report.pageErrors.push({
      profile,
      scenario: scenarioRef.current,
      message: String(err && err.message ? err.message : err).slice(0, 800),
      stack: String((err && err.stack) || '').slice(0, 1200),
    })
  })
  page.on('requestfailed', (req) => {
    report.network.push({
      profile,
      scenario: scenarioRef.current,
      kind: 'requestfailed',
      url: req.url(),
      failure: req.failure()?.errorText,
    })
  })
  page.on('response', (res) => {
    if (res.status() >= 400) {
      report.network.push({
        profile,
        scenario: scenarioRef.current,
        kind: 'http',
        status: res.status(),
        url: res.url(),
      })
    }
  })
}

async function shoot(page, profile, name, options = {}) {
  const file = `${profile}-${name}.png`
  await page.screenshot({ path: path.join(OUT_DIR, file), ...options })
  report.shots.push({ profile, name, file })
  console.log(`  [shot] ${file}`)
  return file
}

const SEEN_KEYS_INIT = `
try {
  localStorage.setItem('kitty-metro-install-guide-seen', '1');
  localStorage.setItem('kitty-metro-onboarding-hint-seen', '1');
} catch (e) {}
`

async function newPage(browser, profileCfg, { cleanStorage = false } = {}) {
  const context = await browser.newContext(profileCfg.contextOptions)
  if (!cleanStorage) {
    await context.addInitScript(SEEN_KEYS_INIT)
  }
  const page = await context.newPage()
  const scenarioRef = { current: 'init' }
  attachDiagnostics(page, profileCfg.name, scenarioRef)
  return { context, page, scenarioRef }
}

async function waitUiReady(page) {
  // Заставка живёт минимум 1200 мс, основной UI монтируется после неё.
  await page.waitForSelector('.bottom-sheet', { timeout: 20000 })
  await page.waitForTimeout(1200) // добираем анимации карты и раскладку подписей
}

async function pickStation(page, ariaLabel, title) {
  const input = page.getByRole('combobox', { name: ariaLabel })
  await input.click()
  await input.fill('')
  await input.pressSequentially(title.slice(0, Math.max(4, title.length - 3)), { delay: 40 })
  const option = page.getByRole('option', { name: title, exact: true }).first()
  await option.waitFor({ timeout: 10000 })
  await option.click()
  await page.waitForTimeout(300)
}

async function buildRoute(page) {
  await pickStation(page, 'Станция отправления', ROUTE_FROM)
  await pickStation(page, 'Станция назначения', ROUTE_TO)
  await page.waitForSelector('.route-result, .bottom-route-chip', { timeout: 20000 })
  await page.waitForTimeout(1600) // авто-подгонка вьюпорта под маршрут + анимации
}

async function zoomAtCanvasCenter(page, steps, dx = 0, dy = 0) {
  const canvas = page.locator('canvas.metro-map-svg')
  const box = await canvas.boundingBox()
  if (!box) return
  const x = box.x + box.width / 2 + dx
  const y = box.y + box.height / 2 + dy
  await page.mouse.move(x, y)
  for (let i = 0; i < steps; i += 1) {
    await page.mouse.wheel(0, -240)
    await page.waitForTimeout(160)
  }
  await page.waitForTimeout(900)
}

async function runProfile(browser, profileCfg) {
  const p = profileCfg.name
  console.log(`\n=== профиль ${p} ===`)

  // --- 1. Чистый localStorage: заставка -> install guide -> подсказка онбординга
  {
    const { context, page, scenarioRef } = await newPage(browser, profileCfg, { cleanStorage: true })
    scenarioRef.current = 'clean-storage'
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(450)
    await shoot(page, p, '01-splash')

    await waitUiReady(page)
    await page.waitForTimeout(900)

    const guide = page.locator('.install-guide-card')
    if (await guide.count()) {
      await shoot(page, p, '02-install-guide')
      const closeBtn = page.locator('.install-guide-close-button').first()
      await closeBtn.click()
      await page.waitForTimeout(600)
    } else {
      report.notes.push(`${p}: карточка установки PWA не показалась на чистом localStorage`)
    }

    const hint = page.locator('.onboarding-hint')
    if (await hint.count()) {
      await shoot(page, p, '03-onboarding-hint')
    } else {
      report.notes.push(`${p}: подсказка онбординга не показалась на чистом localStorage`)
      await shoot(page, p, '03-onboarding-hint-MISSING')
    }
    await context.close()
  }

  // --- 2. Схема целиком + зум в плотный центр
  {
    const { context, page, scenarioRef } = await newPage(browser, profileCfg)
    scenarioRef.current = 'map'
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await waitUiReady(page)
    await page.waitForTimeout(700)
    await shoot(page, p, '04-map-full')

    scenarioRef.current = 'map-zoom'
    await zoomAtCanvasCenter(page, 4)
    await shoot(page, p, '05-map-zoom-center')
    await zoomAtCanvasCenter(page, 3)
    await shoot(page, p, '06-map-zoom-center-deep')
    await context.close()
  }

  // --- 3. Маршрут, альтернативы, шторка с деталями
  {
    const { context, page, scenarioRef } = await newPage(browser, profileCfg)
    scenarioRef.current = 'route'
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await waitUiReady(page)

    scenarioRef.current = 'route-typing'
    const input = page.getByRole('combobox', { name: 'Станция отправления' })
    await input.click()
    await input.pressSequentially(ROUTE_FROM.slice(0, 5), { delay: 60 })
    await page.waitForSelector('[role="option"]', { timeout: 10000 })
    await page.waitForTimeout(250)
    await shoot(page, p, '07-suggestions')

    scenarioRef.current = 'route-build'
    const option = page.getByRole('option', { name: ROUTE_FROM, exact: true }).first()
    await option.click()
    await page.waitForTimeout(300)
    await pickStation(page, 'Станция назначения', ROUTE_TO)
    await page.waitForSelector('.route-result, .bottom-route-chip', { timeout: 20000 })
    await page.waitForTimeout(1800)
    await shoot(page, p, '08-route-built')

    // Альтернативы с цветными пилюлями линий
    const chips = page.locator('.bottom-route-chip')
    const chipCount = await chips.count()
    report.notes.push(`${p}: вариантов маршрута — ${chipCount}`)
    if (chipCount > 0) {
      const wrapper = page.locator('.bottom-route-summary-wrapper, .route-choices-desktop').first()
      if (await wrapper.count()) {
        const b = await wrapper.boundingBox()
        const vp = page.viewportSize()
        let clip
        if (b && vp) {
          const pad = 12
          const x = Math.max(0, b.x - pad)
          const y = Math.max(0, b.y - pad)
          clip = {
            x,
            y,
            width: Math.max(1, Math.min(vp.width - x, b.width + pad * 2)),
            height: Math.max(1, Math.min(vp.height - y, b.height + pad * 2)),
          }
        }
        await shoot(page, p, '09-route-alternatives', clip ? { clip } : {})
      }
    }

    // Раскрытая шторка с деталями
    scenarioRef.current = 'route-sheet'
    if (chipCount > 0) {
      await chips.first().click()
      await page.waitForTimeout(1200)
    }
    const steps = await page.locator('.route-step').count()
    report.notes.push(`${p}: шагов маршрута в деталях — ${steps}`)
    await shoot(page, p, '10-route-details')

    // Зум в маршрут — видно ли его поверх остальных линий и пересадки
    scenarioRef.current = 'route-zoom'
    await zoomAtCanvasCenter(page, 3)
    await shoot(page, p, '11-route-zoom')

    // Прокрутка деталей до конца — проверяем длинные названия и вёрстку карточек
    scenarioRef.current = 'route-details-scroll'
    const scroll = page.locator('.route-result-scroll').first()
    if (await scroll.count()) {
      await scroll.evaluate((el) => {
        el.scrollTop = el.scrollHeight
      })
      await page.waitForTimeout(500)
      await shoot(page, p, '12-route-details-bottom')
    }

    // Измерения вёрстки: что вылезает за пределы вьюпорта
    const overflow = await page.evaluate(() => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const bad = []
      document.querySelectorAll('body *').forEach((el) => {
        const st = getComputedStyle(el)
        if (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0') return
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) return
        const overRight = r.right - vw
        const overLeft = -r.left
        const overBottom = r.bottom - vh
        if (overRight > 2 || overLeft > 2 || overBottom > 2) {
          bad.push({
            cls: el.className && String(el.className).slice(0, 80),
            tag: el.tagName,
            rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
            overRight: Math.round(overRight),
            overLeft: Math.round(overLeft),
            overBottom: Math.round(overBottom),
          })
        }
      })
      return { vw, vh, bad: bad.slice(0, 40) }
    })
    report.notes.push({ profile: p, overflowCheck: overflow })

    await context.close()
  }
}

async function main() {
  await fsp.mkdir(OUT_DIR, { recursive: true })
  const server = await startServer()
  console.log(`static server: ${BASE_URL} (root ${APP_DIR})`)

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb'],
  })

  try {
    for (const profile of PROFILES) {
      if (ONLY && profile.name !== ONLY) continue
      await runProfile(browser, profile)
    }
  } finally {
    await browser.close()
    server.close()
    report.finishedAt = new Date().toISOString()
    await fsp.writeFile(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
    console.log(`\nreport: ${path.join(OUT_DIR, 'report.json')}`)
    console.log(`shots: ${report.shots.length}, pageErrors: ${report.pageErrors.length}, console: ${report.console.length}, network: ${report.network.length}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
