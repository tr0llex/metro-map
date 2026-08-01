import type { KeyboardEvent, TransitionEvent } from 'react'
import helloKittyIcon from '../assets/kitty-metro-logo.svg'

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
      <div className="app-splash-orbit">
        <div className="app-splash-orbit-inner" />
      </div>
      <div className="app-splash-floaters" aria-hidden="true">
        <span className="app-splash-heart app-splash-heart--1" />
        <span className="app-splash-heart app-splash-heart--2" />
        <span className="app-splash-heart app-splash-heart--3" />
        <span className="app-splash-heart app-splash-heart--4" />
        <span className="app-splash-heart app-splash-heart--5" />
        <span className="app-splash-heart app-splash-heart--6" />
        <span className="app-splash-heart app-splash-heart--7" />
        <span className="app-splash-heart app-splash-heart--8" />
        <span className="app-splash-heart app-splash-heart--9" />
        <span className="app-splash-heart app-splash-heart--10" />
        <span className="app-splash-heart app-splash-heart--11" />
        <span className="app-splash-heart app-splash-heart--12" />
        <span className="app-splash-heart app-splash-heart--13" />
        <span className="app-splash-heart app-splash-heart--14" />
        <span className="app-splash-heart app-splash-heart--15" />
        <span className="app-splash-heart app-splash-heart--16" />
        <span className="app-splash-star app-splash-star--1" />
        <span className="app-splash-star app-splash-star--2" />
        <div className="app-splash-sparkles">
          <span className="app-splash-sparkle" />
          <span className="app-splash-sparkle" />
          <span className="app-splash-sparkle" />
          <span className="app-splash-sparkle" />
          <span className="app-splash-sparkle" />
          <span className="app-splash-sparkle" />
          <span className="app-splash-sparkle" />
          <span className="app-splash-sparkle" />
          <span className="app-splash-sparkle" />
          <span className="app-splash-sparkle" />
        </div>
      </div>
      <div className="app-splash-card">
        <div className="app-splash-hero">
          <div className="app-splash-hero-avatar" aria-hidden="true">
            <div className="app-splash-hero-avatar-ring" />
            <img src={helloKittyIcon} alt="Hello Kitty" className="app-splash-logo-img" />
          </div>
        </div>
        <h1 className="app-splash-title">Метро Москвы</h1>
        <p className="app-splash-subtitle">
          <span className="app-splash-hello">Hello Kitty</span>
        </p>
        {/* VQA-12: раньше здесь публиковался личный e-mail автора
            («by alex@samoy.love»). Перед публичным релизом заменено на
            нейтральную подпись — вернуть прежний вариант можно правкой
            одной этой строки. */}
        <p className="app-splash-credits">сделано с любовью</p>
      </div>
    </div>
  )
}
