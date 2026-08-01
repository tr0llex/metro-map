import type { RouteResult } from '../../metro/types.ts'

/** Подпись варианта маршрута в чипах выбора: «Самый быстрый», «Минимум пересадок», «Маршрут N». */
export function getRouteVariantLabel(index: number, routes: RouteResult[]): string {
  if (index === 0) return 'Самый быстрый'

  if (routes.length > 1) {
    const fastest = routes[0]
    const minTransfers = routes.reduce(
      (min, r) => (r.transfersCount < min ? r.transfersCount : min),
      routes[0]?.transfersCount ?? Infinity,
    )

    const bestTransfersIndex = routes.findIndex(
      (r, i) => i !== 0 && r.transfersCount === minTransfers && fastest && minTransfers < fastest.transfersCount,
    )

    if (index === bestTransfersIndex) {
      return 'Минимум пересадок'
    }
  }

  return `Маршрут ${index + 1}`
}
