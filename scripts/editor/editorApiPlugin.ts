/**
 * Запись правок редактора прямо в `data/` — только для dev/editor-сборки.
 *
 * Раньше сохранение выглядело так: кнопка кладёт JSON в буфер обмена, человек
 * открывает `data/layout.json`, вставляет, запускает `npm run build:data`,
 * потом `npm run build`. Четыре шага, из которых три — ручные, и на каждом
 * можно вставить не туда или забыть пересобрать.
 *
 * Здесь один шаг: редактор шлёт патч, сервер накладывает его на файлы и сразу
 * пересобирает граф солвером. Прод после этого получается обычным
 * `npm run build` — он забирает уже пересобранный `normalized/fullGraph.json`.
 *
 * БЕЗОПАСНОСТЬ. Плагин подключается только в dev и editor-режимах и живёт
 * исключительно в `configureServer` — в прод-бандл не попадает ни строчки, а
 * dev-сервер по умолчанию слушает localhost. Пишем ровно три вида файлов
 * внутри `data/`, имена файлов линий берём из файловой системы, а не из
 * запроса, поэтому выйти за каталог запросом нельзя.
 */

import { execFile } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Connect, Plugin } from 'vite'

import { applyEditorPatch, type DataFiles, type EditorPatch } from './applyEditorPatch.ts'

const execFileAsync = promisify(execFile)

export const EDITOR_SAVE_ENDPOINT = '/__editor/save'

/** Тело ответа сервера — им же питается панель сохранения в редакторе. */
export type EditorSaveResponse = {
  ok: boolean
  /** Человекочитаемый список изменений. */
  changes: string[]
  /** Какие файлы переписаны. */
  changedFiles: string[]
  /** Что сказал солвер (или почему не запускался). */
  solver: { ok: boolean; message: string }
  error?: string
}

function readDataFiles(root: string): { files: DataFiles; lineNames: string[] } {
  const linesDir = join(root, 'data', 'lines')
  const lineNames = readdirSync(linesDir).filter((n) => n.endsWith('.json')).sort()

  const lines: DataFiles['lines'] = {}
  for (const name of lineNames) {
    lines[name] = JSON.parse(readFileSync(join(linesDir, name), 'utf8'))
  }

  return {
    files: {
      lines,
      transfers: JSON.parse(readFileSync(join(root, 'data', 'transfers.json'), 'utf8')),
      layout: JSON.parse(readFileSync(join(root, 'data', 'layout.json'), 'utf8')),
    },
    lineNames,
  }
}

/** Формат файлов `data/` — два пробела и перевод строки в конце. */
const serialize = (value: unknown) => JSON.stringify(value, null, 2) + '\n'

async function runSolver(root: string): Promise<EditorSaveResponse['solver']> {
  try {
    const { stdout } = await execFileAsync(
      'go',
      ['run', '.', '-data', '../data', '-out', '../normalized/fullGraph.json'],
      { cwd: join(root, 'go-layout-solver'), timeout: 120_000, windowsHide: true },
    )
    const lines = stdout.trim().split('\n')
    return { ok: true, message: lines[0] ?? 'граф пересобран' }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Отсутствие Go — не повод терять уже записанные правки: файлы на диске,
    // а граф можно пересобрать вручную.
    return { ok: false, message: `солвер не отработал: ${message.split('\n')[0]}` }
  }
}

function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      // Полная раскладка — это ~25 КБ. Мегабайта хватит с запасом, а без
      // потолка сюда можно залить что угодно.
      if (data.length > 1_000_000) reject(new Error('слишком большой запрос'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export function editorApiPlugin(root: string): Plugin {
  return {
    name: 'metro-map:editor-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(EDITOR_SAVE_ENDPOINT, (req, res) => {
        const send = (status: number, body: EditorSaveResponse) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(body))
        }

        if (req.method !== 'POST') {
          send(405, {
            ok: false,
            changes: [],
            changedFiles: [],
            solver: { ok: false, message: 'не запускался' },
            error: 'нужен POST',
          })
          return
        }

        void (async () => {
          try {
            const raw = await readBody(req)
            const patch = JSON.parse(raw) as EditorPatch

            const { files } = readDataFiles(root)
            const { files: next, changes, changedFiles } = applyEditorPatch(files, patch)

            if (changedFiles.length === 0) {
              send(200, {
                ok: true,
                changes: [],
                changedFiles: [],
                solver: { ok: true, message: 'изменений нет — солвер не запускался' },
              })
              return
            }

            // Пишем только после того, как ВСЁ содержимое собрано и проверено:
            // упасть на середине и оставить `data/` полуприменённым нельзя.
            for (const path of changedFiles) {
              if (path === 'data/layout.json') {
                writeFileSync(join(root, 'data', 'layout.json'), serialize(next.layout), 'utf8')
              } else if (path === 'data/transfers.json') {
                writeFileSync(
                  join(root, 'data', 'transfers.json'),
                  serialize(next.transfers),
                  'utf8',
                )
              } else {
                const name = path.slice('data/lines/'.length)
                writeFileSync(
                  join(root, 'data', 'lines', name),
                  serialize(next.lines[name]),
                  'utf8',
                )
              }
            }

            const solver = await runSolver(root)
            send(200, { ok: true, changes, changedFiles, solver })
          } catch (error) {
            send(400, {
              ok: false,
              changes: [],
              changedFiles: [],
              solver: { ok: false, message: 'не запускался' },
              error: error instanceof Error ? error.message : String(error),
            })
          }
        })()
      })
    },
  }
}
