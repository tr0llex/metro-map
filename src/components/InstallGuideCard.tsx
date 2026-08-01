import { useEffect, useId, useRef } from 'react'
import appLogo from '../assets/metro-logo.svg'

export type InstallGuidePlatform = 'ios' | 'android' | 'desktop' | 'unknown'

interface InstallGuideCardProps {
  platform: InstallGuidePlatform
  onClose: () => void
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function InstallGuideCard({ platform, onClose }: InstallGuideCardProps) {
  const cardRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const uid = useId()
  const titleId = `install-guide-title-${uid}`
  const subtitleId = `install-guide-subtitle-${uid}`

  /**
   * A11Y-7. Карточка объявлена `role="dialog" aria-modal="true"`, но фокус не
   * держала: Tab уводил на кнопки зума карты, тумблер темы, чип шапки — то
   * есть на весь фон, который для скринридера обязан быть недоступен. Собственная
   * кнопка «Понятно» за восемь нажатий Tab так и не достигалась. Escape тоже
   * ничего не делал.
   *
   * Здесь: фокус на кнопку при открытии, цикл по Tab внутри карточки, Escape
   * закрывает, фокус возвращается туда, откуда пришёл.
   */
  useEffect(() => {
    if (typeof document === 'undefined') return

    const previouslyFocused = document.activeElement as HTMLElement | null
    closeButtonRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }

      if (event.key !== 'Tab') return

      const card = cardRef.current
      if (!card) return

      const focusable = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement

      // Фокус мог оказаться снаружи (мышью по фону) — возвращаем его внутрь.
      if (!(active instanceof Node) || !card.contains(active)) {
        event.preventDefault()
        first.focus()
        return
      }

      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
        return
      }

      if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)

    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      previouslyFocused?.focus?.()
    }
  }, [onClose])

  const renderPlatformLabel = () => {
    if (platform === 'ios') return 'Safari на iPhone или iPad'
    if (platform === 'android') return 'Chrome на Android'
    if (platform === 'desktop') return 'Настольный браузер'
    return 'Ваш браузер'
  }

  const renderSteps = () => {
    if (platform === 'ios') {
      return (
        <ol className="install-guide-steps">
          <li>Открой страницу в Safari.</li>
          <li>Нажми «Поделиться».</li>
          <li>Выбери «На экран “Домой”».</li>
        </ol>
      )
    }

    if (platform === 'android') {
      return (
        <ol className="install-guide-steps">
          <li>Открой эту страницу в Chrome.</li>
          <li>Нажми меню ⋮ в адресной строке.</li>
          <li>Выбери «Установить приложение» или «На главный экран».</li>
        </ol>
      )
    }

    if (platform === 'desktop') {
      return (
        <ol className="install-guide-steps">
          <li>В правой части адресной строки.</li>
          <li>Нажми иконку установки приложения.</li>
          <li>Подтверди установку.</li>
        </ol>
      )
    }

    return (
      <ol className="install-guide-steps">
        <li>Открой меню браузера.</li>
        <li>Найди пункт «Установить приложение» или «На главный экран».</li>
        <li>Подтверди и запускай метро с иконки.</li>
      </ol>
    )
  }

  return (
    <div
      className="install-guide-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={subtitleId}
      ref={cardRef}
    >
      <div className="install-guide-header">
        <div className="install-guide-logo">
          <img
            src={appLogo}
            alt="Иконка схемы метро"
            className="install-guide-logo-img"
          />
        </div>
        <div className="install-guide-header-text">
          <h2 className="install-guide-title" id={titleId}>
            Поставь метро как приложение
          </h2>
          <p className="install-guide-subtitle" id={subtitleId}>
            Иконка на главном экране, метро всегда под рукой — даже офлайн.
          </p>
        </div>
      </div>

      <div className="install-guide-platform-row">
        <span className="install-guide-platform-chip">{renderPlatformLabel()}</span>
      </div>

      {renderSteps()}

      <p className="install-guide-note">
        После установки метро будет на главном экране и работать офлайн. Обновления подтянутся
        сами.
      </p>
      <div className="install-guide-actions">
        <button
          type="button"
          className="install-guide-close-button"
          onClick={onClose}
          ref={closeButtonRef}
        >
          Понятно
        </button>
      </div>
    </div>
  )
}
