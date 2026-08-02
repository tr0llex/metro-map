import { useCallback, useEffect, useRef, useState } from 'react'
import type { RouteResult } from '../metro/types.ts'

// Сколько ждём ответ воркера, прежде чем признать расчёт провалившимся.
// Воркер может не ответить вовсе (упал, не создался, зажевал память) — без этого
// таймаута индикатор загрузки висел бы вечно.
const ROUTE_REQUEST_TIMEOUT_MS = 9000

// Первый запрос — особый случай: воркер отвечает только после загрузки графа
// (отдельный ассет, ~сотни килобайт), и на медленной сети или холодном старте
// PWA девяти секунд не хватает. Считать таймаут от готовности графа нельзя —
// воркер о ней не сообщает, — поэтому первому запросу даём отдельный бюджет и
// отдельный текст ошибки: «данные ещё грузятся» вместо «расчёт завис».
const ROUTE_FIRST_REQUEST_TIMEOUT_MS = 30000

// Обычный расчёт укладывается в единицы миллисекунд, и если показывать индикатор
// сразу, пользователь видит не «загрузку», а мигание скелетона на каждый запрос.
// Поэтому индикатор появляется, только если расчёт реально затянулся...
const ROUTE_LOADING_SHOW_DELAY_MS = 220
// ...а появившись — держится минимум столько, чтобы не мигнуть и не исчезнуть.
const ROUTE_LOADING_MIN_VISIBLE_MS = 420

/** Сколько альтернативных маршрутов просим у воркера. */
const MAX_ALTERNATIVES = 6

/** Что мы помним о запросе, пока ждём ответ. */
type RouteRequestContext = {
  fromId: string
  toId: string
  fromTitleEffective: string
  toTitleEffective: string
  /** Раскладка на момент ОТПРАВКИ запроса: пока считалось, экран мог повернуться. */
  isDesktop: boolean
}

type RouteWorkerState = {
  /** Показывать ли индикатор расчёта (не то же самое, что «идёт расчёт»). */
  isRouteLoading: boolean
  /**
   * Отправить запрос. Все предыдущие ожидающие ответы отменяются.
   * `false` — воркера нет (не создался или уже уничтожен).
   */
  postRoute: (
    ctx: RouteRequestContext,
    overrides: { edgeOverrides: unknown; extraEdges: unknown[] },
  ) => boolean
  /** Параметры последнего запроса — чтобы кнопка «Повторить» могла его переиграть. */
  getLastRequest: () => { fromId: string; toId: string } | null
  /** Погасить индикатор и сторожевой таймер, не трогая содержимое ответа. */
  stopRouteLoading: () => void
  /**
   * Разрешение применить deep link. Выдаётся один раз на «живой» воркер:
   * пересоздание воркера (в т.ч. двойной монтаж в StrictMode) сбрасывает
   * разрешение, чтобы ссылка не потерялась.
   */
  claimDeepLinkSlot: () => boolean
  /** Воркер создан и готов принимать запросы. */
  hasWorker: () => boolean
}

/**
 * Транспорт до воркера маршрутизации.
 *
 * Здесь только доставка: создание воркера, нумерация запросов, отмена
 * устаревших ответов, сторожевые таймауты и видимость индикатора. Что делать
 * с результатом и какие проверки нужны ДО отправки — решает вызывающий.
 */
export function useRouteWorker(params: {
  /** Пришёл непустой результат на актуальный запрос. */
  onRoutes: (ctx: RouteRequestContext, routes: RouteResult[]) => void
  /** Расчёт не удался: текст готов к показу пользователю. */
  onError: (message: string) => void
}): RouteWorkerState {
  const { onRoutes, onError } = params

  // ID запроса, ответ на который мы сейчас ждём (null — ничего не считается).
  const [pendingRouteRequestId, setPendingRouteRequestId] = useState<number | null>(null)
  // Отдельный флаг именно ВИДИМОСТИ индикатора: расчёт почти всегда мгновенный,
  // и показывать скелетон на 5 мс — значит просто мигать пользователю в лицо.
  const [isRouteLoadingVisible, setIsRouteLoadingVisible] = useState(false)
  const routeLoadingShownAtRef = useRef<number | null>(null)

  const routeWorkerRef = useRef<Worker | null>(null)
  const routeWorkerRequestIdRef = useRef(0)
  const routeWorkerPendingRef = useRef<Map<number, RouteRequestContext>>(new Map())

  // Таймер «воркер не ответил» для текущего запроса маршрута.
  const routeRequestTimeoutRef = useRef<number | null>(null)
  // Ответил ли воркер хоть раз: пока нет — граф ещё может грузиться, и запросу
  // положен увеличенный таймаут (см. ROUTE_FIRST_REQUEST_TIMEOUT_MS).
  const hasWorkerRespondedRef = useRef(false)
  const lastRouteRequestRef = useRef<{ fromId: string; toId: string } | null>(null)
  const deepLinkAppliedRef = useRef(false)

  // Видимость индикатора отделена от факта расчёта: см. ROUTE_LOADING_SHOW_DELAY_MS.
  useEffect(() => {
    if (typeof window === 'undefined') return

    if (pendingRouteRequestId != null) {
      if (isRouteLoadingVisible) return
      const timeoutId = window.setTimeout(() => {
        routeLoadingShownAtRef.current = Date.now()
        setIsRouteLoadingVisible(true)
      }, ROUTE_LOADING_SHOW_DELAY_MS)
      return () => window.clearTimeout(timeoutId)
    }

    if (!isRouteLoadingVisible) return

    const shownAt = routeLoadingShownAtRef.current ?? 0
    const restMs = Math.max(0, ROUTE_LOADING_MIN_VISIBLE_MS - (Date.now() - shownAt))
    const timeoutId = window.setTimeout(() => {
      routeLoadingShownAtRef.current = null
      setIsRouteLoadingVisible(false)
    }, restMs)
    return () => window.clearTimeout(timeoutId)
  }, [pendingRouteRequestId, isRouteLoadingVisible])

  // Гасим индикатор загрузки и сторожевой таймер.
  // Вызывается и при успехе, и при ошибке, и при отмене устаревшего запроса,
  // поэтому «залипнуть» индикатор не может.
  const stopRouteLoading = useCallback(() => {
    if (routeRequestTimeoutRef.current != null) {
      window.clearTimeout(routeRequestTimeoutRef.current)
      routeRequestTimeoutRef.current = null
    }
    setPendingRouteRequestId(null)
  }, [])

  // Обработчики ответа воркера держим в ref и обновляем на каждом рендере.
  //
  // Это принципиально: сам воркер должен создаваться РОВНО ОДИН РАЗ. Раньше эффект
  // создания воркера зависел от коллбэков (`setRouteSheetOpenState` и т.п.), а те
  // пересоздаются при смене `isDesktop`. На широком экране `isDesktop` переключается
  // с false на true сразу после монтирования — воркер пересоздавался прямо посреди
  // расчёта, pending-запрос вычищался, и маршрут молча терялся (сильнее всего это
  // било по deep link: на десктопе ссылка вообще не открывала маршрут).
  const routeWorkerMessageRef = useRef<(event: MessageEvent) => void>(() => {})
  const routeWorkerErrorRef = useRef<() => void>(() => {})

  useEffect(() => {
    const pending = routeWorkerPendingRef.current

    routeWorkerErrorRef.current = () => {
      pending.clear()
      stopRouteLoading()
      onError('Не удалось построить маршрут: расчёт завершился с ошибкой. Попробуй ещё раз.')
    }

    routeWorkerMessageRef.current = (event: MessageEvent) => {
      const msg = event.data as
        | { type: 'routeResult'; requestId: number; routes: RouteResult[] }
        | { type: 'routeError'; requestId: number; errorMessage: string }

      if (!msg || typeof msg.requestId !== 'number') return

      // Воркер жив и граф загружен — дальше действует обычный таймаут.
      hasWorkerRespondedRef.current = true

      const ctx = pending.get(msg.requestId)
      // Ответ на устаревший (отменённый) запрос: молча игнорируем,
      // индикатор при этом продолжает относиться к актуальному запросу.
      if (!ctx) return
      pending.delete(msg.requestId)

      stopRouteLoading()

      if (msg.type === 'routeError') {
        onError(msg.errorMessage || 'Маршрут между этими станциями не найден.')
        return
      }

      const routes = msg.routes ?? []
      if (routes.length === 0) {
        onError('Маршрут между этими станциями не найден.')
        return
      }

      onRoutes(ctx, routes)
    }
  })

  useEffect(() => {
    if (typeof window === 'undefined') return

    const worker = new Worker(new URL('../routeWorker.ts', import.meta.url), { type: 'module' })
    routeWorkerRef.current = worker

    const pending = routeWorkerPendingRef.current

    worker.onerror = () => routeWorkerErrorRef.current()
    worker.onmessage = (event: MessageEvent) => routeWorkerMessageRef.current(event)

    return () => {
      routeWorkerRef.current = null
      pending.clear()
      stopRouteLoading()
      deepLinkAppliedRef.current = false
      // Новый воркер — новая загрузка графа, значит снова «первый запрос».
      hasWorkerRespondedRef.current = false
      worker.terminate()
    }
  }, [stopRouteLoading])

  // Тот же приём, что и с обработчиками ответа: postRoute обязан быть стабильным,
  // а onError пересоздаётся вызывающим на каждом рендере.
  const onErrorRef = useRef(onError)
  useEffect(() => {
    onErrorRef.current = onError
  })

  const postRoute = useCallback(
    (
      ctx: RouteRequestContext,
      overrides: { edgeOverrides: unknown; extraEdges: unknown[] },
    ): boolean => {
      const worker = routeWorkerRef.current
      if (!worker) return false

      // Отменяем/игнорируем все предыдущие pending запросы
      // (важно при быстром тапе по станциям)
      routeWorkerPendingRef.current.clear()

      routeWorkerRequestIdRef.current += 1
      const requestId = routeWorkerRequestIdRef.current

      lastRouteRequestRef.current = { fromId: ctx.fromId, toId: ctx.toId }
      routeWorkerPendingRef.current.set(requestId, ctx)

      worker.postMessage({
        type: 'route',
        requestId,
        fromId: ctx.fromId,
        toId: ctx.toId,
        maxAlternatives: MAX_ALTERNATIVES,
        edgeOverrides: overrides.edgeOverrides,
        extraEdges: overrides.extraEdges,
      })

      setPendingRouteRequestId(requestId)

      if (typeof window !== 'undefined') {
        const isFirstRequest = !hasWorkerRespondedRef.current
        const timeoutMs = isFirstRequest
          ? ROUTE_FIRST_REQUEST_TIMEOUT_MS
          : ROUTE_REQUEST_TIMEOUT_MS

        routeRequestTimeoutRef.current = window.setTimeout(() => {
          routeRequestTimeoutRef.current = null
          // Ответа так и нет: считаем запрос потерянным, снимаем его из pending,
          // чтобы опоздавший ответ уже ничего не перерисовал.
          if (!routeWorkerPendingRef.current.has(requestId)) return
          routeWorkerPendingRef.current.delete(requestId)
          setPendingRouteRequestId(null)
          onErrorRef.current(
            isFirstRequest
              ? 'Данные схемы всё ещё загружаются. Проверь связь и попробуй ещё раз.'
              : 'Расчёт маршрута занял слишком много времени. Попробуй ещё раз.',
          )
        }, timeoutMs)
      }

      return true
    },
    [],
  )

  const getLastRequest = useCallback(() => lastRouteRequestRef.current, [])

  const claimDeepLinkSlot = useCallback(() => {
    if (deepLinkAppliedRef.current) return false
    deepLinkAppliedRef.current = true
    return true
  }, [])

  const hasWorker = useCallback(() => routeWorkerRef.current != null, [])

  return {
    isRouteLoading: isRouteLoadingVisible,
    postRoute,
    getLastRequest,
    stopRouteLoading,
    claimDeepLinkSlot,
    hasWorker,
  }
}
