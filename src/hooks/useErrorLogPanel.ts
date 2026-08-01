import { useEffect, useState } from 'react'
import { readErrorLog, subscribeErrorLog } from '../utils/errorLog.ts'
import type { ErrorLogEntry } from '../utils/errorLog.ts'

export type ErrorLogPanelState = {
  entries: ErrorLogEntry[]
  setEntries: (entries: ErrorLogEntry[]) => void
  isOpen: boolean
  open: () => void
  close: () => void
}

/**
 * Локальный журнал ошибок и его панель.
 *
 * Накопленное читаем при старте и подписываемся на новые записи, чтобы кнопка
 * «Журнал ошибок» появлялась сразу, а не после перезагрузки.
 */
export function useErrorLogPanel(): ErrorLogPanelState {
  const [entries, setEntries] = useState<ErrorLogEntry[]>([])
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    setEntries(readErrorLog())
    return subscribeErrorLog(setEntries)
  }, [])

  return {
    entries,
    setEntries,
    isOpen,
    open: () => setIsOpen(true),
    close: () => setIsOpen(false),
  }
}
