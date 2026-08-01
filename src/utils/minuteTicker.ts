/**
 * Тик по границе минуты.
 *
 * Нужен «Прибытию ~HH:MM» в шторке маршрута: значение считается от текущего
 * времени, и без пересчёта оно замерзает на моменте построения маршрута —
 * с открытой шторкой через двадцать минут подпись врёт ровно на двадцать минут.
 *
 * Почему не `setInterval(…, 60000)`: интервал стартует от произвольного момента
 * внутри минуты, поэтому подпись меняется не тогда, когда меняются системные
 * часы, а с плавающим сдвигом до 59 секунд. Здесь каждый следующий таймер
 * ставится ровно до ближайшей границы минуты, поэтому дрейф не накапливается
 * даже после долгих пауз (вкладка в фоне, спящий телефон).
 *
 * Логика вынесена из App.tsx отдельным модулем, чтобы её можно было проверить
 * подменой времени — см. minuteTicker.test.ts.
 */

export const MINUTE_MS = 60_000

/**
 * Запас после границы. Таймеры браузера умеют срабатывать на доли миллисекунды
 * РАНЬШЕ срока, и без запаса `new Date()` внутри обработчика вернул бы ещё
 * старую минуту — подпись не изменилась бы, а следующий тик встал бы почти
 * вплотную. 50 мс невидимы глазу и снимают весь класс проблем.
 */
export const MINUTE_TICK_SKEW_MS = 50

/** Сколько миллисекунд осталось до ближайшей границы минуты. */
export function msUntilNextMinute(nowMs: number): number {
  return MINUTE_MS - (nowMs % MINUTE_MS)
}

/** Задержка следующего таймера: до границы минуты плюс запас. */
export function nextMinuteTickDelay(nowMs: number): number {
  return msUntilNextMinute(nowMs) + MINUTE_TICK_SKEW_MS
}

/**
 * Вызывает `onTick` на каждой границе минуты. Возвращает функцию отписки.
 *
 * Таймеры берутся из глобального контекста, а не из `window`: тот же код должен
 * работать и в тестовом окружении без DOM.
 */
export function startMinuteTicker(onTick: () => void): () => void {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const scheduleNext = () => {
    timeoutId = setTimeout(() => {
      onTick()
      scheduleNext()
    }, nextMinuteTickDelay(Date.now()))
  }

  scheduleNext()

  return () => {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    timeoutId = undefined
  }
}
