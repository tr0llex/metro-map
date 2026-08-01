import type { KeyboardEvent, TransitionEvent } from 'react'
import appLogo from '../assets/metro-logo.svg'

/** Позиции и тайминги каждого узла заданы в стилях (.app-splash-node--N). */
const NODE_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8] as const

interface SplashScreenProps {
  isDone: boolean
  onDone: () => void
  onHidden: () => void
}

export function SplashScreen({ isDone, onDone, onHidden }: SplashScreenProps) {
  const handleRootClick = () => {
    onDone()
  }

  const handleRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onDone()
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      onDone()
    }
  }

  const handleTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    if (isDone) {
      onHidden()
    }
  }

  return (
    <div
      className={`app-splash${isDone ? ' app-splash--hidden' : ''}`}
      onClick={handleRootClick}
      onKeyDown={handleRootKeyDown}
      onTransitionEnd={handleTransitionEnd}
      role="dialog"
      aria-modal="true"
      aria-label="Заставка приложения"
      tabIndex={0}
    >
      {/* Фоновый мотив: восемь «узлов» из фирменного знака (src/assets/splash-node.svg,
          подключён маской в стилях — цвет берёт тема). Прежняя версия рендерила
          шестнадцать сердец старого бренда, две звезды, орбиту и десять искр;
          половина была скрыта стилями, остальное к новому знаку отношения не имеет,
          поэтому из разметки убрано, а не спрятано. */}
      <div className="app-splash-floaters" aria-hidden="true">
        {NODE_INDEXES.map((n) => (
          <span key={n} className={`app-splash-node app-splash-node--${n}`} />
        ))}
      </div>
      <div className="app-splash-card">
        <div className="app-splash-hero">
          <div className="app-splash-hero-avatar" aria-hidden="true">
            <img src={appLogo} alt="Метро Москвы" className="app-splash-logo-img" />
          </div>
        </div>
        <h1 className="app-splash-title">Метро Москвы</h1>
        <p className="app-splash-subtitle">
          <span className="app-splash-hello">схема и маршруты</span>
        </p>
        <p className="app-splash-credits">by alex@samoy.love</p>
      </div>
    </div>
  )
}
