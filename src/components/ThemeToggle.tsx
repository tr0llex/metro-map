import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import type { ReactElement } from 'react'
import './ThemeToggle.css'
import {
  THEME_PREFERENCE_LABELS,
  applyThemePreference,
  readStoredThemePreference,
  subscribeSystemTheme,
  writeThemePreference,
} from '../utils/theme.ts'
import type { ThemePreference } from '../utils/theme.ts'

const OPTIONS: ThemePreference[] = ['system', 'light', 'dark']

function IconSystem() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="1.5" y="2.5" width="13" height="9" rx="1.6" />
      <path d="M5.5 13.5h5" />
    </svg>
  )
}

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

const ICONS: Record<ThemePreference, () => ReactElement> = {
  system: IconSystem,
  light: IconLight,
  dark: IconDark,
}

/**
 * Переключатель темы: «как в системе / светлая / тёмная».
 *
 * Состояние живёт в localStorage и применяется атрибутом data-theme на <html>
 * (см. src/utils/theme.ts). Ранняя установка, чтобы не было вспышки светлой
 * темы, продублирована инлайн-скриптом в index.html — этот компонент лишь
 * поддерживает атрибут в актуальном состоянии и рисует контрол.
 */
export function ThemeToggle() {
  const [preference, setPreference] = useState<ThemePreference>(() => readStoredThemePreference())

  // Layout-эффект, а не обычный: атрибут должен быть на месте до отрисовки кадра.
  useLayoutEffect(() => {
    applyThemePreference(preference)
  }, [preference])

  // В режиме «как в системе» следим за сменой системной темы: сам атрибут
  // не меняется, но цвет статус-бара (meta theme-color) нужно пересчитать.
  useEffect(() => {
    if (preference !== 'system') return
    return subscribeSystemTheme(() => {
      applyThemePreference('system')
    })
  }, [preference])

  const handleSelect = useCallback((next: ThemePreference) => {
    setPreference(next)
    writeThemePreference(next)
    applyThemePreference(next)
  }, [])

  return (
    <div className="theme-toggle-dock">
      <div className="theme-toggle" role="group" aria-label="Тема оформления">
        {OPTIONS.map((option) => {
          const Icon = ICONS[option]
          const isActive = option === preference
          return (
            <button
              key={option}
              type="button"
              className="theme-toggle-option"
              data-theme-option={option}
              aria-label={`Тема: ${THEME_PREFERENCE_LABELS[option].toLowerCase()}`}
              aria-pressed={isActive}
              title={THEME_PREFERENCE_LABELS[option]}
              onClick={() => handleSelect(option)}
            >
              <Icon />
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default ThemeToggle
