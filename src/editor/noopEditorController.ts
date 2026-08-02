import { fullGraphStations } from '../metro/fullGraph.ts'
import type { FullGraphStation } from '../metro/types.ts'
import type { EditorController, EditorMapProps } from './editorTypes.ts'

/**
 * Заглушка редактора для продакшен-сборки.
 *
 * Модуль обязан оставаться крошечным и не тянуть за собой ничего редакторского:
 * именно он попадает в прод-бандл вместо `useEditorController`, а сам
 * `useEditorController` вырезается tree-shaking-ом (см. App.tsx).
 *
 * Все возвращаемые значения — стабильные константы, чтобы MetroMap не терял
 * мемоизацию из-за новых ссылок на каждый рендер.
 */

const EMPTY_STATION_BY_ID: Map<string, FullGraphStation> = (() => {
  const map = new Map<string, FullGraphStation>()
  for (const s of fullGraphStations) map.set(s.id, s)
  return map
})()

const EMPTY_STATION_TITLE_BY_ID: Map<string, string> = (() => {
  const map = new Map<string, string>()
  for (const s of fullGraphStations) map.set(s.id, s.title)
  return map
})()

const EMPTY_RECORD = {} as Record<string, never>
const noop = () => {}

const MAP_PROPS: EditorMapProps = {
  editMode: false,
  collisionDebug: false,
  onLayoutChange: noop,
  editorLayoutOverrides: EMPTY_RECORD,
  editorLayoutApplyToken: 0,
  onEditStationInspect: noop,
  stationTitleOverrides: EMPTY_RECORD,
  editorFocusCommand: null,
}

const CONTROLLER: EditorController = {
  editMode: false,
  allStations: fullGraphStations,
  stationById: EMPTY_STATION_BY_ID,
  stationTitleById: EMPTY_STATION_TITLE_BY_ID,
  stationOverrides: EMPTY_RECORD,
  edgeOverrides: EMPTY_RECORD,
  manualEdges: EMPTY_RECORD,
  mapProps: MAP_PROPS,
  overlay: null,
}

export function useNoopEditorController(): EditorController {
  return CONTROLLER
}
