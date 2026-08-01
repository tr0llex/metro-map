import './ThemeStationHint.css'

export type StationHintKind = 'from' | 'to' | 'info'

export type StationHint = {
  /** Меняется на каждый показ: нужен как key, чтобы анимация проигрывалась заново. */
  id: number
  kind: StationHintKind
  text: string
}

interface ThemeStationHintProps {
  hint: StationHint | null
}

/**
 * Всплывающая подсказка «куда попала станция».
 *
 * Нужна из-за нового тап-флоу: раньше выбор поля был явным (поповер «Откуда /
 * Куда»), теперь тап назначает поле сам, и без обратной связи пользователь не
 * поймёт, что произошло. Подсказка держится пару секунд и не перехватывает
 * события указателя — карта под ней остаётся живой.
 *
 * Именование файла с префикса Theme — согласованное разграничение с параллельным
 * агентом, который правит остальные компоненты и общие стили.
 */
export function ThemeStationHint({ hint }: ThemeStationHintProps) {
  return (
    <div className="theme-station-hint-dock" role="status" aria-live="polite">
      {hint && (
        <div key={hint.id} className="theme-station-hint" data-kind={hint.kind}>
          {hint.kind !== 'info' && (
            <span className="theme-station-hint-badge" aria-hidden="true">
              {hint.kind === 'from' ? 'A' : 'B'}
            </span>
          )}
          <span className="theme-station-hint-text">{hint.text}</span>
        </div>
      )}
    </div>
  )
}

export default ThemeStationHint
