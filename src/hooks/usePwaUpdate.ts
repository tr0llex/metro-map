import { useCallback, useEffect, useRef, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { recordError } from '../utils/errorLog.ts'

/** Признак того, что ожидающее обновление уже применялось в этой вкладке — защита от петли перезагрузок. */
const SW_COLD_START_APPLIED_KEY = 'metro-map-sw-cold-start-applied'

const UPDATE_DISMISSED_KEY = 'metro-map-update-dismissed'

/** Не чаще одной проверки обновления в три секунды: фокус/pageshow/visibility приходят пачкой. */
const SW_UPDATE_CHECK_THROTTLE_MS = 3000

/**
 * Сколько после загрузки страницы обновление считается «приехавшим на старте»
 * и применяется молча.
 *
 * Проверять только `registration.waiting` в момент регистрации мало: когда
 * версию выкатили, пока вкладка была закрыта, в этот момент новый воркер ещё
 * качается. Он встаёт в очередь через долю секунды ПОСЛЕ onRegistered — и
 * свежая загрузка получала баннер вместо обновления. Со стороны это выглядит
 * как «жму F5, а версия старая»: перезагрузка идёт через старый воркер и снова
 * отдаёт закэшированное.
 *
 * Десять секунд — с запасом на медленную сеть, но заведомо меньше, чем нужно
 * человеку, чтобы уйти вглубь приложения и подтянуть lazy-чанки старой версии.
 */
const COLD_START_UPDATE_WINDOW_MS = 10_000

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
/**
 * Имя актуального service worker. Всё остальное, что зарегистрировано на этом
 * origin, — наследие прежних версий и подлежит снятию.
 *
 * Список прежних имён не держим намеренно: он устаревал бы при каждом
 * переименовании, а забытая в нём строка означает чужой воркер, живущий у
 * пользователя вечно.
 */
const CURRENT_SW_FILE = '/metro-map-sw.js'

/**
 * Префикс имён кэшей, которыми управляет Workbox (`workbox-precache-v2-…`).
 *
 * Их держит действующий воркер, и трогать их из приложения нельзя: устаревшие
 * версии он подчищает сам (`cleanupOutdatedCaches` в vite.config.ts). Всё
 * остальное на origin — кэши воркеров прежних поколений, писавших их руками.
 */
const WORKBOX_CACHE_PREFIX = 'workbox-'

export function usePwaUpdate(): PwaUpdateState {
  // Dev: service worker только мешает — он отдаёт закэшированные модули поверх
  // свежих. Один раз за сессию сносим регистрации и кэши.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!import.meta.env.DEV) return
    if (!('serviceWorker' in navigator)) return

    const alreadyCleaned = window.sessionStorage.getItem('metro-map-dev-sw-cleaned') === '1'
    if (alreadyCleaned) return
    window.sessionStorage.setItem('metro-map-dev-sw-cleaned', '1')

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
  // Момент загрузки страницы. Проставляется эффектом, а не при первом рендере:
  // Date.now() в теле хука — обращение к внешнему изменяемому состоянию.
  const mountedAtMsRef = useRef<number | undefined>(undefined)
  useEffect(() => {
    mountedAtMsRef.current = Date.now()
  }, [])

  // Пока идёт молчаливое применение, баннер показывать незачем: страница
  // вот-вот перезагрузится сама.
  const [isApplyingSilently, setIsApplyingSilently] = useState(false)

  /**
   * Занимает право на молчаливое применение — одно на вкладку.
   *
   * Флаг в sessionStorage защищает от петли перезагрузок, если активация
   * почему-то не доводится до конца, и заодно связывает оба пути (ожидающий
   * воркер на момент регистрации и обновление, доехавшее чуть позже): применить
   * молча можно только один раз.
   */
  const claimSilentUpdate = useCallback((): boolean => {
    if (typeof window === 'undefined') return false
    try {
      if (window.sessionStorage.getItem(SW_COLD_START_APPLIED_KEY) === '1') return false
      window.sessionStorage.setItem(SW_COLD_START_APPLIED_KEY, '1')
    } catch {
      return false
    }
    setIsApplyingSilently(true)
    return true
  }, [])

  const checkForSwUpdate = useCallback(() => {
    if (typeof window === 'undefined') return

    const now = Date.now()
    if (now - swLastUpdateCheckMsRef.current < SW_UPDATE_CHECK_THROTTLE_MS) {
      return
    }
    swLastUpdateCheckMsRef.current = now

    const reg = swRegistrationRef.current
    if (!reg) return

    // update() отклоняется, если регистрация к этому моменту мертва: воркер
    // стал redundant или регистрацию сняли (в том числе чисткой легаси ниже, из
    // другой вкладки или самим Safari при вытеснении). Это не ошибка приложения
    // — проверять больше нечего, поэтому забываем ссылку и молчим. Без catch
    // отказ всплывал бы как unhandledrejection и попадал в журнал ошибок.
    void reg.update().catch(() => {
      if (swRegistrationRef.current === reg) {
        swRegistrationRef.current = undefined
      }
    })
  }, [])

  const { needRefresh: [needRefresh], updateServiceWorker } = useRegisterSW({
    onRegistered(swRegistration: ServiceWorkerRegistration | undefined) {
      swRegistrationRef.current = swRegistration
      if (import.meta.env.DEV) {
        console.log('SW registered', swRegistration)
      }
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
      // Обновления, доехавшие чуть позже этого момента, ловит эффект ниже:
      // здесь `waiting` пуст, когда новый воркер ещё качается.
      if (!swRegistration?.waiting) return
      if (!claimSilentUpdate()) return
      if (import.meta.env.DEV) {
        console.log('SW: применяю ожидающее обновление на холодном старте')
      }
      void updateServiceWorker(true)
    },
    onRegisterError(error: unknown) {
      // В проде отказ регистрации нужен в журнале ошибок, а не в консоли:
      // консоль у пользователя никто не читает, а журнал он умеет отправить.
      recordError('error', error, { source: 'service-worker-register' })
      if (import.meta.env.DEV) {
        console.log('SW registration error', error)
      }
    },
  })

  // Обновление, найденное в первые секунды после загрузки страницы.
  //
  // На перезагрузке после выкатки браузер только начинает качать новый воркер,
  // поэтому в onRegistered `waiting` ещё пуст, и одной проверки там мало: без
  // этого эффекта свежая загрузка получала баннер, а не новую версию — то есть
  // перезагрузка страницы обновление не применяла.
  //
  // Ограничение по времени важно: молчаливая подмена безопасна ровно пока
  // человек не успел уйти вглубь приложения и подтянуть lazy-чанки старой
  // версии — иначе они дадут 404.
  useEffect(() => {
    if (!needRefresh) return
    if (typeof window === 'undefined') return
    const mountedAtMs = mountedAtMsRef.current ?? Date.now()
    if (Date.now() - mountedAtMs > COLD_START_UPDATE_WINDOW_MS) return
    if (!claimSilentUpdate()) return

    if (import.meta.env.DEV) {
      console.log('SW: обновление приехало на загрузке страницы — применяю молча')
    }
    void updateServiceWorker(true)
  }, [needRefresh, updateServiceWorker, claimSilentUpdate])

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

  // Разовая чистка УСТАРЕВШИХ регистраций service worker.
  //
  // Браузер держит регистрацию по имени файла, и новый воркер с другим именем
  // старую не вытесняет: та продолжает перехватывать запросы и отдавать свою
  // версию приложения. За историю проекта имя менялось дважды (`/sw.js` до
  // перехода на vite-plugin-pwa и ещё раз при переименовании), поэтому снимаем
  // всё, что не совпадает с текущим именем.
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
          return !url.pathname.endsWith(CURRENT_SW_FILE)
        } catch {
          return false
        }
      })

      if (legacyRegs.length === 0) {
        return
      }

      // Кэши легаси-воркеров сносим, кэши текущего — нет.
      //
      // Раньше здесь удалялись ВСЕ кэши origin, и вместе с наследием улетал
      // действующий precache Workbox: оболочка приложения, граф маршрутизации и
      // данные схемы. Человек оставался с установленным PWA без офлайна до
      // следующей установки воркера — а маршрут, построенный в этот промежуток
      // без сети, падал на загрузке графа.
      try {
        const keys = await caches.keys()
        await Promise.all(
          keys
            .filter((key) => !key.startsWith(WORKBOX_CACHE_PREFIX))
            .map((key) => caches.delete(key)),
        )
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
    isUpdateReady: needRefresh && !isUpdateDismissed && !isApplyingSilently,
    applyUpdate,
    dismissUpdate,
  }
}
