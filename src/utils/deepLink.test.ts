// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'

import {
  buildRouteShareUrl,
  clearDeepLinkParamsFromUrl,
  hasAnyDeepLinkParam,
  readDeepLinkStationIds,
} from './deepLink.ts'

/**
 * Идентификатор станции содержит косую черту: `1/park-kultury`. Именно поэтому
 * ссылка обязана строиться через encodeURIComponent — иначе при склейке ссылок
 * и в чужих парсерах косая черта ведёт себя непредсказуемо.
 */
const FROM = '6/medvedkovo'
const TO = '1/salarevo'

describe('readDeepLinkStationIds', () => {
  it('читает обе станции из строки запроса', () => {
    expect(readDeepLinkStationIds('?from=6%2Fmedvedkovo&to=1%2Fsalarevo')).toEqual({
      fromId: FROM,
      toId: TO,
    })
  })

  it('незакодированная косая черта тоже читается', () => {
    expect(readDeepLinkStationIds('?from=6/medvedkovo&to=1/salarevo')).toEqual({
      fromId: FROM,
      toId: TO,
    })
  })

  it('обрезает пробелы вокруг значений', () => {
    expect(readDeepLinkStationIds('?from=%20' + encodeURIComponent(FROM) + '%20&to=' + TO)?.fromId).toBe(
      FROM,
    )
  })

  it('без одной из станций ссылка не считается маршрутной', () => {
    expect(readDeepLinkStationIds('?from=' + FROM)).toBeNull()
    expect(readDeepLinkStationIds('?to=' + TO)).toBeNull()
    expect(readDeepLinkStationIds('')).toBeNull()
  })

  it('пустое значение параметра не считается станцией', () => {
    expect(readDeepLinkStationIds('?from=&to=' + TO)).toBeNull()
    expect(readDeepLinkStationIds('?from=%20%20&to=' + TO)).toBeNull()
  })
})

describe('hasAnyDeepLinkParam', () => {
  it('отличает обрезанную ссылку от обычного входа', () => {
    expect(hasAnyDeepLinkParam('?from=' + FROM)).toBe(true)
    expect(hasAnyDeepLinkParam('?to=' + TO)).toBe(true)
    expect(hasAnyDeepLinkParam('?utm_source=vk')).toBe(false)
    expect(hasAnyDeepLinkParam('')).toBe(false)
  })

  it('пустой параметр не считается признаком маршрута', () => {
    expect(hasAnyDeepLinkParam('?from=&to=')).toBe(false)
  })
})

describe('buildRouteShareUrl', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/')
  })

  it('косая черта в идентификаторе кодируется', () => {
    const url = buildRouteShareUrl(FROM, TO)
    expect(url).toContain('from=6%2Fmedvedkovo')
    expect(url).toContain('to=1%2Fsalarevo')
  })

  it('построенная ссылка читается обратно без потерь', () => {
    const url = buildRouteShareUrl(FROM, TO)!
    const search = new URL(url).search
    expect(readDeepLinkStationIds(search)).toEqual({ fromId: FROM, toId: TO })
  })

  it('прежние параметры адреса в ссылку не тянутся', () => {
    window.history.replaceState({}, '', '/?utm_source=vk&from=old')
    const url = buildRouteShareUrl(FROM, TO)!
    expect(url).not.toContain('utm_source')
    expect(url).not.toContain('old')
  })
})

describe('clearDeepLinkParamsFromUrl', () => {
  /**
   * Мусорные from/to обязаны исчезать из адреса: иначе перезагрузка
   * бесконечно повторяет неудачный сценарий, а ссылка выглядит рабочей.
   */
  it('убирает from и to, сохраняя остальные параметры', () => {
    window.history.replaceState({}, '', '/?from=' + FROM + '&to=' + TO + '&utm_source=vk')
    clearDeepLinkParamsFromUrl()
    expect(window.location.search).toBe('?utm_source=vk')
  })

  it('якорь адреса не теряется', () => {
    window.history.replaceState({}, '', '/?from=' + FROM + '&to=' + TO + '#map')
    clearDeepLinkParamsFromUrl()
    expect(window.location.hash).toBe('#map')
    expect(window.location.search).toBe('')
  })

  it('на адресе без параметров ничего не ломает', () => {
    window.history.replaceState({}, '', '/somewhere')
    clearDeepLinkParamsFromUrl()
    expect(window.location.pathname).toBe('/somewhere')
    expect(window.location.search).toBe('')
  })
})
