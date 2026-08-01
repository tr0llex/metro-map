import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MINUTE_MS,
  MINUTE_TICK_SKEW_MS,
  msUntilNextMinute,
  nextMinuteTickDelay,
  startMinuteTicker,
} from './minuteTicker.ts'

/**
 * Заявление «время прибытия обновляется по границе минуты» до сих пор держалось
 * на честном слове. Здесь оно проверяется подменой системного времени: тик
 * обязан прийти РОВНО на границе минуты, а не через минуту после подписки.
 */
describe('minuteTicker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('msUntilNextMinute считает остаток до границы минуты', () => {
    // 12:34:00.000 — до следующей границы ровно минута.
    expect(msUntilNextMinute(Date.UTC(2026, 0, 1, 12, 34, 0, 0))).toBe(MINUTE_MS)
    // 12:34:59.500 — осталось полсекунды.
    expect(msUntilNextMinute(Date.UTC(2026, 0, 1, 12, 34, 59, 500))).toBe(500)
    // 12:34:01.000 — 59 секунд.
    expect(msUntilNextMinute(Date.UTC(2026, 0, 1, 12, 34, 1, 0))).toBe(59_000)
  })

  it('nextMinuteTickDelay добавляет запас, чтобы не попасть в ту же минуту', () => {
    const now = Date.UTC(2026, 0, 1, 12, 34, 59, 500)
    expect(nextMinuteTickDelay(now)).toBe(500 + MINUTE_TICK_SKEW_MS)
  })

  it('первый тик приходит на ближайшей границе минуты, а не через минуту', () => {
    // Подписываемся в 12:34:59.500 — до границы 500 мс.
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 12, 34, 59, 500)))
    const onTick = vi.fn()
    const stop = startMinuteTicker(onTick)

    vi.advanceTimersByTime(499)
    expect(onTick).not.toHaveBeenCalled()

    vi.advanceTimersByTime(MINUTE_TICK_SKEW_MS + 1)
    expect(onTick).toHaveBeenCalledTimes(1)
    // Часы уже перевалили за границу: значение, посчитанное в обработчике,
    // относится к новой минуте.
    expect(new Date(Date.now()).getUTCMinutes()).toBe(35)

    stop()
  })

  it('следующие тики идут ровно по границам минут, дрейф не накапливается', () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 12, 0, 17, 123)))
    const minutesAtTick: number[] = []
    const offsetsInMinute: number[] = []
    const stop = startMinuteTicker(() => {
      minutesAtTick.push(new Date(Date.now()).getUTCMinutes())
      offsetsInMinute.push(Date.now() % MINUTE_MS)
    })

    // Пять минут вперёд — ожидаем ровно пять тиков на границах 12:01…12:05.
    vi.advanceTimersByTime(5 * MINUTE_MS)

    expect(minutesAtTick).toEqual([1, 2, 3, 4, 5])
    // Каждый тик — в первые 100 мс своей минуты, дрейфа нет.
    expect(offsetsInMinute).toEqual([50, 50, 50, 50, 50])

    stop()
  })

  it('отписка останавливает тики', () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 0, 1, 12, 0, 0, 0)))
    const onTick = vi.fn()
    const stop = startMinuteTicker(onTick)

    vi.advanceTimersByTime(MINUTE_MS + MINUTE_TICK_SKEW_MS)
    expect(onTick).toHaveBeenCalledTimes(1)

    stop()
    vi.advanceTimersByTime(10 * MINUTE_MS)
    expect(onTick).toHaveBeenCalledTimes(1)
  })
})
