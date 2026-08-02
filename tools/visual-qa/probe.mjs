// Точечные проверки поверх основного прогона (shoot.mjs):
//  * скроллится ли шторка/панель с деталями маршрута;
//  * как рисуется «дальний переход» (out-of-station) в маршруте;
//  * крупный план пересадочного узла Библиотека им.Ленина / Боровицкая / Арбатская.
// Запуск: docker run --rm -v <dist>:/app/dist:ro -v <out>:/out metromap-visual-qa node probe.mjs
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { chromium, devices } from 'playwright'

const APP_DIR = process.env.QA_APP_DIR || '/app/dist'
const OUT_DIR = process.env.QA_OUT_DIR || '/out'
const PORT = Number(process.env.QA_PORT || 4174)
const BASE_URL = `http://127.0.0.1:${PORT}/`

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    let rel = decodeURIComponent(url.pathname)
    if (rel.endsWith('/')) rel += 'index.html'
    let filePath = path.join(APP_DIR, path.normalize(rel).replace(/^([/\\])+/, ''))
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      if (path.extname(filePath) === '') filePath = path.join(APP_DIR, 'index.html')
      else return void res.writeHead(404).end('not found')
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' })
    res.end(await fsp.readFile(filePath))
  })
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)))
}

const PROFILES = {
  mobile: {
    ...devices['iPhone 13'],
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'ru-RU',
  },
  desktop: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    locale: 'ru-RU',
  },
}

const INIT = `try{localStorage.setItem('kitty-metro-install-guide-seen','1');localStorage.setItem('kitty-metro-onboarding-hint-seen','1')}catch(e){}`

const out = { probes: [] }

async function open(browser, profileName) {
  const context = await browser.newContext(PROFILES[profileName])
  await context.addInitScript(INIT)
  const page = await context.newPage()
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.bottom-sheet', { timeout: 20000 })
  await page.waitForTimeout(1400)
  return { context, page }
}

async function pick(page, label, title) {
  const input = page.getByRole('combobox', { name: label })
  await input.click()
  await input.fill('')
  await input.pressSequentially(title.slice(0, Math.max(4, title.length - 3)), { delay: 40 })
  await page.getByRole('option', { name: title, exact: true }).first().click()
  await page.waitForTimeout(300)
}

async function buildRoute(page, from, to) {
  await pick(page, 'Станция отправления', from)
  await pick(page, 'Станция назначения', to)
  await page.waitForSelector('.route-result, .bottom-route-chip', { timeout: 20000 })
  await page.waitForTimeout(1600)
}

async function scrollMetrics(page) {
  return page.evaluate(() => {
    const sel = ['.bottom-sheet', '.bottom-sheet-inner', '.bottom-route-details', '.route-result', '.route-result-scroll']
    const res = {}
    for (const s of sel) {
      const el = document.querySelector(s)
      if (!el) { res[s] = null; continue }
      const st = getComputedStyle(el)
      res[s] = {
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
        scrollTopBefore: el.scrollTop,
        overflowY: st.overflowY,
        cssHeight: st.height,
        maxHeight: st.maxHeight,
      }
      el.scrollTop = 99999
      res[s].scrollTopAfter = el.scrollTop
      el.scrollTop = res[s].scrollTopBefore
    }
    res.viewportH = window.innerHeight
    res.lastStepBottom = (() => {
      const steps = document.querySelectorAll('.route-step')
      const last = steps[steps.length - 1]
      return last ? Math.round(last.getBoundingClientRect().bottom) : null
    })()
    res.stepsCount = document.querySelectorAll('.route-step').length
    return res
  })
}

async function main() {
  await fsp.mkdir(OUT_DIR, { recursive: true })
  const server = await startServer()
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })

  try {
    // --- A. Скроллятся ли детали маршрута
    for (const profile of ['mobile', 'desktop']) {
      const { context, page } = await open(browser, profile)
      await buildRoute(page, 'Планерная', 'Бунинская аллея')
      const chip = page.locator('.bottom-route-chip').first()
      if (await chip.count()) { await chip.click(); await page.waitForTimeout(1200) }

      const before = await scrollMetrics(page)
      out.probes.push({ probe: 'scroll', profile, metrics: before })

      // пробуем прокрутить каждый контейнер и посмотреть, изменилась ли картинка
      await page.evaluate(() => {
        for (const s of ['.route-result-scroll', '.bottom-route-details', '.bottom-sheet-inner', '.bottom-sheet']) {
          const el = document.querySelector(s)
          if (el) el.scrollTop = 99999
        }
      })
      await page.waitForTimeout(500)
      await page.screenshot({ path: path.join(OUT_DIR, `${profile}-13-details-scrolled.png`) })

      // колесом мыши по области деталей
      const target = page.locator('.route-result').first()
      const box = await target.boundingBox()
      if (box) {
        await page.mouse.move(box.x + box.width / 2, Math.min(box.y + 60, (await page.viewportSize()).height - 40))
        for (let i = 0; i < 8; i += 1) { await page.mouse.wheel(0, 200); await page.waitForTimeout(80) }
      }
      await page.waitForTimeout(500)
      await page.screenshot({ path: path.join(OUT_DIR, `${profile}-14-details-wheel.png`) })
      out.probes.push({ probe: 'scroll-after-wheel', profile, metrics: await scrollMetrics(page) })
      await context.close()
    }

    // --- B. Дальний переход (out-of-station) в маршруте
    for (const profile of ['mobile', 'desktop']) {
      const { context, page } = await open(browser, profile)
      await buildRoute(page, 'Октябрьское Поле', 'Панфиловская')
      await page.screenshot({ path: path.join(OUT_DIR, `${profile}-15-long-transfer.png`) })

      // зум в область маршрута: курсор в видимой части карты (верхняя треть)
      const canvas = page.locator('canvas.metro-map-svg')
      const cb = await canvas.boundingBox()
      if (cb) {
        const x = cb.x + cb.width / 2
        const y = cb.y + cb.height * 0.18
        await page.mouse.move(x, y)
        for (let i = 0; i < 5; i += 1) { await page.mouse.wheel(0, -240); await page.waitForTimeout(150) }
      }
      await page.waitForTimeout(900)
      await page.screenshot({ path: path.join(OUT_DIR, `${profile}-16-long-transfer-zoom.png`) })
      await context.close()
    }

    // --- C. Крупный план узла Библиотека им.Ленина / Боровицкая / Арбатская (desktop)
    {
      const { context, page } = await open(browser, 'desktop')
      const canvas = page.locator('canvas.metro-map-svg')
      const cb = await canvas.boundingBox()
      if (cb) {
        // координаты узла на стартовом виде 1440x900 (см. desktop-04-map-full.png)
        await page.mouse.move(cb.x + 610, cb.y + 390)
        for (let i = 0; i < 5; i += 1) { await page.mouse.wheel(0, -240); await page.waitForTimeout(150) }
      }
      await page.waitForTimeout(900)
      await page.screenshot({ path: path.join(OUT_DIR, 'desktop-17-hub-biblioteka.png') })
      await context.close()
    }
  } finally {
    await browser.close()
    server.close()
    await fsp.writeFile(path.join(OUT_DIR, 'probe.json'), JSON.stringify(out, null, 2), 'utf8')
    console.log(JSON.stringify(out, null, 2))
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
