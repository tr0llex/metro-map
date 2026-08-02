import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Connect, Plugin, ViteDevServer } from 'vite'

import {
  EDITOR_SAVE_ENDPOINT,
  editorApiPlugin,
  type EditorSaveResponse,
} from './editorApiPlugin.ts'

type Handler = (req: Connect.IncomingMessage, res: FakeResponse) => void

/**
 * Плагин живёт целиком в `configureServer`, поэтому проверяется он тем же
 * способом, каким его вызывает Vite: подсовываем поддельный сервер и
 * перехватываем обработчик, который плагин на него вешает.
 */
function mountHandler(root: string): { path: string; handler: Handler } {
  let mounted: { path: string; handler: Handler } | null = null
  const server = {
    middlewares: {
      use: (path: string, handler: Handler) => {
        mounted = { path, handler }
      },
    },
  } as unknown as ViteDevServer

  const plugin = editorApiPlugin(root) as Plugin
  const configureServer = plugin.configureServer as (s: ViteDevServer) => void
  configureServer(server)

  if (!mounted) throw new Error('плагин не повесил обработчик')
  return mounted
}

class FakeResponse {
  statusCode = 200
  headers: Record<string, string> = {}
  body = ''
  readonly finished: Promise<void>
  private resolve!: () => void

  constructor() {
    this.finished = new Promise((r) => {
      this.resolve = r
    })
  }

  setHeader(name: string, value: string) {
    this.headers[name] = value
  }

  end(chunk: string) {
    this.body = chunk
    this.resolve()
  }
}

/** Минимальный запрос: тело приходит потоком, как у настоящего http-сервера. */
function fakeRequest(method: string, chunks: string[] = []) {
  const req = new EventEmitter() as Connect.IncomingMessage & { emitBody: () => void }
  req.method = method
  req.emitBody = () => {
    for (const chunk of chunks) req.emit('data', chunk)
    req.emit('end')
  }
  return req
}

async function call(root: string, method: string, body?: unknown | string) {
  const { handler } = mountHandler(root)
  const raw = typeof body === 'string' ? body : body === undefined ? '' : JSON.stringify(body)
  const req = fakeRequest(method, raw ? [raw] : [''])
  const res = new FakeResponse()

  handler(req, res)
  req.emitBody()
  await res.finished

  return { res, json: JSON.parse(res.body) as EditorSaveResponse }
}

let root: string

const linePath = () => join(root, 'data', 'lines', '001-a.json')
const layoutPath = () => join(root, 'data', 'layout.json')
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'metro-editor-api-'))
  mkdirSync(join(root, 'data', 'lines'), { recursive: true })

  writeFileSync(
    linePath(),
    JSON.stringify(
      {
        id: 1,
        title: 'Первая',
        color: '#E42313',
        ring: false,
        stations: [
          { id: '1/a', title: 'А', toNextSeconds: 120 },
          { id: '1/b', title: 'Б' },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  writeFileSync(
    join(root, 'data', 'lines', '002-b.json'),
    JSON.stringify(
      {
        id: 2,
        title: 'Вторая',
        color: '#4F8242',
        ring: false,
        stations: [{ id: '2/a', title: 'Га' }],
      },
      null,
      2,
    ) + '\n',
  )
  writeFileSync(
    join(root, 'data', 'transfers.json'),
    JSON.stringify(
      {
        defaults: {
          rideSeconds: 150,
          hubMinSeconds: 240,
          kindSeconds: { near: 180, far: 300, mcc: 300, out_of_station: 480 },
        },
        transfers: [],
      },
      null,
      2,
    ) + '\n',
  )
  writeFileSync(
    layoutPath(),
    JSON.stringify(
      { stations: { '1/a': [0, 0], '1/b': [10, 0], '2/a': [0, 20] }, rings: {} },
      null,
      2,
    ) + '\n',
  )
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('точка сохранения', () => {
  it('висит на том адресе, который спрашивает панель сохранения', () => {
    expect(mountHandler(root).path).toBe(EDITOR_SAVE_ENDPOINT)
    expect(EDITOR_SAVE_ENDPOINT).toBe('/__editor/save')
  })

  /**
   * Запись правок — не то, что должно случаться по переходу по ссылке или
   * префетчу браузера. Всё, кроме POST, отбивается до чтения тела.
   */
  it.each(['GET', 'PUT', 'DELETE'])('на %s отвечает 405 и ничего не пишет', async (method) => {
    const before = readFileSync(linePath(), 'utf8')
    const { res, json } = await call(root, method, { stations: { '1/a': { title: 'Ы' } } })

    expect(res.statusCode).toBe(405)
    expect(json.ok).toBe(false)
    expect(json.error).toContain('POST')
    expect(readFileSync(linePath(), 'utf8')).toBe(before)
  })

  it('отвечает JSON в utf-8 — иначе кириллица в ошибках нечитаема', async () => {
    const { res } = await call(root, 'GET')
    expect(res.headers['Content-Type']).toContain('charset=utf-8')
  })

  /**
   * Полная раскладка — это ~25 КБ. Без потолка в эндпоинт можно залить что
   * угодно и съесть память dev-сервера.
   */
  it('тело больше мегабайта отвергается', async () => {
    const huge = 'x'.repeat(1_000_001)
    const { res, json } = await call(root, 'POST', huge)

    expect(res.statusCode).toBe(400)
    expect(json.ok).toBe(false)
    expect(json.error).toContain('слишком большой')
  })

  it('тело в пределах лимита читается целиком, даже если пришло кусками', async () => {
    const { handler } = mountHandler(root)
    const patch = JSON.stringify({ stations: { '1/a': { title: 'Разрезанная' } } })
    const req = fakeRequest('POST', [patch.slice(0, 10), patch.slice(10)])
    const res = new FakeResponse()

    handler(req, res)
    req.emitBody()
    await res.finished

    expect(res.statusCode).toBe(200)
    expect(readJson(linePath()).stations[0].title).toBe('Разрезанная')
  })

  it('битый JSON — это 400, а не падение сервера', async () => {
    const { res, json } = await call(root, 'POST', '{не json')
    expect(res.statusCode).toBe(400)
    expect(json.ok).toBe(false)
  })
})

describe('запись в data/', () => {
  /**
   * Солвера в тестовом корне нет — каталога go-layout-solver не существует.
   * Это ровно тот случай, когда на машине нет Go: правки обязаны остаться на
   * диске, а неудача солвера — быть названной вслух, а не проглоченной.
   */
  it('без солвера правки всё равно записаны, и об этом сказано', async () => {
    const { res, json } = await call(root, 'POST', {
      stations: { '1/a': { title: 'Новая А' } },
    })

    expect(res.statusCode).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.solver.ok).toBe(false)
    expect(json.solver.message).toContain('солвер не отработал')
    expect(json.changedFiles).toEqual(['data/lines/001-a.json'])
    expect(readJson(linePath()).stations[0].title).toBe('Новая А')
  })

  it('формат файла сохраняется: два пробела и перевод строки в конце', async () => {
    await call(root, 'POST', { stations: { '1/a': { title: 'Новая А' } } })
    const text = readFileSync(linePath(), 'utf8')

    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "id": 1')
  })

  it('пустой патч не трогает файлы и не запускает солвер', async () => {
    const before = readFileSync(linePath(), 'utf8')
    const { json } = await call(root, 'POST', {})

    expect(json.ok).toBe(true)
    expect(json.changedFiles).toEqual([])
    expect(json.solver.message).toContain('не запускался')
    expect(readFileSync(linePath(), 'utf8')).toBe(before)
  })

  /**
   * ГЛАВНОЕ СВОЙСТВО. Патч накладывается целиком в памяти и только потом
   * пишется на диск. Иначе отказ на середине оставил бы `data/`
   * полуприменённым — часть файлов новая, часть старая, и понять, что именно
   * уехало, было бы уже нечем.
   */
  it('патч с ошибкой не оставляет полуприменённых файлов', async () => {
    const lineBefore = readFileSync(linePath(), 'utf8')
    const layoutBefore = readFileSync(layoutPath(), 'utf8')

    const { res, json } = await call(root, 'POST', {
      // Первая часть валидна и одна бы записалась…
      stations: { '1/a': { title: 'Новая А' } },
      // …а эта останавливает применение целиком.
      rides: { 'нет>такого': 100 },
    })

    expect(res.statusCode).toBe(400)
    expect(json.ok).toBe(false)
    expect(json.error).toContain('нет ни на одной линии')
    expect(readFileSync(linePath(), 'utf8')).toBe(lineBefore)
    expect(readFileSync(layoutPath(), 'utf8')).toBe(layoutBefore)
  })

  it('неполная раскладка отвергается целиком', async () => {
    const layoutBefore = readFileSync(layoutPath(), 'utf8')
    const { res, json } = await call(root, 'POST', { layout: { '1/a': [5, 5] } })

    expect(res.statusCode).toBe(400)
    expect(json.error).toContain('нет координат')
    expect(readFileSync(layoutPath(), 'utf8')).toBe(layoutBefore)
  })

  it('пересадка между линиями попадает в transfers.json', async () => {
    const { json } = await call(root, 'POST', {
      transfers: { upsert: [{ stations: ['1/a', '2/a'], kind: 'far', seconds: 400 }] },
    })

    expect(json.changedFiles).toEqual(['data/transfers.json'])
    const written = readJson(join(root, 'data', 'transfers.json'))
    expect(written.transfers).toEqual([{ stations: ['1/a', '2/a'], kind: 'far', seconds: 400 }])
  })

  /** Имя файла линии берётся из файловой системы, а не из запроса. */
  it('трогает только те файлы линий, которые реально изменились', async () => {
    const otherBefore = readFileSync(join(root, 'data', 'lines', '002-b.json'), 'utf8')
    const { json } = await call(root, 'POST', { rides: { '1/a>1/b': 130 } })

    expect(json.changedFiles).toEqual(['data/lines/001-a.json'])
    expect(readFileSync(join(root, 'data', 'lines', '002-b.json'), 'utf8')).toBe(otherBefore)
    expect(readJson(linePath()).stations[0].toNextSeconds).toBe(130)
  })
})
