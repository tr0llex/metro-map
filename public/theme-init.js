/*
 * Ранняя установка темы — ДО первого кадра.
 *
 * Подключён в index.html как обычный (не module, не defer) <script src>: такой
 * скрипт блокирует разбор документа и гарантированно исполняется раньше, чем
 * браузер что-либо нарисует. Именно поэтому файл лежит в public/ и грузится
 * отдельным запросом, а не собирается Vite в assets/: содержимое обязано
 * приехать раньше основного бандла.
 *
 * Почему не инлайн (как было раньше): инлайн-скрипт вынуждал держать
 * 'unsafe-inline' в script-src боевого CSP. Внешний файл снимает это
 * послабление, а вспышки не появляется — скрипт по-прежнему render-blocking.
 *
 * Логика продублирована в src/utils/theme.ts (applyThemePreference). Правьте
 * оба места вместе: ключ хранилища, допустимые значения и цвета статус-бара.
 */
;(function () {
  var STORAGE_KEY = 'metro-map-theme'
  var THEME_COLOR_LIGHT = '#f5f5f7'
  var THEME_COLOR_DARK = '#16101c'

  var preference = null
  try {
    var raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'dark' || raw === 'light') preference = raw
  } catch (e) {
    /* приватный режим — остаётся системная тема */
  }

  if (!preference) return

  try {
    document.documentElement.setAttribute('data-theme', preference)
  } catch (e) {
    /* до <html> не добраться нечем — дальше всё равно нечего делать */
  }

  /*
   * Цвет системной строки. В <head> лежит пара meta[theme-color] с
   * медиазапросами light/dark, и браузер берёт ПЕРВЫЙ подходящий по порядку в
   * DOM. Поэтому свой управляемый meta вставляем в самое начало <head> — только
   * так он перебивает пару при принудительном выборе темы. Без этого при
   * принудительно тёмной теме системная строка вспыхивала светлой.
   *
   * Тот же элемент потом находит и обновляет src/utils/theme.ts — по атрибуту
   * data-theme-managed, поэтому дубля не возникает.
   */
  try {
    var head = document.head
    if (!head) return
    var meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    meta.setAttribute('data-theme-managed', '1')
    meta.setAttribute(
      'content',
      preference === 'dark' ? THEME_COLOR_DARK : THEME_COLOR_LIGHT,
    )
    head.insertBefore(meta, head.firstChild)
  } catch (e) {
    /* цвет статус-бара — украшение, ошибка здесь не должна ронять старт */
  }
})()
