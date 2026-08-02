/**
 * Локальный журнал ошибок.
 *
 * Задача: после релиза владелец должен иметь возможность узнать, что именно
 * сломалось у пользователя. Внешние сервисы (Sentry и т.п.) сознательно НЕ
 * подключаются: лишняя зависимость, сетевой запрос и вопрос приватности.
 *
 * Поэтому всё локально: последние ошибки складываются в localStorage с жёстким
 * лимитом по количеству и по размеру, а пользователь может открыть журнал в
 * интерфейсе и скопировать его текстом, чтобы прислать вручную.
 *
 * НИЧЕГО НИКУДА НЕ ОТПРАВЛЯЕТСЯ. Здесь нет ни одного сетевого вызова.
 */

const ERROR_LOG_STORAGE_KEY = 'metro-map-error-log-v1'

/** Больше 20 записей никто читать не станет, а место они съедят. */
const MAX_ENTRIES = 20
/** Потолок на весь журнал: localStorage обычно ~5 МБ на origin, жадничать незачем. */
const MAX_TOTAL_CHARS = 24_000
const MAX_MESSAGE_CHARS = 400
const MAX_STACK_CHARS = 1200
const MAX_SOURCE_CHARS = 200
/** Один и тот же сбой в цикле не должен вытеснить всю историю. */
const DEDUPE_WINDOW_MS = 4000

type ErrorLogEntryKind = 'error' | 'promise' | 'render'

export type ErrorLogEntry = {
  /** Момент первой записи, epoch ms. */
  at: number
  kind: ErrorLogEntryKind
  message: string
  source?: string
  stack?: string
  /** Сколько раз подряд повторилась та же ошибка. */
  count: number
}

type Listener = (entries: ErrorLogEntry[]) => void

const listeners = new Set<Listener>()
let installed = false

function clip(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}

function hasStorage(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage
}

function isEntry(value: unknown): value is ErrorLogEntry {
  if (!value || typeof value !== 'object') return false
  const e = value as Partial<ErrorLogEntry>
  return typeof e.at === 'number' && typeof e.message === 'string'
}

export function readErrorLog(): ErrorLogEntry[] {
  if (!hasStorage()) return []
  try {
    const raw = window.localStorage.getItem(ERROR_LOG_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry).map((e) => ({
      at: e.at,
      kind: e.kind === 'promise' || e.kind === 'render' ? e.kind : 'error',
      message: e.message,
      source: typeof e.source === 'string' ? e.source : undefined,
      stack: typeof e.stack === 'string' ? e.stack : undefined,
      count: typeof e.count === 'number' && e.count > 0 ? e.count : 1,
    }))
  } catch {
    return []
  }
}

function notify(entries: ErrorLogEntry[]): void {
  for (const listener of listeners) {
    try {
      listener(entries)
    } catch {
      // Подписчик не должен ломать запись журнала.
    }
  }
}

function persist(entries: ErrorLogEntry[]): ErrorLogEntry[] {
  if (!hasStorage()) return entries

  // Сначала лимит по количеству, потом — по суммарному размеру: срезаем самые
  // старые записи, пока JSON не влезет в бюджет.
  let list = entries.slice(-MAX_ENTRIES)
  let json = JSON.stringify(list)
  while (list.length > 1 && json.length > MAX_TOTAL_CHARS) {
    list = list.slice(1)
    json = JSON.stringify(list)
  }

  try {
    window.localStorage.setItem(ERROR_LOG_STORAGE_KEY, json)
  } catch {
    // Квота кончилась — журнал не критичен, молча забываем.
  }

  return list
}

/** Записывает ошибку в журнал. Никогда не бросает исключений сама. */
export function recordError(
  kind: ErrorLogEntryKind,
  error: unknown,
  extra?: { source?: string },
): void {
  try {
    let message = ''
    let stack: string | undefined

    if (error instanceof Error) {
      message = `${error.name}: ${error.message}`
      stack = typeof error.stack === 'string' ? error.stack : undefined
    } else if (typeof error === 'string') {
      message = error
    } else {
      try {
        message = JSON.stringify(error)
      } catch {
        message = String(error)
      }
    }

    message = clip((message || 'Неизвестная ошибка').trim(), MAX_MESSAGE_CHARS)

    const entry: ErrorLogEntry = {
      at: Date.now(),
      kind,
      message,
      source: extra?.source ? clip(extra.source, MAX_SOURCE_CHARS) : undefined,
      stack: stack ? clip(stack, MAX_STACK_CHARS) : undefined,
      count: 1,
    }

    const entries = readErrorLog()
    const last = entries[entries.length - 1]

    if (last && last.message === entry.message && entry.at - last.at < DEDUPE_WINDOW_MS) {
      last.count += 1
      last.at = entry.at
    } else {
      entries.push(entry)
    }

    notify(persist(entries))
  } catch {
    // Журнал ошибок не имеет права стать источником ошибок.
  }
}

export function clearErrorLog(): void {
  if (hasStorage()) {
    try {
      window.localStorage.removeItem(ERROR_LOG_STORAGE_KEY)
    } catch {
      // ignore
    }
  }
  notify([])
}

export function subscribeErrorLog(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function formatTime(at: number): string {
  try {
    return new Date(at).toISOString()
  } catch {
    return String(at)
  }
}

/** Текст для ручной отправки: журнал + минимальный контекст окружения. */
export function formatErrorLogForShare(entries: ErrorLogEntry[]): string {
  const head = [
    'Журнал ошибок — Метро Москвы',
    `Собран: ${formatTime(Date.now())}`,
    typeof navigator !== 'undefined' ? `UA: ${clip(navigator.userAgent, MAX_SOURCE_CHARS)}` : '',
    typeof window !== 'undefined' ? `URL: ${window.location.href}` : '',
    typeof window !== 'undefined' ? `Экран: ${window.innerWidth}x${window.innerHeight}` : '',
    '',
  ].filter(Boolean)

  if (entries.length === 0) {
    return [...head, 'Ошибок нет.'].join('\n')
  }

  const body = entries.map((entry, index) => {
    const lines = [
      `#${index + 1} [${entry.kind}] ${formatTime(entry.at)}${entry.count > 1 ? ` ×${entry.count}` : ''}`,
      entry.message,
    ]
    if (entry.source) lines.push(`источник: ${entry.source}`)
    if (entry.stack) lines.push(entry.stack)
    return lines.join('\n')
  })

  return [...head, ...body].join('\n\n')
}

/**
 * Глобальные перехватчики. Ставятся один раз и как можно раньше (main.tsx),
 * чтобы поймать в том числе ошибки на старте приложения.
 */
export function installErrorReporter(): void {
  if (installed) return
  if (typeof window === 'undefined') return
  installed = true

  window.addEventListener('error', (event: ErrorEvent) => {
    // Ошибки загрузки ресурсов (img/script) не имеют event.error и всплывают
    // сюда же — их отличаем по отсутствию message.
    const source =
      event.filename != null && event.filename !== ''
        ? `${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}`
        : undefined
    recordError('error', event.error ?? event.message ?? 'Ошибка без описания', { source })
  })

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    recordError('promise', event.reason ?? 'Promise отклонён без причины')
  })
}
