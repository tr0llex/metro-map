import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RouteResult } from './metro/types'
import { encodeRoutingGraph } from './metro/routingGraphPayload'
import { fullGraphEdges, fullGraphStations } from './metro/fullGraph'

/**
 * routeWorker.ts исполняется в контексте DedicatedWorker и вешает обработчик на
 * `self.onmessage`. Настоящий Worker в vitest поднимать неоправданно дорого,
 * поэтому подменяем глобальный `self` заглушкой и импортируем модуль заново —
 * это проверяет ровно то, что важно: протокол сообщений и обработку ошибок.
 *
 * Граф воркер больше не импортирует статически (иначе те же данные попадали бы
 * в сборку дважды), а грузит отдельным ассетом, поэтому здесь подменяется ещё и
 * `fetch`: он отдаёт РЕАЛЬНЫЙ граф из normalized/fullGraph.json в том же
 * компактном формате, который эмитит плагин сборки. Ответы стали асинхронными
 * (ждут загрузки графа), поэтому после отправки сообщения ждём слив очередей.
 */

type PostedMessage =
  | { type: 'routeResult'; requestId: number; routes: RouteResult[] }
  | { type: 'routeError'; requestId: number; errorMessage: string }

type WorkerStub = {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage: (msg: PostedMessage) => void
}

let stub: WorkerStub
let posted: PostedMessage[]
let fetchedUrls: string[]

const payload = encodeRoutingGraph({ stations: fullGraphStations, edges: fullGraphEdges })

/** Ответ fetch с настоящим графом. */
function okGraphResponse() {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(JSON.parse(JSON.stringify(payload))),
  })
}

/** Ждём, пока отработают все микрозадачи (загрузка графа) и очередь макрозадач. */
async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function installStub() {
  posted = []
  stub = {
    onmessage: null,
    postMessage: (msg) => {
      posted.push(msg)
    },
  }
  ;(globalThis as unknown as { self: WorkerStub }).self = stub
}

async function loadWorker(fetchImpl: (url: string) => Promise<unknown> = okGraphResponse) {
  fetchedUrls = []
  installStub()
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      fetchedUrls.push(String(url))
      return fetchImpl(String(url))
    }),
  )

  vi.resetModules()
  await import('./routeWorker')
  await settle()
  return stub
}

/** Отправляет сообщение воркеру так же, как это делает основной поток. */
async function send(data: unknown) {
  expect(stub.onmessage, 'воркер не установил onmessage').toBeTypeOf('function')
  stub.onmessage!({ data })
  await settle()
}

beforeEach(async () => {
  await loadWorker()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as unknown as { self?: unknown }).self
})

describe('routeWorker — загрузка графа', () => {
  it('запрашивает граф сразу при загрузке модуля, до первого запроса маршрута', () => {
    // Ключевое требование: fetch стартует на этапе загрузки воркера, иначе первый
    // маршрут ждал бы ещё и сеть.
    expect(fetchedUrls.length).toBe(1)
    expect(fetchedUrls[0]).toContain('kitty-metro-routing-graph.json')
    expect(posted).toEqual([])
  })

  it('не перезапрашивает граф на каждый запрос маршрута', async () => {
    await send({ type: 'route', requestId: 1, fromId: '6/medvedkovo', toId: '1/salarevo' })
    await send({ type: 'route', requestId: 2, fromId: '6/medvedkovo', toId: '1/salarevo' })
    expect(fetchedUrls.length).toBe(1)
  })

  it('отвечает на запросы, пришедшие ДО завершения загрузки графа', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    await loadWorker(async () => {
      await gate
      return {
        ok: true,
        status: 200,
        json: () => Promise.resolve(JSON.parse(JSON.stringify(payload))),
      }
    })

    stub.onmessage!({
      data: { type: 'route', requestId: 11, fromId: '6/medvedkovo', toId: '1/salarevo' },
    })
    await settle()
    expect(posted, 'ответ не должен уходить до готовности графа').toEqual([])

    release!()
    await settle()

    expect(posted.length).toBe(1)
    expect(posted[0].type).toBe('routeResult')
    expect(posted[0].requestId).toBe(11)
  })

  it('если граф не загрузился, отвечает routeError с тем же requestId', async () => {
    await loadWorker(() => Promise.resolve({ ok: false, status: 404 }))

    await send({ type: 'route', requestId: 3, fromId: '6/medvedkovo', toId: '1/salarevo' })

    expect(posted.length).toBe(1)
    const response = posted[0]
    expect(response.type).toBe('routeError')
    expect(response.requestId).toBe(3)
    if (response.type !== 'routeError') return
    expect(response.errorMessage).toContain('404')
  })

  it('после провала загрузки СЛЕДУЮЩИЙ запрос пробует скачать граф заново', async () => {
    // Раньше отклонённый промис жил до конца жизни воркера: кнопка «Попробовать
    // ещё раз» слала запрос в тот же воркер и получала ту же ошибку навсегда.
    let attempt = 0
    await loadWorker(() => {
      attempt += 1
      // 1 — попытка на загрузке модуля, 2 — первый запрос маршрута, 3 — повтор.
      if (attempt <= 2) return Promise.reject(new Error('сеть моргнула'))
      return okGraphResponse()
    })

    await send({ type: 'route', requestId: 1, fromId: '6/medvedkovo', toId: '1/salarevo' })
    expect(posted[0].type).toBe('routeError')

    await send({ type: 'route', requestId: 2, fromId: '6/medvedkovo', toId: '1/salarevo' })
    expect(posted[1].type).toBe('routeResult')
    expect(posted[1].requestId).toBe(2)
    expect(fetchedUrls.length).toBe(3)
  })

  it('после успешной загрузки повторных попыток не делает', async () => {
    await send({ type: 'route', requestId: 1, fromId: '6/medvedkovo', toId: '1/salarevo' })
    await send({ type: 'route', requestId: 2, fromId: '6/medvedkovo', toId: '1/salarevo' })
    await send({ type: 'route', requestId: 3, fromId: '6/medvedkovo', toId: '1/salarevo' })
    expect(fetchedUrls.length).toBe(1)
    expect(posted.every((m) => m.type === 'routeResult')).toBe(true)
  })

  it('HTML вместо JSON (SPA-фолбэк) даёт понятную ошибку, а не «Unexpected token»', async () => {
    await loadWorker(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === 'content-type' ? 'text/html' : null) },
        json: () => Promise.reject(new SyntaxError("Unexpected token '<'")),
      }),
    )

    await send({ type: 'route', requestId: 4, fromId: '6/medvedkovo', toId: '1/salarevo' })

    const response = posted[0]
    expect(response.type).toBe('routeError')
    if (response.type !== 'routeError') return
    expect(response.errorMessage).toContain('text/html')
  })
})

describe('routeWorker — протокол сообщений', () => {
  it('регистрирует обработчик onmessage при загрузке', () => {
    expect(stub.onmessage).toBeTypeOf('function')
  })

  it('на запрос type=route отвечает routeResult с тем же requestId', async () => {
    await send({ type: 'route', requestId: 42, fromId: '6/medvedkovo', toId: '1/salarevo' })

    expect(posted.length).toBe(1)
    const response = posted[0]
    expect(response.type).toBe('routeResult')
    expect(response.requestId).toBe(42)
    if (response.type !== 'routeResult') return
    expect(response.routes.length).toBeGreaterThan(1)
    expect(response.routes[0].steps.length).toBeGreaterThan(0)
    expect(response.routes[0].totalMinutes).toBeGreaterThan(0)
  })

  it('сохраняет соответствие requestId при нескольких запросах подряд', async () => {
    // Оба сообщения отправляем ДО ожидания: проверяем, что асинхронная выдача
    // не переставляет ответы местами.
    stub.onmessage!({
      data: { type: 'route', requestId: 1, fromId: '6/medvedkovo', toId: '1/salarevo' },
    })
    stub.onmessage!({
      data: { type: 'route', requestId: 2, fromId: '2/khovrino', toId: '1/yugo-zapadnaya' },
    })
    await settle()

    expect(posted.map((m) => m.requestId)).toEqual([1, 2])
    expect(posted.every((m) => m.type === 'routeResult')).toBe(true)
  })

  it('передаёт maxAlternatives в поиск маршрутов', async () => {
    await send({
      type: 'route',
      requestId: 7,
      fromId: '6/medvedkovo',
      toId: '1/salarevo',
      maxAlternatives: 3,
    })

    const response = posted[0]
    expect(response.type).toBe('routeResult')
    if (response.type !== 'routeResult') return
    expect(response.routes.length).toBeLessThanOrEqual(3)
  })

  it('передаёт edgeOverrides: отключённое ребро меняет ответ', async () => {
    await send({ type: 'route', requestId: 1, fromId: '1/komsomolskaya', toId: '1/salarevo' })
    const base = posted[0]
    if (base.type !== 'routeResult') throw new Error('ожидался routeResult')
    const midStep = base.routes[0].steps[Math.floor(base.routes[0].steps.length / 2)]
    const key = [midStep.fromStationId, midStep.toStationId].sort().join('|')

    await send({
      type: 'route',
      requestId: 2,
      fromId: '1/komsomolskaya',
      toId: '1/salarevo',
      edgeOverrides: { [key]: { disabled: true } },
    })

    const withOverride = posted[1]
    if (withOverride.type !== 'routeResult') throw new Error('ожидался routeResult')
    expect(withOverride.routes[0].totalMinutes).toBeGreaterThan(base.routes[0].totalMinutes)
  })

  it('передаёт extraEdges: добавленный перегон используется', async () => {
    await send({
      type: 'route',
      requestId: 5,
      fromId: '1/komsomolskaya',
      toId: '1/salarevo',
      extraEdges: [
        { fromStationId: '1/komsomolskaya', toStationId: '1/salarevo', medianTravelSeconds: 60 },
      ],
    })

    const response = posted[0]
    if (response.type !== 'routeResult') throw new Error('ожидался routeResult')
    expect(response.routes[0].steps.length).toBe(1)
    expect(response.routes[0].totalMinutes).toBe(1)
  })

  it('на несуществующие станции отвечает routeResult с пустым списком, а не ошибкой', async () => {
    await send({ type: 'route', requestId: 9, fromId: 'no-such', toId: '1/salarevo' })

    const response = posted[0]
    expect(response.type).toBe('routeResult')
    if (response.type !== 'routeResult') return
    expect(response.routes).toEqual([])
  })

  it('игнорирует сообщения чужого типа и пустые сообщения', async () => {
    await send({ type: 'somethingElse', requestId: 1 })
    await send(null)
    await send(undefined)
    expect(posted).toEqual([])
  })

  it('на ошибку внутри поиска отвечает routeError с тем же requestId', async () => {
    // Ломаем поиск маршрутов, чтобы проверить ветку catch протокола.
    vi.resetModules()
    vi.doMock('./metro/routing', () => ({
      setRoutingGraph: () => {},
      findRouteAlternativesFullGraph: () => {
        throw new Error('boom')
      },
    }))

    installStub()
    await import('./routeWorker')
    await settle()

    await send({ type: 'route', requestId: 77, fromId: 'a', toId: 'b' })

    expect(posted.length).toBe(1)
    const response = posted[0]
    expect(response.type).toBe('routeError')
    expect(response.requestId).toBe(77)
    if (response.type !== 'routeError') return
    expect(response.errorMessage).toBe('boom')

    vi.doUnmock('./metro/routing')
    vi.resetModules()
  })
})
