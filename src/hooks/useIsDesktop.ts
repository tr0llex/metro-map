import { useEffect, useState } from 'react'

/**
 * Условие раскладки «боковая панель слева» вместо нижней шторки.
 *
 * ОБЯЗАНО СОВПАДАТЬ с медиазапросами в App.css, theme.css и ThemeToggle.css:
 * CSS рисует панель, а этот флаг управляет её поведением (перетаскивание,
 * отступы карты, измерение высоты). Разъедутся — панель будет нарисована сбоку,
 * но продолжит ездить вверх-вниз от свайпов.
 *
 * Низкий экран здесь равноправен с широким. Телефон в альбомной ориентации —
 * 812x375: нижняя шторка занимала 635px при экране в 375px, то есть 169% высоты,
 * и карте оставалась полоса в 144px. Дефицитный ресурс в этой ориентации —
 * высота, а нижняя шторка тратит именно её. Слева же 812px ширины простаивают.
 * Поэтому в альбомной ориентации берём ту же боковую панель, что и на десктопе.
 *
 * Порог по высоте, а не по ориентации: узкое и низкое окно на десктопе страдает
 * ровно так же, и ему нужна та же панель.
 */
const SIDE_PANEL_QUERY = '(min-width: 1024px), (max-height: 500px)'

/**
 * Начальное значение всегда false и уточняется в эффекте: на широком экране
 * `isDesktop` переключается сразу после монтирования, и всё, что от него
 * зависит, обязано это переживать (см. useRouteWorker).
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia === 'undefined') {
      return
    }

    const media = window.matchMedia(SIDE_PANEL_QUERY)
    const handleChange = () => {
      setIsDesktop(media.matches)
    }

    handleChange()
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

  return isDesktop
}
