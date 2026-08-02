import { describe, expect, it } from 'vitest'

import { getRouteVariantLabel } from './routeLabels.ts'
import type { RouteResult } from '../../metro/types.ts'

const route = (totalMinutes: number, transfersCount: number): RouteResult => ({
  steps: [],
  totalMinutes,
  transfersCount,
})

describe('getRouteVariantLabel — подписи вариантов маршрута', () => {
  it('первый вариант всегда «Самый быстрый»', () => {
    expect(getRouteVariantLabel(0, [route(30, 2)])).toBe('Самый быстрый')
    expect(getRouteVariantLabel(0, [])).toBe('Самый быстрый')
  })

  /**
   * «Минимум пересадок» имеет смысл только если такой вариант ДЕЙСТВИТЕЛЬНО
   * лучше быстрейшего по числу пересадок. Иначе подпись обещает выгоду,
   * которой нет.
   */
  it('вариант с меньшим числом пересадок подписан «Минимум пересадок»', () => {
    const routes = [route(30, 2), route(35, 0), route(40, 3)]
    expect(getRouteVariantLabel(1, routes)).toBe('Минимум пересадок')
  })

  it('если у быстрейшего пересадок уже минимум — особой подписи нет', () => {
    const routes = [route(30, 0), route(35, 1), route(40, 2)]
    expect(getRouteVariantLabel(1, routes)).toBe('Маршрут 2')
    expect(getRouteVariantLabel(2, routes)).toBe('Маршрут 3')
  })

  it('подпись достаётся первому подходящему варианту, а не каждому с минимумом', () => {
    const routes = [route(30, 2), route(35, 1), route(36, 1)]
    expect(getRouteVariantLabel(1, routes)).toBe('Минимум пересадок')
    expect(getRouteVariantLabel(2, routes)).toBe('Маршрут 3')
  })

  it('остальные варианты нумеруются с единицы', () => {
    const routes = [route(30, 1), route(35, 1), route(40, 1), route(45, 1)]
    expect(getRouteVariantLabel(1, routes)).toBe('Маршрут 2')
    expect(getRouteVariantLabel(3, routes)).toBe('Маршрут 4')
  })

  it('единственный вариант особых подписей не получает', () => {
    const routes = [route(30, 1)]
    expect(getRouteVariantLabel(1, routes)).toBe('Маршрут 2')
  })
})
