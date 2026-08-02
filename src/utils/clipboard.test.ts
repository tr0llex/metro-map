// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { copyTextToClipboard } from './clipboard.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** jsdom не реализует navigator.clipboard — подставляем свою. */
function stubClipboard(writeText: (text: string) => Promise<void>) {
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
}

describe('copyTextToClipboard', () => {
  it('использует Clipboard API, когда он доступен', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    stubClipboard(writeText)

    await expect(copyTextToClipboard('текст')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('текст')
  })

  /**
   * Clipboard API доступен только в secure context и только по
   * пользовательскому жесту. Отказ разрешения обязан уводить в фолбэк, а не
   * возвращать «не скопировалось».
   */
  it('при отказе Clipboard API уходит в фолбэк execCommand', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new DOMException('NotAllowedError')))
    const exec = vi.fn().mockReturnValue(true)
    ;(document as unknown as { execCommand: unknown }).execCommand = exec

    await expect(copyTextToClipboard('текст')).resolves.toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
  })

  it('без Clipboard API сразу работает фолбэк', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const exec = vi.fn().mockReturnValue(true)
    ;(document as unknown as { execCommand: unknown }).execCommand = exec

    await expect(copyTextToClipboard('текст')).resolves.toBe(true)
  })

  it('фолбэк кладёт текст в поле и убирает его за собой', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    let seen = ''
    ;(document as unknown as { execCommand: unknown }).execCommand = () => {
      // jsdom не переносит фокус по select(), поэтому смотрим само поле:
      // на момент копирования оно обязано лежать в документе с текстом внутри.
      seen = document.querySelector('textarea')?.value ?? ''
      return true
    }

    await copyTextToClipboard('значение для буфера')

    expect(seen).toBe('значение для буфера')
    expect(document.querySelectorAll('textarea')).toHaveLength(0)
  })

  it('провал фолбэка возвращает false, а не бросает', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    ;(document as unknown as { execCommand: unknown }).execCommand = () => false
    await expect(copyTextToClipboard('текст')).resolves.toBe(false)
  })

  it('исключение внутри фолбэка тоже даёт false', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    ;(document as unknown as { execCommand: unknown }).execCommand = () => {
      throw new Error('нет поддержки')
    }
    await expect(copyTextToClipboard('текст')).resolves.toBe(false)
  })
})
