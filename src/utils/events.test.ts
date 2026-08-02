// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SITE_EVENTS, trackEvent } from './events.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('trackEvent', () => {
  it('шлёт beacon без тела на /e/<событие>', () => {
    const sendBeacon = vi.fn().mockReturnValue(true)
    vi.stubGlobal('navigator', { ...navigator, sendBeacon })

    trackEvent('route_built')

    expect(sendBeacon).toHaveBeenCalledTimes(1)
    const [url, body] = sendBeacon.mock.calls[0]
    expect(url).toBe('/e/route_built')
    // Второго аргумента нет намеренно: с ним запрос уехал бы с телом и
    // Content-Type, а событие целиком помещается в путь.
    expect(body).toBeUndefined()
  })

  /**
   * Главное свойство: счётчик не имеет права ломать обработчик, из которого
   * его позвали. Клик по станции обязан отработать, даже если сеть отвалилась
   * или sendBeacon бросил.
   */
  it('не бросает, когда sendBeacon падает', () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      sendBeacon: () => {
        throw new Error('заблокировано расширением')
      },
    })

    expect(() => trackEvent('station_pick')).not.toThrow()
  })

  it('падает на fetch с keepalive, если beacon недоступен', () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('navigator', { ...navigator, sendBeacon: undefined })
    vi.stubGlobal('fetch', fetchMock)

    trackEvent('pwa_install')

    expect(fetchMock).toHaveBeenCalledWith('/e/pwa_install', {
      method: 'POST',
      keepalive: true,
    })
  })

  /**
   * Имена дублируются в конфиге экспортёра на сервере. Тест не может
   * проверить тот файл, но может поймать имя, которое не пройдёт проверку
   * nginx: только строчные буквы, цифры и подчёркивание, от трёх символов.
   */
  it('все имена событий проходят проверку приёмника', () => {
    for (const event of SITE_EVENTS) {
      expect(event).toMatch(/^[a-z][a-z0-9_]{2,39}$/)
    }
  })
})
