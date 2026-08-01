import { useEffect, useState } from 'react'

export type MapInsets = {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * Отступы карты, занятые интерфейсом поверх неё.
 *
 * Карта центрует маршрут по видимой области, а не по всему холсту — иначе
 * шапка, шторка и кнопки зума накрывают ровно то, что человек хотел увидеть.
 * Меряем по реальным прямоугольникам элементов: раскладка сложная (слои,
 * safe-area, клавиатура), и вывести это из CSS-переменных не получится.
 *
 * `bottom` СЮДА НЕ ПИШЕТСЯ: снизу отступ задаёт шторка, и она сообщает его
 * отдельно через getBottomInsetPx — по кадрам анимации, а не по состоянию.
 */
export function useMapVisibleInsets(params: {
  isDesktop: boolean
  isRouteSheetOpen: boolean
}): MapInsets {
  const { isDesktop, isRouteSheetOpen } = params

  const [mapVisibleInsets, setMapVisibleInsets] = useState<MapInsets>({
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (typeof document === 'undefined') return

    let raf = 0
    let burstRaf: number | null = null
    const schedule = () => {
      if (raf) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        const mapEl = document.querySelector<HTMLElement>('.metro-map-wrapper')
        if (!mapEl) return

        const mapRect = mapEl.getBoundingClientRect()
        const mapWidth = Math.max(1, mapRect.width)
        const mapHeight = Math.max(1, mapRect.height)

        let top = 0
        let left = 0
        let right = 0

        let headerInsetCandidate = 0
        let headerRect: DOMRect | null = null

        const headerEl = document.querySelector<HTMLElement>('.app-header')
        if (headerEl) {
          const r = headerEl.getBoundingClientRect()
          headerRect = r
          headerInsetCandidate = Math.min(Math.max(0, r.bottom - mapRect.top), mapHeight)
        }

        // dev-editor панель учитываем только когда она реально присутствует в DOM
        const hubPanelEl = document.querySelector<HTMLElement>('.hub-editor-panel')
        if (hubPanelEl) {
          const r = hubPanelEl.getBoundingClientRect()
          const inset = Math.max(0, r.right - mapRect.left)
          if (inset > left) {
            left = Math.min(inset, mapWidth)
          }
        }

        const sheetEl = document.querySelector<HTMLElement>('.bottom-sheet')
        if (sheetEl && isDesktop) {
          const r = sheetEl.getBoundingClientRect()
          const inset = Math.max(0, r.right - mapRect.left)
          if (inset > left) {
            left = Math.min(inset, mapWidth)
          }
        }

        const zoomControlsEl = document.querySelector<HTMLElement>('.metro-map-zoom-controls')
        if (zoomControlsEl) {
          const r = zoomControlsEl.getBoundingClientRect()
          const inset = Math.max(0, mapRect.right - r.left)
          if (inset > right) {
            right = Math.min(inset, mapWidth)
          }
        }

        if (headerRect && headerInsetCandidate > 0) {
          const usableLeft = mapRect.left + left
          const usableRight = mapRect.right - right
          const overlapW = Math.min(headerRect.right, usableRight) - Math.max(headerRect.left, usableLeft)
          if (overlapW > 0) {
            top = headerInsetCandidate
          }
        }

        // Возвращаем ПРЕЖНИЙ объект, если ничего не изменилось.
        // React сравнивает состояние по Object.is, поэтому новый объект с теми
        // же числами — это перерендер App, перерендер MetroMap (мемоизация по
        // `visibleInsets` не срабатывает) и перезапуск эффекта автофита. А сюда
        // мы приходим 16 раз подряд на «всплеске» и на каждом resize/scroll.
        setMapVisibleInsets((prev: MapInsets) => {
          if (
            prev.top === top &&
            prev.right === right &&
            prev.left === left
          ) {
            return prev
          }
          return { top, right, bottom: prev.bottom, left }
        })
      })
    }

    const startBurst = () => {
      if (burstRaf != null) {
        window.cancelAnimationFrame(burstRaf)
        burstRaf = null
      }

      let framesLeft = 16
      const tick = () => {
        schedule()
        framesLeft -= 1
        if (framesLeft > 0) {
          burstRaf = window.requestAnimationFrame(tick)
        } else {
          burstRaf = null
        }
      }

      burstRaf = window.requestAnimationFrame(tick)
    }

    schedule()
    startBurst()
    window.addEventListener('resize', schedule)
    const vv = window.visualViewport
    vv?.addEventListener('resize', schedule)
    vv?.addEventListener('scroll', schedule)

    return () => {
      window.removeEventListener('resize', schedule)
      vv?.removeEventListener('resize', schedule)
      vv?.removeEventListener('scroll', schedule)
      if (raf) {
        window.cancelAnimationFrame(raf)
      }
      if (burstRaf != null) {
        window.cancelAnimationFrame(burstRaf)
      }
    }
  }, [isDesktop, isRouteSheetOpen])

  return mapVisibleInsets
}
