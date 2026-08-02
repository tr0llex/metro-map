interface RouteHeaderProps {
  logoSrc: string
  logoAlt: string
  headerTitle: string
  headerChipClassName: string
  onChipClick: () => void
  /**
   * Боковая панель вместо нижней шторки (десктоп и альбомная ориентация).
   * См. useIsDesktop.ts — там же объяснено, почему условие одно на оба случая.
   */
  isDesktop: boolean
}

export function RouteHeader({
  logoSrc,
  logoAlt,
  headerTitle,
  headerChipClassName,
  onChipClick,
  isDesktop,
}: RouteHeaderProps) {
  return (
    <header className="app-header">
      <div className="app-header-left">
        <div className="app-header-logo">
          <img src={logoSrc} alt={logoAlt} className="app-header-logo-img" />
        </div>
      </div>

      {/*
        Чип со строкой «Откуда → Куда» нужен только там, где полей ввода не
        видно: на телефоне шторка свёрнута, и чип — единственное место, где
        виден выбранный маршрут. Нажатие раскрывает шторку и ставит курсор в
        незаполненное поле.

        При боковой панели оба поля видны всегда, в четырёх пикселях под чипом.
        Он дословно повторял их содержимое, а его действие — «раскрыть панель» —
        относилось к панели, которая и так раскрыта. Вместо повтора здесь стоит
        название продукта: шапка перестаёт дублировать форму и начинает делать
        то, для чего шапка нужна.
      */}
      {isDesktop ? (
        <div className="app-header-brand">Метро Москвы</div>
      ) : (
        <button type="button" className={headerChipClassName} onClick={onChipClick}>
          <span className="app-header-chip-title">{headerTitle}</span>
        </button>
      )}
    </header>
  )
}
