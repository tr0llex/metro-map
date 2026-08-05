// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SITE_EVENTS, trackEvent } from './events.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'sendBeacon')
})

const stubBeacon = (impl: (url: string) => boolean) => {
  const sendBeacon = vi.fn(impl)
  Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: sendBeacon })
  return sendBeacon
}

describe('доставка события', () => {
  /**
   * sendBeacon, а не fetch: браузер доставляет его сам и переживает уход со
   * страницы, а обычный fetch при закрытии вкладки отменяется.
   */
  it('идёт через sendBeacon, когда он есть', () => {
    const beacon = stubBeacon(() => true)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    trackEvent('route_built')

    expect(beacon).toHaveBeenCalledWith('/e/route_built')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /**
   * Без второго аргумента: строка или Blob добавили бы тело и Content-Type,
   * а событие целиком помещается в путь.
   */
  it('уходит пустым POST без тела', () => {
    const beacon = stubBeacon(() => true)
    trackEvent('station_pick')

    expect(beacon.mock.calls[0]).toHaveLength(1)
  })

  it('где beacon недоступен — fetch с keepalive', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    trackEvent('pwa_install')

    expect(fetchMock).toHaveBeenCalledWith('/e/pwa_install', {
      method: 'POST',
      keepalive: true,
    })
  })

  /** Имена закрыты и на сервере: незнакомое сворачивается в ряд «other». */
  it.each(SITE_EVENTS)('имя %s уходит в путь как есть', (event) => {
    const beacon = stubBeacon(() => true)
    trackEvent(event)
    expect(beacon).toHaveBeenCalledWith(`/e/${event}`)
  })
})

describe('счётчик не ломает приложение', () => {
  /** Это счётчик, а не функциональность: упасть в обработчике клика он не вправе. */
  it('падение beacon проглатывается', () => {
    stubBeacon(() => {
      throw new Error('заблокировано расширением')
    })

    expect(() => trackEvent('route_built')).not.toThrow()
  })

  it('отказ сети в fetch проглатывается', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    expect(() => trackEvent('route_built')).not.toThrow()
    await Promise.resolve()
  })

  /** Ни beacon, ни fetch — событие просто теряется, и это нормально. */
  it('без транспорта событие молча теряется', () => {
    vi.stubGlobal('fetch', undefined)
    expect(() => trackEvent('route_built')).not.toThrow()
  })
})
