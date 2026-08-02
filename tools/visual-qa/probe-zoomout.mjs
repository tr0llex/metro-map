// Проверка: показывает ли стартовый вид схему целиком и можно ли отдалить её до целой схемы.
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { chromium, devices } from 'playwright'

const APP_DIR = process.env.QA_APP_DIR || '/app/dist'
const OUT_DIR = process.env.QA_OUT_DIR || '/out'
const PORT = Number(process.env.QA_PORT || 4176)
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

const PROFILES = {
  mobile: { ...devices['iPhone 13'], viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'ru-RU' },
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'ru-RU' },
}

async function main() {
  await fsp.mkdir(OUT_DIR, { recursive: true })
  const server = await startServer()
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  try {
    for (const name of ['mobile', 'desktop']) {
      const context = await browser.newContext(PROFILES[name])
      await context.addInitScript(`try{localStorage.setItem('metro-map-install-guide-seen','1');localStorage.setItem('metro-map-onboarding-hint-seen','1')}catch(e){}`)
      const page = await context.newPage()
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.bottom-sheet', { timeout: 20000 })
      await page.waitForTimeout(1600)

      const zoomOut = page.getByRole('button', { name: 'Отдалить карту' })
      for (let i = 0; i < 8; i += 1) {
        await zoomOut.click()
        await page.waitForTimeout(220)
      }
      await page.waitForTimeout(1200)
      await page.screenshot({ path: path.join(OUT_DIR, `${name}-20-zoomed-out.png`) })
      await context.close()
    }
  } finally {
    await browser.close()
    server.close()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
