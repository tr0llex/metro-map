import type {
  EdgeOverride,
  EditorOverridesGrid,
  EditorOverridesRingShape,
  EditorOverridesStationLayoutParams,
  FullGraphEdge,
  FullGraphLine,
  FullGraphStation,
  FullGraphTransferHub,
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

/** Полный слепок редактируемого состояния — единица истории undo/redo. */
export type EditorSnapshot = {
  stationOverrides: Record<string, StationOverride>
  stationHubOverrides: Record<string, string | null>
  edgeOverrides: Record<string, EdgeOverride>
  hubMinOverrides: Record<string, number>
  manualStations: Record<string, FullGraphStation>
  manualEdges: Record<string, FullGraphEdge>
  hiddenStations: Record<string, true>
  lastLayoutOverrides: Record<string, { x: number; y: number }>
  hubRotationOverrides: Record<string, number>

  canonicalGrid: EditorOverridesGrid
  canonicalRingShapes: Record<string, EditorOverridesRingShape>
  canonicalStationParams: Record<string, EditorOverridesStationLayoutParams>
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
  ringShapes: Record<string, EditorOverridesRingShape>
  stationParams: Record<string, EditorOverridesStationLayoutParams>
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
  onCanonicalLayoutChange: (payload: CanonicalLayoutPayload) => void
  editorLayoutOverrides: Record<string, { x: number; y: number }>
  editorLayoutApplyToken: number
  onEditStationInspect: (stationId: string) => void
  stationHubOverrides: Record<string, string | null>
  hiddenStationIds: Set<string>
  stationTitleOverrides: Record<string, string>
  extraStations: FullGraphStation[]
  hubRotateCommand: HubRotateCommand | null
  hubMirrorCommand: HubMirrorCommand | null
  editorFocusCommand: EditorFocusCommand | null
  onEditSelectionChange: (ids: string[]) => void
}

/**
 * Всё, что нужно редакторскому оверлею (FAB-кнопки, тост, HubEditorPanel).
 * В проде этот объект равен null и вместе с ним из бандла исчезает вся логика.
 */
export interface EditorOverlayApi {
  toast: string | null

  inspectedStation: FullGraphStation | null
  inspectedLineId: number | null
  inspectedLine: FullGraphLine | null
  inspectedLineEdges: FullGraphEdge[]
  inspectedHub: FullGraphTransferHub | null
  inspectedEdges: FullGraphEdge[]

  stationOverrides: Record<string, StationOverride>
  stationHubOverrides: Record<string, string | null>
  edgeOverrides: Record<string, EdgeOverride>
  hubMinOverrides: Record<string, number>
  hubRotationOverrides: Record<string, number>
  manualStations: Record<string, FullGraphStation>
  manualEdges: Record<string, FullGraphEdge>
  hiddenStations: Record<string, true>
  lastLayoutOverrides: Record<string, { x: number; y: number }>
  canonicalGrid: EditorOverridesGrid
  canonicalRingShapes: Record<string, EditorOverridesRingShape>
  canonicalStationParams: Record<string, EditorOverridesStationLayoutParams>

  availableHubIds: string[]
  stationById: Map<string, FullGraphStation>
  lineByNumericId: Map<number, FullGraphLine>
  effectiveLineStationIdsById: Map<number, string[]>
  editorSelectedStationIds: string[]
  hubAddStationInput: string
  newEdgeTarget: string
  findExactStationByName: (name: string) => FullGraphStation | undefined
  edgeKey: (a: string, b: string) => string

  collisionDebug: boolean
  canUndo: boolean
  canRedo: boolean

  setHubAddStationInput: (value: string) => void
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
  changeStationHub: (stationId: string, newHubId: string | null) => void
  changeHubMinMinutes: (hubId: string, minutesStr: string) => void
  changeEdgeMinutes: (edge: FullGraphEdge, minutesStr: string) => void
  toggleEdgeTransfer: (edge: FullGraphEdge) => void
  toggleEdgeDisabled: (edge: FullGraphEdge) => void
  toggleStationHidden: (stationId: string) => void
  focusStation: (stationId: string) => void
  rotateHubGeometry: (hubId: string, direction: 'cw' | 'ccw') => void
  mirrorHubGeometry: (hubId: string) => void
  updateStationGeoFromOSM: (stationId: string) => Promise<void>
  createManualStation: () => void
  deleteManualStation: (stationId: string) => void
  resetStationEdits: (stationId: string) => void
  resetEdgeEdits: (edge: FullGraphEdge) => void
  resetHubEdits: (hubId: string, hubStationIds: string[]) => void
  resetAllEdits: () => void
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
