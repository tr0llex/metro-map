interface UpdateBannerProps {
  onClick: () => void
}

export function UpdateBanner({ onClick }: UpdateBannerProps) {
  return (
    <div className="update-banner" role="status" aria-live="polite">
      <div className="update-banner-icon" aria-hidden="true">
        ⟳
      </div>
      <div className="update-banner-content">
        <span className="update-banner-title">Новая схема готова</span>
        <span className="update-banner-subtitle">Обновим за пару секунд?</span>
      </div>
      <button
        type="button"
        className="update-banner-button"
        onClick={onClick}
      >
        Обновить
      </button>
    </div>
  )
}
