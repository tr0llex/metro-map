// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildRouteShareUrl,
  clearDeepLinkParamsFromUrl,
  hasAnyDeepLinkParam,
  readDeepLinkStationIds,
} from './deepLink.ts'

const FROM = '1/park-kultury'
const TO = '5/kitay-gorod'

beforeEach(() => {
  window.history.replaceState({}, '', '/')
})

afterEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState({}, '', '/')
})

describe('сборка ссылки на маршрут', () => {
  /**
   * ID станций содержат косую черту. Без кодирования она разбирается как есть,
   * но при склейке ссылок и в чужих парсерах ведёт себя непредсказуемо.
   */
  it('кодирует косую черту в id станции', () => {
    const url = buildRouteShareUrl(FROM, TO)

    expect(url).toContain(`from=${encodeURIComponent(FROM)}`)
    expect(url).toContain(`to=${encodeURIComponent(TO)}`)
    expect(url).not.toContain(`from=${FROM}`)
  })

  it('ссылка абсолютная — её можно переслать', () => {
    expect(buildRouteShareUrl(FROM, TO)).toMatch(/^https?:\/\//)
  })

  /** Собранная ссылка обязана читаться собственным разборщиком. */
  it('читается обратно тем же модулем', () => {
    const url = new URL(buildRouteShareUrl(FROM, TO)!)
    expect(readDeepLinkStationIds(url.search)).toEqual({ fromId: FROM, toId: TO })
  })

  it('хвост прежнего адреса в ссылку не попадает', () => {
    window.history.replaceState({}, '', '/?from=старое&to=тоже-старое#якорь')
    const url = buildRouteShareUrl(FROM, TO)!

    expect(url).not.toContain('старое')
    expect(url).not.toContain('якорь')
  })
})

describe('очистка адресной строки', () => {
  /**
   * Иначе перезагрузка бесконечно повторяет неудачный сценарий, а ссылка
   * выглядит рабочей.
   */
  it('убирает параметры маршрута', () => {
    window.history.replaceState({}, '', '/?from=нет&to=тоже-нет')
    clearDeepLinkParamsFromUrl()

    expect(window.location.search).toBe('')
    expect(hasAnyDeepLinkParam(window.location.search)).toBe(false)
  })

  /** Чужие параметры — не наши: трогать их права нет. */
  it('посторонние параметры и якорь сохраняет', () => {
    window.history.replaceState({}, '', '/?utm_source=chat&from=нет#details')
    clearDeepLinkParamsFromUrl()

    expect(window.location.search).toBe('?utm_source=chat')
    expect(window.location.hash).toBe('#details')
  })

  it('на чистом адресе ничего не портит', () => {
    window.history.replaceState({}, '', '/route')
    clearDeepLinkParamsFromUrl()

    expect(window.location.pathname).toBe('/route')
    expect(window.location.search).toBe('')
  })

  /** Старый WebView без history.replaceState не должен ронять приложение. */
  it('без history.replaceState молчит', () => {
    const original = window.history.replaceState
    Object.defineProperty(window.history, 'replaceState', {
      configurable: true,
      value: undefined,
    })

    expect(() => clearDeepLinkParamsFromUrl()).not.toThrow()

    Object.defineProperty(window.history, 'replaceState', {
      configurable: true,
      value: original,
    })
  })

  it('отказ history не роняет приложение', () => {
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
      throw new Error('SecurityError')
    })

    expect(() => clearDeepLinkParamsFromUrl()).not.toThrow()
  })
})

describe('признак ссылки на маршрут', () => {
  /** Половинчатая ссылка молча не делала ничего — получатель не понимал, что она обрезана. */
  it.each([
    ['?from=1%2Fa&to=5%2Fb', true],
    ['?from=1%2Fa', true],
    ['?to=5%2Fb', true],
    ['?from=%20', false],
    ['', false],
    ['?utm_source=chat', false],
  ])('%s → %s', (search, expected) => {
    expect(hasAnyDeepLinkParam(search)).toBe(expected)
  })
})
