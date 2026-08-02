import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import './ThemeToggle.css'
import {
  applyThemePreference,
  readStoredThemePreference,
  resolveTheme,
  subscribeSystemTheme,
  writeThemePreference,
} from '../utils/theme.ts'
import type { ResolvedTheme, ThemePreference } from '../utils/theme.ts'

function IconLight() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="3.1" />
      <path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.1 3.1l1.1 1.1M11.8 11.8l1.1 1.1M12.9 3.1l-1.1 1.1M4.2 11.8l-1.1 1.1" />
    </svg>
  )
}

function IconDark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" />
    </svg>
  )
}

/**
 * Переключатель темы: одна кнопка «светлая ⇄ тёмная».
 *
 * Состояние живёт в localStorage и применяется атрибутом data-theme на <html>
 * (см. src/utils/theme.ts). Ранняя установка, чтобы не было вспышки светлой
 * темы, продублирована инлайн-скриптом в index.html — этот компонент лишь
 * поддерживает атрибут в актуальном состоянии и рисует контрол.
 *
 * ПОЧЕМУ НЕ ТРИ СЕГМЕНТА. Раньше здесь стоял ряд «как в системе / светлая /
 * тёмная» — плашка на треть верхней кромки ради настройки, к которой обращаются
 * один раз за всё время. При этом «как в системе» — не выбор, а отсутствие
 * выбора: он не делает ничего сверх того, что и так происходит по умолчанию.
 *
 * Режим «как в системе» остался, но ушёл из интерфейса: пока кнопку не трогали,
 * тема берётся у системы и следует за ней. Первое нажатие фиксирует явную тему —
 * с этого момента человек сказал, чего хочет, и угадывать больше нечего.
 * Возврата в «как в системе» из интерфейса нет: он стоил бы двух лишних кнопок
 * на экране ради состояния, равного первому запуску.
 *
 * На кнопке иконка ЦЕЛИ, а не текущей темы: нажатие обещает солнце и даёт
 * солнце. Иконка текущего состояния сообщала бы то, что и так видно по всему
 * экрану.
 */
export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(() => readStoredThemePreference())
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(readStoredThemePreference()))

  // Layout-эффект, а не обычный: атрибут должен быть на месте до отрисовки кадра.
  useLayoutEffect(() => {
    setResolved(applyThemePreference(preference))
  }, [preference])

  // В режиме «как в системе» следим за сменой системной темы: сам атрибут
  // не меняется, но цвет статус-бара и иконка кнопки — да, ведь кнопка
  // показывает тему, противоположную текущей.
  useEffect(() => {
    if (preference !== 'system') return
    return subscribeSystemTheme(() => {
      setResolved(applyThemePreference('system'))
    })
  }, [preference])

  const next: ResolvedTheme = resolved === 'dark' ? 'light' : 'dark'

  const handleToggle = useCallback(() => {
    setPreference(next)
    writeThemePreference(next)
    setResolved(applyThemePreference(next))
  }, [next])

  const Icon = next === 'dark' ? IconDark : IconLight

  return (
    <div className="theme-toggle-dock">
      <button
        type="button"
        className="theme-toggle"
        data-theme-next={next}
        aria-label={next === 'dark' ? 'Включить тёмную тему' : 'Включить светлую тему'}
        title={next === 'dark' ? 'Тёмная тема' : 'Светлая тема'}
        onClick={handleToggle}
      >
        <Icon />
      </button>
    </div>
  )
}

export default ThemeToggle
