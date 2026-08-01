import { useEffect, useState } from 'react'

/**
 * Широкий экран. Начальное значение всегда false и уточняется в эффекте:
 * на широком экране `isDesktop` переключается сразу после монтирования, и всё,
 * что от него зависит, обязано это переживать (см. useRouteWorker).
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia === 'undefined') {
      return
    }

    const media = window.matchMedia('(min-width: 1024px)')
    const handleChange = () => {
      setIsDesktop(media.matches)
    }

    handleChange()
    media.addEventListener('change', handleChange)
    return () => media.removeEventListener('change', handleChange)
  }, [])

  return isDesktop
}
