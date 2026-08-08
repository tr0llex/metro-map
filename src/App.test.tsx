// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RouteResult } from './metro/types.ts'

/**
 * Карта — это канвас на 4500 строк, и в тестах App она нужна только как
 * источник трёх событий: готовность viewport, тап по станции и жест.
 * Настоящая карта проверяется в MetroMap.test.tsx.
 */
const mapProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))

vi.mock('./components/MetroMap.tsx', () => ({
  MetroMap: (props: Record<string, unknown>) => {
    mapProps.current = props
    return <div data-testid="metro-map" />
  },
}))

/**
 * Модуль регистрации service worker виртуальный: его подставляет
 * vite-plugin-pwa при сборке, и в раннере его нет. Сам PWA-путь проверяется
 * в usePwaUpdate.test.ts.
 */
const pwa = vi.hoisted(() => ({
  needRefresh: false,
  updateServiceWorker: vi.fn(),
  setNeedRefresh: vi.fn(),
}))

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    needRefresh: [pwa.needRefresh, pwa.setNeedRefresh],
    offlineReady: [false, vi.fn()],
    updateServiceWorker: pwa.updateServiceWorker,
  }),
}))

const { App } = await import('./App.tsx').then((m) => ({ App: m.default }))

afterEach(cleanup)

/** Две станции с уникальными названиями: по ним ищет автодополнение. */
const FROM = { id: '1/chistye-prudy', title: 'Чистые пруды' }
const TO = { id: '1/frunzenskaya', title: 'Фрунзенская' }

const SPLASH_MIN_MS = 1500
const MAP_READY_FALLBACK_MS = 3500

/** Маршрут, который «считает» подставной воркер. */
const routeOf = (minutes: number, transfers = 0): RouteResult => ({
  totalMinutes: minutes,
  transfersCount: transfers,
  steps: [
    {
      fromStationId: FROM.id,
      toStationId: TO.id,
      lineId: '1',
      travelMinutes: minutes,
    },
  ],
})

/** Сколько маршрутов вернёт воркер на следующий запрос. */
let routesToReturn: RouteResult[] = [routeOf(24)]
let workerReply: 'routes' | 'error' | 'silent' = 'routes'
let workers: FakeWorker[] = []

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  posted: Array<Record<string, unknown>> = []

  constructor() {
    workers.push(this)
  }

  postMessage(msg: Record<string, unknown>) {
    this.posted.push(msg)
    if (workerReply === 'silent') return

    const data =
      workerReply === 'error'
        ? { type: 'routeError', requestId: msg.requestId, errorMessage: 'Маршрут не найден' }
        : { type: 'routeResult', requestId: msg.requestId, routes: routesToReturn }

    // Воркер отвечает асинхронно — как настоящий.
    queueMicrotask(() => this.onmessage?.({ data } as MessageEvent))
  }

  terminate() {}
}

/**
 * Кадры анимации под ручным управлением. Список подсказок рисуется в портале
 * по измеренному прямоугольнику поля, а измерение отложено до кадра — без
 * прогонки очереди список в разметке не появится.
 */
let frames: FrameRequestCallback[] = []

const flushFrames = (count = 30) => {
  for (let i = 0; i < count; i += 1) {
    const queued = frames
    if (queued.length === 0) break
    frames = []
    for (const fn of queued) fn(i * 16)
  }
}

/**
 * Прогнать очередь кадров ОТДЕЛЬНЫМ act'ом. Внутри одного асинхронного act
 * React откладывает перерисовку до его конца, поэтому эффект, ставящий кадр в
 * очередь, ещё не отработал бы, а очередь уже оказалась бы пустой.
 */
async function nextFrame() {
  await act(async () => {
    flushFrames()
  })
}

/**
 * Дать интерфейсу устояться: анимация ухода списка снимает его не сразу, а
 * отложенное измерение может успеть поставить его обратно.
 */
async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    await nextFrame()
  }
}

/** Довести приложение до состояния «заставка отыграла, карта готова». */
async function bootUi() {
  await act(async () => {
    vi.advanceTimersByTime(MAP_READY_FALLBACK_MS)
  })
  await nextFrame()
}

function renderApp() {
  const view = render(<App />)
  return view
}

const from = () => screen.getByRole('combobox', { name: 'Станция отправления' })
const to = () => screen.getByRole('combobox', { name: 'Станция назначения' })
const errorText = () => document.querySelector('.error-text')?.textContent ?? null

/**
 * Строки подсказок ИМЕННО этого поля. Списки обоих полей живут в портале рядом
 * друг с другом, и запрос по всему документу берёт чужие строки.
 */
const optionsOf = (input: HTMLElement) => {
  const listbox = document.getElementById(input.getAttribute('aria-controls') ?? '')
  return listbox ? within(listbox).queryAllByRole('option') : []
}

const optionOf = (input: HTMLElement, title: string) => {
  const listbox = document.getElementById(input.getAttribute('aria-controls')!)!
  return within(listbox).getByRole('option', { name: new RegExp(title) })
}

/** Ввести название и выбрать первую подсказку. */
async function pickStation(input: HTMLElement, title: string) {
  await typeInto(input, title)
  await act(async () => {
    fireEvent.click(optionOf(input, title))
  })
  await nextFrame()
}

/** Открыть список подсказок и довести его до разметки. */
async function typeInto(input: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value } })
  })
  await nextFrame()
}

/** Полный маршрут: обе станции выбраны, воркер ответил. */
async function buildRoute() {
  await pickStation(from(), FROM.title)
  await pickStation(to(), TO.title)
  await waitFor(() => expect(document.querySelector('.summary-time')).toBeTruthy())
}

beforeEach(() => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  })
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')

  frames = []
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    frames.push(fn)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})

  workers = []
  routesToReturn = [routeOf(24)]
  workerReply = 'routes'
  mapProps.current = null

  vi.stubGlobal('Worker', FakeWorker)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 })))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('запуск приложения', () => {
  /** Заставка — это «привет», а не загрузочный экран; под ней уже живёт карта. */
  it('показывает заставку и карту, но не интерфейс маршрута', () => {
    renderApp()

    expect(screen.getByRole('dialog', { name: 'Заставка приложения' })).toBeTruthy()
    expect(screen.getByTestId('metro-map')).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: 'Станция отправления' })).toBeNull()
  })

  it('после заставки и готовности карты показывает поля маршрута', async () => {
    renderApp()
    await bootUi()

    expect(from()).toBeTruthy()
    expect(to()).toBeTruthy()
  })

  /**
   * Страховка обязательна: без сигнала от карты пользователь застрял бы на
   * заставке навсегда.
   */
  it('готовность карты снимает заставку раньше страховки', async () => {
    renderApp()

    await act(async () => {
      ;(mapProps.current!.onInitialViewportReady as () => void)()
      vi.advanceTimersByTime(SPLASH_MIN_MS)
    })
    expect(from()).toBeTruthy()
  })

  /** Единственный заголовок первого уровня: без него у экрана нет оглавления. */
  it('у экрана есть заголовок для скринридера', () => {
    renderApp()
    expect(screen.getByRole('heading', { name: 'Метро Москвы: схема и маршруты' })).toBeTruthy()
  })

  /**
   * A11Y-4. До поля «Откуда» приходилось нажимать Tab девять раз: кнопки зума,
   * тумблер темы, чип шапки, ручка шторки.
   */
  it('ссылка-пропуск ведёт прямо к вводу маршрута', async () => {
    renderApp()
    await bootUi()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Перейти к вводу маршрута' }))
    })
    expect(document.activeElement).toBe(from())
  })
})

describe('построение маршрута из полей', () => {
  it('выбор двух станций строит маршрут', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    expect(document.querySelector('.summary-time')?.textContent).toContain('24 мин')
    expect(from()).toHaveProperty('value', FROM.title)
    expect(to()).toHaveProperty('value', TO.title)
  })

  it('одной станции для маршрута мало', async () => {
    renderApp()
    await bootUi()
    await pickStation(from(), FROM.title)

    expect(workers[0]?.posted ?? []).toHaveLength(0)
    expect(document.querySelector('.summary-time')).toBeNull()
  })

  /** Первый тап заполняет «Откуда», и курсор обязан переехать в «Куда». */
  it('после выбора «Откуда» курсор переезжает в «Куда»', async () => {
    renderApp()
    await bootUi()
    await pickStation(from(), FROM.title)

    expect(document.activeElement).toBe(to())
  })

  it('маршрут уходит в воркер с обеими станциями', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    const msg = workers[0].posted.at(-1)!
    expect(msg.fromId).toBe(FROM.id)
    expect(msg.toId).toBe(TO.id)
  })

  /** Ссылку на маршрут можно скопировать из адресной строки, не нажимая «Поделиться». */
  it('построенный маршрут попадает в адресную строку', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    expect(window.location.search).toContain(encodeURIComponent(FROM.id))
    expect(window.location.search).toContain(encodeURIComponent(TO.id))
  })

  it('результат объявляется скринридеру', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    const live = document.querySelector('.route-loading-live')!
    expect(live.textContent).toContain('Маршрут построен')
    expect(live.textContent).toContain(FROM.title)
    expect(live.textContent).toContain('Один вариант')
  })

  it('несколько вариантов объявляются числом', async () => {
    routesToReturn = [routeOf(24), routeOf(27, 1), routeOf(31, 2)]
    renderApp()
    await bootUi()
    await buildRoute()

    expect(document.querySelector('.route-loading-live')?.textContent).toContain('3 варианта')
  })

  it('построенный маршрут попадает в недавние', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    const stored = window.localStorage.getItem('metro-map-recents-v1')
    expect(stored).toContain(FROM.id)
  })

  /**
   * Флаг сработает на СЛЕДУЮЩЕМ запуске: карточка установки не должна
   * накрывать свежий результат.
   */
  it('построенный маршрут делает предложение установки осмысленным', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    expect(window.localStorage.getItem('metro-map-install-guide-earned')).toBe('1')
    expect(document.querySelector('.install-guide-card')).toBeNull()
  })
})

describe('ввод с клавиатуры', () => {
  it('Enter в поле выбирает первую подсказку', async () => {
    renderApp()
    await bootUi()

    await typeInto(from(), FROM.title)
    await act(async () => {
      fireEvent.keyDown(from(), { key: 'Enter' })
    })
    await nextFrame()

    expect(from()).toHaveProperty('value', FROM.title)
  })

  it('стрелки водят по списку, Enter берёт выбранное', async () => {
    renderApp()
    await bootUi()

    await typeInto(from(), 'Чист')
    expect(optionsOf(from()).length).toBeGreaterThan(0)

    fireEvent.keyDown(from(), { key: 'ArrowDown' })
    fireEvent.keyDown(from(), { key: 'ArrowUp' })
    await act(async () => {
      fireEvent.keyDown(from(), { key: 'Enter' })
    })

    expect((from() as HTMLInputElement).value).toBeTruthy()
  })

  /** Escape закрывает список, не трогая ни фокус, ни введённый текст. */
  it('Escape закрывает список, оставляя текст', async () => {
    renderApp()
    await bootUi()

    await typeInto(from(), FROM.title)
    expect(optionsOf(from()).length).toBeGreaterThan(0)

    await act(async () => {
      fireEvent.keyDown(from(), { key: 'Escape' })
    })
    // Список уходит с анимацией и до её конца показывает прежние строки.
    await settle()

    expect(optionsOf(from())).toHaveLength(0)
    expect(from()).toHaveProperty('value', FROM.title)
  })

  /** Любой ввод возвращает список, закрытый Escape'ом. */
  it('следующий ввод возвращает закрытый список', async () => {
    renderApp()
    await bootUi()

    await typeInto(from(), FROM.title)
    await act(async () => {
      fireEvent.keyDown(from(), { key: 'Escape' })
    })
    await settle()

    await typeInto(from(), 'Чист')
    expect(optionsOf(from()).length).toBeGreaterThan(0)
  })

  it('Enter без выбранной станции просит выбрать из списка', async () => {
    renderApp()
    await bootUi()

    await typeInto(from(), 'ap,f')
    await act(async () => {
      fireEvent.keyDown(from(), { key: 'Enter' })
    })

    expect(errorText()).toBe('Выбери станцию "Откуда" из списка подсказок.')
  })

  it('Enter в «Куда» без станции просит то же самое', async () => {
    renderApp()
    await bootUi()

    await typeInto(to(), 'zzz')
    await act(async () => {
      fireEvent.keyDown(to(), { key: 'Enter' })
    })

    expect(errorText()).toBe('Выбери станцию "Куда" из списка подсказок.')
  })

  it('Enter с обеими станциями строит маршрут', async () => {
    renderApp()
    await bootUi()
    await pickStation(from(), FROM.title)

    await typeInto(to(), TO.title)
    await act(async () => {
      fireEvent.keyDown(to(), { key: 'Enter' })
    })
    await nextFrame()

    await waitFor(() => expect(document.querySelector('.summary-time')).toBeTruthy())
  })
})

describe('одна и та же станция в обоих полях', () => {
  /**
   * Раньше здесь был молчаливый return: подсказка «съедалась», поле не
   * менялось, сообщения не было — пользователь упирался в тупик без причины.
   */
  it('выбор занятой станции объясняется, а не проглатывается', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    await typeInto(from(), TO.title)
    await act(async () => {
      fireEvent.click(optionOf(from(), TO.title))
    })

    expect(errorText()).toContain('уже выбрана как станция назначения')
  })

  it('то же самое для поля «Куда»', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    await typeInto(to(), FROM.title)
    await act(async () => {
      fireEvent.click(optionOf(to(), FROM.title))
    })

    expect(errorText()).toContain('уже выбрана как станция отправления')
  })
})

describe('обмен станциями', () => {
  const swap = () =>
    screen.getByRole('button', { name: 'Поменять местами станции Откуда и Куда' })

  it('меняет поля местами и пересчитывает маршрут', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    await act(async () => {
      fireEvent.click(swap())
    })

    expect(from()).toHaveProperty('value', TO.title)
    expect(to()).toHaveProperty('value', FROM.title)

    const msg = workers[0].posted.at(-1)!
    expect(msg.fromId).toBe(TO.id)
    expect(msg.toId).toBe(FROM.id)
  })

  /**
   * Обратный маршрут — тот же самый, лишь пройденный в другую сторону. Гасить
   * его на время пересчёта значит мигать всем интерфейсом от одного нажатия.
   */
  it('не гасит показанный маршрут на время пересчёта', async () => {
    workerReply = 'silent'
    renderApp()
    await bootUi()

    workerReply = 'routes'
    await buildRoute()

    workerReply = 'silent'
    await act(async () => {
      fireEvent.click(swap())
    })

    expect(document.querySelector('.summary-time')).toBeTruthy()
  })

  it('на пустых полях ничего не делает', async () => {
    renderApp()
    await bootUi()

    await act(async () => {
      fireEvent.click(swap())
    })
    expect(errorText()).toBeNull()
  })
})

describe('отказы расчёта', () => {
  it('ошибка воркера показывается вместо маршрута', async () => {
    workerReply = 'error'
    renderApp()
    await bootUi()

    await pickStation(from(), FROM.title)
    await pickStation(to(), TO.title)

    await waitFor(() => expect(errorText()).toBe('Маршрут не найден'))
    expect(document.querySelector('.summary-time')).toBeNull()
  })

  it('после ошибки маршрут можно переиграть', async () => {
    workerReply = 'error'
    renderApp()
    await bootUi()
    await pickStation(from(), FROM.title)
    await pickStation(to(), TO.title)
    await waitFor(() => expect(errorText()).toBeTruthy())

    workerReply = 'routes'
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Построить маршрут ещё раз' }))
    })

    await waitFor(() => expect(document.querySelector('.summary-time')).toBeTruthy())
  })

  /** Пока воркер считает, шторка показывает скелетон, а не «ничего не произошло». */
  it('затянувшийся расчёт показывает состояние загрузки', async () => {
    workerReply = 'silent'
    renderApp()
    await bootUi()
    await pickStation(from(), FROM.title)
    await pickStation(to(), TO.title)

    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(document.querySelector('.route-loading')).toBeTruthy()
    expect(document.querySelector('.route-loading-live')?.textContent).toBe('Строим маршрут…')
  })
})

describe('ссылка на маршрут', () => {
  it('открывает маршрут сразу при запуске', async () => {
    window.history.replaceState(
      {},
      '',
      `/?from=${encodeURIComponent(FROM.id)}&to=${encodeURIComponent(TO.id)}`,
    )

    renderApp()
    await bootUi()

    await waitFor(() => expect(document.querySelector('.summary-time')).toBeTruthy())
    expect(from()).toHaveProperty('value', FROM.title)
    expect(to()).toHaveProperty('value', TO.title)
  })

  /** Половинчатая ссылка молча не делала ничего: получатель не понимал, что она обрезана. */
  it('неполная ссылка объясняет, что в ней не так', async () => {
    window.history.replaceState({}, '', `/?from=${encodeURIComponent(FROM.id)}`)

    renderApp()
    await bootUi()

    expect(errorText()).toContain('неполная')
  })

  it('ссылка с несуществующей станцией объясняет себя', async () => {
    window.history.replaceState({}, '', '/?from=99/нет-такой&to=98/и-такой-нет')

    renderApp()
    await bootUi()

    expect(errorText()).toContain('таких станций нет')
  })

  it('ссылка «из А в А» объясняет себя', async () => {
    const same = encodeURIComponent(FROM.id)
    window.history.replaceState({}, '', `/?from=${same}&to=${same}`)

    renderApp()
    await bootUi()

    expect(errorText()).toContain('совпадают')
  })
})

describe('шапка над картой', () => {
  /**
   * Прежде формулировок было три — «Откуда: X», «Куда: Y» и «X → Y», — и при
   * заполнении второго поля надпись меняла не только значение, но и структуру.
   */
  it('всегда говорит на одном языке «откуда → куда»', async () => {
    renderApp()
    await bootUi()

    const chip = () => document.querySelector('.app-header-chip')!
    expect(chip().textContent).toBe('Откуда? → Куда?')

    await pickStation(from(), FROM.title)
    expect(chip().textContent).toBe(`${FROM.title} → Куда?`)

    await pickStation(to(), TO.title)
    expect(chip().textContent).toBe(`${FROM.title} → ${TO.title}`)
  })

  it('нажатие на чип ставит курсор в незаполненное поле', async () => {
    renderApp()
    await bootUi()
    await pickStation(from(), FROM.title)
    fireEvent.blur(to())

    await act(async () => {
      fireEvent.click(document.querySelector('.app-header-chip')!)
    })
    expect(document.activeElement).toBe(to())
  })
})

describe('подсказка первого запуска', () => {
  it('на чистом экране объясняет тапы по станциям', async () => {
    renderApp()
    await bootUi()

    expect(screen.getByRole('note').textContent).toContain('Тап по станции')
  })

  it('закрывается насовсем', async () => {
    renderApp()
    await bootUi()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Скрыть подсказку' }))
    })

    expect(screen.queryByRole('note')).toBeNull()
    expect(window.localStorage.getItem('metro-map-onboarding-hint-seen')).toBe('1')
  })

  /** Человек уже разобрался сам — подсказка становится помехой. */
  it('исчезает, как только начали вводить станцию', async () => {
    renderApp()
    await bootUi()

    await typeInto(from(), 'Чист')
    expect(screen.queryByRole('note')).toBeNull()
  })

  it('на следующем запуске не возвращается', async () => {
    window.localStorage.setItem('metro-map-onboarding-hint-seen', '1')
    renderApp()
    await bootUi()

    expect(screen.queryByRole('note')).toBeNull()
  })
})

describe('быстрые маршруты', () => {
  const savedRoute = {
    fromStationId: FROM.id,
    toStationId: TO.id,
    fromTitle: FROM.title,
    toTitle: TO.title,
    lastUsedAt: 1,
  }

  it('кнопка «Рядом» есть всегда', async () => {
    renderApp()
    await bootUi()

    expect(screen.getByRole('button', { name: 'Показать станции рядом' })).toBeTruthy()
  })

  it('недавние и избранные показываются, когда они есть', async () => {
    window.localStorage.setItem('metro-map-recents-v1', JSON.stringify([savedRoute]))
    window.localStorage.setItem('metro-map-favorites-v1', JSON.stringify([savedRoute]))

    renderApp()
    await bootUi()

    expect(screen.getByRole('button', { name: 'Показать недавние маршруты' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Показать избранные маршруты' })).toBeTruthy()
  })

  it('без сохранённых маршрутов лишних кнопок нет', async () => {
    renderApp()
    await bootUi()

    expect(screen.queryByRole('button', { name: 'Показать недавние маршруты' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Показать избранные маршруты' })).toBeNull()
  })

  it('сохранённый маршрут строится одним нажатием', async () => {
    window.localStorage.setItem('metro-map-favorites-v1', JSON.stringify([savedRoute]))
    renderApp()
    await bootUi()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Показать избранные маршруты' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: `${FROM.title} → ${TO.title}` }))
    })

    await waitFor(() => expect(document.querySelector('.summary-time')).toBeTruthy())
  })

  it('недавние можно очистить', async () => {
    window.localStorage.setItem('metro-map-recents-v1', JSON.stringify([savedRoute]))
    renderApp()
    await bootUi()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Показать недавние маршруты' }))
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Очистить' }))
    })

    expect(screen.queryByRole('button', { name: 'Показать недавние маршруты' })).toBeNull()
  })

  it('панель закрывается', async () => {
    renderApp()
    await bootUi()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Показать станции рядом' }))
    })
    expect(screen.getByRole('region', { name: 'Быстрые маршруты' })).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Скрыть быстрые маршруты' }))
    })
    expect(screen.queryByRole('region', { name: 'Быстрые маршруты' })).toBeNull()
  })
})

describe('станции рядом', () => {
  const stubGeolocation = (impl: (ok: PositionCallback, err: PositionErrorCallback) => void) => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: { getCurrentPosition: vi.fn(impl) },
    })
  }

  const openNearby = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Показать станции рядом' }))
    })
  }

  it('ставит найденную станцию в поле «Откуда»', async () => {
    stubGeolocation((ok) =>
      ok({ coords: { latitude: 55.7558, longitude: 37.6173 } } as GeolocationPosition),
    )

    renderApp()
    await bootUi()
    await openNearby()

    const row = document.querySelector('.smart-suggestions-section:last-child .smart-suggestions-row')
    const chip = within(row as HTMLElement).getAllByRole('button')[0]
    const title = chip.textContent!

    await act(async () => {
      fireEvent.click(chip)
    })
    expect(from()).toHaveProperty('value', title)
  })

  /**
   * Раньше при отказе в геолокации вся строка чипов пропадала с экрана, и
   * заботливо написанный текст ошибки не показывался никогда — человек думал,
   * что сломал приложение.
   */
  it('отказ в геолокации объясняется на месте', async () => {
    stubGeolocation((_ok, err) => err({ code: 1 } as GeolocationPositionError))

    renderApp()
    await bootUi()
    await openNearby()

    expect(screen.getByRole('alert').textContent).toContain('Нет разрешения')
    expect(screen.getByRole('button', { name: 'Попробовать ещё раз' })).toBeTruthy()
  })

  it('после отказа попытку можно повторить', async () => {
    let deny = true
    stubGeolocation((ok, err) => {
      if (deny) err({ code: 2 } as GeolocationPositionError)
      else ok({ coords: { latitude: 55.75, longitude: 37.61 } } as GeolocationPosition)
    })

    renderApp()
    await bootUi()
    await openNearby()

    deny = false
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Попробовать ещё раз' }))
    })

    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('варианты маршрута', () => {
  beforeEach(() => {
    routesToReturn = [routeOf(24), routeOf(27, 1), routeOf(31, 2)]
  })

  it('показывает все варианты чипами', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    expect(document.querySelectorAll('.bottom-route-summary-scroll .route-choice-chip')).toHaveLength(3)
  })

  it('выбор варианта меняет показанный маршрут', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    const chips = document.querySelectorAll('.bottom-route-summary-scroll .route-choice-chip')
    await act(async () => {
      fireEvent.click(chips[2])
    })

    expect(document.querySelector('.summary-time')?.textContent).toContain('31 мин')
  })

  it('вариант выбирается и с клавиатуры', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    const chips = document.querySelectorAll('.bottom-route-summary-scroll .route-choice-chip')
    await act(async () => {
      fireEvent.keyDown(chips[1], { key: 'Enter' })
    })
    expect(document.querySelector('.summary-time')?.textContent).toContain('27 мин')

    await act(async () => {
      fireEvent.keyDown(chips[2], { key: ' ' })
    })
    expect(document.querySelector('.summary-time')?.textContent).toContain('31 мин')
  })

  it('единственный вариант чипами не показывается', async () => {
    routesToReturn = [routeOf(24)]
    renderApp()
    await bootUi()
    await buildRoute()

    expect(document.querySelectorAll('.bottom-route-summary-scroll .route-choice-chip')).toHaveLength(0)
  })
})

describe('избранное', () => {
  it('маршрут добавляется и убирается', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Добавить маршрут в избранное' }))
    })
    expect(window.localStorage.getItem('metro-map-favorites-v1')).toContain(FROM.id)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Убрать маршрут из избранного' }))
    })
    expect(window.localStorage.getItem('metro-map-favorites-v1')).not.toContain(FROM.id)
  })
})

describe('шторка маршрута', () => {
  it('ручка раскрывает и сворачивает детали', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    const handle = () => screen.getByRole('button', { name: /детали маршрута/ })
    const wasExpanded = handle().getAttribute('aria-expanded')

    await act(async () => {
      fireEvent.click(handle())
    })
    expect(handle().getAttribute('aria-expanded')).not.toBe(wasExpanded)
  })

  /**
   * До маршрута раскрывать нечего, и шторка это знает: физика сама сворачивает
   * её обратно, пока hasRoute ложно. Ручка при этом остаётся в разметке и в
   * обходе по Tab — фокусируемая кнопка, нажатие на которую ничего не меняет.
   */
  /**
   * До маршрута раскрывать нечего: детали рендерятся только при маршруте, а
   * форма и так видна во всегда видимой части — ход шторки нулевой. Кнопка
   * здесь обещала «Раскрыть шторку», по нажатию не делала ничего и занимала
   * шаг в обходе по Tab, поэтому остаётся только полоска-захват.
   */
  it('на свёрнутой шторке без маршрута ручка — не кнопка', async () => {
    renderApp()
    await bootUi()

    expect(screen.queryByRole('button', { name: /шторку/ })).toBeNull()

    const handle = document.querySelector('.bottom-sheet-handle')!
    expect(handle.tagName).toBe('DIV')
    expect(handle.getAttribute('aria-hidden')).toBe('true')
  })

  /**
   * А вот раскрытой без маршрута шторка бывает — панель быстрых маршрутов
   * поднимает её сама. Тогда ручка обязана оставаться рабочим переключателем:
   * это второй способ закрыть панель, в том числе с клавиатуры.
   */
  it('при открытой панели быстрых маршрутов ручка её сворачивает', async () => {
    renderApp()
    await bootUi()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Показать станции рядом' }))
    })
    await settle(1)

    const handle = screen.getByRole('button', { name: 'Свернуть шторку' })
    expect(handle.getAttribute('aria-expanded')).toBe('true')

    await act(async () => {
      fireEvent.click(handle)
    })
    await settle(1)

    expect(screen.queryByRole('region', { name: 'Быстрые маршруты' })).toBeNull()
    expect(document.querySelector('.bottom-sheet-handle')!.tagName).toBe('DIV')
  })

  /** Ручка остаётся захватом для жеста: он ищет её по классу, а не по тегу. */
  it('полоска-захват сохраняет класс для перетаскивания', async () => {
    renderApp()
    await bootUi()

    expect(document.querySelector('.bottom-sheet-handle')).toBeTruthy()
  })
})

describe('очистка полей', () => {
  it('крестик стирает станцию и снятый маршрут', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Очистить поле Откуда' }))
    })

    expect(from()).toHaveProperty('value', '')
    expect(document.querySelector('.summary-time')).toBeNull()
  })
})

describe('подсказки в пустом поле', () => {
  /**
   * Раньше список открывался только после ввода, и клик в поле не давал ничего:
   * человек упирался в пустой прямоугольник и должен был угадать, что делать.
   */
  it('фокус на пустом поле показывает недавнее', async () => {
    window.localStorage.setItem(
      'metro-map-recents-v1',
      JSON.stringify([
        {
          fromStationId: FROM.id,
          toStationId: TO.id,
          fromTitle: FROM.title,
          toTitle: TO.title,
          lastUsedAt: 1,
        },
      ]),
    )

    renderApp()
    await bootUi()

    await act(async () => {
      fireEvent.focus(from())
    })
    await nextFrame()
    expect(optionsOf(from()).length).toBeGreaterThan(0)
  })

  /**
   * Закрытие по blur отложено: на тач-экране палец сначала снимает фокус с
   * поля и лишь потом доводит click до строки — без задержки строка исчезала
   * бы из-под пальца.
   */
  it('уход фокуса закрывает список не мгновенно', async () => {
    window.localStorage.setItem(
      'metro-map-recents-v1',
      JSON.stringify([
        {
          fromStationId: FROM.id,
          toStationId: TO.id,
          fromTitle: FROM.title,
          toTitle: TO.title,
          lastUsedAt: 1,
        },
      ]),
    )

    renderApp()
    await bootUi()
    await act(async () => {
      fireEvent.focus(from())
    })
    await nextFrame()
    expect(optionsOf(from()).length).toBeGreaterThan(0)

    fireEvent.blur(from())
    expect(optionsOf(from()).length).toBeGreaterThan(0)

    await settle()
    expect(optionsOf(from())).toHaveLength(0)
  })
})

describe('журнал ошибок', () => {
  /** Кнопка появляется, только если в журнале реально что-то есть. */
  it('на чистом журнале кнопки нет', async () => {
    renderApp()
    await bootUi()

    expect(screen.queryByRole('button', { name: /Журнал ошибок/ })).toBeNull()
  })

  it('накопленные ошибки можно открыть и закрыть', async () => {
    window.localStorage.setItem(
      'metro-map-error-log-v1',
      JSON.stringify([{ at: 1, kind: 'error', message: 'TypeError: беда', count: 1 }]),
    )

    renderApp()
    await bootUi()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Показать журнал ошибок/ }))
    })
    expect(screen.getByRole('dialog', { name: 'Журнал ошибок' })).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Закрыть журнал ошибок' }))
    })
    expect(screen.queryByRole('dialog', { name: 'Журнал ошибок' })).toBeNull()
  })
})

describe('карточка установки', () => {
  /** Карточка «зарабатывается»: человек уже строил маршрут в прошлый запуск. */
  it('появляется заработавшему и закрывается', async () => {
    window.localStorage.setItem('metro-map-install-guide-earned', '1')
    window.localStorage.setItem('metro-map-onboarding-hint-seen', '1')

    renderApp()
    await bootUi()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })

    expect(screen.getByRole('dialog', { name: /Поставь метро/ })).toBeTruthy()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Понятно' }))
    })
    expect(screen.queryByRole('dialog', { name: /Поставь метро/ })).toBeNull()
  })

  it('нажатие мимо карточки её закрывает', async () => {
    window.localStorage.setItem('metro-map-install-guide-earned', '1')
    window.localStorage.setItem('metro-map-onboarding-hint-seen', '1')

    renderApp()
    await bootUi()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })

    await act(async () => {
      fireEvent.click(document.querySelector('.install-guide-backdrop')!)
    })
    expect(screen.queryByRole('dialog', { name: /Поставь метро/ })).toBeNull()
  })

  /** Карточка накрывала подсказку онбординга, которую человек начал читать. */
  it('онбординг не перебивает', async () => {
    window.localStorage.setItem('metro-map-install-guide-earned', '1')

    renderApp()
    await bootUi()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })

    expect(screen.queryByRole('dialog', { name: /Поставь метро/ })).toBeNull()
    expect(screen.getByRole('note')).toBeTruthy()
  })
})

describe('связь с картой', () => {
  it('карта получает выбранные станции и маршрут', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    expect(mapProps.current!.fromStationId).toBe(FROM.id)
    expect(mapProps.current!.toStationId).toBe(TO.id)
    expect((mapProps.current!.routeStationIds as string[]).length).toBeGreaterThan(0)
  })

  /**
   * Какое поле получит следующий тап: пустое «Откуда» → «Откуда», иначе «Куда».
   * Карта красит станции по этому же признаку.
   */
  it('режим выбора идёт за пустым полем', async () => {
    renderApp()
    await bootUi()
    expect(mapProps.current!.selectionMode).toBe('from')

    await pickStation(from(), FROM.title)
    expect(mapProps.current!.selectionMode).toBe('to')
  })

  /** Тап по станции на карте — второй способ задать маршрут, помимо ввода. */
  it('тап по станции заполняет пустое поле', async () => {
    renderApp()
    await bootUi()

    await act(async () => {
      ;(
        mapProps.current!.onSelectStation as (
          id: string,
          name: string,
          point: { x: number; y: number },
        ) => unknown
      )(FROM.id, FROM.title, { x: 100, y: 200 })
    })

    expect(from()).toHaveProperty('value', FROM.title)
  })

  /** Жест по карте сворачивает шторку: она закрывает собой то, на что смотрят. */
  it('жест по карте сворачивает шторку с маршрутом', async () => {
    renderApp()
    await bootUi()
    await buildRoute()

    await act(async () => {
      ;(mapProps.current!.onMapInteraction as () => void)()
    })

    expect(
      screen.getByRole('button', { name: /детали маршрута/ }).getAttribute('aria-expanded'),
    ).toBe('false')
  })
})
