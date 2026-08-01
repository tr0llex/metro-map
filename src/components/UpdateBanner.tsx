import { IconRefresh } from './icons.tsx'

interface UpdateBannerProps {
  onUpdate: () => void
  onLater: () => void
}

export function UpdateBanner({ onUpdate, onLater }: UpdateBannerProps) {
  return (
    <div className="update-banner" role="status" aria-live="polite">
      {/* Раньше здесь стоял текстовый глиф ⟳: его рисунок и вес зависят от
          системного шрифта, а на части Android он вообще подменялся тофу. */}
      <div className="update-banner-icon" aria-hidden="true">
        <IconRefresh />
      </div>
      <div className="update-banner-content">
        <span className="update-banner-title">Доступно обновление</span>
        <span className="update-banner-subtitle">Обновить приложение сейчас?</span>
      </div>
      <div className="update-banner-actions">
        <button
          type="button"
          className="update-banner-later"
          onClick={onLater}
        >
          Позже
        </button>
        <button
          type="button"
          className="update-banner-button"
          onClick={onUpdate}
        >
          Обновить
        </button>
      </div>
    </div>
  )
}
