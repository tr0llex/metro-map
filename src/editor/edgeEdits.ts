import { parseTravelTime } from './travelTime.ts'
import { DEFAULT_TRANSFER_KIND, type TransferKind } from './transferKinds.ts'
import type { EdgeOverride, FullGraphEdge } from '../metro/types.ts'

/**
 * Правки рёбер как чистые переходы состояния.
 *
 * Каждая функция получает текущую таблицу оверрайдов и возвращает следующую —
 * ту же ссылку, если ничего не изменилось. Логика здесь непростая: оверрайд,
 * совпавший с базовым графом, обязан ИСЧЕЗНУТЬ, иначе счётчик правок горит на
 * пустом месте, а патч уносит на сервер значения, равные тем, что уже в
 * файлах. В хуке эти ветвления тонули среди setState и эффектов.
 */

export type EdgeOverrides = Record<string, EdgeOverride>
export type EdgeTransferKinds = Record<string, TransferKind>

const withoutKey = <T>(prev: Record<string, T>, key: string) => {
  if (!(key in prev)) return prev
  const next = { ...prev }
  delete next[key]
  return next
}

/** Совпал ли оверрайд с базовым ребром во всех своих полях. */
function isSameAsBase(override: EdgeOverride, edge: FullGraphEdge) {
  return (
    (override.disabled === undefined || override.disabled === false) &&
    (override.isTransfer === undefined || override.isTransfer === !!edge.isTransfer) &&
    (override.medianTravelSeconds === undefined ||
      override.medianTravelSeconds === edge.medianTravelSeconds)
  )
}

const put = (prev: EdgeOverrides, key: string, next: EdgeOverride, edge: FullGraphEdge) =>
  isSameAsBase(next, edge) ? withoutKey(prev, key) : { ...prev, [key]: next }

/**
 * Перегон <-> пересадка, и ничего больше.
 *
 * Прежде это была карусель из трёх положений: перегон -> «близкая» ->
 * «дальняя» -> перегон, — и каждый щелчок ПЕРЕПИСЫВАЛ время, потому что
 * «близкая» и «дальняя» ничем, кроме времени, не различались: тип пересадки
 * в патч всегда уходил базовый. Теперь тип выбирается явно
 * (`setTransferKind`), а время трогает только тот, кто его правит.
 */
export function toggleTransfer(prev: EdgeOverrides, key: string, edge: FullGraphEdge) {
  const current = prev[key]
  const effective =
    current && current.isTransfer !== undefined ? current.isTransfer : !!edge.isTransfer
  return put(prev, key, { ...(current ?? {}), isTransfer: !effective }, edge)
}

export function toggleDisabled(prev: EdgeOverrides, key: string, edge: FullGraphEdge) {
  const current = prev[key]
  return put(prev, key, { ...(current ?? {}), disabled: !(current?.disabled ?? false) }, edge)
}

/**
 * Новое время перегона из строки «м:сс» либо голых секунд — см. travelTime.ts
 * о том, почему минуты как единица здесь не годятся. Ноль допустим: это
 * осмысленное значение, а не отсутствие ввода. Нечитаемый ввод и пустая
 * строка снимают ТОЛЬКО время, оставляя прочие правки ребра.
 */
export function setTravelTime(
  prev: EdgeOverrides,
  key: string,
  edge: FullGraphEdge,
  timeStr: string,
) {
  const current = prev[key]
  const parsed = parseTravelTime(timeStr)
  const seconds = parsed != null && parsed >= 0 ? parsed : undefined

  if (seconds !== undefined) {
    return put(prev, key, { ...(current ?? {}), medianTravelSeconds: seconds }, edge)
  }

  if (!current) return withoutKey(prev, key)

  const next: EdgeOverride = {}
  if (current.isTransfer !== undefined) next.isTransfer = current.isTransfer
  if (current.disabled !== undefined) next.disabled = current.disabled
  return put(prev, key, next, edge)
}

/** Тип пересадки, выбранный руками; совпавший с графом снимается. */
export function setTransferKind(
  prev: EdgeTransferKinds,
  key: string,
  edge: FullGraphEdge,
  kind: TransferKind,
) {
  if (kind === (edge.transferKind ?? DEFAULT_TRANSFER_KIND)) return withoutKey(prev, key)
  if (prev[key] === kind) return prev
  return { ...prev, [key]: kind }
}

export const forgetEdge = withoutKey
