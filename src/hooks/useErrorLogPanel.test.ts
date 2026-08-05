// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { recordError } from '../utils/errorLog.ts'
import { useErrorLogPanel } from './useErrorLogPanel.ts'

const ERROR_LOG_STORAGE_KEY = 'metro-map-error-log-v1'

beforeEach(() => {
  window.localStorage.clear()
})

describe('журнал ошибок в интерфейсе', () => {
  it('на чистой установке пуст и закрыт', () => {
    const { result } = renderHook(() => useErrorLogPanel())

    expect(result.current.entries).toEqual([])
    expect(result.current.isOpen).toBe(false)
  })

  /** Накопленное за прошлые запуски читаем сразу — иначе кнопка журнала не появится. */
  it('поднимает накопленные записи при старте', () => {
    window.localStorage.setItem(
      ERROR_LOG_STORAGE_KEY,
      JSON.stringify([{ at: 1, kind: 'error', message: 'старая беда', count: 1 }]),
    )

    const { result } = renderHook(() => useErrorLogPanel())
    expect(result.current.entries).toHaveLength(1)
    expect(result.current.entries[0].message).toBe('старая беда')
  })

  /**
   * Ради этого и подписка: кнопка «Журнал ошибок» обязана появляться сразу
   * после сбоя, а не после перезагрузки.
   */
  it('свежую ошибку подхватывает без перезагрузки', () => {
    const { result } = renderHook(() => useErrorLogPanel())

    act(() => recordError('error', new Error('свежая беда')))

    expect(result.current.entries).toHaveLength(1)
    expect(result.current.entries[0].message).toContain('свежая беда')
  })

  it('подписка снимается вместе с хуком', () => {
    const { result, unmount } = renderHook(() => useErrorLogPanel())
    unmount()

    expect(() => recordError('error', new Error('после смерти'))).not.toThrow()
    expect(result.current.entries).toEqual([])
  })

  it('открывается и закрывается', () => {
    const { result } = renderHook(() => useErrorLogPanel())

    act(() => result.current.open())
    expect(result.current.isOpen).toBe(true)

    act(() => result.current.close())
    expect(result.current.isOpen).toBe(false)
  })

  /** Панель очищает журнал сама и возвращает наверх результат — хук обязан его принять. */
  it('принимает список, обновлённый панелью', () => {
    const { result } = renderHook(() => useErrorLogPanel())
    act(() => recordError('error', new Error('беда')))

    act(() => result.current.setEntries([]))
    expect(result.current.entries).toEqual([])
  })
})
