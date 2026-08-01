import { useCallback, useEffect, useState } from 'react'
import './ThemeErrorLogPanel.css'
import { copyTextToClipboard } from '../utils/clipboard.ts'
import { clearErrorLog, formatErrorLogForShare, readErrorLog } from '../utils/errorLog.ts'
import type { ErrorLogEntry } from '../utils/errorLog.ts'

interface ThemeErrorLogPanelProps {
  entries: ErrorLogEntry[]
  onClose: () => void
  onEntriesChange: (entries: ErrorLogEntry[]) => void
}

function formatWhen(at: number): string {
  try {
    return new Date(at).toLocaleString('ru-RU')
  } catch {
    return String(at)
  }
}

const KIND_LABELS: Record<string, string> = {
  error: 'Ошибка',
  promise: 'Promise',
  render: 'Рендер',
}

/**
 * Просмотр локального журнала ошибок.
 *
 * Ошибки собираются в localStorage (см. src/utils/errorLog.ts) и НИКУДА не
 * отправляются: единственный способ передать их разработчику — скопировать
 * текст и прислать вручную. Панель и существует ровно ради этого.
 *
 * Имя файла начинается с Theme — согласованное разграничение с параллельным
 * агентом, который правит остальные компоненты.
 */
export function ThemeErrorLogPanel({ entries, onClose, onEntriesChange }: ThemeErrorLogPanelProps) {
  const [copyState, setCopyState] = useState<'idle' | 'ok' | 'fail'>('idle')

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const handleCopy = useCallback(async () => {
    const ok = await copyTextToClipboard(formatErrorLogForShare(entries))
    setCopyState(ok ? 'ok' : 'fail')
    window.setTimeout(() => setCopyState('idle'), 2400)
  }, [entries])

  const handleClear = useCallback(() => {
    clearErrorLog()
    onEntriesChange(readErrorLog())
  }, [onEntriesChange])

  return (
    <div className="theme-error-log-backdrop" onClick={onClose}>
      <section
        className="theme-error-log"
        role="dialog"
        aria-modal="true"
        aria-label="Журнал ошибок"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="theme-error-log-header">
          <h2 className="theme-error-log-title">Журнал ошибок</h2>
          <button
            type="button"
            className="theme-error-log-close"
            onClick={onClose}
            aria-label="Закрыть журнал ошибок"
          >
            ×
          </button>
        </header>

        <p className="theme-error-log-note">
          Записи хранятся только на этом устройстве и никуда не отправляются. Если что-то сломалось —
          скопируй текст и пришли его нам.
        </p>

        <div className="theme-error-log-list">
          {entries.length === 0 && <div className="theme-error-log-empty">Ошибок нет.</div>}
          {entries
            .slice()
            .reverse()
            .map((entry, index) => (
              <article className="theme-error-log-item" key={`${entry.at}-${index}`}>
                <div className="theme-error-log-item-head">
                  <span className="theme-error-log-kind">{KIND_LABELS[entry.kind] ?? entry.kind}</span>
                  <span className="theme-error-log-time">{formatWhen(entry.at)}</span>
                  {entry.count > 1 && <span className="theme-error-log-count">×{entry.count}</span>}
                </div>
                <div className="theme-error-log-message">{entry.message}</div>
                {entry.source && <div className="theme-error-log-source">{entry.source}</div>}
              </article>
            ))}
        </div>

        <div className="theme-error-log-actions">
          <button
            type="button"
            className="theme-error-log-button theme-error-log-button--primary"
            onClick={() => void handleCopy()}
            disabled={entries.length === 0}
          >
            {copyState === 'ok'
              ? 'Скопировано'
              : copyState === 'fail'
                ? 'Не удалось скопировать'
                : 'Скопировать журнал'}
          </button>
          <button
            type="button"
            className="theme-error-log-button"
            onClick={handleClear}
            disabled={entries.length === 0}
          >
            Очистить
          </button>
        </div>
      </section>
    </div>
  )
}

export default ThemeErrorLogPanel
