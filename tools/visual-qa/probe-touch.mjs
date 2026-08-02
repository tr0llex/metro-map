// Проверка тач-жеста: можно ли на мобильном доскроллить детали маршрута пальцем.
// Свайп эмулируется через CDP Input.dispatchTouchEvent — это настоящие touch-события,
// а не page.mouse.wheel (мышиное колесо на телефоне недоступно).
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { chromium, devices } from 'playwright'

const APP_DIR = process.env.QA_APP_DIR || '/app/dist'
const OUT_DIR = process.env.QA_OUT_DIR || '/out'
const PORT = Number(process.env.QA_PORT || 4175)
const BASE_URL = `http://127.0.0.1:${PORT}/`

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }

function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    let rel = decodeURIComponent(url.pathname)
    if (rel.endsWith('/')) rel += 'index.html'
    let f = path.join(APP_DIR, path.normalize(rel).replace(/^([/\\])+/, ''))
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      if (path.extname(f) === '') f = path.join(APP_DIR, 'index.html')
      else return void res.writeHead(404).end('not found')
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' })
    res.end(await fsp.readFile(f))
  })
  return new Promise((r) => server.listen(PORT, '127.0.0.1', () => r(server)))
}

async function touchDrag(cdp, x, fromY, toY, steps = 24) {
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y: fromY, id: 1 }],
  })
  for (let i = 1; i <= steps; i += 1) {
    const y = fromY + ((toY - fromY) * i) / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y, id: 1 }] })
    await new Promise((r) => setTimeout(r, 16))
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

async function main() {
  await fsp.mkdir(OUT_DIR, { recursive: true })
  const server = await startServer()
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  const result = {}

  try {
    const context = await browser.newContext({
      ...devices['iPhone 13'],
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'ru-RU',
    })
    await context.addInitScript(
      `try{localStorage.setItem('metro-map-install-guide-seen','1');localStorage.setItem('metro-map-onboarding-hint-seen','1')}catch(e){}`,
    )
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.bottom-sheet', { timeout: 20000 })
    await page.waitForTimeout(1400)

    const pick = async (label, title) => {
      const input = page.getByRole('combobox', { name: label })
      await input.click()
      await input.fill('')
      await input.pressSequentially(title.slice(0, Math.max(4, title.length - 3)), { delay: 40 })
      await page.getByRole('option', { name: title, exact: true }).first().click()
      await page.waitForTimeout(300)
    }
    await pick('Станция отправления', 'Планерная')
    await pick('Станция назначения', 'Бунинская аллея')
    await page.waitForSelector('.bottom-route-chip', { timeout: 20000 })
    await page.waitForTimeout(1500)
    await page.locator('.bottom-route-chip').first().click()
    await page.waitForTimeout(1400)

    const snap = () =>
      page.evaluate(() => {
        const sheet = document.querySelector('.bottom-sheet')
        const steps = document.querySelectorAll('.route-step')
        const last = steps[steps.length - 1]
        return {
          sheetScrollTop: sheet ? Math.round(sheet.scrollTop) : null,
          firstStepTop: steps[0] ? Math.round(steps[0].getBoundingClientRect().top) : null,
          lastStepBottom: last ? Math.round(last.getBoundingClientRect().bottom) : null,
          viewportH: window.innerHeight,
        }
      })

    result.before = await snap()
    await page.screenshot({ path: path.join(OUT_DIR, 'mobile-18-touch-before.png') })

    // Свайп вверх внутри области деталей маршрута (пытаемся доскроллить до конца)
    for (let i = 0; i < 4; i += 1) {
      await touchDrag(cdp, 195, 700, 260)
      await page.waitForTimeout(450)
    }
    result.afterSwipeUp = await snap()
    await page.screenshot({ path: path.join(OUT_DIR, 'mobile-19-touch-after-swipe.png') })

    await context.close()
  } finally {
    await browser.close()
    server.close()
    await fsp.writeFile(path.join(OUT_DIR, 'probe-touch.json'), JSON.stringify(result, null, 2), 'utf8')
    console.log(JSON.stringify(result, null, 2))
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
