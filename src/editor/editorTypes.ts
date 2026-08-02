import type {
  EdgeOverride,
  LayoutRingShape,
  StationLayoutParams,
  FullGraphEdge,
  FullGraphLine,
  FullGraphStation,
} from '../metro/types.ts'

/**
 * Переопределения станции, которые умеет вносить редактор схемы.
 * Держим отдельно от FullGraphStation: тут все поля опциональны и означают
 * «отличается от базового графа», а отсутствие поля — «как в графе».
 */
export type StationOverride = {
  title?: string
  lineNumericId?: number | null
  lat?: number
  lon?: number
}

/**
 * Слепок РЕДАКТИРУЕМОГО состояния — единица истории undo/redo.
 *
 * Сюда намеренно НЕ входят `canonicalGrid` / `canonicalRingShapes` /
 * `canonicalStationParams`: это производные данные, которые MetroMap
 * пересчитывает из раскладки и присылает обратно через `onCanonicalLayoutChange`.
 * Пока они лежали в снапшоте, применение снапшота при undo порождало новые
 * объекты → менялся `makeEditorSnapshot` → перезапускался эффект записи
 * истории → `pushEditorHistory` обрезал ветку redo, и redo пропадал после
 * каждого undo. Раскладка (`lastLayoutOverrides`) в истории есть, а канонические
 * параметры однозначно из неё выводятся, так что ничего не теряется.
 */
export type EditorSnapshot = {
  stationOverrides: Record<string, StationOverride>
  stationHubOverrides: Record<string, string | null>
  edgeOverrides: Record<string, EdgeOverride>
  manualEdges: Record<string, FullGraphEdge>
  lastLayoutOverrides: Record<string, { x: number; y: number }>
}

export type EditorHistoryState = {
  items: EditorSnapshot[]
  index: number // -1, если истории ещё нет
}

export type HubRotateCommand = { hubId: string; direction: 'cw' | 'ccw'; token: number }
export type HubMirrorCommand = { hubId: string; token: number }
export type EditorFocusCommand = { stationId: string; token: number }

export type CanonicalLayoutPayload = {
  grid: { stepPx: number }
  ringShapes: Record<string, LayoutRingShape>
  stationParams: Record<string, StationLayoutParams>
}

/**
 * Ровно тот набор пропсов MetroMap, который порождает редактор.
 * Имена и семантика совпадают с MetroMapProps — App просто расспредивает
 * этот объект в <MetroMap />, поэтому контракт с картой не меняется.
 */
export interface EditorMapProps {
  editMode: boolean
  collisionDebug: boolean
  onLayoutChange: (overrides: Record<string, { x: number; y: number }>) => void
  editorLayoutOverrides: Record<string, { x: number; y: number }>
  editorLayoutApplyToken: number
  onEditStationInspect: (stationId: string) => void
  stationHubOverrides: Record<string, string | null>
  stationTitleOverrides: Record<string, string>
  editorFocusCommand: EditorFocusCommand | null
}

/**
 * Всё, что нужно редакторскому оверлею (FAB-кнопки, тост, HubEditorPanel).
 * В проде этот объект равен null и вместе с ним из бандла исчезает вся логика.
 */
export interface EditorOverlayApi {
  toast: string | null

  inspectedStation: FullGraphStation | null
  inspectedLineId: number | null
  inspectedEdges: FullGraphEdge[]

  stationOverrides: Record<string, StationOverride>
  stationHubOverrides: Record<string, string | null>
  edgeOverrides: Record<string, EdgeOverride>
  manualEdges: Record<string, FullGraphEdge>
  lastLayoutOverrides: Record<string, { x: number; y: number }>
  /**
   * Формы колец, посчитанные картой. `grid` и `stationParams` из
   * `CanonicalLayoutPayload` сюда не попадают: солвер их не читает
   * (см. комментарий к `buildEditorPatch`), поэтому редактор их не хранит.
   */

  stationById: Map<string, FullGraphStation>
  lineByNumericId: Map<number, FullGraphLine>
  newEdgeTarget: string
  findExactStationByName: (name: string) => FullGraphStation | undefined
  edgeKey: (a: string, b: string) => string

  collisionDebug: boolean
  canUndo: boolean
  canRedo: boolean

  setNewEdgeTarget: (value: string) => void
  setManualEdges: (
    updater: (prev: Record<string, FullGraphEdge>) => Record<string, FullGraphEdge>,
  ) => void
  setInspectedStationId: (id: string | null) => void

  showToast: (message: string) => void
  undo: () => void
  redo: () => void
  toggleEditMode: () => void
  exitEditMode: () => void
  toggleCollisionDebug: () => void

  changeStationTitle: (stationId: string, nextTitle: string) => void
  changeStationLine: (stationId: string, lineIdStr: string) => void
  changeEdgeMinutes: (edge: FullGraphEdge, minutesStr: string) => void
  toggleEdgeTransfer: (edge: FullGraphEdge) => void
  toggleEdgeDisabled: (edge: FullGraphEdge) => void
  focusStation: (stationId: string) => void
  updateStationGeoFromOSM: (stationId: string) => Promise<void>
  resetStationEdits: (stationId: string) => void
  resetEdgeEdits: (edge: FullGraphEdge) => void
}

/**
 * Публичный контракт редактора для App. Всё, что нужно пользовательскому
 * сценарию, лежит плоско; всё сугубо редакторское спрятано в `overlay`.
 */
export interface EditorController {
  editMode: boolean

  /** Граф с учётом правок редактора. В проде — ровно базовый граф. */
  allStations: FullGraphStation[]
  stationById: Map<string, FullGraphStation>
  stationTitleById: Map<string, string>

  /** Сырые оверрайды: нужны роутингу (worker) и подписям в UI. */
  stationOverrides: Record<string, StationOverride>
  edgeOverrides: Record<string, EdgeOverride>
  manualEdges: Record<string, FullGraphEdge>

  mapProps: EditorMapProps

  overlay: EditorOverlayApi | null
}
