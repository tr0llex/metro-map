import { useCallback, useEffect, useRef, useState } from 'react'
import { copyTextToClipboard } from '../utils/clipboard.ts'
import { buildRouteShareUrl } from '../utils/deepLink.ts'

/** Сколько висит подсказка «ссылка скопирована». */
const SHARE_HINT_DURATION_MS = 2400

type ShareRouteState = {
  /** Текст всплывающей подсказки под кнопкой «Поделиться» (null — нет). */
  shareHint: string | null
  shareRoute: () => Promise<void>
}

/**
 * «Поделиться маршрутом».
 *
 * Сначала пробуем системный шит (navigator.share) — на телефоне это
 * единственный привычный способ. Если его нет или он упал не по отмене
 * пользователя, копируем ссылку в буфер и говорим об этом подсказкой.
 */
export function useShareRoute(params: {
  fromStationId: string | null
  toStationId: string | null
  stationTitleById: Map<string, string>
}): ShareRouteState {
  const { fromStationId, toStationId, stationTitleById } = params

  const [shareHint, setShareHint] = useState<string | null>(null)
  const shareHintTimeoutRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (shareHintTimeoutRef.current != null) {
        window.clearTimeout(shareHintTimeoutRef.current)
        shareHintTimeoutRef.current = null
      }
    }
  }, [])

  const shareRoute = useCallback(async () => {
    const from = fromStationId
    const to = toStationId
    if (!from || !to) return

    const shareUrl = buildRouteShareUrl(from, to)
    if (!shareUrl) return

    const fromTitle = stationTitleById.get(from) ?? ''
    const toTitle = stationTitleById.get(to) ?? ''
    const title =
      fromTitle && toTitle ? `Метро: ${fromTitle} → ${toTitle}` : 'Маршрут в метро Москвы'

    const showHint = (text: string) => {
      setShareHint(text)
      if (shareHintTimeoutRef.current != null) {
        window.clearTimeout(shareHintTimeoutRef.current)
      }
      shareHintTimeoutRef.current = window.setTimeout(() => {
        shareHintTimeoutRef.current = null
        setShareHint(null)
      }, SHARE_HINT_DURATION_MS)
    }

    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title, text: title, url: shareUrl })
        return
      } catch (err) {
        // Пользователь закрыл системный шит — это не ошибка, ничего не показываем.
        if (err instanceof DOMException && err.name === 'AbortError') return
        // Иначе падаем в фолбэк с копированием.
      }
    }

    const copied = await copyTextToClipboard(shareUrl)
    showHint(copied ? 'Ссылка на маршрут скопирована' : 'Не удалось скопировать ссылку')
  }, [fromStationId, toStationId, stationTitleById])

  return { shareHint, shareRoute }
}
