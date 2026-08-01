/**
 * Deep links на маршрут: `?from=<stationId>&to=<stationId>`.
 *
 * ID станций выглядят как `1/park-kultury` и содержат косую черту, поэтому
 * в ссылку они всегда попадают через encodeURIComponent (`1%2Fpark-kultury`),
 * а читаются через URLSearchParams — он сам декодирует значение. Без
 * кодирования косая черта в query разбирается как есть, но при склейке ссылок
 * и в чужих парсерах ведёт себя непредсказуемо.
 */

export function readDeepLinkStationIds(search: string): { fromId: string; toId: string } | null {
  try {
    const params = new URLSearchParams(search)
    const fromId = params.get('from')?.trim()
    const toId = params.get('to')?.trim()
    if (!fromId || !toId) return null
    return { fromId, toId }
  } catch {
    return null
  }
}

/** Есть ли в адресе хоть один параметр маршрута — чтобы отличить обрезанную ссылку от обычного входа. */
export function hasAnyDeepLinkParam(search: string): boolean {
  try {
    const params = new URLSearchParams(search)
    return Boolean(params.get('from')?.trim() || params.get('to')?.trim())
  } catch {
    return false
  }
}

/**
 * Убираем мусорные `?from/?to` из адреса: иначе перезагрузка бесконечно
 * повторяет неудачный сценарий, а ссылка выглядит рабочей.
 */
export function clearDeepLinkParamsFromUrl(): void {
  if (typeof window === 'undefined') return
  if (typeof window.history?.replaceState !== 'function') return

  try {
    const url = new URL(window.location.href)
    url.searchParams.delete('from')
    url.searchParams.delete('to')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  } catch {
    // ignore
  }
}

/** Абсолютная ссылка на текущий маршрут — для «Поделиться» и для синхронизации адресной строки. */
export function buildRouteShareUrl(fromId: string, toId: string): string | null {
  if (typeof window === 'undefined') return null

  try {
    const { origin, pathname } = window.location
    return `${origin}${pathname}?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`
  } catch {
    return null
  }
}
