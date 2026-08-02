import { useCallback, useEffect, useState } from 'react'

type NavigatorWithStandalone = Navigator & { standalone?: boolean }

/**
 * Человек уже строил маршрут хотя бы раз. Карточка установки читает этот флаг
 * на старте: до первого маршрута предлагать установку нечего (см. UX-9).
 */
const INSTALL_GUIDE_EARNED_KEY = 'kitty-metro-install-guide-earned'

const INSTALL_GUIDE_SEEN_KEY = 'kitty-metro-install-guide-seen'

/** Пауза после появления основного UI: карточка не должна выпрыгивать вместе с картой. */
const INSTALL_GUIDE_DELAY_MS = 900

export type InstallGuidePlatform = 'ios' | 'android' | 'desktop' | 'unknown'

type InstallGuideState = {
  /** Карточку пора показать: все условия сошлись. */
  shouldShow: boolean
  /** Платформа для текста инструкции. Осмысленна только при shouldShow. */
  platform: InstallGuidePlatform
  close: () => void
}

/** Отметить, что польза приложения доказана: карточка появится на СЛЕДУЮЩЕМ запуске. */
export function markInstallGuideEarned(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(INSTALL_GUIDE_EARNED_KEY, '1')
  } catch {
    // ignore
  }
}

/**
 * Карточка «установи приложение на домашний экран».
 *
 * UX-9. Раньше она выезжала через ~1,8 с после запуска, накрывала подсказку
 * онбординга, которую человек начал читать полсекунды назад, и приходила до
 * того, как он вообще понял, что это за приложение.
 *
 * Теперь она «зарабатывается»: человек уже строил маршрут в прошлый раз (то
 * есть застал пользу) и пришёл снова. Плюс она никогда не перебивает онбординг.
 */
export function useInstallGuide(params: {
  isPrimaryUiReady: boolean
  isOnboardingHintVisible: boolean
}): InstallGuideState {
  const { isPrimaryUiReady, isOnboardingHintVisible } = params

  const [platform, setPlatform] = useState<InstallGuidePlatform | 'hidden'>(() => {
    if (typeof window === 'undefined') {
      return 'hidden'
    }

    const isStandaloneDisplay =
      (typeof window.matchMedia === 'function' &&
        window.matchMedia('(display-mode: standalone)').matches === true) ||
      ((window.navigator as NavigatorWithStandalone).standalone === true)

    if (isStandaloneDisplay) {
      return 'hidden'
    }

    try {
      const hasSeen = window.localStorage.getItem(INSTALL_GUIDE_SEEN_KEY) === '1'
      if (hasSeen) {
        return 'hidden'
      }
    } catch {
      return 'hidden'
    }

    const ua = window.navigator.userAgent || ''
    const isIOS = /iPhone|iPad|iPod/.test(ua)
    const isAndroid = /Android/.test(ua)

    if (isIOS) return 'ios'
    if (isAndroid) return 'android'
    if (window.innerWidth >= 768) return 'desktop'
    return 'unknown'
  })

  const isOpen = platform !== 'hidden'
  const [isDelayPassed, setIsDelayPassed] = useState(false)

  /**
   * Право карточки на показ. Считается ОДИН РАЗ на старте и в этой сессии
   * больше не меняется: флаг ставится по факту построенного маршрута, но
   * карточка появится только на следующем запуске — иначе она накрывает свежий
   * результат ровно в тот момент, ради которого человек всё и делал.
   */
  const [isEarned] = useState(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.localStorage.getItem(INSTALL_GUIDE_EARNED_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    if (!isPrimaryUiReady || !isOpen) {
      setIsDelayPassed(false)
      return
    }

    let timeoutId: number | undefined

    if (typeof window !== 'undefined') {
      timeoutId = window.setTimeout(() => {
        setIsDelayPassed(true)
      }, INSTALL_GUIDE_DELAY_MS)
    } else {
      setIsDelayPassed(true)
    }

    return () => {
      if (timeoutId !== undefined && typeof window !== 'undefined') {
        window.clearTimeout(timeoutId)
      }
    }
  }, [isPrimaryUiReady, isOpen])

  const close = useCallback(() => {
    setPlatform('hidden')
    if (typeof window === 'undefined') {
      return
    }

    try {
      window.localStorage.setItem(INSTALL_GUIDE_SEEN_KEY, '1')
    } catch {
      // ignore
    }
  }, [])

  return {
    shouldShow: isPrimaryUiReady && isOpen && isDelayPassed && isEarned && !isOnboardingHintVisible,
    platform: platform === 'hidden' ? 'unknown' : platform,
    close,
  }
}
