import { useCallback, useEffect, useRef, useState } from 'react'
import type { StationHint, StationHintKind } from '../components/ThemeStationHint.tsx'

/** Сколько держится подсказка «станция назначена в поле». */
const STATION_HINT_DURATION_MS = 2200

type StationHintState = {
  hint: StationHint | null
  show: (kind: StationHintKind, text: string) => void
}

/** Всплывающее подтверждение «Откуда: …» / «Куда: …» после тапа по станции. */
export function useStationHint(): StationHintState {
  const [hint, setHint] = useState<StationHint | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const idRef = useRef(0)

  const show = useCallback((kind: StationHintKind, text: string) => {
    idRef.current += 1
    setHint({ id: idRef.current, kind, text })

    if (typeof window === 'undefined') return
    if (timeoutRef.current != null) {
      window.clearTimeout(timeoutRef.current)
    }
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null
      setHint(null)
    }, STATION_HINT_DURATION_MS)
  }, [])

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && timeoutRef.current != null) {
        window.clearTimeout(timeoutRef.current)
        timeoutRef.current = null
      }
    }
  }, [])

  return { hint, show }
}
