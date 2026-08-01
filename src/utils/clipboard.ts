/**
 * Копирование текста в буфер обмена.
 *
 * Общий модуль намеренно лежит вне src/editor/**: им пользуются и прод
 * («Поделиться маршрутом», копирование журнала ошибок), и редактор схемы
 * (экспорт editor_overrides.json). Если бы функция жила в редакторе, любой
 * импорт из прод-кода утянул бы редакторский модуль в прод-бандл.
 *
 * Асинхронный Clipboard API доступен только в secure context и только по
 * пользовательскому жесту, поэтому есть фолбэк на execCommand('copy').
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Отказ разрешения или не-secure контекст — падаем в фолбэк ниже.
    }
  }

  if (typeof document === 'undefined') return false

  try {
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.style.position = 'fixed'
    el.style.top = '0'
    el.style.left = '-9999px'
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}
