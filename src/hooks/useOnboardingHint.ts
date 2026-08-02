import { useCallback, useState } from 'react'

const ONBOARDING_HINT_STORAGE_KEY = 'kitty-metro-onboarding-hint-seen'

type OnboardingHintState = {
  /** Подсказка ещё не закрывалась ни разу за всю историю установки. */
  isVisible: boolean
  /** Закрыть навсегда: и в этой сессии, и во всех следующих. */
  dismiss: () => void
}

/** Подсказка первого запуска: «первый тап — Откуда, второй — Куда». */
export function useOnboardingHint(): OnboardingHintState {
  const [isVisible, setIsVisible] = useState(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.localStorage.getItem(ONBOARDING_HINT_STORAGE_KEY) !== '1'
    } catch {
      return false
    }
  })

  const dismiss = useCallback(() => {
    if (typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(ONBOARDING_HINT_STORAGE_KEY, '1')
      } catch {
        // ignore
      }
    }
    setIsVisible(false)
  }, [])

  return { isVisible, dismiss }
}
