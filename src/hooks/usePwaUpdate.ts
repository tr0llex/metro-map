import { useCallback, useEffect, useRef, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'

/** Признак того, что ожидающее обновление уже применялось в этой вкладке — защита от петли перезагрузок. */
const SW_COLD_START_APPLIED_KEY = 'kitty-metro-sw-cold-start-applied'

const UPDATE_DISMISSED_KEY = 'kitty-metro-update-dismissed'

/** Не чаще одной проверки обновления в три секунды: фокус/pageshow/visibility приходят пачкой. */
const SW_UPDATE_CHECK_THROTTLE_MS = 3000

type PwaUpdateState = {
  /** Готово новое обновление и человек его ещё не откладывал в этой сессии. */
  isUpdateReady: boolean
  applyUpdate: () => void
  dismissUpdate: () => void
}

/**
 * Обвязка service worker: регистрация, проверки обновления, баннер «есть новая
 * версия» и самолечение на холодном старте.
 *
 * Всё, что связано с SW, живёт здесь целиком — включая dev-режим (где SW нужно
 * наоборот снести) и разовую чистку легаси-регистрации `/sw.js`.
 */
export function usePwaUpdate(): PwaUpdateState {
  // Dev: service worker только мешает — он отдаёт закэшированные модули поверх
  // свежих. Один раз за сессию сносим регистрации и кэши.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!import.meta.env.DEV) return
    if (!('serviceWorker' in navigator)) return

    const alreadyCleaned = window.sessionStorage.getItem('kitty-metro-dev-sw-cleaned') === '1'
    if (alreadyCleaned) return
    window.sessionStorage.setItem('kitty-metro-dev-sw-cleaned', '1')

    void (async () => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations()
        await Promise.all(regs.map((r) => r.unregister()))

        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))

        if (regs.length > 0) {
          window.location.reload()
        }
      } catch {
        // ignore
      }
    })()
  }, [])

  const swRegistrationRef = useRef<ServiceWorkerRegistration | undefined>(undefined)
  const swLastUpdateCheckMsRef = useRef<number>(0)

  const checkForSwUpdate = useCallback(() => {
    if (typeof window === 'undefined') return

    const now = Date.now()
    if (now - swLastUpdateCheckMsRef.current < SW_UPDATE_CHECK_THROTTLE_MS) {
      return
    }
    swLastUpdateCheckMsRef.current = now

    const reg = swRegistrationRef.current
    if (!reg) return
    void reg.update()
  }, [])

  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    onRegistered(swRegistration: ServiceWorkerRegistration | undefined) {
      swRegistrationRef.current = swRegistration
      console.log('SW registered', swRegistration)
      checkForSwUpdate()

      // Самолечение на холодном старте.
      //
      // registerType: 'prompt' означает, что новая версия ждёт явного согласия
      // пользователя. Это правильно ПОСРЕДИ сессии: смена версии на лету может
      // дать 404 на уже загруженных lazy-чанках. Но если по какой-то причине
      // подтвердить обновление не удаётся (баннер перекрыт, не нажимается,
      // пользователь его закрыл), приложение застревает на старой версии
      // навсегда — обычная перезагрузка идёт через service worker и снова
      // отдаёт закэшированное.
      //
      // Поэтому: если обновление УЖЕ ждало на момент регистрации, значит это
      // свежая загрузка страницы, ломать нечего — применяем молча. Спрашиваем
      // только про обновления, найденные во время работы.
      //
      // sessionStorage-флаг защищает от петли перезагрузок, если активация
      // почему-то не доводится до конца.
      if (!swRegistration?.waiting) return
      try {
        if (window.sessionStorage.getItem(SW_COLD_START_APPLIED_KEY) === '1') return
        window.sessionStorage.setItem(SW_COLD_START_APPLIED_KEY, '1')
      } catch {
        return
      }
      console.log('SW: применяю ожидающее обновление на холодном старте')
      void updateServiceWorker(true)
    },
    onRegisterError(error: unknown) {
      console.log('SW registration error', error)
    },
  })

  const [isUpdateDismissed, setIsUpdateDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false
    }

    try {
      return window.sessionStorage.getItem(UPDATE_DISMISSED_KEY) === '1'
    } catch {
      return false
    }
  })

  // Проверяем обновление при каждом возвращении к приложению: PWA живёт долго,
  // и без этого человек может месяцами сидеть на версии, установленной однажды.
  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    checkForSwUpdate()

    const onFocus = () => checkForSwUpdate()
    const onPageShow = () => checkForSwUpdate()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkForSwUpdate()
      }
    }

    window.addEventListener('focus', onFocus)
    window.addEventListener('pageshow', onPageShow)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('pageshow', onPageShow)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [checkForSwUpdate])

  // Разовая чистка легаси-регистрации `/sw.js` (до перехода на vite-plugin-pwa):
  // она перехватывала запросы и отдавала свою старую версию приложения.
  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }
    if (!('serviceWorker' in navigator)) {
      return
    }

    void (async () => {
      let registrations: readonly ServiceWorkerRegistration[]
      try {
        registrations = await navigator.serviceWorker.getRegistrations()
      } catch {
        return
      }

      const legacyRegs = registrations.filter((reg) => {
        const sw = reg.active ?? reg.waiting ?? reg.installing
        if (!sw?.scriptURL) return false
        try {
          const url = new URL(sw.scriptURL)
          return url.pathname.endsWith('/sw.js')
        } catch {
          return false
        }
      })

      if (legacyRegs.length === 0) {
        return
      }

      try {
        const keys = await caches.keys()
        await Promise.all(keys.map((k) => caches.delete(k)))
      } catch {
        // ignore
      }

      for (const reg of legacyRegs) {
        try {
          await reg.unregister()
        } catch {
          // ignore
        }
      }

      checkForSwUpdate()
    })()
  }, [checkForSwUpdate])

  // «Отложил» относится к КОНКРЕТНОМУ обновлению. Как только оно применилось
  // (needRefresh снова false), флаг снимаем — иначе следующая версия придёт
  // молча и человек её никогда не увидит.
  useEffect(() => {
    if (needRefresh) {
      return
    }
    if (!isUpdateDismissed) {
      return
    }

    setIsUpdateDismissed(false)
    if (typeof window !== 'undefined') {
      try {
        window.sessionStorage.removeItem(UPDATE_DISMISSED_KEY)
      } catch {
        // ignore
      }
    }
  }, [needRefresh, isUpdateDismissed])

  const applyUpdate = useCallback(() => {
    updateServiceWorker(true)
  }, [updateServiceWorker])

  const dismissUpdate = useCallback(() => {
    setIsUpdateDismissed(true)
    if (typeof window === 'undefined') {
      return
    }

    try {
      window.sessionStorage.setItem(UPDATE_DISMISSED_KEY, '1')
    } catch {
      // ignore
    }
  }, [])

  return {
    isUpdateReady: needRefresh && !isUpdateDismissed,
    applyUpdate,
    dismissUpdate,
  }
}
