import { lazy, Suspense } from 'react'
import { fullGraphEdges, fullGraphLines, fullGraphTransferHubs } from '../metro/fullGraph.ts'
import { SaveBar } from './SaveBar.tsx'
import type { EditorOverlayApi } from './editorTypes.ts'

const HubEditorPanelLazy = lazy(() =>
  import('../components/HubEditorPanel.tsx').then((m) => ({ default: m.HubEditorPanel })),
)

const BASE_HUB_IDS = fullGraphTransferHubs.map((hub) => hub.id)

type EditorOverlayProps = {
  editor: EditorOverlayApi
  /** true, когда режим редактирования включён (панель и инструменты видимы) */
  active: boolean
}

/**
 * Весь редакторский UI: панель станции, панель сохранения, FAB-кнопки и тост.
 * Компонент грузится динамически и только в dev/editor сборке — в прод-бандл он
 * не попадает вообще.
 */
export function EditorOverlay({ editor, active }: EditorOverlayProps) {
  return (
    <>
      {active && editor.inspectedStation && (
        <Suspense fallback={null}>
          <HubEditorPanelLazy
            inspectedStation={editor.inspectedStation}
            inspectedLineId={editor.inspectedLineId}
            inspectedLine={editor.inspectedLine}
            inspectedLineEdges={editor.inspectedLineEdges}
            inspectedHub={editor.inspectedHub}
            inspectedEdges={editor.inspectedEdges}
            fullGraphLines={fullGraphLines}
            fullGraphEdges={fullGraphEdges}
            stationOverrides={editor.stationOverrides}
            manualStations={editor.manualStations}
            manualEdges={editor.manualEdges}
            stationHubOverrides={editor.stationHubOverrides}
            hiddenStations={editor.hiddenStations}
            availableHubIds={editor.availableHubIds}
            baseHubIds={BASE_HUB_IDS}
            stationById={editor.stationById}
            lineByNumericId={editor.lineByNumericId}
            effectiveLineStationIdsById={editor.effectiveLineStationIdsById}
            edgeOverrides={editor.edgeOverrides}
            editorSelectedStationIds={editor.editorSelectedStationIds}
            hubAddStationInput={editor.hubAddStationInput}
            newEdgeTarget={editor.newEdgeTarget}
            findExactStationByName={editor.findExactStationByName}
            edgeKey={editor.edgeKey}
            onClose={editor.exitEditMode}
            onUndo={editor.undo}
            onRedo={editor.redo}
            canUndo={editor.canUndo}
            canRedo={editor.canRedo}
            onChangeStationTitle={editor.changeStationTitle}
            onChangeStationLine={editor.changeStationLine}
            onDeleteManualStation={editor.deleteManualStation}
            onToggleEdgeTransfer={editor.toggleEdgeTransfer}
            onChangeEdgeMinutes={editor.changeEdgeMinutes}
            onToggleEdgeDisabled={editor.toggleEdgeDisabled}
            onChangeStationHub={editor.changeStationHub}
            onChangeHubMinMinutes={editor.changeHubMinMinutes}
            onToggleStationHidden={editor.toggleStationHidden}
            onSetHubAddStationInput={editor.setHubAddStationInput}
            onSetNewEdgeTarget={editor.setNewEdgeTarget}
            onSetManualEdges={editor.setManualEdges}
            onSetInspectedStationId={editor.setInspectedStationId}
            onFocusStation={editor.focusStation}
            onRotateHubGeometry={editor.rotateHubGeometry}
            onMirrorHubGeometry={editor.mirrorHubGeometry}
            onUpdateStationGeoFromOSM={editor.updateStationGeoFromOSM}
            onResetStationEdits={editor.resetStationEdits}
            onResetEdgeEdits={editor.resetEdgeEdits}
            onResetHubEdits={editor.resetHubEdits}
            onResetAllEdits={editor.resetAllEdits}
          />
        </Suspense>
      )}

      <button
        type="button"
        className={`editor-fab${active ? ' editor-fab--active' : ''}`}
        onClick={editor.toggleEditMode}
        aria-label={active ? 'Выключить режим редактора' : 'Включить режим редактора'}
      >
        ✎
      </button>

      {active && <SaveBar editor={editor} />}

      {active && (
        <div className="editor-tools-stack" aria-label="Инструменты редактора">
          <button
            type="button"
            className={`editor-fab editor-fab--small${
              editor.collisionDebug ? ' editor-fab--active' : ''
            }`}
            onClick={editor.toggleCollisionDebug}
            aria-label={
              editor.collisionDebug
                ? 'Выключить отладку коллизий подписей'
                : 'Включить отладку коллизий подписей'
            }
          >
            ⚡
          </button>
        </div>
      )}

      {editor.toast && (
        <div className="editor-toast" role="status" aria-live="polite">
          {editor.toast}
        </div>
      )}
    </>
  )
}
