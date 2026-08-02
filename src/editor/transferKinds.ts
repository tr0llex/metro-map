/**
 * Типы пересадок, какими их знает `data/transfers.json`.
 *
 * ПОЧЕМУ ЭТОТ СПИСОК ЗДЕСЬ. Панель показывала «близкая/дальняя» по порогу в
 * шесть минут, то есть выводила тип из времени, а в патч всё равно уходил
 * базовый `kind`. Поменять тип было НЕЛЬЗЯ ни одним действием: пересадка,
 * заведённая как `near`, оставалась `near`, сколько бы времени ей ни ставили,
 * а про `mcc` и `out_of_station` интерфейс не знал вовсе.
 *
 * Значения не выдуманы: ровно их принимает сервер (`TRANSFER_KINDS` в
 * `scripts/editor/applyEditorPatch.ts`, а следом солвер). Совпадение списков
 * стережёт тест — разойдутся, и сервер отвергнет весь патч целиком.
 */
export const TRANSFER_KINDS = ['near', 'far', 'mcc', 'out_of_station'] as const

export type TransferKind = (typeof TRANSFER_KINDS)[number]

/** Тип по умолчанию: им заводится любая новая пересадка. */
export const DEFAULT_TRANSFER_KIND: TransferKind = 'near'

export const TRANSFER_KIND_TITLES: Record<TransferKind, string> = {
  near: 'близкая',
  far: 'дальняя',
  mcc: 'МЦК',
  out_of_station: 'через улицу',
}

export function isTransferKind(value: string): value is TransferKind {
  return (TRANSFER_KINDS as readonly string[]).includes(value)
}
