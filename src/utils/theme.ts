/**
 * Тема оформления: «системная / светлая / тёмная».
 *
 * Токены обеих тем уже живут в src/index.css: тёмная включается медиазапросом
 * `prefers-color-scheme: dark`, а атрибут `data-theme` на <html> побеждает
 * системную настройку в обе стороны. Этот модуль — единственное место, которое
 * этот атрибут выставляет.
 *
 * ВАЖНО: ранняя (до первого кадра) установка атрибута продублирована инлайн-
 * скриптом в index.html — иначе принудительно тёмная тема даёт вспышку светлой
 * на старте. При изменении ключа/значений правьте оба места.
 */

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'kitty-metro-theme'

/** Должно совпадать с meta[name="theme-color"] в index.html. */
const THEME_COLOR_LIGHT = '#f5f5f7'
const THEME_COLOR_DARK = '#16101c'

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)'

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function readStoredThemePreference(): ThemePreference {
  if (typeof window === 'undefined') return 'system'
  try {
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY)
    return isThemePreference(raw) ? raw : 'system'
  } catch {
    return 'system'
  }
}

export function writeThemePreference(preference: ThemePreference): void {
  if (typeof window === 'undefined') return
  try {
    if (preference === 'system') {
      window.localStorage.removeItem(THEME_STORAGE_KEY)
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference)
    }
  } catch {
    // Приватный режим / переполненное хранилище: выбор просто не переживёт перезагрузку.
  }
}

export function getSystemTheme(): ResolvedTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'light'
  try {
    return window.matchMedia(DARK_MEDIA_QUERY).matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? getSystemTheme() : preference
}

/**
 * Цвет системной строки/адресной панели. В index.html два meta[theme-color]
 * с медиазапросами, и браузер выбирает ПЕРВЫЙ подходящий по порядку в DOM —
 * поэтому свой управляемый meta вставляем в самое начало <head>: только так он
 * может перебить пару «light/dark» при принудительном выборе темы.
 */
function applyThemeColorMeta(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  const head = document.head
  if (!head) return

  try {
    let meta = head.querySelector<HTMLMetaElement>('meta[name="theme-color"][data-theme-managed]')
    if (!meta) {
      meta = document.createElement('meta')
      meta.setAttribute('name', 'theme-color')
      meta.setAttribute('data-theme-managed', '1')
      head.insertBefore(meta, head.firstChild)
    }
    meta.setAttribute('content', resolved === 'dark' ? THEME_COLOR_DARK : THEME_COLOR_LIGHT)
  } catch {
    // Цвет статус-бара — украшение, ошибка здесь не должна ронять приложение.
  }
}

/** Ставит (или снимает) data-theme на <html> и синхронизирует theme-color. */
export function applyThemePreference(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference)

  if (typeof document !== 'undefined') {
    const root = document.documentElement
    if (root) {
      if (preference === 'system') root.removeAttribute('data-theme')
      else root.setAttribute('data-theme', preference)
    }
  }

  applyThemeColorMeta(resolved)
  return resolved
}

/** Подписка на смену системной темы (нужна только в режиме «системная»). */
export function subscribeSystemTheme(listener: (theme: ResolvedTheme) => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {}
  }

  let mql: MediaQueryList
  try {
    mql = window.matchMedia(DARK_MEDIA_QUERY)
  } catch {
    return () => {}
  }

  const handler = (event: MediaQueryListEvent) => {
    listener(event.matches ? 'dark' : 'light')
  }

  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }

  // Safari < 14: только устаревший addListener.
  mql.addListener(handler)
  return () => mql.removeListener(handler)
}

export const THEME_PREFERENCE_LABELS: Record<ThemePreference, string> = {
  system: 'Как в системе',
  light: 'Светлая',
  dark: 'Тёмная',
}
