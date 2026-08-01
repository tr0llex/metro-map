import appLogo from '../assets/metro-logo.svg'

export type InstallGuidePlatform = 'ios' | 'android' | 'desktop' | 'unknown'

interface InstallGuideCardProps {
  platform: InstallGuidePlatform
  onClose: () => void
}

export function InstallGuideCard({ platform, onClose }: InstallGuideCardProps) {
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
    <div className="install-guide-card" role="dialog" aria-modal="true">
      <div className="install-guide-header">
        <div className="install-guide-logo">
          <img
            src={appLogo}
            alt="Иконка схемы метро"
            className="install-guide-logo-img"
          />
        </div>
        <div className="install-guide-header-text">
          <h2 className="install-guide-title">Поставь метро как приложение</h2>
          <p className="install-guide-subtitle">
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
        >
          Понятно
        </button>
      </div>
    </div>
  )
}
