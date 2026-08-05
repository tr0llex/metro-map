// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RouteResult } from './metro/types.ts'

/** Карта здесь нужна только как источник тапов по станции — см. App.test.tsx. */
const mapProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))

vi.mock('./components/MetroMap.tsx', () => ({
  MetroMap: (props: Record<string, unknown>) => {
    mapProps.current = props
    return <div data-testid="metro-map" />
  },
}))

const pwa = vi.hoisted(() => ({ updateServiceWorker: vi.fn(), setNeedRefresh: vi.fn() }))

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    needRefresh: [false, pwa.setNeedRefresh],
    offlineReady: [false, vi.fn()],
    updateServiceWorker: pwa.updateServiceWorker,
  }),
}))

const { App } = await import('./App.tsx').then((m) => ({ App: m.default }))

afterEach(cleanup)

const FROM = { id: '1/chistye-prudy', title: 'Чистые пруды' }
const TO = { id: '1/frunzenskaya', title: 'Фрунзенская' }
const THIRD = { id: '1/krasnoselskaya', title: 'Красносельская' }

const MAP_READY_FALLBACK_MS = 3500
/** Долгое нажатие открывает поповер в любом состоянии. */
const LONG_PRESS_MS = 480

const route: RouteResult = {
  totalMinutes: 24,
  transfersCount: 0,
  steps: [{ fromStationId: FROM.id, toStationId: TO.id, lineId: '1', travelMinutes: 24 }],
}

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null

  postMessage(msg: Record<string, unknown>) {
    queueMicrotask(() =>
      this.onmessage?.({
        data: { type: 'routeResult', requestId: msg.requestId, routes: [route] },
      } as MessageEvent),
    )
  }

  terminate() {}
}

let frames: FrameRequestCallback[] = []

const flushFrames = (count = 30) => {
  for (let i = 0; i < count; i += 1) {
    const queued = frames
    if (queued.length === 0) break
    frames = []
    for (const fn of queued) fn(i * 16)
  }
}

async function nextFrame() {
  await act(async () => {
    flushFrames()
  })
}

async function bootUi() {
  await act(async () => {
    vi.advanceTimersByTime(MAP_READY_FALLBACK_MS)
  })
  await nextFrame()
}

const from = () => screen.getByRole('combobox', { name: 'Станция отправления' })
const to = () => screen.getByRole('combobox', { name: 'Станция назначения' })
const errorText = () => document.querySelector('.error-text')?.textContent ?? null
const hint = () => document.querySelector('.theme-station-hint')?.textContent ?? null

const optionOf = (input: HTMLElement, title: string) => {
  const listbox = document.getElementById(input.getAttribute('aria-controls')!)!
  return within(listbox).getByRole('option', { name: new RegExp(title) })
}

const optionsOf = (input: HTMLElement) => {
  const listbox = document.getElementById(input.getAttribute('aria-controls') ?? '')
  return listbox ? within(listbox).queryAllByRole('option') : []
}

async function typeInto(input: HTMLElement, value: string) {
  await act(async () => {
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value } })
  })
  await nextFrame()
}

async function pickStation(input: HTMLElement, title: string) {
  await typeInto(input, title)
  await act(async () => {
    fireEvent.click(optionOf(input, title))
  })
  await nextFrame()
}

/** Тап по станции на схеме — так, как его отдаёт карта. */
async function tapStation(station: { id: string; title: string }, heldMs = 0) {
  window.dispatchEvent(new window.PointerEvent('pointerdown', { clientX: 100, clientY: 200 }))
  if (heldMs > 0) vi.advanceTimersByTime(heldMs)

  await act(async () => {
    ;(
      mapProps.current!.onSelectStation as (
        id: string,
        name: string,
        point: { x: number; y: number },
      ) => unknown
    )(station.id, station.title, { x: 100, y: 200 })
  })
  await nextFrame()
}

const popover = () => document.querySelector('.station-pick-popover')

beforeEach(() => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
  })
  window.localStorage.clear()
  window.history.replaceState({}, '', '/')

  frames = []
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    frames.push(fn)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
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
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('тап по станции на схеме', () => {
  /** Первый тап — «Откуда», второй — «Куда»: это и есть быстрый путь. */
  it('первый тап заполняет «Откуда», второй — «Куда»', async () => {
    render(<App />)
    await bootUi()

    await tapStation(FROM)
    expect(from()).toHaveProperty('value', FROM.title)
    expect(popover()).toBeNull()

    await tapStation(TO)
    expect(to()).toHaveProperty('value', TO.title)
    await waitFor(() => expect(document.querySelector('.summary-time')).toBeTruthy())
  })

  /**
   * Тап по уже выбранной станции — почти всегда промах: сообщаем и выходим,
   * поповер тут ничего полезного не предложит.
   */
  it('повторный тап по «Откуда» объясняется подсказкой', async () => {
    render(<App />)
    await bootUi()
    await tapStation(FROM)

    await tapStation(FROM)
    expect(hint()).toContain('уже выбрана как «Откуда»')
    expect(popover()).toBeNull()
  })

  it('повторный тап по «Куда» — тоже', async () => {
    render(<App />)
    await bootUi()
    await tapStation(FROM)
    await tapStation(TO)

    await tapStation(TO)
    expect(hint()).toContain('уже выбрана как «Куда»')
  })

  /**
   * Когда обе точки заданы, тап НИЧЕГО не меняет сам: раньше он подменял
   * «Куда», и маршрут перестраивался неожиданно для человека, который просто
   * ткнул в карту.
   */
  it('при занятых полях спрашивает, какое поле менять', async () => {
    render(<App />)
    await bootUi()
    await tapStation(FROM)
    await tapStation(TO)

    await tapStation(THIRD)

    expect(popover()).toBeTruthy()
    expect(from()).toHaveProperty('value', FROM.title)
    expect(to()).toHaveProperty('value', TO.title)
  })

  /** Долгое нажатие открывает выбор поля даже при пустых полях. */
  it('долгое нажатие сразу спрашивает поле', async () => {
    render(<App />)
    await bootUi()

    await tapStation(FROM, LONG_PRESS_MS)

    expect(popover()).toBeTruthy()
    expect(from()).toHaveProperty('value', '')
  })
})

describe('выбор поля в поповере', () => {
  const openPopover = async () => {
    await tapStation(FROM)
    await tapStation(TO)
    await tapStation(THIRD)
    await waitFor(() => expect(popover()).toBeTruthy())
  }

  const pick = async (name: RegExp) => {
    await act(async () => {
      fireEvent.click(within(popover() as HTMLElement).getByRole('button', { name }))
    })
    await nextFrame()
  }

  it('кнопка «Откуда» ставит станцию в это поле и пересчитывает маршрут', async () => {
    render(<App />)
    await bootUi()
    await openPopover()

    await pick(/Откуда/)

    expect(from()).toHaveProperty('value', THIRD.title)
    expect(to()).toHaveProperty('value', TO.title)
    await waitFor(() => expect(document.querySelector('.summary-time')).toBeTruthy())
  })

  it('кнопка «Куда» — симметрично', async () => {
    render(<App />)
    await bootUi()
    await openPopover()

    await pick(/Куда/)

    expect(to()).toHaveProperty('value', THIRD.title)
    expect(from()).toHaveProperty('value', FROM.title)
  })

  /** Поповер закрывается сам: человек уже сделал выбор. */
  it('после выбора закрывается', async () => {
    render(<App />)
    await bootUi()
    await openPopover()
    await pick(/Откуда/)

    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    await nextFrame()
    expect(popover()).toBeNull()
  })

  /**
   * Отказ обязан объясниться: действие не состоялось, и без подсказки это
   * выглядит как поломка.
   */
  it('выбор поля, занятого этой же станцией, объясняется', async () => {
    render(<App />)
    await bootUi()
    await tapStation(FROM)
    await tapStation(TO)

    // Долгим нажатием открываем выбор для станции, уже стоящей в «Куда».
    await tapStation(TO, LONG_PRESS_MS)
    await waitFor(() => expect(popover()).toBeTruthy())

    await pick(/Откуда/)
    expect(hint()).toContain('уже выбрана как «Куда»')
  })
})

describe('Enter в поле «Откуда»', () => {
  it('совпадение с «Куда» объясняется под полем', async () => {
    render(<App />)
    await bootUi()
    await pickStation(from(), FROM.title)
    await pickStation(to(), TO.title)

    await typeInto(from(), TO.title)
    await act(async () => {
      fireEvent.keyDown(from(), { key: 'Enter' })
    })
    await nextFrame()

    expect(errorText()).toContain('не могут совпадать')
    expect(document.querySelector('.summary-time')).toBeNull()
  })
})

describe('клавиатура в поле «Куда»', () => {
  it('стрелки водят по списку', async () => {
    render(<App />)
    await bootUi()

    await typeInto(to(), 'Чист')
    expect(optionsOf(to()).length).toBeGreaterThan(0)

    fireEvent.keyDown(to(), { key: 'ArrowDown' })
    fireEvent.keyDown(to(), { key: 'ArrowUp' })
    await act(async () => {
      fireEvent.keyDown(to(), { key: 'Enter' })
    })
    await nextFrame()

    expect((to() as HTMLInputElement).value).toBeTruthy()
  })

  it('Escape закрывает список, оставляя текст', async () => {
    render(<App />)
    await bootUi()
    await typeInto(to(), TO.title)

    await act(async () => {
      fireEvent.keyDown(to(), { key: 'Escape' })
    })
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(300)
      })
      await nextFrame()
    }

    expect(optionsOf(to())).toHaveLength(0)
    expect(to()).toHaveProperty('value', TO.title)
  })

  it('совпадение с «Откуда» объясняется под полем', async () => {
    render(<App />)
    await bootUi()
    await pickStation(from(), FROM.title)
    await pickStation(to(), TO.title)

    await typeInto(to(), FROM.title)
    await act(async () => {
      fireEvent.keyDown(to(), { key: 'Enter' })
    })
    await nextFrame()

    expect(errorText()).toContain('не могут совпадать')
  })

  /** Заполнили «Куда» первым — курсор обязан переехать в пустое «Откуда». */
  it('после «Куда» курсор уходит в пустое «Откуда»', async () => {
    render(<App />)
    await bootUi()

    await typeInto(to(), TO.title)
    await act(async () => {
      fireEvent.keyDown(to(), { key: 'Enter' })
    })
    await nextFrame()

    expect(document.activeElement).toBe(from())
  })
})

describe('обмен станциями на неполном маршруте', () => {
  /** Одно поле заполнено — обмен просто переносит его, маршрута ещё нет. */
  it('переносит единственную станцию в другое поле', async () => {
    render(<App />)
    await bootUi()
    await pickStation(from(), FROM.title)

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Поменять местами станции Откуда и Куда' }),
      )
    })
    await nextFrame()

    expect(to()).toHaveProperty('value', FROM.title)
    expect(from()).toHaveProperty('value', '')
    expect(document.querySelector('.summary-time')).toBeNull()
  })
})

describe('станция «рядом» при заполненном «Куда»', () => {
  it('сразу строит маршрут', async () => {
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true })
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition: (ok: PositionCallback) =>
          ok({ coords: { latitude: 55.7558, longitude: 37.6173 } } as GeolocationPosition),
      },
    })

    render(<App />)
    await bootUi()
    await pickStation(to(), TO.title)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Показать станции рядом' }))
    })
    await nextFrame()

    const row = document.querySelector(
      '.smart-suggestions-section:last-child .smart-suggestions-row',
    )
    const chip = within(row as HTMLElement).getAllByRole('button')[0]
    await act(async () => {
      fireEvent.click(chip)
    })
    await nextFrame()

    await waitFor(() => expect(document.querySelector('.summary-time')).toBeTruthy())
  })
})
