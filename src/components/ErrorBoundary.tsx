import { Component } from 'react'
import type { CSSProperties, ErrorInfo, ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

// Полная очистка «залипшей» PWA: кэши + service worker + перезагрузка.
async function resetAppAndReload(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys()
      await Promise.all(keys.map((key) => caches.delete(key)))
    }
  } catch {
    // Игнорируем: сброс кэша не должен мешать перезагрузке.
  }

  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((registration) => registration.unregister()))
    }
  } catch {
    // Игнорируем.
  }

  // Сохранённые маршруты — тоже возможная причина падения: одна битая запись
  // роняла приложение при каждом построении маршрута. Без их очистки экран
  // ошибки не даёт выхода: перезагрузка возвращает то же падение, и выбраться
  // можно только вручную стерев данные сайта в настройках браузера.
  //
  // Чистим только свои ключи и только те, что можно безболезненно потерять:
  // выбор темы и признак «инструкцию по установке уже видел» переживают сброс.
  try {
    for (const key of ['kitty-metro-favorites-v1', 'kitty-metro-recents-v1']) {
      window.localStorage.removeItem(key)
    }
  } catch {
    // Игнорируем: приватный режим или переполненное хранилище.
  }

  window.location.reload()
}

// Экран ошибки живёт на инлайн-стилях (он должен работать, даже если упал
// рендер приложения), поэтому цвета берём из тех же CSS-переменных темы —
// с запасными светлыми значениями на случай, если стили ещё не подключились.
const styles: Record<string, CSSProperties> = {
  root: {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    background:
      'linear-gradient(180deg, var(--app-bg-1, #f7f8fa) 0%, var(--app-bg-2, #edeff3) 100%)',
    color: 'var(--color-text-secondary, #5a3a4a)',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  card: {
    width: '100%',
    maxWidth: '360px',
    background: 'var(--color-surface-white, #ffffff)',
    borderRadius: '20px',
    padding: '24px',
    boxShadow: 'var(--shadow-soft, 0 12px 32px rgba(214, 122, 168, 0.22))',
    textAlign: 'center',
  },
  // T-5. Раньше здесь стоял эмодзи-бантик 🎀 — последний след прежнего бренда
  // и вдобавок глиф, который на каждой платформе рисуется своим шрифтом.
  // Заменён инлайновым знаком приложения: «М» из сходящихся штрихов.
  mark: {
    width: '56px',
    height: '56px',
    margin: '0 auto 12px',
    display: 'block',
  },
  title: {
    margin: '0 0 8px',
    fontSize: '19px',
    fontWeight: 700,
    color: 'var(--color-text-raspberry, #c2578c)',
  },
  text: {
    margin: '0 0 18px',
    fontSize: '14px',
    lineHeight: 1.5,
    color: 'var(--color-text-secondary, #7a5a68)',
  },
  button: {
    width: '100%',
    border: 'none',
    borderRadius: '14px',
    padding: '13px 18px',
    fontSize: '15px',
    fontWeight: 600,
    // Те же токены основного действия, что и у .primary-button: подпись на
    // кнопке даёт 6:1 в обеих темах (Дизайн-4).
    color: 'var(--color-primary-on, #ffffff)',
    background: 'var(--color-primary-surface, #28344f)',
    cursor: 'pointer',
  },
  details: {
    marginTop: '16px',
    fontSize: '12px',
    color: 'var(--color-text-muted, #a8899a)',
    textAlign: 'left',
    wordBreak: 'break-word',
  },
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Ошибка рендера приложения:', error, info.componentStack)
  }

  private handleReset = (): void => {
    void resetAppAndReload()
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div style={styles.root} role="alert">
        <div style={styles.card}>
          <svg
            style={styles.mark}
            viewBox="0 0 64 64"
            aria-hidden="true"
            focusable="false"
            fill="none"
            stroke="var(--color-accent, #e87bad)"
            strokeWidth={6}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M16 46V22" />
            <path d="M16 22 32 38 48 22" />
            <path d="M48 22v24" />
          </svg>
          <h1 style={styles.title}>Что-то пошло не так</h1>
          <p style={styles.text}>
            Приложение не смогло отрисовать схему метро. Обычно помогает очистка кэша и
            перезагрузка — маршруты и избранное при этом сохранятся.
          </p>
          <button type="button" style={styles.button} onClick={this.handleReset}>
            Очистить кэш и перезагрузить
          </button>
          <details style={styles.details}>
            <summary>Подробности ошибки</summary>
            <div>{error.message}</div>
          </details>
        </div>
      </div>
    )
  }
}

export default ErrorBoundary
