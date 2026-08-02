import { describe, expect, it } from 'vitest'

import {
  DEFAULT_TRANSFER_KIND,
  TRANSFER_KINDS,
  TRANSFER_KIND_TITLES,
  isTransferKind,
} from './transferKinds.ts'
import { TRANSFER_KINDS as SERVER_TRANSFER_KINDS } from '../../scripts/editor/applyEditorPatch.ts'

describe('типы пересадок', () => {
  /**
   * ГЛАВНАЯ ПРОВЕРКА. Список в панели и список, который принимает сервер, —
   * это две записи одного и того же. Разойдутся, и сервер ответит «неизвестный
   * тип пересадки», отвергнув патч ЦЕЛИКОМ: вместе с типом потеряются и
   * переименования, и сдвиги, и времена перегонов.
   */
  it('совпадают с тем, что принимает сервер', () => {
    expect([...TRANSFER_KINDS].sort()).toEqual([...SERVER_TRANSFER_KINDS].sort())
  })

  it('у каждого типа есть человеческое название', () => {
    for (const kind of TRANSFER_KINDS) {
      expect(TRANSFER_KIND_TITLES[kind]).toBeTruthy()
    }
  })

  it('тип по умолчанию — из того же списка', () => {
    expect(isTransferKind(DEFAULT_TRANSFER_KIND)).toBe(true)
  })

  it('чужое значение отвергается', () => {
    expect(isTransferKind('mcd')).toBe(false)
    expect(isTransferKind('')).toBe(false)
  })
})
