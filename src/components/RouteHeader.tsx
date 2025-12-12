interface RouteHeaderProps {
  logoSrc: string
  logoAlt: string
  headerTitle: string
  headerChipClassName: string
  onChipClick: () => void
}

export function RouteHeader({
  logoSrc,
  logoAlt,
  headerTitle,
  headerChipClassName,
  onChipClick,
}: RouteHeaderProps) {
  return (
    <header className="app-header">
      <div className="app-header-left">
        <div className="app-header-logo">
          <img src={logoSrc} alt={logoAlt} className="app-header-logo-img" />
        </div>
      </div>
      <button
        type="button"
        className={headerChipClassName}
        onClick={onChipClick}
      >
        <span className="app-header-chip-title">{headerTitle}</span>
      </button>
    </header>
  )
}
